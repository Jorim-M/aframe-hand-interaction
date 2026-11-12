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
