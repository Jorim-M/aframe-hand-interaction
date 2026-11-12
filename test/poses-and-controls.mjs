// hand-pose, push-button, hand-slider. Usage: node newctl.mjs <library.js> [nobatch]
import * as THREE from 'three';
import { load, scene, entity, over } from './harness.mjs';
const lib = load(process.argv[2]);
const batched = process.argv[3] !== 'nobatch';
const res = []; const check = (n, ok, note = '') => res.push({ n, ok, note });
const D2R = THREE.MathUtils.degToRad;
const setCurl = (h, c) => { h.curl = { index: c[0], middle: c[1], ring: c[2], pinky: c[3] }; h.thumbTip = null; };
const OPEN = [0.02, 0.02, 0.02, 0.02], FIST = [1, 1, 1, 1], POINT = [0, 1, 1, 1], HORNS = [0, 1, 1, 0];
function attach(S, el, name, data) {
  const def = lib.comps[name]; const c = Object.create(def); c.el = el; c.system = S.sceneEl.systems[name]; c.data = {};
  for (const k in def.schema) c.data[k] = def.schema[k].default;
  Object.assign(c.data, data); el.components[name] = c; c.init(); return c;
}

// ── POSES: record with the right hand at scale 1, test everywhere ──
const rec = scene(lib, { scale: 1, batched });
rec.addHand('left', {}); rec.addHand('right', {});
const sys = rec.sceneEl.systems['hand-pose'];
const shots = {};
for (const [name, c] of [['open', OPEN], ['fist', FIST], ['point', POINT]]) { setCurl(rec.hands.right, c); rec.tick(1); shots[name] = sys.capture('right'); }
const dOF = sys.distance(Float32Array.from(shots.open.joints), Float32Array.from(shots.fist.joints));
const dOP = sys.distance(Float32Array.from(shots.open.joints), Float32Array.from(shots.point.joints));
console.log('pose distances (palm lengths): open-fist ' + dOF.toFixed(3) + ', open-point ' + dOP.toFixed(3));

for (const scale of [0.75, 1, 1.25]) {
  for (const side of ['right', 'left']) {
    const tag = ' (' + side + ' @' + scale + ')';
    const S = scene(lib, { scale, batched });
    const hl = S.addHand('left', {}), hr = S.addHand('right', {});
    const hEl = side === 'left' ? hl : hr; const h = S.hands[side];
    for (const k in shots) S.sceneEl.systems['hand-pose'].define(k, shots[k]);
    const c = attach(S, hEl, 'hand-pose', { hand: side });
    const run = (n) => { for (let i = 0; i < n; i++) { S.tick(1); c.tick(S.sceneEl.time); } };
    h.yaw = D2R(35); h.pitch = D2R(-25);                      // a different hand orientation from the recording
    setCurl(h, OPEN); run(12);
    check('open hand → posestart open' + tag, c.current === 'open', JSON.stringify(c.best));
    setCurl(h, FIST); run(12);
    check('close it → open ends, fist starts' + tag, hEl.log.includes('poseend') && c.current === 'fist', JSON.stringify(c.best));
    setCurl(h, HORNS); run(12);
    check('an unrecorded shape (horns) → no pose' + tag, c.current === null, JSON.stringify(c.best));
    setCurl(h, [0.08, 0.1, 0.1, 0.12]); run(12);
    check('an open hand with fingers bent ~8° still counts as open' + tag, c.current === 'open', JSON.stringify(c.best));
    // per-pose threshold: loosen "open" so a clearly relaxed hand counts
    S.sceneEl.systems['hand-pose'].define('open', Object.assign({}, shots.open, { threshold: 0.2 }));
    setCurl(h, FIST); run(12); setCurl(h, [0.15, 0.2, 0.2, 0.25]); run(12);
    check('per-pose threshold: relaxed hand counts as a loosened open' + tag, c.current === 'open', JSON.stringify(c.best));
    S.sceneEl.systems['hand-pose'].define('open', shots.open);
    // a one-frame flicker must not start a pose
    setCurl(h, HORNS); run(12); const before = hEl.log.filter((e) => e === 'posestart').length;
    setCurl(h, FIST); run(1); setCurl(h, HORNS); run(10);
    check('a one-frame glimpse does not start a pose' + tag, hEl.log.filter((e) => e === 'posestart').length === before);
  }
}

// ── PUSH BUTTON ──
for (const scale of [0.75, 1, 1.25]) {
  const tag = ' @' + scale;
  const S = scene(lib, { scale, batched }); S.addHand('left', {}); S.addHand('right', {});
  const h = S.hands.right; setCurl(h, POINT); h.pitch = D2R(-60); S.tick(2);
  const tip = h.local('index-finger-tip');
  const btn = S.addObject('btn', new THREE.CylinderGeometry(0.03, 0.03, 0.02, 16), [tip.x, tip.y - 0.03 - 0.01, tip.z], []);
  const c = attach(S, btn, 'push-button', {});
  const restY = btn.object3D.position.y;
  const run = (n) => { for (let i = 0; i < n; i++) { S.tick(1); c.tick(S.sceneEl.time, 11); } };
  run(5);
  over({ tick: () => run(1) }, 150, (k) => { h.wrist.y = 1.3 - 0.036 * k; });   // tip 6 mm into travel (top 30 mm below)
  const half = restY - btn.object3D.position.y;
  check('cap follows the fingertip part-way' + tag, Math.abs(half - 0.006) < 0.0015 && !btn.log.includes('click'), (half * 1000).toFixed(1) + ' mm');
  over({ tick: () => run(1) }, 100, (k) => { h.wrist.y = 1.264 - 0.012 * k; });  // to the bottom
  check('clicks once at the bottom' + tag, btn.log.filter((e) => e === 'click').length === 1, btn.log.join(','));
  over({ tick: () => run(1) }, 100, (k) => { h.wrist.y = 1.252 - 0.006 * k; }); run(5);
  check('pushing further: no second click, cap stays at its travel' + tag, btn.log.filter((e) => e === 'click').length === 1 && Math.abs(restY - btn.object3D.position.y - 0.012) < 1e-4);
  over({ tick: () => run(1) }, 150, (k) => { h.wrist.y = 1.246 + 0.08 * k; }); run(20);
  check('lift off: buttonup and springs back' + tag, btn.log.includes('buttonup') && Math.abs(btn.object3D.position.y - restY) < 1e-6);
  // Side entry: finger comes in sideways below the top surface
  h.wrist.y = 1.3 - 0.045; h.wrist.x += 0.1; run(5);
  over({ tick: () => run(1) }, 200, (k) => { h.wrist.x = (0.2 + 0.1) - 0.1 * k; }); run(5);
  check('finger slid in from the side: no click' + tag, btn.log.filter((e) => e === 'click').length === 1);
}

// ── SLIDER ──
for (const scale of [0.75, 1, 1.25]) {
  const tag = ' @' + scale;
  const S = scene(lib, { scale, batched }); S.addHand('left', {}); S.addHand('right', {});
  const h = S.hands.right; setCurl(h, POINT); h.pitch = D2R(-60); S.tick(2);
  const tip = h.local('index-finger-tip');
  const knob = S.addObject('knob', new THREE.BoxGeometry(0.03, 0.03, 0.03), [tip.x, tip.y - 0.03, tip.z], []);
  const c = attach(S, knob, 'hand-slider', { axis: 'x', length: 0.2, value: 0.5 });
  const run = (n) => { for (let i = 0; i < n; i++) { S.tick(1); c.tick(S.sceneEl.time, 11); } };
  run(5);
  check('untouched: value stays 0.5' + tag, c.value === 0.5);
  over({ tick: () => run(1) }, 100, (k) => { h.wrist.y = 1.3 - 0.025 * k; }); run(2);
  const x0 = h.wrist.x;
  over({ tick: () => run(1) }, 200, (k) => { h.wrist.x = x0 + 0.06 * k; }); run(2);
  check('drag 6 cm right → value ≈ 0.8' + tag, Math.abs(c.value - 0.8) < 0.02 && knob.log.includes('slidestart'), c.value.toFixed(3));
  over({ tick: () => run(1) }, 200, (k) => { h.wrist.x = x0 + 0.06 + 0.2 * k; }); run(2);
  check('drag past the end → clamps at 1' + tag, c.value === 1, c.value.toFixed(3));
  over({ tick: () => run(1) }, 100, (k) => { h.wrist.y = 1.275 + 0.1 * k; }); run(2);
  check('lift off → slideend' + tag, knob.log.includes('slideend'));
  const v = c.value; h.wrist.x = x0; run(5);
  check('finger elsewhere: value stays' + tag, c.value === v);
}
let fail = 0; for (const r of res) { if (!r.ok) fail++; console.log((r.ok ? 'pass ' : 'FAIL ') + r.n + (r.ok ? '' : '  ' + r.note)); }
console.log(fail ? fail + ' failed' : 'all ' + res.length + ' passed');
process.exitCode = fail ? 1 : 0;
