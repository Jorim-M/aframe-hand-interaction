import * as THREE from 'three';
import { load, scene } from './harness.mjs';
// blockEntities: water stops the arc; without it the arc lands through it.
// Usage: node teleport-blocking.mjs <library.js> [nobatch]
const lib = load(process.argv[2]);
function run(withWater, blockSel) {
  const S = scene(lib, { batched: process.argv[3] !== 'nobatch' });
  S.groups['.no-landing'] = [];
  S.addHand('left', { 'hand-teleport': { collisionEntities: '.landable', blockEntities: blockSel } });
  const g = new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2);
  S.addObject('ground', g, [0, 0, 0], ['.landable']);
  if (withWater) S.addObject('water', new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), [0, 0.05, -20], ['.no-landing']);
  const h = S.hands.left; h.curl = { index: 0.15, middle: 0.2, ring: 0.2, pinky: 0.2 };
  S.tick(3); S.pinch('left', true); S.tick(5);
  const tp = S.handEls.left.components['hand-teleport'];
  const info = { valid: tp.hasValidTarget, target: tp.target.toArray().map((v) => v.toFixed(2)).join(','), color: '#' + tp.arc.material.color.getHexString() };
  S.pinch('left', false); S.tick(2);
  info.teleported = S.handEls.left.log.includes('teleported');
  return info;
}
const a = run(false, '.no-landing'), b = run(true, '.no-landing'), c = run(true, '');
console.log('ground only          ', JSON.stringify(a));
console.log('water, blockEntities ', JSON.stringify(b));
console.log('water not listed     ', JSON.stringify(c));
const ok = a.teleported && !b.teleported && !b.valid && c.teleported;
console.log(ok ? 'all 3 passed' : '1 failed');
process.exitCode = ok ? 0 : 1;
