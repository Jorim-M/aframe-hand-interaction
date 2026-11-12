// Runs every test file against the built library, with both ways of
// reading the hand joints (XRFrame.fillPoses in one call, and the
// per-joint getJointPose fallback), and against the minified build.
//   node test/run.mjs          (npm test)
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const libs = ['aframe-hand-interaction.js', 'aframe-hand-interaction.min.js'];
const tests = [
  ['gestures.mjs', true], ['grab.mjs', true], ['joint.mjs', true],
  ['poses-and-controls.mjs', true], ['teleport-blocking.mjs', true], ['tutorial.mjs', false],
];
let failed = 0;
for (const lib of libs) {
  for (const [file, modes] of tests) {
    for (const mode of modes ? ['', 'nobatch'] : ['']) {
      const args = [path.join(here, file), path.join(dist, lib)].concat(mode ? [mode] : []);
      const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
      const lines = (r.stdout || '').trim().split('\n');
      const summary = lines[lines.length - 1];
      const ok = r.status === 0;
      if (!ok) failed++;
      console.log((ok ? 'ok   ' : 'FAIL ') + (lib.includes('.min') ? 'min  ' : 'src  ') + file.padEnd(26) + (mode || 'batched').padEnd(9) + summary);
      if (!ok) console.log((r.stdout || '') + (r.stderr || ''));
    }
  }
}
console.log(failed ? '\n' + failed + ' test runs failed' : '\nall test runs passed');
process.exitCode = failed ? 1 : 0;
