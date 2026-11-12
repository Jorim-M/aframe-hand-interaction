/*!
 * aframe-hand-interaction v2.6.0
 * Controller-free movement and interaction for WebXR hand
 * tracking in A-Frame 1.7+. Full documentation: README.md
 *
 * Quick start — the whole kit on your rig:
 *   <a-entity hand-interaction>
 *     <a-entity camera position="0 1.6 0" look-controls></a-entity>
 *   </a-entity>
 *   <a-plane class="landable" ...>     where you can teleport
 *   <a-box class="interactable" ...>   point at it / press it
 *   <a-box class="grabbable" ...>      pick it up
 *
 * Components:
 *   hand-interaction — on the rig: sets up both hands (below)
 *   hand-teleport    — pinch, aim the arc, release to teleport
 *   hand-thumb-tilt  — thumb tap switches turning on; thumbs-up
 *                      and tilt to snap-turn
 *   hand-pointer     — point, curl the finger to select (A-Frame
 *                      cursor events); pointer-draggable to drag
 *   hand-poke        — press things with your fingertip
 *   hand-grab        — open hand, close it around an object
 *   hand-joint       — attach any entity to a hand joint; palm-up
 *                      events for wrist menus
 *   hand-pose        — events for hand shapes you record
 *   push-button      — a button that travels with your fingertip
 *   hand-slider      — a slider knob you drag with a fingertip
 *   hand-tutorial    — on the scene: guided first-time walkthrough
 *   tutorial-mount   — where the tutorial panel shows for a step
 *
 * Pinching is only for teleport; grabbing uses the whole hand; a
 * thumb tap on a curled index (the turning switch) is never a
 * pinch. Hand-shape checks are relative to your palm, so they work
 * for any hand size.
 *
 * Author: Jorim M. Oduo (Beamport Story Labs)
 * License: MIT
 */
if (typeof AFRAME === 'undefined') {
  throw new Error('aframe-hand-interaction: AFRAME not found. Load A-Frame before this file.');
}

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════
// HAND INPUT — the one place that reads the tracked hands.
// Each hand's 25 joints are read once per frame, however many
// components ask, in rig-local space (.local) and, on request,
// world space (.world). Also provides:
//   palm            wrist → middle knuckle distance (m), smoothed;
//                   the unit for size-independent distances
//   straight(f)     finger straightness: 1 = straight, ~0.45 =
//                   curled into a fist ('thumb', 'index', 'middle',
//                   'ring', 'pinky'); null if joints are missing
//   ok(...names)    true if all those joints are tracked
//   jointQuatWorld(name, out)  a joint's world orientation (needs
//                   get(side, rigObj) this frame)
// ═══════════════════════════════════════════════════════════
const HAND_JOINTS = ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'];
['index', 'middle', 'ring', 'pinky'].forEach((f) => {
  HAND_JOINTS.push(f + '-finger-metacarpal', f + '-finger-phalanx-proximal',
    f + '-finger-phalanx-intermediate', f + '-finger-phalanx-distal', f + '-finger-tip');
});
const FINGER_CHAIN = { thumb: ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'] };
['index', 'middle', 'ring', 'pinky'].forEach((f) => {
  FINGER_CHAIN[f] = [f + '-finger-phalanx-proximal', f + '-finger-phalanx-intermediate',
    f + '-finger-phalanx-distal', f + '-finger-tip'];
});
const REFERENCE_PALM = 0.095; // m, a typical adult palm; used until a hand is measured
const HIGHLIGHT_COLOR = '#2b4f80'; // default hover/near tint (pointer, poke, grab)

AFRAME.registerSystem('hand-input', {
  init: function () {
    this.frameCount = 0;
    this.hands = { left: this.makeHand('left'), right: this.makeHand('right') };
    this._buf = new Float32Array(HAND_JOINTS.length * 16);
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._rigQuat = new THREE.Quaternion();
    this._seg = new THREE.Vector3();
    this._to = new THREE.Vector3();
    this._closest = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._one = new THREE.Vector3(1, 1, 1);
  },

  tick: function () { this.frameCount++; },

  makeHand: function (side) {
    const h = {
      side, source: null, spaces: null, tracked: false, frame: null, count: -1,
      has: {}, local: {}, world: {}, worldRig: null, worldCount: -1, worldFrame: null,
      wristQuat: new THREE.Quaternion(), wristQuatWorld: new THREE.Quaternion(),
      palm: REFERENCE_PALM, palmMeasured: false, _straight: {},
      mats: new Float32Array(HAND_JOINTS.length * 16), rigQuat: new THREE.Quaternion(),
    };
    HAND_JOINTS.forEach((n) => { h.local[n] = new THREE.Vector3(); h.world[n] = new THREE.Vector3(); });
    h.ok = (...names) => names.every((n) => h.has[n]);
    h.straight = (f) => this.straightness(h, f);
    h.jointQuatWorld = (name, out) => {
      const i = HAND_JOINTS.indexOf(name);
      if (i < 0 || !h.has[name]) return null;
      this._m.fromArray(h.mats, i * 16).decompose(this._p, out, this._s);
      return out.premultiply(h.rigQuat);
    };
    return h;
  },

  // The XRInputSource for a hand, or null
  source: function (side) {
    const session = this.el.xrSession;
    if (!this.el.frame || !session) return null;
    for (const s of session.inputSources) {
      if (s.hand && s.handedness === side) return s;
    }
    return null;
  },

  // This frame's data for a hand, or null if it isn't tracked. Pass
  // the rig's object3D to also get world-space positions.
  get: function (side, rigObj) {
    const h = this.hands[side];
    const frame = this.el.frame;
    if (!h || !frame) return null;
    if (h.frame !== frame || h.count !== this.frameCount) this.read(h, frame);
    if (!h.tracked) return null;
    if (rigObj && (h.worldRig !== rigObj || h.worldCount !== h.count || h.worldFrame !== frame)) {
      rigObj.updateMatrixWorld();
      for (const n of HAND_JOINTS) {
        if (h.has[n]) h.world[n].copy(h.local[n]).applyMatrix4(rigObj.matrixWorld);
      }
      rigObj.getWorldQuaternion(this._rigQuat);
      h.rigQuat.copy(this._rigQuat);
      h.wristQuatWorld.copy(h.wristQuat).premultiply(this._rigQuat);
      h.worldRig = rigObj; h.worldCount = h.count; h.worldFrame = frame;
    }
    return h;
  },

  read: function (h, frame) {
    h.frame = frame;
    h.count = this.frameCount;
    h.tracked = false;
    h._straight = {};
    h.worldRig = null;
    const source = this.source(h.side);
    if (source !== h.source) { h.source = source; h.spaces = null; }
    if (!source || !source.hand) { HAND_JOINTS.forEach((n) => { h.has[n] = false; }); return; }
    const refSpace = this.el.renderer.xr.getReferenceSpace();
    if (!h.spaces) h.spaces = HAND_JOINTS.map((n) => source.hand.get(n) || null);

    if (frame.fillPoses && h.spaces.every(Boolean)) {
      // One call for all 25 joints (all-or-nothing)
      const ok = frame.fillPoses(h.spaces, refSpace, this._buf);
      HAND_JOINTS.forEach((n, i) => {
        h.has[n] = ok;
        if (ok) h.local[n].set(this._buf[i * 16 + 12], this._buf[i * 16 + 13], this._buf[i * 16 + 14]);
      });
      if (ok) {
        h.mats.set(this._buf);
        this._m.fromArray(this._buf, 0); this._m.decompose(this._p, h.wristQuat, this._s);
      }
    } else {
      HAND_JOINTS.forEach((n, i) => {
        const space = h.spaces[i];
        const pose = space && frame.getJointPose(space, refSpace);
        h.has[n] = !!pose;
        if (!pose) return;
        const p = pose.transform.position, q = pose.transform.orientation;
        h.local[n].set(p.x, p.y, p.z);
        this._q.set(q.x, q.y, q.z, q.w);
        this._m.compose(h.local[n], this._q, this._one).toArray(h.mats, i * 16);
        if (i === 0) h.wristQuat.copy(this._q);
      });
    }
    if (!h.has.wrist) return;
    h.tracked = true;

    // Palm length: the size unit for hand-shape distances
    if (h.has['middle-finger-phalanx-proximal']) {
      const p = h.local.wrist.distanceTo(h.local['middle-finger-phalanx-proximal']);
      if (p > 0.05 && p < 0.16) {
        if (!h.palmMeasured) { h.palm = p; h.palmMeasured = true; }
        else h.palm += (p - h.palm) * 0.05;
      }
    }
  },

  // 1 = straight; drops toward ~0.45 as the finger curls into a fist
  straightness: function (h, f) {
    if (f in h._straight) return h._straight[f];
    const chain = FINGER_CHAIN[f];
    let result = null;
    if (chain && h.ok(...chain)) {
      const [a, b, c, d] = chain.map((n) => h.local[n]);
      const len = a.distanceTo(b) + b.distanceTo(c) + c.distanceTo(d);
      result = len > 0 ? a.distanceTo(d) / len : 1;
    }
    h._straight[f] = result;
    return result;
  },

  // Distance from a rig-local point to the side of the index finger
  // (knuckle → last joint): where the thumb lands in a thumb tap
  indexSideDistance: function (h, point) {
    const a = h.local['index-finger-phalanx-proximal'], b = h.local['index-finger-phalanx-distal'];
    this._seg.subVectors(b, a);
    this._to.subVectors(point, a);
    const len2 = this._seg.lengthSq();
    const t = len2 > 0 ? Math.min(1, Math.max(0, this._to.dot(this._seg) / len2)) : 0;
    this._closest.copy(a).addScaledVector(this._seg, t);
    return point.distanceTo(this._closest);
  },

  // A thumb tap on the side of a curled index (the turning switch),
  // as opposed to a real pinch: index curled AND the thumb nearer
  // the side of the index than its tip. A real pinch puts the thumb
  // at the index tip, so it never matches, however tight.
  isThumbTap: function (h) {
    if (!h || !h.ok('thumb-tip', 'index-finger-tip', 'index-finger-phalanx-proximal', 'index-finger-phalanx-distal')) return false;
    const idx = h.straight('index');
    if (idx === null || idx >= 0.7) return false;
    const thumb = h.local['thumb-tip'];
    return this.indexSideDistance(h, thumb) < thumb.distanceTo(h.local['index-finger-tip']);
  }
});

// ═══════════════════════════════════════════════════════════
// PINCH — decides, once per pinch, what it's for. Components that
// use pinches register their hand here and implement wantsPinch() /
// pinchStart() / pinchEnd(). In order:
//   1. a thumb tap on a curled index → nothing (it's the turning switch)
//   2. hand-teleport (which declines while the hand is at or
//      holding a grabbable)
// Emits 'pinchdecision' on the hand ({ owner, reason }).
// ═══════════════════════════════════════════════════════════
const PINCH_PRIORITY = ['hand-teleport'];

AFRAME.registerSystem('hand-pinch', {
  init: function () { this.hands = new Map(); },

  register: function (handEl, side) {
    if (this.hands.has(handEl)) return;
    const st = { side, owner: null };
    st.onStart = () => this.start(handEl, st);
    st.onEnd = () => this.end(st);
    handEl.addEventListener('pinchstarted', st.onStart);
    handEl.addEventListener('pinchended', st.onEnd);
    this.hands.set(handEl, st);
  },

  start: function (handEl, st) {
    if (st.owner) return;
    const input = this.el.systems['hand-input'];
    if (input && input.isThumbTap(input.get(st.side))) {
      handEl.emit('pinchdecision', { owner: null, reason: 'thumb tap' });
      return;
    }
    for (const name of PINCH_PRIORITY) {
      const c = handEl.components[name];
      if (c && c.wantsPinch()) {
        st.owner = c;
        c.pinchStart();
        handEl.emit('pinchdecision', { owner: name, reason: '' });
        return;
      }
    }
    handEl.emit('pinchdecision', { owner: null, reason: 'nothing wants it' });
  },

  end: function (st) {
    const o = st.owner;
    st.owner = null;
    if (o) o.pinchEnd();
  }
});

// ═══════════════════════════════════════════════════════════
// HIGHLIGHT — shared emissive tint for hovered / touched objects.
// Counts requests per material, so two hands (or pointer + poke)
// on the same object never leave it stuck tinted.
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-highlight', {
  init: function () {
    this.saved = new Map(); // material → { orig: Color, count }
    this._tint = new THREE.Color();
  },

  set: function (el, color, on) {
    if (!el || !el.object3D) return;
    if (on) this._tint.set(color);
    el.object3D.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m.emissive) continue; // e.g. unlit materials: no highlight
        let s = this.saved.get(m);
        if (on) {
          if (!s) { s = { orig: m.emissive.clone(), count: 0 }; this.saved.set(m, s); }
          s.count++;
          m.emissive.copy(s.orig).add(this._tint);
        } else if (s) {
          s.count--;
          if (s.count <= 0) { m.emissive.copy(s.orig); this.saved.delete(m); }
        }
      }
    });
  }
});

// ═══════════════════════════════════════════════════════════
// HAND TELEPORT — pinch and hold to aim, release to teleport.
// While pinching, the aim comes from the input source's
// targetRaySpace: the platform-native pointing ray (the same
// one Quest uses for its system UI), which stays stable while
// the fingers are pinched.
// The ray is a ballistic arc — p(t) = origin + v·t + ½g·t² —
// like classic controller teleport, so no downward-pointing is
// required: aim anywhere and the parabola finds the ground.
// Poses are in XR reference space == rig-local space, so they
// are transformed by the rig's world matrix before simulating
// the arc. The system tracks which hand owns the arc, so only
// one hand aims at a time.
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-teleport', {
  init: function () {
    this.activeHand = null;
  }
});

AFRAME.registerComponent('hand-teleport', {
  schema: {
    hand: { default: 'right' },
    curveShootingSpeed: { default: 7.5 }, // arc launch speed (m/s) — controls range
    gravity: { default: -9.8 },
    // blink-controls-style additions:
    cameraRig: { default: '#rig' },      // rig element moved on teleport
    hitColor: { type: 'color', default: '#4d93fd' },
    missColor: { type: 'color', default: '#e86a6a' },
    planeRadius: { default: 0 },         // plane-fallback landing boundary (0 = unlimited)
    collisionEntities: { default: '' },  // selector for landable meshes; empty = flat y=0 plane
    blockEntities: { default: '' },      // selector for meshes that stop the arc and can't be landed on (water, walls)
    teleportOrigin: { default: '#head' },// land THIS on the target (the camera, not the rig origin)
    landingNormal: { type: 'vec3', default: { x: 0, y: 1, z: 0 } },
    landingMaxAngle: { default: 45 },    // reject slopes steeper than this (degrees)
    rayFloor: { default: -20 },          // arc simulation horizon below y=0 (for valleys)
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    const sceneObj = this.el.sceneEl.object3D;

    // Ballistic arc rendered as a camera-facing ribbon, tapering
    // toward the tip like the classic teleport curve. Geometry is
    // pre-allocated once; positions update in place each tick.
    // Sample count along the arc — more points = smoother arch.
    // 64 is plenty since every point lies on the visible curve.
    this.numPoints = 64;
    this.arcPoints = [];
    for (let i = 0; i < this.numPoints; i++) this.arcPoints.push(new THREE.Vector3());

    const arcGeo = new THREE.BufferGeometry();
    this.arcPositions = new Float32Array(this.numPoints * 2 * 3);
    arcGeo.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    const arcIndices = [];
    for (let i = 0; i < this.numPoints - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      arcIndices.push(a, b, c, b, d, c);
    }
    arcGeo.setIndex(arcIndices);
    this.arcMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, fog: false, // feedback never fades into scene fog
    });
    this.arc = new THREE.Mesh(arcGeo, this.arcMat);
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    sceneObj.add(this.arc);

    // Target ring marker, flat on the ground
    const ringGeo = new THREE.RingGeometry(0.14, 0.2, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.visible = false;
    sceneObj.add(this.ring);

    // Halo: a vertical light pillar rising from the ring, so the
    // target reads from any viewing angle — a flat ring seen
    // edge-on (e.g. aiming at an elevated platform) all but
    // disappears. Additive-blended cylinder with a vertical
    // gradient fading to nothing at the top.
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = 1; haloCanvas.height = 64;
    const hctx = haloCanvas.getContext('2d');
    const hgrad = hctx.createLinearGradient(0, 64, 0, 0);
    hgrad.addColorStop(0.0, 'rgba(255,255,255,0.85)');
    hgrad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    hgrad.addColorStop(1.0, 'rgba(255,255,255,0)');
    hctx.fillStyle = hgrad;
    hctx.fillRect(0, 0, 1, 64);
    const haloTex = new THREE.CanvasTexture(haloCanvas);

    const haloGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.55, 24, 1, true);
    haloGeo.translate(0, 0.275, 0); // pivot at the base, on the ring
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd,
      map: haloTex,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.Mesh(haloGeo, this.haloMat);
    this.halo.visible = false;
    sceneObj.add(this.halo);

    this.target = new THREE.Vector3();
    this.hasValidTarget = false;
    this.pinching = false;

    // Scratch vectors
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._camPos = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    this._side = new THREE.Vector3();

    // Collision + arrival (blink-controls-style)
    this.originEl = document.querySelector(this.data.teleportOrigin) || this.rigEl;
    this.raycaster = new THREE.Raycaster();
    this.collisionMeshes = [];
    this.castMeshes = [];                // landable + blocking, raycast together
    this.blockMeshes = new Set();
    this.hitFound = false;
    this._landingNormal = new THREE.Vector3(
      this.data.landingNormal.x, this.data.landingNormal.y, this.data.landingNormal.z
    ).normalize();
    this._hitNormal = new THREE.Vector3(0, 1, 0);
    this._normalMatrix = new THREE.Matrix3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._segStart = new THREE.Vector3();
    this._segEnd = new THREE.Vector3();
    this._segDir = new THREE.Vector3();
    this._originPos = new THREE.Vector3();

    // Pinches come from the shared arbiter (hand-pinch), which drops
    // thumb taps and asks wantsPinch() below
    this.el.sceneEl.systems['hand-pinch'].register(this.el, this.data.hand);
  },

  // ── Pinch arbiter interface ──
  // Not while the other hand is aiming, or while this hand is
  // pointing (a trigger pull can look like a pinch)
  wantsPinch: function () {
    if (this.system.activeHand && this.system.activeHand !== this) return false;
    const ptr = this.el.components['hand-pointer'];
    if (ptr && ptr.pState !== 'idle') return false;
    // Hand at something it could grab, or holding it: not a teleport
    const grab = this.el.components['hand-grab'];
    if (grab && (grab.heldEl || grab.near)) return false;
    return true;
  },

  pinchStart: function () {
    this.system.activeHand = this;
    this.pinching = true;
    this.refreshCollisionMeshes();
  },

  // Release = teleport, if the arc found somewhere to land
  pinchEnd: function () {
    if (!this.pinching) return;
    this.pinching = false;
    if (this.system.activeHand === this) this.system.activeHand = null;
    if (this.hasValidTarget) {
      // teleportOrigin: land the CAMERA on the target, not the rig
      // origin — if you've physically walked away from the rig
      // center, you still arrive exactly where you aimed.
      const target = this.target.clone();
      const rigPos = this.rigEl.object3D.position;
      const oldPosition = rigPos.clone();
      this.originEl.object3D.getWorldPosition(this._originPos);
      rigPos.x += target.x - this._originPos.x;
      rigPos.z += target.z - this._originPos.z;
      rigPos.y = target.y; // rig floor onto the landing height
      this.el.emit('teleported', {
        oldPosition: oldPosition,
        newPosition: rigPos.clone(),
        hitPoint: target,
        hand: this.data.hand,
      });
    }
    this.hide();
  },

  // Gather landable meshes from the collisionEntities selector.
  // InstancedMesh children (grass, flowers) are skipped — you land
  // on terrain, not on a blade of grass.
  // blockEntities meshes are raycast too: a hit on one ends the arc
  // there and is never a valid landing.
  refreshCollisionMeshes: function () {
    this.collisionMeshes.length = 0;
    this.castMeshes.length = 0;
    this.blockMeshes.clear();
    const gather = (selector, fn) => {
      if (!selector) return;
      for (const el of document.querySelectorAll(selector)) {
        if (!el.object3D) continue;
        el.object3D.traverse((obj) => { if (obj.isMesh && !obj.isInstancedMesh) fn(obj); });
      }
    };
    gather(this.data.blockEntities, (m) => this.blockMeshes.add(m));
    gather(this.data.collisionEntities, (m) => { if (!this.blockMeshes.has(m)) this.collisionMeshes.push(m); });
    if (!this.collisionMeshes.length) return; // plane fallback: blockers need landable meshes
    this.castMeshes.push(...this.collisionMeshes, ...this.blockMeshes);
  },

  hide: function () {
    this.arc.visible = false;
    this.ring.visible = false;
    this.halo.visible = false;
    this.hasValidTarget = false;
  },

  // Called when tracking is lost mid-pinch: releases the aim and
  // frees the shared lock so the other hand isn't locked out.
  cancelPinch: function () {
    this.pinching = false;
    if (this.system.activeHand === this) this.system.activeHand = null;
    this.hide();
  },

  tick: function () {
    if (!this.pinching) { this.hide(); return; }

    const sceneEl = this.el.sceneEl;
    const frame = sceneEl.frame;
    const session = sceneEl.xrSession;
    if (!frame || !session) { this.cancelPinch(); return; }

    const source = sceneEl.systems['hand-input'].source(this.data.hand);
    // Source gone = hand tracking lost — cancel rather than hold the lock
    if (!source || !source.targetRaySpace) { this.cancelPinch(); return; }

    const refSpace = sceneEl.renderer.xr.getReferenceSpace();
    const rayPose = frame.getPose(source.targetRaySpace, refSpace);
    if (!rayPose) { this.hide(); return; }

    // Pose is rig-local: bring it into world space
    const rigObj = this.rigEl.object3D;
    rigObj.updateMatrixWorld();

    this._origin.set(
      rayPose.transform.position.x,
      rayPose.transform.position.y,
      rayPose.transform.position.z
    ).applyMatrix4(rigObj.matrixWorld);

    // Ray direction = -Z of the target-ray pose orientation
    this._quat.set(
      rayPose.transform.orientation.x,
      rayPose.transform.orientation.y,
      rayPose.transform.orientation.z,
      rayPose.transform.orientation.w
    );
    this._dir.set(0, 0, -1)
      .applyQuaternion(this._quat)
      .transformDirection(rigObj.matrixWorld);

    // Ballistic arc, two-pass:
    // PASS 1 (collision): march the parabola in coarse segments and
    // raycast each against the collision meshes to find the hit time.
    // With no collisionEntities, fall back to the closed-form flat
    // ground plane (y = 0) hit.
    // PASS 2 (rendering): redistribute all N points evenly over
    // [0, tHit] — every point lies on the visible curve, which is
    // what keeps the arch smooth instead of polygonal.
    const speed = this.data.curveShootingSpeed;
    const gravity = this.data.gravity;
    const N = this.numPoints;

    const vy = this._dir.y * speed;
    const y0 = this._origin.y;
    const useMeshes = this.collisionMeshes.length > 0;
    // Simulation horizon: flight time down to the floor plane
    // (y=0 without meshes; a deep rayFloor with them, so the arc
    // can descend into valleys below y=0)
    const floorY = useMeshes ? this.data.rayFloor : 0;
    const tEnd = (-vy - Math.sqrt(vy * vy - 2 * gravity * (y0 - floorY))) / gravity;
    // Hand below the simulated floor: no arc can land
    if (!(tEnd > 0)) { this.hide(); return; }

    const parab = (t, out) => out.set(
      this._origin.x + this._dir.x * speed * t,
      this._origin.y + vy * t + 0.5 * gravity * t * t,
      this._origin.z + this._dir.z * speed * t
    );

    let tHit = tEnd;
    this.hitFound = !useMeshes; // plane fallback always lands at y=0
    let blocked = false;
    this._hitNormal.copy(this._up);

    if (useMeshes) {
      const SEGMENTS = 24;
      parab(0, this._segStart);
      for (let s = 1; s <= SEGMENTS; s++) {
        parab((s / SEGMENTS) * tEnd, this._segEnd);
        this._segDir.subVectors(this._segEnd, this._segStart);
        const segLen = this._segDir.length();
        if (segLen > 1e-6) {
          this._segDir.multiplyScalar(1 / segLen);
          this.raycaster.set(this._segStart, this._segDir);
          this.raycaster.near = 0;
          this.raycaster.far = segLen;
          const hits = this.raycaster.intersectObjects(this.castMeshes, false);
          if (hits.length) {
            const hit = hits[0];
            tHit = ((s - 1) + hit.distance / segLen) / SEGMENTS * tEnd;
            this.hitFound = true;
            blocked = this.blockMeshes.has(hit.object);
            if (hit.face) {
              this._normalMatrix.getNormalMatrix(hit.object.matrixWorld);
              this._hitNormal.copy(hit.face.normal)
                .applyMatrix3(this._normalMatrix).normalize();
            } else {
              this._hitNormal.copy(this._up);
            }
            break;
          }
        }
        this._segStart.copy(this._segEnd);
      }
    }

    // PASS 2: even resampling over the actual flight
    for (let i = 0; i < N; i++) {
      parab((i / (N - 1)) * tHit, this.arcPoints[i]);
    }
    if (!useMeshes) this.arcPoints[N - 1].y = 0; // land exactly on the plane

    this.target.copy(this.arcPoints[N - 1]);

    // Validity: must have hit something, and the landing surface
    // must not be steeper than landingMaxAngle
    let valid = this.hitFound && !blocked;
    if (valid && useMeshes) {
      const slope = THREE.MathUtils.radToDeg(this._hitNormal.angleTo(this._landingNormal));
      valid = slope <= this.data.landingMaxAngle;
    }
    if (valid && !useMeshes && this.data.planeRadius > 0) {
      // optional circular boundary for the flat-plane fallback
      const distFromCenter = Math.sqrt(
        this.target.x * this.target.x + this.target.z * this.target.z
      );
      valid = distFromCenter < this.data.planeRadius;
    }
    this.hasValidTarget = valid;

    const color = valid ? this.data.hitColor : this.data.missColor;
    this.arcMat.color.set(color);
    this.ringMat.color.set(color);
    this.haloMat.color.set(color);

    // Build the camera-facing ribbon: at each arc point, offset two
    // vertices sideways along cross(tangent, toCamera), tapering
    // from thick at the hand to a point at the target.
    sceneEl.camera.getWorldPosition(this._camPos);
    for (let i = 0; i < N; i++) {
      const p = this.arcPoints[i];
      const next = this.arcPoints[Math.min(i + 1, N - 1)];
      const prev = this.arcPoints[Math.max(i - 1, 0)];
      this._tangent.subVectors(next, prev);
      this._toCam.subVectors(this._camPos, p);
      this._side.crossVectors(this._tangent, this._toCam);
      const len = this._side.length();
      if (len > 1e-6) { this._side.multiplyScalar(1 / len); }
      else { this._side.set(0, 1, 0); }

      const k = i / (N - 1);
      const halfWidth = 0.028 * (1 - k) + 0.004;

      this.arcPositions[i * 6]     = p.x + this._side.x * halfWidth;
      this.arcPositions[i * 6 + 1] = p.y + this._side.y * halfWidth;
      this.arcPositions[i * 6 + 2] = p.z + this._side.z * halfWidth;
      this.arcPositions[i * 6 + 3] = p.x - this._side.x * halfWidth;
      this.arcPositions[i * 6 + 4] = p.y - this._side.y * halfWidth;
      this.arcPositions[i * 6 + 5] = p.z - this._side.z * halfWidth;
    }
    this.arc.geometry.attributes.position.needsUpdate = true;
    this.arc.visible = true;

    // Ring at the target, oriented to the landing surface (flat on
    // ground, tilted on slopes). Hidden entirely on a total miss —
    // the red arc alone signals "nothing to land on there".
    if (this.hitFound) {
      this.ring.position.copy(this.target).addScaledVector(this._hitNormal, 0.02);
      this.ring.quaternion.setFromUnitVectors(this._up, this._hitNormal);
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08;
      this.ring.scale.set(pulse, 1, pulse);
      this.ring.visible = true;
      // Halo rises from the ring along the surface normal, with a
      // slow breathing motion on its height
      this.halo.position.copy(this.ring.position);
      this.halo.quaternion.copy(this.ring.quaternion);
      this.halo.scale.set(pulse, 1 + Math.sin(performance.now() * 0.004) * 0.12, pulse);
      this.halo.visible = true;
    } else {
      this.ring.visible = false;
      this.halo.visible = false;
    }
  },

  remove: function () {
    this.cancelPinch();
    const sceneObj = this.el.sceneEl.object3D;
    sceneObj.remove(this.arc);
    sceneObj.remove(this.ring);
    sceneObj.remove(this.halo);
  }
});

// ═══════════════════════════════════════════════════════════
// HAND THUMBS-UP TILT SNAP-TURN — make a thumbs-up, then tilt
// the thumb left or right past ~35° to snap the view 45° in
// that direction. Return the thumb toward vertical to re-arm.
// Either hand does both directions — the thumb is a joystick.
//
// Built from STATIC quantities (a pose + an orientation), not
// motion, so tracking jitter cannot accumulate into phantom
// snaps the way it can with a swipe detector:
// 1. Pose check: thumb extended (tip far from its base, relative
//    to palm length) AND index + middle curled. This
//    configuration is distinctive — relaxed idle hands, points,
//    and pinches all fail it.
// 2. Tilt: the thumb direction projected onto the head's
//    horizontal right vector vs world up, as a signed angle
//    from vertical. Head-relative, so "left" is YOUR left.
// 3. Hysteresis + hold: fires only after the tilt zone is held
//    ~120ms (debounces single-frame misreads), and re-arms only
//    once the thumb returns within the neutral cone.
// 4. Thumbs-DOWN guard: if the thumb points below horizontal,
//    the tilt sign becomes meaningless — ignored entirely.
// ═══════════════════════════════════════════════════════════
// Which hand turns: only one at a time. A tap on a hand makes it
// the turning hand (and switches the other off); a tap on the
// turning hand switches turning off.
AFRAME.registerSystem('hand-thumb-tilt', {
  init: function () {
    this.activeHand = undefined; // 'left' | 'right' | null, set from startHand
    this.lastToggle = -1e9;
  }
});

AFRAME.registerComponent('hand-thumb-tilt', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    head: { default: '#head' },
    angle: { default: 45 },
    tiltOn: { default: 35 },             // degrees from vertical to trigger
    tiltOff: { default: 20 },            // neutral cone for re-arming
    // Tilt is measured from the hand's own resting thumb angle,
    // sampled when the thumbs-up starts (clamped to ±neutralMax),
    // so a thumb that naturally leans doesn't sit near a trigger
    adaptNeutral: { default: true },
    neutralMax: { default: 20 },         // degrees
    neutralSampleMs: { default: 100 },
    poseGraceMs: { default: 150 },       // brief tracking dropouts are ignored
    holdMs: { default: 120 },            // tilt must be sustained this long
    cooldown: { default: 300 },          // ms between snaps
    // Hand-shape checks are relative, so they work for any hand size
    fingerCurled: { default: 0.7 },      // index/middle straightness below this = curled
    thumbExtended: { default: 0.58 },    // thumb tip to thumb base, in palm lengths
    showIndicator: { default: true },     // tilt indicator above the thumb
    indicatorColor: { type: 'color', default: '#ffffff' },
    indicatorOffset: { default: 0.05 },   // height above the thumb tip (m)
    // Thumb-tap toggle: tap the thumb on the middle of the curled
    // index finger to make this the turning hand, or to switch off
    toggleTap: { default: true },
    startHand: { default: 'none', oneOf: ['none', 'left', 'right'] },
    tapContact: { default: 0.32 },        // thumb tip to index side: touching (palm lengths)
    tapRelease: { default: 0.42 },        // ...clearly apart, re-arms the tap (palm lengths)
    tapApproachMs: { default: 150 },      // window for measuring the approach (ms)
    tapTravel: { default: 0.16 },         // thumb must close this much within the window (palm lengths)
    // The fist must already be closed this long before a tap counts.
    // A hand-pointer trigger pull curls the index onto the thumb, which
    // looks like a tap; but there the fist has only just closed.
    tapFistMs: { default: 200 },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.headEl = document.querySelector(this.data.head);
    this.armed = true;
    this.lastSnap = -1e9;
    this.zoneCandidate = 0;   // -1 left, 0 neutral, +1 right
    this.zoneSince = 0;
    this._headPos = new THREE.Vector3();
    this._wrist = new THREE.Vector3();
    this._thumbTip = new THREE.Vector3();
    this._thumbMeta = new THREE.Vector3();
    this._idxTip = new THREE.Vector3();
    this._midTip = new THREE.Vector3();
    this._thumbDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.lastPoseTime = -1e9;
    this.neutral = 0;
    this.neutralReady = false;
    this.neutralSum = 0;
    this.neutralN = 0;
    this.poseStart = 0;
    this.relTilt = 0;

    if (this.system.activeHand === undefined) {
      this.system.activeHand = this.data.startHand === 'none' ? null : this.data.startHand;
    }
    this.fistSince = null;   // when index + middle became curled
    this.tapArmed = false;   // thumb must be apart from the finger first
    this.tapHist = [];       // recent [time, distance] samples
    this._toggleTime = -1e9;
    this._idxProx = new THREE.Vector3();
    this._idxDist = new THREE.Vector3();
    this._seg = new THREE.Vector3();
    this._toThumb = new THREE.Vector3();
    this._closest = new THREE.Vector3();

    // Indicator state, written by detect() each frame
    this._vis = false;
    this._tiltDeg = 0;
    this._alpha = 0;
    this._flashSide = 0;
    this._flashTime = -1e9;
    this._indPos = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    if (this.data.showIndicator) this.buildIndicator();
  },

  // Indicator: a centre dot, a track on each side that fills as
  // the thumb tilts toward the trigger angle, and an arrowhead
  // that brightens at the threshold and flashes on a snap. Drawn
  // on top of the hand (no depth test) and turned to face the
  // camera, so its +X is always the viewer's right.
  buildIndicator: function () {
    const color = new THREE.Color(this.data.indicatorColor);
    const mat = () => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });

    const group = new THREE.Group();
    group.renderOrder = 999;
    group.visible = false;

    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 16), mat());
    group.add(dot);

    const barGeo = new THREE.PlaneGeometry(0.03, 0.003);
    barGeo.translate(0.015, 0, 0); // pivot at the inner end
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.007);
    arrowShape.lineTo(0.01, 0);
    arrowShape.lineTo(0, -0.007);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);

    const sides = {};
    for (const s of [-1, 1]) {
      const track = new THREE.Mesh(barGeo, mat());
      track.position.x = s * 0.009;
      track.scale.x = s;
      const fill = new THREE.Mesh(barGeo, mat());
      fill.position.x = s * 0.009;
      const arrow = new THREE.Mesh(arrowGeo, mat());
      arrow.position.x = s * 0.042;
      arrow.scale.x = s;
      group.add(track, fill, arrow);
      sides[s] = { track, fill, arrow };
    }
    group.traverse((o) => { o.renderOrder = 999; });

    this.indicator = { group, dot, sides };
    this.el.sceneEl.object3D.add(group);
  },

  updateIndicator: function (time, dt) {
    const ind = this.indicator;
    if (!ind) return;

    // Fade in/out (~60ms time constant)
    const k = 1 - Math.exp(-(dt || 16) / 60);
    this._alpha += ((this._vis ? 1 : 0) - this._alpha) * k;
    if (this._alpha < 0.01) { ind.group.visible = false; return; }
    ind.group.visible = true;

    // Above the thumb tip, facing the camera
    ind.group.position.copy(this._indPos);
    ind.group.position.y += this.data.indicatorOffset;
    this.el.sceneEl.camera.getWorldPosition(this._camPos);
    ind.group.lookAt(this._camPos);

    const a = this._alpha;
    const on = this.isActive();
    // Off: only a dim dot. On: dim until re-armed after a snap.
    const base = on ? (this.armed ? 1 : 0.35) : 0;
    const tilt = this._tiltDeg;
    const flash = Math.max(0, 1 - (time - this._flashTime) / 300);
    const toggled = Math.max(0, 1 - (time - this._toggleTime) / 600);

    // Dot pulses on every toggle; stays dim while turning is off
    ind.dot.material.opacity = Math.max(a * (on ? 0.9 * base : 0.3), a * toggled);
    ind.dot.scale.setScalar(1 + 1.5 * toggled);

    for (const s of [-1, 1]) {
      const p = (on && this.armed && Math.sign(tilt) === s)
        ? Math.min(1, Math.abs(tilt) / this.data.tiltOn) : 0;
      const parts = ind.sides[s];
      parts.track.material.opacity = a * 0.3 * base;
      parts.fill.visible = p > 0.02;
      parts.fill.scale.x = s * p;
      parts.fill.material.opacity = a * 0.95;
      // Both arrows flash when turning switches on
      const f = Math.max(this._flashSide === s ? flash : 0, on ? toggled : 0);
      parts.arrow.material.opacity =
        Math.max(a * (0.35 + 0.65 * p) * base, a * f);
      const sc = 1 + 0.5 * f;
      parts.arrow.scale.set(s * sc, sc, 1);
    }
  },

  remove: function () {
    if (this.indicator) this.el.sceneEl.object3D.remove(this.indicator.group);
  },

  reset: function () {
    this.zoneCandidate = 0;
    this.armed = true;
  },

  // Pose not measurable this frame. Within poseGraceMs it's treated
  // as a tracking blip and the tilt state (hold timer, arming) is
  // kept; after that the next thumbs-up starts fresh.
  poseDropped: function (time) {
    if (time - this.lastPoseTime > this.data.poseGraceMs) this.zoneCandidate = 0;
  },

  isActive: function () {
    return this.system.activeHand === this.data.hand;
  },

  tick: function (time, dt) {
    this._vis = false;
    this.detect(time);
    // Show toggle feedback even though the tap hand isn't a thumbs-up
    if (time - this._toggleTime < 600) this._vis = true;
    if (this.indicator) this.updateIndicator(time, dt);
  },

  // Tap = the thumb lands on the side of the curled index with a
  // quick movement: it must have closed at least tapTravel within
  // the last tapApproachMs. It fires on contact, so feedback is
  // immediate and the thumb doesn't have to lift. A thumb drifting
  // slowly onto the finger (a rest) is too slow to count, and after
  // a tap the thumb must move apart again before the next one.
  detectTap: function (time, h, input, fist) {
    const palm = h.palm;
    const thumbTip = h.local['thumb-tip'];
    const d = input.indexSideDistance(h, thumbTip);
    const hist = this.tapHist;
    hist.push([time, d]);
    while (hist.length && time - hist[0][0] > this.data.tapApproachMs) hist.shift();

    if (d > this.data.tapRelease * palm) { this.tapArmed = true; return; }
    if (!this.tapArmed || d > this.data.tapContact * palm || !fist) return;
    // Fist only just closed (e.g. a hand-pointer trigger pull): not a tap
    if (this.fistSince === null || time - this.fistSince < this.data.tapFistMs) return;
    // Nearer the fingertip than the side of the finger: a pinch
    if (thumbTip.distanceTo(h.local['index-finger-tip']) < d) return;
    // Too slow: a rest, not a tap. Needs to move apart and try again.
    let maxD = d;
    for (const s of hist) if (s[1] > maxD) maxD = s[1];
    if (maxD - d < this.data.tapTravel * palm) { this.tapArmed = false; return; }
    if (time - this.system.lastToggle < 300) return;

    this.tapArmed = false;
    this.system.activeHand = this.isActive() ? null : this.data.hand;
    this.system.lastToggle = time;
    this._toggleTime = time;
    this.reset();
    this._indPos.copy(h.world['thumb-tip']);
    this.el.emit('thumbtilttoggle', {
      enabled: this.isActive(),
      hand: this.data.hand,
      activeHand: this.system.activeHand,
    });
  },

  detect: function (time) {
    const sceneEl = this.el.sceneEl;
    if (!sceneEl.frame || !sceneEl.xrSession) { this.reset(); return; }

    // Never turn with the hand that owns the teleport arc
    const tp = sceneEl.systems['hand-teleport'];
    if (tp && tp.activeHand && tp.activeHand.data.hand === this.data.hand) {
      this.reset();
      return;
    }

    const input = sceneEl.systems['hand-input'];
    const h = input.get(this.data.hand, this.rigEl.object3D);
    // Joints missing this frame: a tracking blip unless it lasts
    if (!h || !h.ok('thumb-tip', 'thumb-metacarpal', 'index-finger-tip',
      'index-finger-phalanx-proximal', 'index-finger-phalanx-distal')) { this.poseDropped(time); return; }
    const idxS = h.straight('index'), midS = h.straight('middle');
    if (idxS === null || midS === null) { this.poseDropped(time); return; }

    const indexCurled = idxS < this.data.fingerCurled;
    const middleCurled = midS < this.data.fingerCurled;
    if (indexCurled && middleCurled) { if (this.fistSince === null) this.fistSince = time; }
    else this.fistSince = null;

    // This hand is using hand-pointer, or holding something (a grip
    // is a fist too): no taps or tilts
    const ptr = this.el.components['hand-pointer'];
    const grabC = this.el.components['hand-grab'];
    if ((ptr && ptr.isPointing()) || (grabC && grabC.heldEl)) { this.poseDropped(time); this.tapArmed = false; return; }

    // ── Thumb-tap toggle ──
    if (this.data.toggleTap) this.detectTap(time, h, input, indexCurled && middleCurled);

    // ── Pose check: is this a thumbs-up? ──
    const thumbTip = h.local['thumb-tip'], thumbMeta = h.local['thumb-metacarpal'];
    const thumbExtended = thumbTip.distanceTo(thumbMeta) > this.data.thumbExtended * h.palm;
    if (!(thumbExtended && indexCurled && middleCurled)) { this.poseDropped(time); return; }

    // ── Tilt: signed angle of the thumb from vertical, along
    //    the head's horizontal right axis ──
    this._thumbDir.subVectors(thumbTip, thumbMeta).normalize();

    // Thumbs-down guard: below horizontal, left/right is meaningless
    if (this._thumbDir.y < -0.15) { this.poseDropped(time); return; }

    this._right.set(1, 0, 0).applyQuaternion(this.headEl.object3D.quaternion);
    this._right.y = 0;
    this._right.normalize();

    const lateral = this._thumbDir.dot(this._right);

    // Thumb pointing mostly forward/back (e.g. on its way to a tap):
    // the left/right angle is unreliable, so ignore it
    if (Math.hypot(lateral, this._thumbDir.y) < 0.5) { this.poseDropped(time); return; }

    const absTilt = THREE.MathUtils.radToDeg(Math.atan2(lateral, this._thumbDir.y));

    // A new thumbs-up (after a real absence): re-arm and re-sample
    // this hand's neutral angle
    if (time - this.lastPoseTime > this.data.poseGraceMs) {
      this.armed = true;
      this.zoneCandidate = 0;
      this.neutralReady = !this.data.adaptNeutral;
      this.neutral = 0;
      this.neutralSum = 0;
      this.neutralN = 0;
      this.poseStart = time;
    }
    this.lastPoseTime = time;

    if (!this.neutralReady) {
      // Learn the resting angle only from a roughly upright thumb. A
      // thumb still swinging in from the side (e.g. straight after a
      // tap) would otherwise set neutral far off and skew both sides.
      if (Math.abs(absTilt) > this.data.neutralMax * 1.5) {
        this.neutralSum = 0;
        this.neutralN = 0;
        this.poseStart = time;
        this._vis = true;
        this._tiltDeg = 0;
        this._indPos.copy(h.world['thumb-tip']);
        return;
      }
      this.neutralSum += absTilt;
      this.neutralN++;
      const m = this.data.neutralMax;
      this.neutral = Math.max(-m, Math.min(m, this.neutralSum / this.neutralN));
      if (time - this.poseStart >= this.data.neutralSampleMs) this.neutralReady = true;
    }
    const tiltDeg = absTilt - this.neutral;
    this.relTilt = tiltDeg;

    // Indicator follows the thumb tip
    this._vis = true;
    this._tiltDeg = this.neutralReady ? tiltDeg : 0;
    this._indPos.copy(h.world['thumb-tip']);

    // Not the turning hand: indicator shows the off state, no snaps
    if (!this.isActive()) { this.zoneCandidate = 0; this.armed = true; return; }
    if (!this.neutralReady) return;

    // ── Hysteresis state machine ──
    const zone = tiltDeg > this.data.tiltOn ? 1
               : tiltDeg < -this.data.tiltOn ? -1
               : 0;

    // Re-arm only inside the neutral cone
    if (!this.armed) {
      if (Math.abs(tiltDeg) < this.data.tiltOff) this.armed = true;
      this.zoneCandidate = 0;
      return;
    }

    if (zone === 0) { this.zoneCandidate = 0; return; }

    // Debounce: the tilt zone must be held for holdMs
    if (this.zoneCandidate !== zone) {
      this.zoneCandidate = zone;
      this.zoneSince = time;
      return;
    }
    if (time - this.zoneSince < this.data.holdMs) return;
    if (time - this.lastSnap < this.data.cooldown) return;

    // Tilt right = turn right (−yaw); tilt left = turn left (+yaw)
    this._flashSide = zone;
    this._flashTime = time;
    this.snap(zone > 0 ? -1 : 1);
    this.lastSnap = time;
    this.armed = false;
    this.zoneCandidate = 0;
  },

  snap: function (dirSign) {
    const rig = this.rigEl.object3D;
    const a = THREE.MathUtils.degToRad(this.data.angle) * dirSign;

    // Pivot the rotation on the head's world XZ position:
    // compensate rig position so the head stays fixed in space
    this.headEl.object3D.getWorldPosition(this._headPos);
    const ox = this._headPos.x - rig.position.x;
    const oz = this._headPos.z - rig.position.z;
    const c = Math.cos(a), s = Math.sin(a);
    rig.position.x = this._headPos.x - (c * ox + s * oz);
    rig.position.z = this._headPos.z - (-s * ox + c * oz);
    rig.rotation.y += a;
    this.el.emit('snapturn', {
      direction: dirSign > 0 ? 'left' : 'right',
      angle: this.data.angle,
      hand: this.data.hand,
    });
  }
});

// ═══════════════════════════════════════════════════════════
// HAND POINTER — point and trigger, for objects out of reach.
// • Point the index finger (middle + ring curled) to show the ray.
//   It stays visible the whole time you point: on an object, a
//   bright cursor and highlight; otherwise it stops on the first
//   `surfaces` mesh with a dim cursor, or at rayLength.
// • Curl the finger like a trigger to press (mousedown), straighten
//   it to release (mouseup, then click if still on the object).
//   Holding the curl and moving drags (see pointer-draggable).
// • The ray runs along the index finger's base bone, which doesn't
//   move when the finger curls, and the target is frozen while the
//   trigger is being pulled, so selecting doesn't knock it off.
// • Off while that hand is near something it can poke or grab,
//   holding something, or aiming a teleport.
// • One hand points at a time (the system's owner).
// • Sends A-Frame cursor events to the object, with detail
//   { cursorEl, intersection, hand }, and the same events on the
//   hand with detail.intersectedEl. Exposes `ray` (world space).
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-pointer', {
  init: function () { this.owner = null; }
});

AFRAME.registerComponent('hand-pointer', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.interactable' },
    far: { default: 10 },               // max pointing distance (m)
    minDistance: { default: 0.3 },      // closer hits are left to poke/grab (m)
    // Finger straightness (1 = straight, ~0.45 = curled into a fist):
    pointStraight: { default: 0.85 },   // index this straight = pointing
    othersCurled: { default: 0.7 },     // middle + ring below this = curled
    triggerCurl: { default: 0.6 },      // index curled below this = press
    releaseStraight: { default: 0.8 },  // index back above this = release
    pointHoldMs: { default: 80 },       // pointing pose held this long first
    surfaces: { default: '' },          // where a free ray stops (e.g. .landable)
    rayLength: { default: 3 },          // free ray length with no surface (m)
    color: { type: 'color', default: '#ffffff' },
    showBeam: { default: true },        // false: only the cursor at the end
    cursorSize: { default: 0.012 },     // cursor radius at 1 m; scales with distance
                                        // so it stays the same size on screen
    highlight: { default: true },       // tint hovered objects (emissive)
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.raycaster = new THREE.Raycaster();
    this.ray = this.raycaster.ray;
    this.intersection = null;
    this.hoverEl = null;
    this.pressedEl = null;
    this.pressDistance = 1;
    this.targetEls = [];
    this.targetObjs = [];
    this.surfaceObjs = [];
    this._surface = false;
    this.lastRefresh = -1e9;
    this._end = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    this.pState = 'idle';          // idle | pointing | curling | pressed
    this.pSince = 0;
    this._candidate = false;
    this._candSince = 0;
    this.fingers = null;           // { index, middle, ring } straightness

    const sceneObj = this.el.sceneEl.object3D;
    const color = new THREE.Color(this.data.color);

    // Beam: unit-length cylinder along +Z, scaled to the hit distance
    const beamGeo = new THREE.CylinderGeometry(0.0025, 0.0025, 1, 6, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, 0.5);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, fog: false,
    }));
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    sceneObj.add(this.beam);

    // Cursor dot, drawn on top so the object can't hide it, with a
    // dark outline so it also shows on light surfaces
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(this.data.cursorSize, 20), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false, side: THREE.DoubleSide,
    }));
    this.dot.renderOrder = 999;
    this.dot.visible = false;
    this.outline = new THREE.Mesh(
      new THREE.RingGeometry(this.data.cursorSize, this.data.cursorSize * 1.45, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false, side: THREE.DoubleSide,
      })
    );
    this.outline.renderOrder = 998;
    this.dot.add(this.outline);
    sceneObj.add(this.dot);
  },

  send: function (name, targetEl) {
    const detail = { cursorEl: this.el, intersection: this.intersection, hand: this.data.hand };
    targetEl.emit(name, detail);
    this.el.emit(name, { intersectedEl: targetEl, intersection: this.intersection, hand: this.data.hand });
  },

  // End a press: mouseup, and click if the ray is still on the object
  releasePress: function (allowClick) {
    const el = this.pressedEl;
    if (!el) return;
    this.pressedEl = null;
    this.send('mouseup', el);
    if (allowClick && this.hoverEl === el) this.send('click', el);
  },

  refreshTargets: function () {
    this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
    this.targetObjs = this.targetEls.map((el) => el.object3D);
    this.surfaceObjs = this.data.surfaces
      ? Array.from(document.querySelectorAll(this.data.surfaces)).map((el) => el.object3D)
      : [];
  },

  // Walk up from the hit mesh to the entity that matched the selector
  entityFor: function (obj) {
    while (obj) {
      if (obj.el && this.targetEls.indexOf(obj.el) !== -1) return obj.el;
      obj = obj.parent;
    }
    return null;
  },

  setHover: function (el) {
    if (el === this.hoverEl) return;
    const old = this.hoverEl;
    this.hoverEl = el;
    if (old) {
      old.removeState('cursor-hovered');
      this.setHighlight(old, false);
      this.send('mouseleave', old);
    }
    if (el) {
      el.addState('cursor-hovered');
      this.setHighlight(el, true);
      this.send('mouseenter', el);
    }
  },

  setHighlight: function (el, on) {
    if (!this.data.highlight) return;
    this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, on);
  },

  hideVisuals: function () {
    this.beam.visible = false;
    this.dot.visible = false;
  },

  // Ray along the index finger's base bone (metacarpal), starting
  // where the fingertip is when the finger is straight. That bone
  // doesn't move when the finger curls, so the trigger doesn't
  // swing the ray.
  pointRay: function (h) {
    const L = h.local;
    const M = L['index-finger-metacarpal'], P = L['index-finger-phalanx-proximal'];
    const fingerLen = P.distanceTo(L['index-finger-phalanx-intermediate']) +
      L['index-finger-phalanx-intermediate'].distanceTo(L['index-finger-phalanx-distal']) +
      L['index-finger-phalanx-distal'].distanceTo(L['index-finger-tip']);
    this._v2.subVectors(P, M).normalize();
    this._v1.copy(P).addScaledVector(this._v2, fingerLen);
    const rigObj = this.rigEl.object3D;
    rigObj.updateMatrixWorld();
    this.ray.origin.copy(this._v1).applyMatrix4(rigObj.matrixWorld);
    this.ray.direction.copy(this._v2).transformDirection(rigObj.matrixWorld);
  },

  // Point-and-trigger state machine (runs before the raycast):
  //   idle → pointing      index straight, middle + ring curled, held pointHoldMs
  //   pointing → curling   index starts to bend: target is frozen
  //   curling → pressed    index curled past triggerCurl: mousedown
  //   curling → pointing   index straightens again: nothing happens
  //   pressed → pointing   index straightens: mouseup (+ click if still on it)
  //   any → idle           middle/ring open (hand relaxed)
  updatePointState: function (time) {
    const d = this.data, f = this.fingers;
    const othersCurled = f.middle < d.othersCurled && f.ring < d.othersCurled;
    const set = (s) => { this.pState = s; this.pSince = time; };
    switch (this.pState) {
      case 'idle':
        if (f.index > d.pointStraight && othersCurled) {
          if (!this._candidate) { this._candidate = true; this._candSince = time; }
          if (time - this._candSince >= d.pointHoldMs) { this._candidate = false; set('pointing'); }
        } else {
          this._candidate = false;
        }
        break;
      case 'pointing':
        if (!othersCurled) set('idle');
        else if (f.index < d.releaseStraight) set('curling');
        break;
      case 'curling':
        if (!othersCurled) set('idle');
        else if (f.index > d.pointStraight) set('pointing');
        else if (f.index < d.triggerCurl) {
          if (this.hoverEl) {
            this.pressedEl = this.hoverEl;
            this.pressDistance = this.intersection ? this.intersection.distance : 1;
            this.send('mousedown', this.pressedEl);
          }
          set('pressed');
        }
        break;
      case 'pressed':
        if (f.index > d.releaseStraight || !othersCurled) {
          this.releasePress(true);
          set(othersCurled ? 'pointing' : 'idle');
        }
        break;
    }
  },

  // True while this hand is using the ray, so other gestures on the
  // same hand (thumb tap, thumb tilt, teleport) step aside
  isPointing: function () {
    return this.pState === 'pointing' || this.pState === 'curling' || !!this.pressedEl;
  },

  tick: function (time) {
    const sceneEl = this.el.sceneEl;

    // Off while aiming a teleport, holding something, or with the hand
    // near something it can poke or grab (near-field takes over)
    const tps = sceneEl.systems['hand-teleport'];
    const tp = this.el.components['hand-teleport'];
    const grabC = this.el.components['hand-grab'];
    const pokeC = this.el.components['hand-poke'];
    const blocked = (tps && tp && tps.activeHand === tp) ||
      (grabC && (grabC.heldEl || grabC.near)) || (pokeC && pokeC.near);

    const h = blocked ? null : sceneEl.systems['hand-input'].get(this.data.hand);
    let haveRay = false;
    let frozen = false;
    if (h && h.has['index-finger-metacarpal']) {
      const index = h.straight('index'), middle = h.straight('middle'), ring = h.straight('ring');
      if (index !== null && middle !== null && ring !== null) {
        this.fingers = { index, middle, ring };
        this.updatePointState(time);
        if (this.pState !== 'idle') {
          frozen = this.pState === 'curling';
          if (!frozen) this.pointRay(h);
          haveRay = true;
        }
      } else {
        this.fingers = null;
      }
    } else if (!h) {
      this.fingers = null;
    }

    if (!haveRay) {
      this.intersection = null;
      this.setHover(null);
      this.releasePress(false);               // tracking lost or blocked: no click
      if (!h) { this.pState = 'idle'; this._candidate = false; }
      if (this.system.owner === this) this.system.owner = null;
      this.hideVisuals();
      return;
    }

    let hit = this.intersection, hitEl = this.hoverEl;
    if (!frozen) {
      if (time - this.lastRefresh > 500) { this.refreshTargets(); this.lastRefresh = time; }
      // Sprites in the scene graph need a camera to be raycast;
      // without one three.js throws on every frame
      this.raycaster.camera = sceneEl.camera;
      this.raycaster.near = 0;
      this.raycaster.far = this.data.far;
      const hits = this.raycaster.intersectObjects(this.targetObjs, true);
      hit = null; hitEl = null;
      for (const x of hits) {
        if (x.distance < this.data.minDistance) continue; // within reach
        const el = this.entityFor(x.object);
        if (el && el.object3D.visible) { hit = x; hitEl = el; break; }
      }
    }

    // One hand at a time: a hand holds the ray while it's pointing
    const sys = this.system;
    if (sys.owner && sys.owner !== this) {
      this.intersection = null;
      this.setHover(null);
      this.hideVisuals();
      return;
    }
    this.intersection = hit;
    this.setHover(hitEl);
    sys.owner = this;

    if (!frozen) {
      this._surface = false;
      if (hit) this._end.copy(hit.point);
      else if (this.pressedEl) this.ray.at(this.pressDistance, this._end);
      else {
        // Free ray: stop on the first surface it meets, if any
        let s = null;
        if (this.surfaceObjs.length) {
          this.raycaster.far = this.data.rayLength * 4;
          const sh = this.raycaster.intersectObjects(this.surfaceObjs, true);
          s = sh.length ? sh[0] : null;
        }
        if (s) { this._end.copy(s.point); this._surface = true; }
        else this.ray.at(this.data.rayLength, this._end);
      }
    }

    if (this.data.showBeam) {
      this.beam.position.copy(this.ray.origin);
      this.beam.lookAt(this._end);
      this.beam.scale.set(1, 1, Math.max(0.001, this.ray.origin.distanceTo(this._end)));
      this.beam.material.opacity = hit || this.pressedEl ? 0.55 : 0.28;
      this.beam.visible = true;
    } else {
      this.beam.visible = false;
    }

    // Cursor: bright on an object, dim on a surface, none in empty air
    const showDot = hit || this.pressedEl || this._surface || (frozen && this.dot.visible);
    if (!showDot) { this.dot.visible = false; return; }
    this.dot.position.copy(this._end);
    sceneEl.camera.getWorldPosition(this._camPos);
    this.dot.lookAt(this._camPos);
    // Same size on screen at any distance; shrinks while pressing
    const camDist = Math.max(0.2, this._camPos.distanceTo(this._end));
    const pressing = this.pressedEl || this.pState === 'curling';
    this.dot.scale.setScalar(camDist * (pressing ? 0.7 : 1));
    this.dot.material.opacity = hit ? 0.95 : 0.4;
    this.outline.material.opacity = hit ? 0.45 : 0.2;
    this.dot.visible = true;
  },

  remove: function () {
    this.releasePress(false);
    this.setHover(null);
    if (this.system.owner === this) this.system.owner = null;
    const sceneObj = this.el.sceneEl.object3D;
    sceneObj.remove(this.beam);
    sceneObj.remove(this.dot);
  }
});

// ═══════════════════════════════════════════════════════════
// POINTER-DRAGGABLE — trigger-and-hold an object with hand-pointer
// (or press it with A-Frame's cursor) and it follows the ray at the
// distance where you grabbed it, keeping the grab offset.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('pointer-draggable', {
  init: function () {
    this.getRay = null;
    this.distance = 0;
    this.offset = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();

    this.onDown = (e) => {
      const cursorEl = e.detail && e.detail.cursorEl;
      const hit = e.detail && e.detail.intersection;
      if (!cursorEl || !hit) return;
      const hp = cursorEl.components['hand-pointer'];
      const rc = cursorEl.components.raycaster;
      if (hp) {
        if (hp.pressedEl !== this.el) return; // e.g. a poke, not a pointer press
        this.getRay = () => hp.ray;
      }
      else if (rc) this.getRay = () => rc.raycaster.ray;
      else return;
      const ray = this.getRay();
      this.distance = ray.origin.distanceTo(hit.point);
      this.el.object3D.getWorldPosition(this._worldPos);
      this.offset.subVectors(this._worldPos, hit.point);
      this.cursorEl = cursorEl;
      this.el.addState('dragged');
      this.el.emit('dragstart');
    };
    this.onUp = () => {
      if (!this.getRay) return;
      this.getRay = null;
      this.cursorEl = null;
      this.el.removeState('dragged');
      this.el.emit('dragend');
    };
    this.el.addEventListener('mousedown', this.onDown);
    this.el.addEventListener('mouseup', this.onUp);
  },

  tick: function () {
    if (!this.getRay) return;
    // The A-Frame cursor sends mouseup to the cursor only if the
    // mouse is released off this object; catch that case too
    if (this.cursorEl && this.cursorEl.components.cursor &&
        !this.cursorEl.components.cursor.cursorDownEl) { this.onUp(); return; }
    const ray = this.getRay();
    ray.at(this.distance, this._target).add(this.offset);
    const parent = this.el.object3D.parent;
    if (parent) { parent.updateMatrixWorld(); parent.worldToLocal(this._target); }
    this.el.object3D.position.copy(this._target);
  },

  remove: function () {
    this.el.removeEventListener('mousedown', this.onDown);
    this.el.removeEventListener('mouseup', this.onUp);
  }
});

// ═══════════════════════════════════════════════════════════
// NEAR-FIELD — touching and holding things within reach.
// ═══════════════════════════════════════════════════════════

// Bounding box of an entity's VISIBLE meshes only, so invisible
// far-pointing hit boxes don't make a poke fire early
const _meshBox = new THREE.Box3();
function visibleBox(obj, out) {
  out.makeEmpty();
  obj.updateMatrixWorld();
  obj.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _meshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    out.union(_meshBox);
  });
  return out;
}

// ─────────────────────────────────────────────────────────
// HAND POKE — the index fingertip presses objects it touches.
// Entering an object sends mouseenter + mousedown; leaving it
// sends mouseup + click + mouseleave, like pressing and letting
// go of a physical button. Detail: { cursorEl, intersection,
// hand, source: 'poke' }. The index finger must be extended, so
// a fist or a grab doesn't press things. Sets `near` while the
// fingertip is close to a target (hand-pointer steps aside).
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('hand-poke', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.interactable' },
    enterMargin: { default: 0.005 },   // touch counts this close to the surface (m)
    exitMargin: { default: 0.015 },    // must pull back this far to release (m)
    fingerExtended: { default: 0.8 },  // index straightness above this = extended
    nearDistance: { default: 0.15 },   // fingertip this close to a target = near-field (m)
    highlight: { default: true },      // tint the object while pressed
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.pokedEl = null;
    this.near = false;
    this.targetEls = [];
    this.lastRefresh = -1e9;
    this.boxes = new Map();
    this._tip = new THREE.Vector3();
  },

  send: function (name, el) {
    el.emit(name, {
      cursorEl: this.el,
      intersection: { point: this._tip.clone(), distance: 0, object: el.object3D },
      hand: this.data.hand,
      source: 'poke',
    });
  },

  release: function (withClick) {
    const el = this.pokedEl;
    if (!el) return;
    this.pokedEl = null;
    this.send('mouseup', el);
    if (withClick) this.send('click', el);
    if (this.data.highlight) this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, false);
    el.removeState('cursor-hovered');
    this.send('mouseleave', el);
  },

  boxOf: function (el) {
    const box = visibleBox(el.object3D, this.boxes.get(el) || new THREE.Box3());
    this.boxes.set(el, box);
    return box;
  },

  tick: function (time) {
    const h = this.el.sceneEl.systems['hand-input'].get(this.data.hand, this.rigEl.object3D);
    if (!h || !h.has['index-finger-tip']) { this.near = false; this.release(false); return; }
    this._tip.copy(h.world['index-finger-tip']);
    const straight = h.straight('index');
    const extended = straight !== null && straight > this.data.fingerExtended;
    const grab = this.el.components['hand-grab'];
    const holding = grab && grab.heldEl;

    if (time - this.lastRefresh > 500) {
      this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
      this.lastRefresh = time;
    }

    // Near-field: fingertip close to any target (hand-pointer steps aside)
    this.near = false;
    for (const el of this.targetEls) {
      if (!el.object3D.visible) continue;
      const box = this.boxOf(el);
      if (!box.isEmpty() && box.distanceToPoint(this._tip) < this.data.nearDistance) { this.near = true; break; }
    }

    // Currently pressing: release once the fingertip pulls back
    if (this.pokedEl) {
      const box = this.boxOf(this.pokedEl);
      if (!box.isEmpty() && box.expandByScalar(this.data.exitMargin).containsPoint(this._tip)) return;
      this.release(extended && !holding);
      return;
    }
    if (!extended || holding) return;

    for (const el of this.targetEls) {
      if (!el.object3D.visible || el.is('grabbed')) continue;
      // push-button and hand-slider handle the fingertip themselves
      if (el.components && (el.components['push-button'] || el.components['hand-slider'])) continue;
      const box = this.boxOf(el);
      if (box.isEmpty()) continue;
      if (box.expandByScalar(this.data.enterMargin).containsPoint(this._tip)) {
        this.pokedEl = el;
        if (this.data.highlight) this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, true);
        el.addState('cursor-hovered');
        this.send('mouseenter', el);
        this.send('mousedown', el);
        return;
      }
    }
  },

  remove: function () { this.release(false); }
});

// ─────────────────────────────────────────────────────────
// HAND GRAB — whole-hand grip. Bring an open hand to a .grabbable
// so it's against your palm, then close your hand: it's picked up
// and follows the hand rigidly (position and rotation) until you
// open your hand again. Pinches play no part, so grabbing never
// competes with teleport.
//   grip      mean straightness of index, middle and ring
//   open      grip above `openGrip` arms a grab
//   closed    grip below `closeGrip` with an object in the grasp
//             zone grabs it; above `releaseGrip` lets go
// Only an open → closed change grabs: pointing (middle and ring
// already curled), a trigger pull, a thumbs-up or a fist moved
// into an object don't pick anything up.
// Grasp zone: a point just in front of the palm; an object counts
// if its box is within `reach` palm lengths of it. Highlights what
// closing your hand would pick up. Sets `near` while an object is
// close (hand-pointer steps aside, teleport declines).
// Snug fit (snap): on grab the object eases, along the palm's
// normal only, until its nearest side rests against the palm — no
// floating a few centimetres off the hand, no sinking into it. It
// keeps its orientation and sideways position. (handy-work snaps the
// hand to the object; here the object comes to the hand, which
// needs no control over the hand model.)
// Grabbing what the other hand holds passes it over.
// Events on the object: grabstart / grabend ({ hand, handEl });
// on the hand: grabstart / grabend ({ el }). State: 'grabbed'.
// ─────────────────────────────────────────────────────────
AFRAME.registerSystem('hand-grab', {
  init: function () { this.holders = new Map(); } // el → component
});

AFRAME.registerComponent('hand-grab', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.grabbable' },
    openGrip: { default: 0.8 },         // grip above this = open hand (arms a grab)
    closeGrip: { default: 0.68 },       // grip below this = closed: grab
    releaseGrip: { default: 0.78 },     // grip above this while holding = let go
    reach: { default: 0.6 },            // grasp zone radius, in palm lengths (~6 cm)
    palmOffset: { default: 0.35 },      // grasp point in front of the palm, palm lengths
    snap: { default: true },            // ease the object against the palm on grab
    snapMs: { default: 100 },           // how long that takes
    palmThickness: { default: 0.15 },   // palm surface below the joints, palm lengths
    snapGap: { default: 0.004 },        // gap left between palm and object (m)
    snapMax: { default: 0.08 },         // never move an object further than this (m)
    nearDistance: { default: 0.15 },    // object this close to the grasp point = near-field (m)
    highlight: { default: true },       // tint what closing the hand would pick up
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.heldEl = null;
    this.nearEl = null;   // highlighted: what closing the hand would pick up
    this.near = false;
    this.armed = false;   // hand has been open since the last grab
    this.grip = null;
    this.targetEls = [];
    this.lastRefresh = -1e9;
    this.offset = new THREE.Matrix4();
    this._handM = new THREE.Matrix4();
    this._m = new THREE.Matrix4();
    this._parentInv = new THREE.Matrix4();
    this._wristPos = new THREE.Vector3();
    this._wristQuat = new THREE.Quaternion();
    this._grasp = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._center = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._palmPt = new THREE.Vector3();
    this._corner = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this.snapFrom = new THREE.Vector3();
    this.snapTo = new THREE.Vector3();
    this.snapStart = -1;
  },

  // World-space wrist pose, grasp point and grip; false if not tracked
  readHand: function () {
    const h = this.el.sceneEl.systems['hand-input'].get(this.data.hand, this.rigEl.object3D);
    if (!h || !h.ok('wrist', 'middle-finger-phalanx-proximal')) return false;
    this._wristPos.copy(h.world.wrist);
    this._wristQuat.copy(h.wristQuatWorld);
    // Palm centre, pushed out along the palm normal (-Y of the wrist)
    this._grasp.lerpVectors(h.world.wrist, h.world['middle-finger-phalanx-proximal'], 0.6);
    this._n.set(0, -1, 0).applyQuaternion(this._wristQuat);
    this._palmPt.copy(this._grasp).addScaledVector(this._n, this.data.palmThickness * h.palm);
    this._grasp.addScaledVector(this._n, this.data.palmOffset * h.palm);
    this.palm = h.palm;
    const i = h.straight('index'), m = h.straight('middle'), r = h.straight('ring');
    this.grip = (i === null || m === null || r === null) ? null : (i + m + r) / 3;
    return true;
  },

  // Nearest grabbable within reach of the grasp point. Also sets
  // this.near. Call after readHand().
  findTarget: function () {
    this.near = false;
    const now = this.el.sceneEl.time || 0;
    if (now - this.lastRefresh > 500 || !this.targetEls.length) {
      this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
      this.lastRefresh = now;
    }
    const reach = this.data.reach * this.palm;
    let best = null, bestD = Infinity;
    for (const el of this.targetEls) {
      if (!el.object3D.visible) continue;
      visibleBox(el.object3D, this._box);
      if (this._box.isEmpty()) continue;
      const d = this._box.distanceToPoint(this._grasp);
      if (d < this.data.nearDistance) this.near = true;
      if (d > reach) continue;
      const dc = this._box.getCenter(this._center).distanceTo(this._grasp);
      if (dc < bestD) { bestD = dc; best = el; }
    }
    return best;
  },

  grab: function (el) {
    const holders = this.system.holders;
    const other = holders.get(el);
    if (other && other !== this) other.release();
    this._handM.compose(this._wristPos, this._wristQuat, this._one);
    el.object3D.updateMatrixWorld();
    this.offset.copy(this._handM).invert().multiply(el.object3D.matrixWorld);
    this.snapStart = -1;
    if (this.data.snap) this.planSnap(el);
    this.heldEl = el;
    holders.set(el, this);
    el.addState('grabbed');
    el.emit('grabstart', { hand: this.data.hand, handEl: this.el });
    this.el.emit('grabstart', { el: el });
  },

  // Where the object should sit: move it along the palm normal until
  // its box's nearest corner is snapGap from the palm surface
  planSnap: function (el) {
    visibleBox(el.object3D, this._box);
    if (this._box.isEmpty()) return;
    const b = this._box;
    let s = Infinity;
    for (let i = 0; i < 8; i++) {
      this._corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      s = Math.min(s, this._corner.sub(this._palmPt).dot(this._n));
    }
    let move = this.data.snapGap - s;
    if (Math.abs(move) < 0.001) return;
    move = Math.max(-this.data.snapMax, Math.min(this.data.snapMax, move));
    // World shift → hand-local, applied to the offset's translation
    this._delta.copy(this._n).multiplyScalar(move).applyQuaternion(this._qInv.copy(this._wristQuat).invert());
    this.snapFrom.setFromMatrixPosition(this.offset);
    this.snapTo.copy(this.snapFrom).add(this._delta);
    this.snapStart = this.el.sceneEl.time || 0;
  },

  release: function () {
    const el = this.heldEl;
    if (!el) return;
    this.heldEl = null;
    this.snapStart = -1;
    if (this.system.holders.get(el) === this) this.system.holders.delete(el);
    el.removeState('grabbed');
    el.emit('grabend', { hand: this.data.hand, handEl: this.el });
    this.el.emit('grabend', { el: el });
  },

  setNear: function (el) {
    if (el === this.nearEl) return;
    const hl = this.el.sceneEl.systems['hand-highlight'];
    if (this.data.highlight && this.nearEl) hl.set(this.nearEl, this.data.highlightColor, false);
    this.nearEl = el;
    if (this.data.highlight && el) hl.set(el, this.data.highlightColor, true);
  },

  tick: function () {
    if (!this.readHand()) {
      this.near = false; this.armed = false;
      this.release();                 // tracking lost: drop it
      this.setNear(null);
      return;
    }
    const d = this.data, grip = this.grip;

    if (this.heldEl) {
      if (grip !== null && grip > d.releaseGrip) {
        this.release();
        this.armed = true;
      } else {
        this.follow();
        return;
      }
    }

    // Not holding: highlight what closing the hand here would pick up
    const target = this.findTarget();
    if (grip === null) { this.setNear(null); return; }
    if (grip > d.openGrip) this.armed = true;
    this.setNear(this.armed ? target : null);
    if (this.armed && grip < d.closeGrip) {
      this.armed = false;
      if (target) this.grab(target);
    }
  },

  // object world = hand world × grab offset, then into parent space
  follow: function () {
    if (this.snapStart >= 0) {
      const t = Math.min(1, ((this.el.sceneEl.time || 0) - this.snapStart) / Math.max(1, this.data.snapMs));
      const k = 1 - (1 - t) * (1 - t);                       // ease out
      this._delta.lerpVectors(this.snapFrom, this.snapTo, k);
      this.offset.setPosition(this._delta);
      if (t >= 1) this.snapStart = -1;
    }
    this._handM.compose(this._wristPos, this._wristQuat, this._one);
    this._m.multiplyMatrices(this._handM, this.offset);
    const obj = this.heldEl.object3D;
    if (obj.parent) {
      obj.parent.updateMatrixWorld();
      this._m.premultiply(this._parentInv.copy(obj.parent.matrixWorld).invert());
    }
    this._m.decompose(obj.position, obj.quaternion, obj.scale);
  },

  remove: function () {
    this.release();
    this.setNear(null);
  }
});

// ═══════════════════════════════════════════════════════════
// HAND JOINT — put any entity on a hand joint. It follows the
// joint's position and (optionally) orientation every frame, plus
// an offset in the joint's own frame, and hides while the hand
// isn't tracked. The entity should be a child of the scene (not of
// the rig or a hand), since it is placed in world space.
//   <a-entity hand-joint="hand: left; joint: wrist; offset: 0 0.03 0">
// Joints: wrist, thumb-tip, index-finger-tip, middle-finger-phalanx-
// proximal, … (the 25 WebXR joint names). In a joint's frame -Z
// points toward the fingertips and -Y out of the palm, so offset
// "0 -0.04 0" on the wrist sits just off the palm.
// faceHead: ignore the joint's orientation and turn to face you, so
// text on it is always readable.
// palmFacing: emits 'palmup' / 'palmdown' on this entity when the
// palm turns toward / away from your face (for wrist menus), and
// sets the 'palm-facing' state.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('hand-joint', {
  schema: {
    hand: { default: 'left' },
    joint: { default: 'wrist' },
    cameraRig: { default: '#rig' },
    head: { default: '#head' },
    offset: { type: 'vec3', default: { x: 0, y: 0, z: 0 } },
    rotate: { default: true },          // follow the joint's orientation too
    faceHead: { default: false },       // instead, turn to face you (labels, menus)
    hideUntracked: { default: true },
    palmFacing: { default: false },     // emit palmup / palmdown
    facingAngle: { default: 50 },       // palm within this of facing your eyes = up (degrees)
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.headEl = document.querySelector(this.data.head);
    this.facing = false;
    this._q = new THREE.Quaternion();
    this._off = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._toHead = new THREE.Vector3();
    this._parentInv = new THREE.Matrix4();
    this._m = new THREE.Matrix4();
    this._one = new THREE.Vector3(1, 1, 1);
    this._pos = new THREE.Vector3();
    this._s = new THREE.Vector3();
  },

  tick: function () {
    const d = this.data, obj = this.el.object3D;
    const h = this.el.sceneEl.systems['hand-input'].get(d.hand, this.rigEl && this.rigEl.object3D);
    if (!h || !h.has[d.joint] || !h.jointQuatWorld(d.joint, this._q)) {
      if (d.hideUntracked) obj.visible = false;
      this.setFacing(false);
      return;
    }
    obj.visible = true;
    this._off.set(d.offset.x, d.offset.y, d.offset.z).applyQuaternion(this._q);
    this._pos.copy(h.world[d.joint]).add(this._off);
    // World pose → the entity's parent space
    this._m.compose(this._pos, this._q, this._one);
    if (obj.parent) {
      obj.parent.updateMatrixWorld();
      this._m.premultiply(this._parentInv.copy(obj.parent.matrixWorld).invert());
    }
    // Position (and rotation); the entity keeps its own scale
    if (d.rotate && !d.faceHead) this._m.decompose(obj.position, obj.quaternion, this._s);
    else obj.position.setFromMatrixPosition(this._m);
    if (d.faceHead && this.headEl) {
      obj.updateMatrixWorld();
      obj.lookAt(this.headEl.object3D.getWorldPosition(this._toHead));
    }

    if (d.palmFacing && this.headEl) {
      h.jointQuatWorld('wrist', this._q);
      this._n.set(0, -1, 0).applyQuaternion(this._q);              // out of the palm
      this.headEl.object3D.getWorldPosition(this._toHead).sub(h.world.wrist).normalize();
      const angle = THREE.MathUtils.radToDeg(this._n.angleTo(this._toHead));
      // hysteresis: on inside facingAngle, off beyond facingAngle + 15
      if (!this.facing && angle < d.facingAngle) this.setFacing(true);
      else if (this.facing && angle > d.facingAngle + 15) this.setFacing(false);
    }
  },

  setFacing: function (on) {
    if (on === this.facing) return;
    this.facing = on;
    if (on) { this.el.addState('palm-facing'); this.el.emit('palmup'); }
    else { this.el.removeState('palm-facing'); this.el.emit('palmdown'); }
  },
});

// ═══════════════════════════════════════════════════════════
// HAND POSE — recognise hand shapes you record.
// A pose is the 24 finger joints' positions relative to the wrist,
// in the wrist's own frame and in palm lengths, so it doesn't
// depend on where the hand is, which way it points, or how big it
// is. Poses are stored as a right hand and mirrored for the left,
// so one recording works for both hands. (handy-work compares joint
// rotations instead; positions avoid depending on each joint's
// orientation convention, and mirror exactly.)
// Distance: weighted mean of the per-joint gaps, in palm lengths.
// For scale (simulated hands): open vs fist ≈ 0.57, open vs point
// ≈ 0.43, point vs horns (just the pinky differs) ≈ 0.12, every
// finger bent ~20° from open ≈ 0.15. The default threshold of 0.1
// tells single-finger differences apart; loosen it per pose for
// shapes people make less exactly.
//
// System (scene.systems['hand-pose']):
//   capture(side)        the hand's current shape → { joints: [...] }
//                        (plain JSON; save it anywhere)
//   define(name, pose)   add or replace a pose; pose.threshold, if
//                        given, overrides the component's for it
//   remove(name), names()
//   match(side)          [[name, distance], ...] nearest first
//
// Component, on a hand entity:
//   <a-entity hand-pose="hand: right; poses: open, fist; threshold: 0.2">
// Emits on the hand: posestart / poseend ({ pose, hand, distance }).
// Unlike handy-work there is a "no pose": nothing starts unless the
// nearest pose is within `threshold` (and clearly nearer than the
// next one); it ends past `exitThreshold`. A pose must hold for
// holdMs (default 80 ms) before it starts.
// ═══════════════════════════════════════════════════════════
const POSE_JOINTS = HAND_JOINTS.slice(1);   // the 24 joints after the wrist
const POSE_WEIGHTS = POSE_JOINTS.map((n) =>
  n.endsWith('-tip') ? 1.5 : n.endsWith('metacarpal') ? 0.4 : 1);
const POSE_WEIGHT_SUM = POSE_WEIGHTS.reduce((a, b) => a + b, 0);

AFRAME.registerSystem('hand-pose', {
  init: function () {
    this.poses = new Map();             // name → Float32Array(72)
    this.cache = { left: { count: -1, frame: null, vec: new Float32Array(72), ok: false },
                   right: { count: -1, frame: null, vec: new Float32Array(72), ok: false } };
    this._inv = new THREE.Quaternion();
    this._v = new THREE.Vector3();
  },

  // The current hand as a normalised right-hand vector (cached per frame)
  vector: function (side) {
    const input = this.el.systems['hand-input'];
    const h = input.get(side);
    const c = this.cache[side];
    if (!h) { c.ok = false; return null; }
    if (c.count === h.count && c.frame === h.frame) return c.ok ? c.vec : null;
    c.count = h.count; c.frame = h.frame;
    c.ok = h.ok(...HAND_JOINTS);
    if (!c.ok) return null;
    this._inv.copy(h.wristQuat).invert();
    const mirror = side === 'left' ? -1 : 1;
    for (let i = 0; i < POSE_JOINTS.length; i++) {
      this._v.subVectors(h.local[POSE_JOINTS[i]], h.local.wrist).applyQuaternion(this._inv).multiplyScalar(1 / h.palm);
      c.vec[i * 3] = this._v.x * mirror; c.vec[i * 3 + 1] = this._v.y; c.vec[i * 3 + 2] = this._v.z;
    }
    return c.vec;
  },

  capture: function (side) {
    const v = this.vector(side);
    if (!v) return null;
    return { joints: Array.from(v, (x) => Math.round(x * 1000) / 1000) };
  },

  define: function (name, pose) {
    const j = pose && (pose.joints || pose);
    if (!j || j.length !== POSE_JOINTS.length * 3) throw new Error('hand-pose: "' + name + '" needs ' + POSE_JOINTS.length * 3 + ' numbers');
    this.poses.set(name, { vec: Float32Array.from(j), threshold: typeof pose.threshold === 'number' ? pose.threshold : null });
  },
  remove: function (name) { this.poses.delete(name); },
  names: function () { return Array.from(this.poses.keys()); },

  distance: function (vec, pose) {
    let sum = 0;
    for (let i = 0; i < POSE_JOINTS.length; i++) {
      const o = i * 3;
      const dx = vec[o] - pose[o], dy = vec[o + 1] - pose[o + 1], dz = vec[o + 2] - pose[o + 2];
      sum += Math.sqrt(dx * dx + dy * dy + dz * dz) * POSE_WEIGHTS[i];
    }
    return sum / POSE_WEIGHT_SUM;
  },

  match: function (side, only) {
    const v = this.vector(side);
    if (!v) return [];
    const out = [];
    for (const [name, pose] of this.poses) {
      if (only && only.length && only.indexOf(name) === -1) continue;
      out.push([name, this.distance(v, pose.vec), pose.threshold]);
    }
    return out.sort((a, b) => a[1] - b[1]);
  },
});

AFRAME.registerComponent('hand-pose', {
  schema: {
    hand: { default: 'right' },
    poses: { type: 'array', default: [] },  // empty = every defined pose
    threshold: { default: 0.1 },        // start when this close (palm lengths)
    exitThreshold: { default: 0.14 },   // end when further than this
    margin: { default: 0.03 },          // nearest must beat the next by this much
    holdMs: { default: 80 },
  },

  init: function () {
    this.current = null;      // pose being held
    this.best = null;         // [name, distance] nearest this frame (for readouts)
    this.candidate = null;
    this.since = 0;
  },

  end: function (distance) {
    if (!this.current) return;
    const pose = this.current;
    this.current = null;
    this.el.emit('poseend', { pose, hand: this.data.hand, distance });
  },

  tick: function (time) {
    const d = this.data;
    const list = this.system.match(d.hand, d.poses);
    this.best = list[0] || null;
    if (!list.length) { this.candidate = null; this.end(null); return; }

    if (this.current) {
      const mine = list.find((x) => x[0] === this.current);
      const exit = mine && mine[2] !== null ? mine[2] * d.exitThreshold / d.threshold : d.exitThreshold;
      if (!mine || mine[1] > exit) this.end(mine ? mine[1] : null);
      else return;
    }
    const [name, dist, own] = list[0];
    const clear = list.length < 2 || list[1][1] - dist >= d.margin;
    if (dist > (own !== null ? own : d.threshold) || !clear) { this.candidate = null; return; }
    if (this.candidate !== name) { this.candidate = name; this.since = time; return; }
    if (time - this.since < d.holdMs) return;
    this.current = name;
    this.candidate = null;
    this.el.emit('posestart', { pose: name, hand: d.hand, distance: dist });
  },

  remove: function () { this.end(null); },
});

// ═══════════════════════════════════════════════════════════
// FINGERTIP CONTROLS — a button that travels with your fingertip,
// and a slider you drag with one. Both read either hand's index
// fingertip directly (hand-poke leaves them alone) and work in the
// entity's own frame, so they can sit on a table, a wall or a
// wrist panel at any angle.
// ═══════════════════════════════════════════════════════════
function localHalfExtents(el, out) {
  const mesh = (el.getObject3D && el.getObject3D('mesh')) || el.object3D;
  const g = mesh && mesh.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  g.boundingBox.getSize(out).multiplyScalar(0.5);
  return out.multiply(el.object3D.scale);
}

// Fingertips of both hands in an entity's PARENT space
function fingertipsInParent(sceneEl, el, rigObj, hands, outs) {
  const input = sceneEl.systems['hand-input'];
  const parent = el.object3D.parent;
  if (parent) parent.updateMatrixWorld();
  let n = 0;
  for (const side of hands) {
    const h = input.get(side, rigObj);
    if (!h || !h.has['index-finger-tip']) continue;
    const s = h.straight('index');
    if (s === null || s < 0.75) continue;            // index must be extended
    const v = outs[n++];
    v.copy(h.world['index-finger-tip']);
    if (parent) parent.worldToLocal(v);
    v.side = side;
  }
  return n;
}

// ─────────────────────────────────────────────────────────
// PUSH BUTTON — the entity is the button cap. Pressed from its top
// (+Y side in its own frame), it moves in with your fingertip up
// to `travel`, clicks (buttondown + click) at clickAt of the
// travel, re-arms below releaseAt (buttonup), and springs back
// when you let go. Pressing in from the side or from below does
// nothing. The pointer can still click it from afar if it is
// .interactable.
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('push-button', {
  schema: {
    travel: { default: 0.012 },         // how far it can be pushed in (m)
    clickAt: { default: 0.85 },         // fraction of travel that clicks
    releaseAt: { default: 0.35 },       // fraction of travel that re-arms
    margin: { default: 0.008 },         // sideways slack around the cap (m)
    returnSpeed: { default: 0.15 },     // spring-back speed (m/s)
    hands: { type: 'array', default: ['left', 'right'] },
    cameraRig: { default: '#rig' },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.rest = this.el.object3D.position.clone();
    this.depth = 0;
    this.pressed = false;
    this.engaged = null;                // side of the finger pressing it
    this.above = { left: false, right: false };
    this._half = new THREE.Vector3();
    this._tips = [new THREE.Vector3(), new THREE.Vector3()];
    this._p = new THREE.Vector3();
    this._inv = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
  },

  // Fingertip in the button's rest frame (origin at rest centre)
  toRest: function (v) {
    this._inv.copy(this.el.object3D.quaternion).invert();
    return this._p.copy(v).sub(this.rest).applyQuaternion(this._inv);
  },

  tick: function (time, dt) {
    const d = this.data;
    if (!localHalfExtents(this.el, this._half)) return;
    const top = this._half.y;
    const n = this.rigEl ? fingertipsInParent(this.el.sceneEl, this.el, this.rigEl.object3D, d.hands, this._tips) : 0;
    let target = 0, presser = null;
    const seen = { left: false, right: false };
    for (let i = 0; i < n; i++) {
      const side = this._tips[i].side;
      const p = this.toRest(this._tips[i]);
      const inside = Math.abs(p.x) <= this._half.x + d.margin && Math.abs(p.z) <= this._half.z + d.margin;
      const push = top - p.y;                       // how far below the rest top surface
      seen[side] = true;
      if (!inside) { this.above[side] = false; continue; }
      if (push <= 0) { this.above[side] = true; continue; }
      // Only a fingertip that came down from above presses it
      if (!this.above[side] && this.engaged !== side) continue;
      if (push > d.travel + 0.04) { this.above[side] = false; continue; } // pushed right through
      if (push > target) { target = push; presser = side; }
    }
    for (const s of ['left', 'right']) if (!seen[s]) this.above[s] = false;
    this.engaged = presser;

    if (presser) this.depth = Math.min(target, d.travel);
    else this.depth = Math.max(0, this.depth - d.returnSpeed * (dt || 16) / 1000);

    this._axis.set(0, 1, 0).applyQuaternion(this.el.object3D.quaternion);
    this.el.object3D.position.copy(this.rest).addScaledVector(this._axis, -this.depth);

    if (!this.pressed && this.depth >= d.travel * d.clickAt) {
      this.pressed = true;
      this.el.addState('pressed');
      this.el.emit('buttondown', { hand: presser });
      this.el.emit('click', { hand: presser, source: 'push-button' });
    } else if (this.pressed && this.depth <= d.travel * d.releaseAt) {
      this.pressed = false;
      this.el.removeState('pressed');
      this.el.emit('buttonup', {});
    }
  },
});

// ─────────────────────────────────────────────────────────
// HAND SLIDER — the entity is the knob. It slides along its
// parent's `axis` within ±length/2 of where it starts, with
// `value` (0–1) setting its starting point. Touch it with a
// fingertip and it follows the finger along the axis until the
// finger moves away. Emits slidestart / change ({ value }) /
// slideend. Set a value from code with el.components['hand-
// slider'].setValue(v).
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('hand-slider', {
  schema: {
    axis: { default: 'x', oneOf: ['x', 'y', 'z'] },
    length: { default: 0.2 },           // travel along the axis (m)
    value: { default: 0.5 },            // starting value, 0–1
    step: { default: 0 },               // snap to steps of this size (0 = smooth)
    grabMargin: { default: 0.012 },     // fingertip this close to the knob takes it (m)
    releaseMargin: { default: 0.035 },  // ...and this far off the axis lets it go (m)
    hands: { type: 'array', default: ['left', 'right'] },
    cameraRig: { default: '#rig' },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    const p = this.el.object3D.position, a = this.data.axis;
    this.center = p.clone();
    this.center[a] -= (this.data.value - 0.5) * this.data.length;
    this.value = this.data.value;
    this.engaged = null;
    this.grabOffset = 0;
    this._half = new THREE.Vector3();
    this._tips = [new THREE.Vector3(), new THREE.Vector3()];
    this._p = new THREE.Vector3();
  },

  setValue: function (v, emit) {
    const d = this.data;
    v = Math.min(1, Math.max(0, v));
    if (d.step > 0) v = Math.round(v / d.step) * d.step;
    this.el.object3D.position[d.axis] = this.center[d.axis] + (v - 0.5) * d.length;
    if (Math.abs(v - this.value) < 1e-4) return;
    this.value = v;
    if (emit !== false) this.el.emit('change', { value: v });
  },

  tick: function () {
    const d = this.data, a = d.axis, pos = this.el.object3D.position;
    if (!localHalfExtents(this.el, this._half)) return;
    const n = this.rigEl ? fingertipsInParent(this.el.sceneEl, this.el, this.rigEl.object3D, d.hands, this._tips) : 0;
    let tip = null;
    for (let i = 0; i < n; i++) {
      const t = this._tips[i];
      if (this.engaged && t.side !== this.engaged) continue;
      this._p.copy(t).sub(pos);
      const off = ['x', 'y', 'z'].filter((k) => k !== a);
      if (this.engaged) {
        // Held: let go once the finger strays off the axis
        if (off.every((k) => Math.abs(this._p[k]) <= this._half[k] + d.releaseMargin)) { tip = t; break; }
      } else if (['x', 'y', 'z'].every((k) => Math.abs(this._p[k]) <= this._half[k] + d.grabMargin)) {
        tip = t;
        this.engaged = t.side;
        this.grabOffset = pos[a] - t[a];          // no jump to the fingertip
        this.el.addState('sliding');
        this.el.emit('slidestart', { value: this.value, hand: t.side });
        break;
      }
    }
    if (!tip) {
      if (this.engaged) {
        this.engaged = null;
        this.el.removeState('sliding');
        this.el.emit('slideend', { value: this.value });
      }
      return;
    }
    const along = tip[a] + this.grabOffset - this.center[a];
    this.setValue(along / d.length + 0.5);
  },
});

// ═══════════════════════════════════════════════════════════
// HAND INTERACTION — the whole kit in one attribute. Put it on the
// rig (the entity holding the camera) and it sets up both hands:
//
//   <a-entity id="rig" hand-interaction>
//     <a-entity camera position="0 1.6 0" look-controls></a-entity>
//   </a-entity>
//
// Recommended split by default: teleport on the left hand, turning
// on the right, and pointer + fingertip press + grab on both.
// Change any of it with the options below, e.g.
//   hand-interaction="teleportHand: right; turnHand: left; tutorial: true"
//
// If the rig already has a hand-tracking-controls child for a hand,
// that entity is used (so you can keep your own hand model
// settings); otherwise one is created. Components you've already
// put on a hand entity are left as they are. The rig and camera get
// ids if they have none, and every component is pointed at them, so
// they don't have to be #rig and #head.
//
// Turning on hand tracking needs nothing extra: A-Frame's
// hand-tracking-controls adds the WebXR 'hand-tracking' feature
// itself. Warns in the console if a hand also carries a controller
// or gesture component that would compete for the same gestures
// (laser-controls, blink-controls, handy-controls, …).
// ═══════════════════════════════════════════════════════════
const SIDES = ['left', 'right'];
const COMPETING = ['laser-controls', 'blink-controls', 'handy-controls', 'oculus-touch-controls',
  'meta-touch-controls'];

function sidesFor(v) { return v === 'both' ? SIDES : v === 'none' ? [] : [v]; }

AFRAME.registerComponent('hand-interaction', {
  schema: {
    teleportHand: { default: 'left', oneOf: ['left', 'right', 'both', 'none'] },
    turnHand: { default: 'right', oneOf: ['left', 'right', 'both', 'none'] },
    turnStartsOn: { default: false },       // turning on from the start (no thumb tap needed)
    pointer: { default: true },             // point and trigger, both hands
    poke: { default: true },                // fingertip press, both hands
    grab: { default: true },                // whole-hand grab, both hands
    poses: { default: false },              // hand-pose events on both hands
    landable: { default: '.landable' },     // where you can teleport ('' = flat floor at y 0)
    blocked: { default: '' },               // what stops the arc and can't be landed on
    interactable: { default: '.interactable' },
    grabbable: { default: '.grabbable' },
    color: { default: '' },                 // feedback colour (arc, ray, turn indicator); '' = default blue
    missColor: { default: '' },             // arc colour with no valid landing; '' = default red
    tutorial: { default: false },           // add hand-tutorial to the scene
  },

  init: function () {
    const d = this.data, rig = this.el, scene = rig.sceneEl;
    if (!rig.id) rig.id = 'hand-interaction-rig';
    const cam = rig.querySelector('[camera]') || scene.querySelector('[camera]');
    if (!cam) console.warn('hand-interaction: no camera found inside the rig; turning and teleport need one.');
    else if (!cam.id) cam.id = 'hand-interaction-head';
    const rigSel = '#' + rig.id, headSel = cam ? '#' + cam.id : '#head';
    this.hands = {};

    const teleportSides = sidesFor(d.teleportHand), turnSides = sidesFor(d.turnHand);
    const surfaces = [d.landable, d.blocked].filter(Boolean).join(', ');

    for (const side of SIDES) {
      let el = Array.from(rig.querySelectorAll('[hand-tracking-controls]'))
        .find((e) => (e.getAttribute('hand-tracking-controls') || {}).hand === side);
      if (!el) {
        el = document.createElement('a-entity');
        el.setAttribute('hand-tracking-controls', { hand: side });
        rig.appendChild(el);
      }
      this.hands[side] = el;
      const add = (name, data) => { if (!el.hasAttribute(name)) el.setAttribute(name, Object.assign({ hand: side }, data)); };

      if (teleportSides.includes(side)) {
        const t = { cameraRig: rigSel, teleportOrigin: headSel };
        if (d.landable) t.collisionEntities = d.landable;
        if (d.blocked) t.blockEntities = d.blocked;
        if (d.color) t.hitColor = d.color;
        if (d.missColor) t.missColor = d.missColor;
        add('hand-teleport', t);
      }
      if (turnSides.includes(side)) {
        const t = { cameraRig: rigSel, head: headSel };
        if (d.color) t.indicatorColor = d.color;
        if (d.turnStartsOn && side === turnSides[0]) t.startHand = side;
        add('hand-thumb-tilt', t);
      }
      if (d.pointer) {
        const p = { cameraRig: rigSel, objects: d.interactable };
        if (surfaces) p.surfaces = surfaces;
        if (d.color) p.color = d.color;
        add('hand-pointer', p);
      }
      if (d.poke) add('hand-poke', { cameraRig: rigSel, objects: d.interactable });
      if (d.grab) add('hand-grab', { cameraRig: rigSel, objects: d.grabbable });
      if (d.poses) add('hand-pose', {});

      const clash = COMPETING.filter((n) => el.hasAttribute(n));
      if (clash.length) {
        console.warn('hand-interaction: the ' + side + ' hand also has ' + clash.join(', ') +
          ', which will compete for the same gestures.');
      }
    }

    if (d.tutorial && !scene.hasAttribute('hand-tutorial')) scene.setAttribute('hand-tutorial', { head: headSel });
  },
});

// ═══════════════════════════════════════════════════════════
// HAND TUTORIAL — a guided walkthrough shown on entering VR.
// Each step waits for the matching library event (teleported,
// thumbtilttoggle, snapturn, click, grabstart). Steps are only
// included for components present in the scene. The panel is fixed
// in the world: at a tutorial-mount entity for that step if there is
// one, otherwise beside the user (sideAngle, 22° to the left), moved only
// between steps and only if it ended up out of view or far away. It
// turns (yaw only) to face the user, and has a "Skip tutorial"
// button that can be pointed at or poked.
// Completion is remembered in localStorage (persist: true); call
// el.components['hand-tutorial'].restart() to show it again.
// Emits 'tutorialstep' ({ index, key }) and 'tutorialdone'.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('hand-tutorial', {
  schema: {
    head: { default: '#head' },
    persist: { default: true },
    storageKey: { default: 'hand-tutorial-done' },
    distance: { default: 1.2 },          // unmounted panel: distance from the head (m)
    sideAngle: { default: 22 },          // unmounted panel: degrees left of forward (negative = right).
                                         // Further out lands in the headset's low-resolution periphery (foveation)
    height: { default: -0.2 },           // unmounted panel: height relative to the eyes (m)
    viewAngle: { default: 50 },          // unmounted panel is moved if further off-forward than this...
    viewDistance: { default: 4 },        // ...or further away than this (m), checked between steps
    skipClass: { default: 'interactable' },
  },

  STEPS: {
    teleport: {
      needs: 'hand-teleport', event: 'teleported',
      text: (h) => 'Move around\n\nPoint at the ground' + (h ? ' with your ' + h + ' hand' : '') +
        ', then pinch and hold. Aim the arc and let go to jump there.',
    },
    turnOn: {
      needs: 'hand-thumb-tilt', event: 'thumbtilttoggle',
      text: (h) => 'Switch on turning\n\nMake a fist' + (h ? ' with your ' + h + ' hand' : '') +
        ' and tap your thumb on the side of your index finger.' + (h ? '' : ' Turning is now on for that hand.'),
      accept: (d) => d && d.enabled,
    },
    turn: {
      needs: 'hand-thumb-tilt', event: 'snapturn',
      text: (h) => 'Turn\n\n' + (h ? 'With your ' + h + ' hand' : 'On that hand') +
        ', give a thumbs-up, then tilt your thumb left or right.',
    },
    turnOff: {
      needs: 'hand-thumb-tilt', event: 'thumbtilttoggle',
      text: (h) => 'Switch off turning\n\nMake a fist' + (h ? ' with your ' + h + ' hand' : ' with that hand') +
        ' and tap your thumb on your index finger again. Switch turning off whenever you don\'t need it, so you don\'t turn by accident.',
      accept: (d) => d && !d.enabled,
    },
    point: {
      needs: 'hand-pointer', event: 'click',
      text: 'Select from a distance\n\nPoint your index finger at something farther away. When it lights up, curl your finger like a trigger, then straighten it.',
      accept: (d) => !!(d && d.cursorEl && d.cursorEl.components &&
        d.cursorEl.components['hand-pointer'] && d.source !== 'poke'),
    },
    poke: {
      needs: 'hand-poke', event: 'click',
      text: 'Press\n\nPress a button within reach with your fingertip.',
      accept: (d) => !!(d && (d.source === 'poke' || d.source === 'push-button')),
    },
    grab: {
      needs: 'hand-grab', event: 'grabstart',
      text: 'Pick things up\n\nReach out with an open hand and close it around an object. Open your hand to let go.',
      accept: (d) => !!(d && d.hand),
    },
  },
  ORDER: ['teleport', 'turnOn', 'turn', 'turnOff', 'point', 'poke', 'grab'],

  init: function () {
    this.headEl = document.querySelector(this.data.head);
    this.steps = [];
    this.index = -1;
    this.active = false;
    this.doneAt = 0;
    this.allDone = false;
    this.mountEl = null;
    this.scaleT = 1;
    this._head = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._toPanel = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);

    this.buildPanel();

    this.onEvent = (e) => {
      if (!this.active || this.doneAt) return;
      if (e.target === this.skipEl) return;
      const step = this.STEPS[this.steps[this.index]];
      if (!step || e.type !== step.event) return;
      if (step.accept && !step.accept(e.detail)) return;
      this.completeStep();
    };
    const sceneEl = this.el.sceneEl;
    this.eventNames = new Set(this.ORDER.map((k) => this.STEPS[k].event));
    this.eventNames.forEach((n) => sceneEl.addEventListener(n, this.onEvent));

    this.onEnterVR = () => this.start();
    this.onExitVR = () => { this.active = false; this.panel.setAttribute('visible', false); };
    sceneEl.addEventListener('enter-vr', this.onEnterVR);
    sceneEl.addEventListener('exit-vr', this.onExitVR);
  },

  buildPanel: function () {
    const panel = document.createElement('a-entity');
    panel.setAttribute('visible', false);
    // Sized so body text is ~2 cm tall: smaller MSDF text breaks up
    // into jagged edges on a headset's display
    panel.setAttribute('geometry', 'primitive: plane; width: 0.8; height: 0.44');
    panel.setAttribute('material', 'shader: flat; color: #11161d; opacity: 0.88; transparent: true; fog: false');

    const progress = document.createElement('a-entity');
    progress.setAttribute('position', '0 0.175 0.002');
    progress.setAttribute('text', 'value: ; align: center; width: 0.73; wrapCount: 40; color: #8fb4e8');

    const body = document.createElement('a-entity');
    body.setAttribute('position', '0 0.01 0.002');
    body.setAttribute('text', 'value: ; align: center; width: 0.73; wrapCount: 32; color: #ffffff');

    const skip = document.createElement('a-entity');
    skip.classList.add(this.data.skipClass);
    skip.setAttribute('position', '0 -0.17 0.004');
    skip.setAttribute('geometry', 'primitive: plane; width: 0.26; height: 0.065');
    skip.setAttribute('material', 'color: #2b3542; fog: false');
    skip.setAttribute('text', 'value: Skip tutorial; align: center; width: 0.65; wrapCount: 30; color: #c9d3df; zOffset: 0.002');
    skip.addEventListener('click', () => this.finish());

    panel.appendChild(progress);
    panel.appendChild(body);
    panel.appendChild(skip);
    this.el.sceneEl.appendChild(panel);
    this.panel = panel;
    this.progressEl = progress;
    this.bodyEl = body;
    this.skipEl = skip;
  },

  isDone: function () {
    if (!this.data.persist) return false;
    try { return localStorage.getItem(this.data.storageKey) === '1'; } catch (e) { return false; }
  },

  restart: function () {
    try { localStorage.removeItem(this.data.storageKey); } catch (e) { /* storage unavailable */ }
    if (this.el.sceneEl.is('vr-mode')) this.start();
  },

  // 'left' / 'right' if exactly one hand has the component, else null
  onlyHand: function (compName) {
    const hands = Array.from(document.querySelectorAll('[' + compName + ']'))
      .map((el) => el.components && el.components[compName] && el.components[compName].data.hand)
      .filter(Boolean);
    const unique = Array.from(new Set(hands));
    return unique.length === 1 ? unique[0] : null;
  },

  // A step is possible if a hand has the component and, for
  // point / poke / grab, the scene has objects it can act on
  // (other than this tutorial's own Skip button)
  stepPossible: function (key) {
    const handEl = document.querySelector('[' + this.STEPS[key].needs + ']');
    if (!handEl) return false;
    const comp = handEl.components && handEl.components[this.STEPS[key].needs];
    const selector = comp && comp.data && comp.data.objects;
    if (!selector) return true;
    return Array.from(document.querySelectorAll(selector)).some((el) => el !== this.skipEl);
  },

  start: function () {
    if (this.isDone()) return;
    this.steps = this.ORDER.filter((k) => this.stepPossible(k));
    // Turning already on (startHand set): no need to teach the switch
    const tilt = this.el.sceneEl.systems['hand-thumb-tilt'];
    if (tilt && tilt.activeHand) this.steps = this.steps.filter((k) => k !== 'turnOn');
    if (!this.steps.length) return;
    this.active = true;
    this.allDone = false;
    this.mountEl = null;
    this.besideUser(this.panel.object3D.position);
    this.panel.setAttribute('visible', true);
    this.showStep(0);
  },

  showStep: function (i) {
    this.index = i;
    this.doneAt = 0;
    const key = this.steps[i];
    this.progressEl.setAttribute('text', 'value', 'Step ' + (i + 1) + ' of ' + this.steps.length);
    const step = this.STEPS[key];
    const text = typeof step.text === 'function' ? step.text(this.onlyHand(step.needs)) : step.text;
    this.bodyEl.setAttribute('text', 'value', text);
    this.place(key);
    this.el.emit('tutorialstep', { index: i, key: key });
  },

  completeStep: function () {
    this.doneAt = performance.now();
    this.bodyEl.setAttribute('text', 'value', 'Done!');
  },

  finish: function () {
    this.active = false;
    this.panel.setAttribute('visible', false);
    if (this.data.persist) {
      try { localStorage.setItem(this.data.storageKey, '1'); } catch (e) { /* storage unavailable */ }
    }
    this.el.emit('tutorialdone');
  },

  // The tutorial-mount entity for a step, if any
  mountFor: function (key) {
    const sys = this.el.sceneEl.systems['tutorial-mount'];
    if (!sys) return null;
    for (const m of sys.mounts) {
      if (m.data.steps.indexOf(key) !== -1) return m;
    }
    return null;
  },

  // Put the panel for this step somewhere fixed in the world
  place: function (key) {
    const obj = this.panel.object3D;
    const mount = this.mountFor(key);
    const prevMount = this.mountEl;
    this.mountEl = mount ? mount.el : null;
    if (mount) {
      mount.el.object3D.getWorldPosition(obj.position);
      this.scaleT = mount.data.scale;
      if (mount.el !== prevMount) obj.scale.setScalar(this.scaleT * 0.6); // small scale-in on a move
    } else {
      this.scaleT = 1;
      // Coming back from a mount, or the panel has drifted out of
      // view or far away while the user moved: put it beside them
      // (besideUser starts the scale-in)
      if (prevMount || !this.inView()) this.besideUser(obj.position);
    }
  },

  // Is the panel roughly ahead of the user and not too far away?
  inView: function () {
    const head = this.headEl.object3D;
    head.getWorldPosition(this._head);
    head.getWorldQuaternion(this._q);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q).setY(0);
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._toPanel.subVectors(this.panel.object3D.position, this._head).setY(0);
    const dist = this._toPanel.length();
    if (dist > this.data.viewDistance) return false;
    if (dist < 1e-3) return false;
    const angle = THREE.MathUtils.radToDeg(this._toPanel.multiplyScalar(1 / dist).angleTo(this._fwd));
    return angle <= this.data.viewAngle;
  },

  // Off to one side of where the user is looking, a little below the
  // eyes, so it never sits in the middle of the view
  besideUser: function (out) {
    const head = this.headEl.object3D;
    head.getWorldPosition(this._head);
    head.getWorldQuaternion(this._q);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q).setY(0);
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._fwd.applyAxisAngle(this._up, THREE.MathUtils.degToRad(this.data.sideAngle));
    out.copy(this._head).addScaledVector(this._fwd, this.data.distance);
    out.y = this._head.y + this.data.height;
    this.panel.object3D.scale.setScalar(0.6);
    return out;
  },

  tick: function (time, dt) {
    if (!this.active) return;

    // After a completed step: show "Done!" briefly, then move on
    if (this.doneAt && performance.now() - this.doneAt > 900) {
      if (this.allDone) {
        this.finish();
        return;
      }
      if (this.index + 1 < this.steps.length) {
        this.showStep(this.index + 1);
      } else {
        this.allDone = true;
        this.progressEl.setAttribute('text', 'value', '');
        this.bodyEl.setAttribute('text', 'value', this.steps.indexOf('turnOff') !== -1
          ? "You're all set\n\nTurning is off for now. Tap your thumb on your index finger to switch it back on."
          : "You're all set");
        this.doneAt = performance.now() + 3000; // final message stays ~4s
      }
    }

    // The panel stays where it is; it only turns (yaw) to face the
    // user, and finishes a short scale-in after a move
    const panelObj = this.panel.object3D;
    if (this.mountEl) this.mountEl.object3D.getWorldPosition(panelObj.position);
    this.headEl.object3D.getWorldPosition(this._head);
    const dx = this._head.x - panelObj.position.x, dz = this._head.z - panelObj.position.z;
    if (dx * dx + dz * dz > 1e-6) panelObj.rotation.set(0, Math.atan2(dx, dz), 0);
    const sc = panelObj.scale.x;
    if (Math.abs(sc - this.scaleT) > 1e-3) {
      panelObj.scale.setScalar(sc + (this.scaleT - sc) * (1 - Math.exp(-(dt || 16) / 70)));
    }
  },

  remove: function () {
    const sceneEl = this.el.sceneEl;
    this.eventNames.forEach((n) => sceneEl.removeEventListener(n, this.onEvent));
    sceneEl.removeEventListener('enter-vr', this.onEnterVR);
    sceneEl.removeEventListener('exit-vr', this.onExitVR);
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
  }
});


// ═══════════════════════════════════════════════════════════
// TUTORIAL MOUNT — marks where the hand-tutorial panel appears for
// the listed steps (teleport, turnOn, turn, turnOff, point, poke,
// grab). The panel sits at this entity's world position and turns
// to face the user. `scale` enlarges it for mounts seen from afar.
//   <a-entity position="6 1.5 -13"
//             tutorial-mount="steps: turnOn, turn, turnOff; scale: 1.4">
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('tutorial-mount', {
  init: function () { this.mounts = []; },
});

AFRAME.registerComponent('tutorial-mount', {
  schema: {
    steps: { type: 'array', default: [] },
    scale: { default: 1 },
  },
  init: function () { this.system.mounts.push(this); },
  remove: function () {
    const i = this.system.mounts.indexOf(this);
    if (i !== -1) this.system.mounts.splice(i, 1);
  },
});

})();
