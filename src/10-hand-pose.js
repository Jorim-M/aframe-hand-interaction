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
