// Whole-hand grip scenarios. Usage: node grip.mjs <library.js>
import * as THREE from 'three';
import { load, scene, over } from './harness.mjs';
const lib = load(process.argv[2]);
const batched = process.argv[3] !== 'nobatch';
const res = []; const check = (n, ok, note = '') => res.push({ n, ok, note });
const open = (h) => { h.curl = { index: 0.05, middle: 0.05, ring: 0.05, pinky: 0.05 }; h.thumbTip = null; h.thumb = { dir: new THREE.Vector3(0.6, 0.3, -0.75).normalize(), bend: 0.2 }; };
const relaxed = (h) => { h.curl = { index: 0.15, middle: 0.2, ring: 0.2, pinky: 0.2 }; h.thumbTip = null; };
function setup(scale) {
  const S = scene(lib, { scale, batched });
  S.addHand('left', { 'hand-teleport': {}, 'hand-pointer': {}, 'hand-poke': {}, 'hand-grab': {} });
  S.addHand('right', { 'hand-thumb-tilt': {}, 'hand-pointer': {}, 'hand-poke': {}, 'hand-grab': {} });
  return S;
}
// grasp point in rig space for a hand (palm centre + 0.35 palm below, hand-local -Y)
function graspPoint(h) {
  const w = h.local('wrist'), m = h.local('middle-finger-phalanx-proximal');
  const palm = w.distanceTo(m);
  return w.clone().lerp(m, 0.6).add(new THREE.Vector3(0, -1, 0).applyQuaternion(h.quat()).multiplyScalar(0.35 * palm));
}
// Distance along the palm normal from the palm surface to the
// block's nearest corner (what the snap aims to make 0.004 m)
function snugGap(h, cube) {
  const w = h.local('wrist'), m = h.local('middle-finger-phalanx-proximal'), palm = w.distanceTo(m);
  const n = new THREE.Vector3(0, -1, 0).applyQuaternion(h.quat());
  const pp = w.clone().lerp(m, 0.6).addScaledVector(n, 0.15 * palm);
  const b = new THREE.Box3().setFromObject(cube.object3D);
  let s = Infinity;
  for (let i = 0; i < 8; i++) { const c = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z); s = Math.min(s, c.sub(pp).dot(n)); }
  return s;
}
const closeHand = (S, h, ms = 150) => over(S, ms, (k) => { for (const f of ['index', 'middle', 'ring', 'pinky']) h.curl[f] = 0.05 + 0.95 * k; });
const openHand = (S, h, ms = 150) => over(S, ms, (k) => { for (const f of ['index', 'middle', 'ring', 'pinky']) h.curl[f] = 1 - 0.95 * k; });

for (const scale of [0.75, 1, 1.25]) {
  const tag = ' @' + scale;
  // 1. Open hand at a block, close → grabbed; move; open → released where it is
  { const S = setup(scale); relaxed(S.hands.left); const h = S.hands.right; open(h); S.tick(3);
    const g = graspPoint(h); const cube = S.addObject('cube', new THREE.BoxGeometry(0.07, 0.07, 0.07), [g.x, g.y, g.z], ['.grabbable']);
    S.tick(5); closeHand(S, h);
    const grabbed = cube.log.includes('grabstart');
    S.tick(15);                                     // snap settles
    const gap = snugGap(h, cube);
    const y0 = cube.object3D.position.y;
    over(S, 100, (k) => { h.wrist.y = 1.3 + 0.2 * k; });
    const moved = cube.object3D.position.y - y0;
    openHand(S, h); S.tick(3);
    const released = cube.log.includes('grabend');
    const y1 = cube.object3D.position.y; S.tick(10); const stays = Math.abs(cube.object3D.position.y - y1) < 1e-6;
    check('open → close at a block grabs it' + tag, grabbed);
    check('it settles against the palm' + tag, Math.abs(gap - 0.004) < 0.002, 'gap ' + (gap * 100).toFixed(2) + ' cm');
    check('it follows the hand' + tag, Math.abs(moved - 0.2) < 0.01, 'moved ' + moved.toFixed(3));
    check('opening the hand lets go' + tag, released && stays); }
  // 1b. A block held a few cm off the palm is drawn in to touch it
  { const S = setup(scale); relaxed(S.hands.left); const h = S.hands.right; open(h); S.tick(3);
    const g = graspPoint(h); const cube = S.addObject('cube', new THREE.BoxGeometry(0.07, 0.07, 0.07), [g.x, g.y - 0.045, g.z], ['.grabbable']);
    S.tick(5); const before = snugGap(h, cube); closeHand(S, h); S.tick(15);
    check('a block off the palm is drawn in' + tag, cube.log.includes('grabstart') && Math.abs(snugGap(h, cube) - 0.004) < 0.002,
      (before * 100).toFixed(1) + ' cm → ' + (snugGap(h, cube) * 100).toFixed(2) + ' cm'); }
  // 2. Fist moved into a block (never open there) → no grab
  { const S = setup(scale); relaxed(S.hands.left); const h = S.hands.right;
    h.curl = { index: 1, middle: 1, ring: 1, pinky: 1 }; h.wrist.x = 0.6; S.tick(5);
    const g = graspPoint(h); const cube = S.addObject('cube', new THREE.BoxGeometry(0.07, 0.07, 0.07), [g.x - 0.4, g.y, g.z], ['.grabbable']);
    over(S, 200, (k) => { h.wrist.x = 0.6 - 0.4 * k; }); S.tick(10);
    check('fist moved into a block does not grab' + tag, !cube.log.includes('grabstart')); }
  // 3. Pinch at a block → no grab, no teleport (left hand)
  { const S = setup(scale); relaxed(S.hands.right); const h = S.hands.left; open(h); S.tick(3);
    const g = graspPoint(h); const cube = S.addObject('cube', new THREE.BoxGeometry(0.07, 0.07, 0.07), [g.x, g.y, g.z], ['.grabbable']);
    S.tick(5);
    over(S, 80, (k) => { h.curl.index = 0.05 + 0.35 * k; }); h.thumbTip = h.handLocal('index-finger-tip'); S.tick(2);
    S.pinch('left', true); S.tick(10); S.pinch('left', false); S.tick(3);
    check('pinch at a block: no grab' + tag, !cube.log.includes('grabstart'));
    check('pinch at a block: no teleport' + tag, !S.handEls.left.log.includes('teleported')); }
  // 4. Pinch in open space still teleports
  { const S = setup(scale); relaxed(S.hands.right); open(S.hands.left); S.tick(3);
    S.pinch('left', true); S.tick(5); S.pinch('left', false); S.tick(2);
    check('pinch away from objects teleports' + tag, S.handEls.left.log.includes('teleported')); }
  // 5. Holding a block with the right hand: thumbs-up tilt doesn't turn
  { const S = setup(scale); relaxed(S.hands.left); const h = S.hands.right; open(h); S.tick(3);
    S.sceneEl.systems['hand-thumb-tilt'].activeHand = 'right';
    const g = graspPoint(h); const cube = S.addObject('cube', new THREE.BoxGeometry(0.07, 0.07, 0.07), [g.x, g.y, g.z], ['.grabbable']);
    S.tick(5); closeHand(S, h);
    h.thumb = { dir: new THREE.Vector3(0.05, 1, -0.1).normalize(), bend: 0 }; S.tick(30);
    over(S, 100, (k) => { const a = THREE.MathUtils.degToRad(50 * k); h.thumb = { dir: new THREE.Vector3(Math.sin(a), Math.cos(a), -0.1).normalize(), bend: 0 }; });
    S.tick(30);
    check('holding: thumbs-up tilt does not turn' + tag, cube.log.includes('grabstart') && S.yawDeg() === 0, 'yaw ' + S.yawDeg()); }
  // 6. Pointer trigger pull at a far target with a block nowhere near: no grab events
  { const S = setup(scale); relaxed(S.hands.left); const h = S.hands.right;
    h.curl = { index: 0, middle: 1, ring: 1, pinky: 1 }; S.tick(15);
    over(S, 130, (k) => { h.curl.index = k; }); S.tick(5);
    check('trigger pull grabs nothing' + tag, !S.handEls.right.log.includes('grabstart')); }
}
let fail = 0;
for (const r of res) { if (!r.ok) fail++; console.log((r.ok ? 'pass ' : 'FAIL ') + r.n + (r.ok ? '' : '  ' + r.note)); }
console.log(fail ? fail + ' failed' : 'all ' + res.length + ' passed');
process.exitCode = fail ? 1 : 0;
