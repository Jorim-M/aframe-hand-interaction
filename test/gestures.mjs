// Core gesture scenarios at three hand sizes.
// Usage: node gestures.mjs <library.js> [nobatch]
import * as THREE from 'three';
import { load, scene, over } from './harness.mjs';

const path = process.argv[2];
const batched = process.argv[3] !== 'nobatch';
const lib = load(path);
const D2R = THREE.MathUtils.degToRad;

const LEFT = () => ({
  'hand-teleport': {}, 'hand-pointer': {}, 'hand-poke': {}, 'hand-grab': {},
});
const RIGHT = () => ({
  'hand-thumb-tilt': {}, 'hand-pointer': {}, 'hand-poke': {}, 'hand-grab': {},
});
function setup(scale) {
  const S = scene(lib, { scale, batched });
  S.addHand('left', LEFT());
  S.addHand('right', RIGHT());
  return S;
}
const relaxed = (h) => { h.curl = { index: 0.15, middle: 0.2, ring: 0.2, pinky: 0.2 }; h.thumbTip = null; h.thumb = { dir: new THREE.Vector3(0.6, 0.3, -0.75).normalize(), bend: 0.2 }; };
const pointing = (h) => { h.curl = { index: 0, middle: 1, ring: 1, pinky: 1 }; h.thumbTip = null; h.thumb = { dir: new THREE.Vector3(0.3, -0.2, -0.9).normalize(), bend: 0.3 }; };
const fist = (h) => { h.curl = { index: 1, middle: 1, ring: 1, pinky: 1 }; };

// Thumb-tap targets beside the curled index (hand-local, unscaled)
function tapPoints(h) {
  const a = h.handLocal('index-finger-phalanx-proximal'), b = h.handLocal('index-finger-phalanx-distal');
  const mid = a.clone().add(b).multiplyScalar(0.5);
  return { apart: mid.clone().add(new THREE.Vector3(0.055, 0.03, 0.02)), contact: mid.clone().add(new THREE.Vector3(0.012, 0.008, 0)) };
}
function thumbTap(S, side, pinchToo = false) {
  const h = S.hands[side];
  fist(h);
  const { apart, contact } = tapPoints(h);
  h.thumbTip = apart.clone(); S.tick(30);                 // fist held ~330 ms, thumb away
  over(S, 60, (k) => { h.thumbTip = apart.clone().lerp(contact, k); });
  if (pinchToo) S.pinch(side, true);                    // headset also reports a pinch
  S.tick(8);
  h.thumbTip = apart.clone(); S.tick(8);
  if (pinchToo) S.pinch(side, false);
  S.tick(3);
}

const results = [];
const check = (name, ok, note = '') => results.push({ name, ok, note });

function run(scale) {
  // 1. Tap switches turning on (right hand)
  { const S = setup(scale); relaxed(S.hands.left); thumbTap(S, 'right');
    const on = S.sceneEl.systems['hand-thumb-tilt'].activeHand === 'right';
    check('tap switches turning on', on);
  // 2. Thumbs-up, tilt right → 45° turn
    const h = S.hands.right; fist(h); h.thumbTip = null;
    h.thumb = { dir: new THREE.Vector3(0.05, 1, -0.1).normalize(), bend: 0 }; S.tick(30);
    over(S, 100, (k) => { const a = D2R(50 * k); h.thumb = { dir: new THREE.Vector3(Math.sin(a), Math.cos(a), -0.1).normalize(), bend: 0 }; });
    S.tick(30);
    check('thumbs-up tilt turns', S.yawDeg() === -45, 'yaw ' + S.yawDeg()); }

  // 3. Point at a far button + trigger → click
  { const S = setup(scale); relaxed(S.hands.left);
    const h = S.hands.right; pointing(h); S.tick(2);
    const o = h.local('index-finger-tip');
    const btn = S.addObject('farButton', new THREE.BoxGeometry(0.3, 0.3, 0.05), [o.x, o.y, -3], ['.interactable']);
    S.tick(15);
    over(S, 130, (k) => { h.curl.index = k; });
    S.tick(3);
    over(S, 130, (k) => { h.curl.index = 1 - k; });
    S.tick(3);
    check('point + trigger clicks a far button', btn.log.includes('click'), btn.log.filter((e) => e !== 'mouseenter' && e !== 'mouseleave').join(',') || 'no events'); }

  // 4. Poke a button within reach
  { const S = setup(scale); relaxed(S.hands.left);
    const h = S.hands.right; pointing(h); S.tick(2);
    const tip = h.local('index-finger-tip');
    const btn = S.addObject('nearButton', new THREE.BoxGeometry(0.06, 0.06, 0.02), [tip.x, tip.y, tip.z - 0.05], ['.interactable']);
    S.tick(50);
    over(S, 120, (k) => { h.wrist.z = -0.25 - 0.06 * k; });
    over(S, 120, (k) => { h.wrist.z = -0.31 + 0.08 * k; });
    S.tick(3);
    check('fingertip press clicks a near button', btn.log.includes('click'), btn.log.join(',') || 'no events'); }

  // 5. (grabbing is whole-hand since v2.3: see grip.mjs)

  // 6. Left pinch in open space → teleport
  { const S = setup(scale); relaxed(S.hands.left); relaxed(S.hands.right);
    S.tick(3); S.pinch('left', true); S.tick(5); S.pinch('left', false); S.tick(2);
    check('left pinch teleports', S.handEls.left.log.includes('teleported')); }

  // 7. Left trigger pull at the ground must NOT teleport
  { const S = setup(scale); relaxed(S.hands.right);
    const h = S.hands.left; pointing(h); h.pitch = -D2R(30); S.tick(15);
    over(S, 60, (k) => { h.curl.index = 0.5 * k; });
    S.pinch('left', true);
    over(S, 60, (k) => { h.curl.index = 0.5 + 0.5 * k; });
    S.tick(3);
    over(S, 100, (k) => { h.curl.index = 1 - k; });
    S.pinch('left', false); S.tick(3);
    check('trigger pull (seen as a pinch) does not teleport', !S.handEls.left.log.includes('teleported')); }

  // 8. Thumb tap the headset also reads as a pinch must NOT teleport
  { const S = setup(scale); relaxed(S.hands.right);
    thumbTap(S, 'left', true);
    check('thumb tap (seen as a pinch) does not teleport', !S.handEls.left.log.includes('teleported')); }

  // 9. Trigger pull doesn't toggle turning (right hand)
  { const S = setup(scale); relaxed(S.hands.left);
    const h = S.hands.right; pointing(h); S.tick(15);
    over(S, 130, (k) => { h.curl.index = k; }); S.tick(10);
    over(S, 130, (k) => { h.curl.index = 1 - k; }); S.tick(5);
    check('trigger pull does not toggle turning', !S.handEls.right.log.includes('thumbtilttoggle')); }
}

const report = {};
for (const scale of [0.75, 1, 1.25]) {
  results.length = 0;
  try { run(scale); } catch (e) { results.push({ name: 'CRASH', ok: false, note: e.message.split('\n')[0] }); }
  report[scale] = results.slice();
}
const names = report[1].map((r) => r.name);
console.log('scenario'.padEnd(52) + '75%    100%   125%');
for (const n of names) {
  const cells = [0.75, 1, 1.25].map((s) => { const r = report[s].find((x) => x.name === n); return r ? (r.ok ? 'pass' : 'FAIL') : '-'; });
  const notes = [0.75, 1, 1.25].map((s) => { const r = report[s].find((x) => x.name === n); return r && !r.ok && r.note ? r.note : ''; }).filter(Boolean);
  console.log(n.padEnd(52) + cells.map((c) => c.padEnd(7)).join('') + (notes.length ? '  ' + notes[0] : ''));
}
const crash = Object.values(report).flat().filter((r) => r.name === 'CRASH');
if (crash.length) console.log('CRASH:', crash[0].note);
const failed = Object.values(report).flat().filter((r) => !r.ok).length;

// Joint reads per frame with the full playground setup on both hands
{ const S = setup(1); relaxed(S.hands.left); relaxed(S.hands.right); S.tick(5); S.resetCalls(); S.tick(10);
  const c = S.calls();
  console.log('\nper frame, both hands, all components: ' + (c.fillCalls / 10) + ' batched joint reads + ' + (c.poseCalls / 10) + ' single joint reads'); }
console.log(failed ? failed + ' failed' : 'all ' + Object.values(report).flat().length + ' passed');
process.exitCode = failed ? 1 : 0;
