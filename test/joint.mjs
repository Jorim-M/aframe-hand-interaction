// hand-joint: follows a joint, offset in joint frame, hides untracked, palm-facing events
import * as THREE from 'three';
import { load, scene, entity } from './harness.mjs';
const lib = load(process.argv[2]);
const batched = process.argv[3] !== 'nobatch';
const res = []; const check = (n, ok, note = '') => res.push({ n, ok, note });
for (const scale of [0.75, 1, 1.25]) {
  const S = scene(lib, { scale, batched });
  S.addHand('left', {}); S.addHand('right', {});
  const el = entity('label'); el.sceneEl = S.sceneEl; S.sceneEl.object3D.add(el.object3D);
  const def = lib.comps['hand-joint']; const c = Object.create(def); c.el = el; c.data = {};
  for (const k in def.schema) c.data[k] = def.schema[k].default;
  Object.assign(c.data, { hand: 'left', joint: 'index-finger-tip', offset: { x: 0, y: 0.02, z: 0 }, palmFacing: true });
  c.init(); el.components['hand-joint'] = c;
  const h = S.hands.left; h.curl = { index: 0, middle: 0.2, ring: 0.2, pinky: 0.2 };
  const run = (n = 1) => { for (let i = 0; i < n; i++) { S.tick(1); c.tick(); } };
  run(2);
  const tip = h.local('index-finger-tip'); const want = tip.clone().add(new THREE.Vector3(0, 0.02, 0).applyQuaternion(h.quat()));
  check('follows the fingertip with offset @' + scale, el.object3D.position.distanceTo(want) < 1e-4, el.object3D.position.distanceTo(want).toExponential(1));
  check('takes the joint orientation @' + scale, el.object3D.quaternion.angleTo(h.quat()) < 1e-4);
  h.yaw = 0.7; run(1);
  check('turns with the hand @' + scale, el.object3D.quaternion.angleTo(h.quat()) < 1e-4);
  h.yaw = 0;
  // palm facing: palm down (default) → not facing; roll the hand palm-up toward the head
  check('palm down: not facing @' + scale, !c.facing);
  h.pitch = 0; const prevQuat = h.quat;
  h.quat = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, Math.PI, 'YXZ'));   // palm up
  h.wrist.set(-0.1, 1.2, -0.3); run(2);
  check('palm turned up toward the face: palmup @' + scale, c.facing && el.log.includes('palmup'));
  h.quat = prevQuat; run(2);
  check('turned back: palmdown @' + scale, !c.facing && el.log.includes('palmdown'));
  h.tracked = false; run(1);
  check('hidden when untracked @' + scale, el.object3D.visible === false);
}
let fail = 0; for (const r of res) { if (!r.ok) fail++; console.log((r.ok ? 'pass ' : 'FAIL ') + r.n + (r.ok ? '' : '  ' + r.note)); }
console.log(fail ? fail + ' failed' : 'all ' + res.length + ' passed');
process.exitCode = fail ? 1 : 0;
