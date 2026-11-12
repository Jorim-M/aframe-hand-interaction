// Shared test harness: loads a library build into a fake A-Frame,
// builds a scene, and drives two simulated 25-joint hands.
import * as THREE from 'three';
import fs from 'fs';

const D2R = THREE.MathUtils.degToRad;

export function load(path) {
  globalThis.THREE = THREE;
  const comps = {}, systems = {};
  globalThis.AFRAME = { registerComponent: (n, d) => { comps[n] = d; }, registerSystem: (n, d) => { systems[n] = d; } };
  const doc = { _q: () => null, _qa: () => [] };
  globalThis.document = {
    querySelector: (s) => doc._q(s), querySelectorAll: (s) => doc._qa(s),
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ createLinearGradient: () => ({ addColorStop() {} }), fillRect() {} }) }),
  };
  (0, eval)(fs.readFileSync(path, 'utf8'));
  return { comps, systems, doc };
}

export function entity(name, obj) {
  const el = {
    name, object3D: obj || new THREE.Object3D(), components: {}, listeners: {}, states: new Set(), log: [],
    emit(n, d) { el.log.push(n); (el.listeners[n] || []).slice().forEach((f) => f({ type: n, detail: d, target: el })); },
    addEventListener(n, f) { (el.listeners[n] ||= []).push(f); },
    removeEventListener(n, f) { el.listeners[n] = (el.listeners[n] || []).filter((x) => x !== f); },
    addState(s) { el.states.add(s); }, removeState(s) { el.states.delete(s); }, is(s) { return el.states.has(s); },
    getAttribute(a) { return a === 'color' ? el.name : null; },
  };
  el.object3D.el = el;
  return el;
}

// ── Hand model. Hand-local frame: wrist at origin, fingers along -Z,
// curling downward (-Y); thumb on the +X side. All lengths × scale. ──
const FINGERS = {
  index:  { base: [0.020, 0, -0.090], meta: [0.018, 0, -0.020], L: [0.045, 0.026, 0.020] },
  middle: { base: [0.000, 0, -0.095], meta: [0.002, 0, -0.020], L: [0.050, 0.030, 0.021] },
  ring:   { base: [-0.020, 0, -0.088], meta: [-0.012, 0, -0.020], L: [0.046, 0.028, 0.020] },
  pinky:  { base: [-0.036, 0, -0.078], meta: [-0.022, 0, -0.020], L: [0.035, 0.020, 0.018] },
};
const FULL = [70, 95, 60].map(D2R); // MCP, PIP, DIP bend at full curl
const V = (a) => new THREE.Vector3(...a);

export class Hand {
  constructor(side, scale = 1) {
    this.side = side; this.s = scale;
    this.wrist = new THREE.Vector3(side === 'left' ? -0.2 : 0.2, 1.3, -0.25);
    this.pitch = 0; this.yaw = 0;
    this.curl = { index: 0, middle: 0, ring: 0, pinky: 0 };
    this.thumb = { dir: new THREE.Vector3(0.6, 0.3, -0.75).normalize(), bend: 0.2 }; // relaxed, off to the side
    this.thumbTip = null;        // explicit tip override (hand-local, unscaled metres × s applied)
    this.tracked = true;
    this.mirror = side === 'left' ? -1 : 1;
  }
  quat() {
    return new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
  joints() {
    if (!this.tracked) return null;
    const s = this.s, q = this.quat(), J = {}, m = this.mirror;
    const put = (n, v) => { const p = v.clone(); p.x *= m; J[n] = { p: p.multiplyScalar(s).applyQuaternion(q).add(this.wrist), q }; };
    put('wrist', V([0, 0, 0]));
    for (const [f, d] of Object.entries(FINGERS)) {
      put(f + '-finger-metacarpal', V(d.meta));
      let p = V(d.base), a = 0;
      put(f + '-finger-phalanx-proximal', p);
      const names = ['phalanx-intermediate', 'phalanx-distal', 'tip'];
      for (let i = 0; i < 3; i++) {
        a += FULL[i] * this.curl[f];
        p = p.clone().add(new THREE.Vector3(0, -Math.sin(a), -Math.cos(a)).multiplyScalar(d.L[i]));
        put(f + '-finger-' + names[i], p);
      }
    }
    // Thumb: base, then three segments along thumb.dir, bending toward -X
    const tb = V([0.025, -0.005, -0.03]);
    put('thumb-metacarpal', tb);
    const L = [0.04, 0.032, 0.025];
    let p = tb.clone(), dir = this.thumb.dir.clone();
    const names = ['thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
    for (let i = 0; i < 3; i++) {
      p = p.clone().addScaledVector(dir, L[i]);
      if (i === 2 && this.thumbTip) p = this.thumbTip.clone();
      put(names[i], p);
      dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), this.thumb.bend);
    }
    return J;
  }
  // index fingertip etc. in rig-local space (for building scenarios)
  local(name) { return this.joints()[name].p.clone(); }
  // hand-local (unscaled) position of a joint, for thumb targets
  handLocal(name) {
    const j = this.joints()[name].p.clone().sub(this.wrist).applyQuaternion(this.quat().invert()).multiplyScalar(1 / this.s);
    j.x *= this.mirror; return j;
  }
}

export function scene(lib, opts = {}) {
  const { comps, systems, doc } = lib;
  const root = new THREE.Scene();
  const rigEl = entity('rig'); root.add(rigEl.object3D);
  const headEl = entity('head'); headEl.object3D.position.set(0, 1.6, 0); rigEl.object3D.add(headEl.object3D);
  const camera = new THREE.PerspectiveCamera(); headEl.object3D.add(camera);
  const hands = { left: new Hand('left', opts.scale || 1), right: new Hand('right', opts.scale || 1) };
  const groups = { '.interactable': [], '.grabbable': [], '.landable': [] };
  const handEls = {};

  let fillCalls = 0, poseCalls = 0;
  const batched = opts.batched !== false;
  let frame = null;
  const sources = ['left', 'right'].map((side) => ({
    handedness: side,
    hand: { get: (n) => ({ side, n }) },
    targetRaySpace: { side, ray: true },
  }));
  const makeFrame = () => {
    const cache = { left: hands.left.joints(), right: hands.right.joints() };
    const f = {
      getJointPose: (sp) => {
        poseCalls++;
        const J = cache[sp.side]; const j = J && J[sp.n];
        return j ? { transform: { position: j.p, orientation: j.q } } : null;
      },
      getPose: (sp) => {
        const J = cache[sp.side]; if (!J) return null;
        // platform ray: from the wrist, along the hand, 20° down
        const h = hands[sp.side];
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(h.pitch - D2R(20), h.yaw, 0, 'YXZ'));
        return { transform: { position: J.wrist.p, orientation: q } };
      },
    };
    if (batched) {
      // Like XRFrame.fillPoses: all joints in one call, all-or-nothing
      f.fillPoses = (spaces, ref, buf) => {
        fillCalls++;
        const m = new THREE.Matrix4();
        for (let i = 0; i < spaces.length; i++) {
          const J = cache[spaces[i].side]; const j = J && J[spaces[i].n];
          if (!j) return false;
          m.compose(j.p, j.q, new THREE.Vector3(1, 1, 1)).toArray(buf, i * 16);
        }
        return true;
      };
    }
    return f;
  };
  const sceneEl = {
    object3D: root, camera, systems: {}, time: 0, frame: null,
    renderer: { xr: { getReferenceSpace: () => ({}) } },
    xrSession: { inputSources: sources.filter((s) => hands[s.handedness].tracked) },
    is: () => true,
  };
  for (const [n, def] of Object.entries(systems)) {
    const s = Object.create(def); s.el = sceneEl; sceneEl.systems[n] = s;
  }
  for (const s of Object.values(sceneEl.systems)) if (s.init) s.init();

  doc._q = (sel) => sel === '#rig' ? rigEl : sel === '#head' ? headEl : null;
  doc._qa = (sel) => groups[sel] || [];

  function addHand(side, componentData) {
    const el = entity(side + 'Hand'); el.sceneEl = sceneEl; handEls[side] = el;
    for (const [name, data] of Object.entries(componentData)) {
      const def = comps[name]; if (!def) throw new Error('no component ' + name);
      const c = Object.create(def); c.el = el; c.system = sceneEl.systems[name];
      c.data = {}; for (const k in def.schema) c.data[k] = def.schema[k].default;
      Object.assign(c.data, { hand: side }, data);
      if (c.data.landingNormal && !c.data.landingNormal.x && c.data.landingNormal.x !== 0) c.data.landingNormal = { x: 0, y: 1, z: 0 };
      el.components[name] = c;
    }
    for (const c of Object.values(el.components)) c.init();
    return el;
  }

  function addObject(name, geo, pos, classes) {
    const el = entity(name, new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
    el.object3D.position.set(...pos); el.sceneEl = sceneEl;
    root.add(el.object3D); root.updateMatrixWorld(true);
    for (const c of classes) groups[c].push(el);
    return el;
  }

  let t = 0;
  const ORDER = ['hand-teleport', 'hand-thumb-tilt', 'hand-poke', 'hand-grab', 'hand-pointer'];
  function tick(n = 1, dt = 11) {
    for (let i = 0; i < n; i++) {
      sceneEl.xrSession.inputSources = sources.filter((s) => hands[s.handedness].tracked);
      sceneEl.frame = frame = makeFrame();
      sceneEl.time = t;
      for (const s of Object.values(sceneEl.systems)) if (s.tick) s.tick(t, dt);
      for (const el of Object.values(handEls)) {
        for (const name of ORDER) if (el.components[name]) el.components[name].tick(t, dt);
      }
      t += dt;
    }
  }
  const pinch = (side, on) => handEls[side].emit(on ? 'pinchstarted' : 'pinchended');
  const yawDeg = () => Math.round(THREE.MathUtils.radToDeg(rigEl.object3D.rotation.y));
  return { sceneEl, rigEl, headEl, hands, handEls, addHand, addObject, tick, pinch, yawDeg, groups,
    calls: () => ({ poseCalls, fillCalls }), resetCalls: () => { poseCalls = 0; fillCalls = 0; } };
}

// Smoothly change something over `ms`, ticking each frame
export function over(S, ms, fn) {
  const n = Math.max(1, Math.round(ms / 11));
  for (let i = 1; i <= n; i++) { fn(i / n); S.tick(1); }
}
