// Builds dist/aframe-hand-interaction.js (one file, no dependencies
// besides A-Frame) from the src/ fragments, then the minified copy.
//   node build.mjs          build
//   node build.mjs --check  fail if dist/ is out of date with src/
// The fragments share one scope (an IIFE), in file-name order:
// 00-header.js sits outside it (licence comment + AFRAME check).
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const srcDir = path.join(root, 'src');
const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js')).sort();
const [header, ...body] = files.map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'));

const out = header.replace('{{VERSION}}', pkg.version) + '\n' +
  "(function () {\n'use strict';\n\n" + body.join('\n') + '\n})();\n';

const dist = path.join(root, 'dist', 'aframe-hand-interaction.js');
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(dist) ? fs.readFileSync(dist, 'utf8') : '';
  if (cur !== out) { console.error('dist/ is out of date: run npm run build'); process.exit(1); }
  console.log('dist/ is up to date');
  process.exit(0);
}
fs.mkdirSync(path.dirname(dist), { recursive: true });
fs.writeFileSync(dist, out);
new Function(out);                       // syntax check
const terser = path.join(root, 'node_modules', '.bin', 'terser');
execFileSync(fs.existsSync(terser) ? terser : 'npx', [
  ...(fs.existsSync(terser) ? [] : ['--yes', 'terser']),
  dist, '-c', '-m', '--comments', '/^!/', '-o', dist.replace(/\.js$/, '.min.js'),
], { stdio: 'inherit' });
console.log('built v' + pkg.version + ': ' + files.length + ' source files → dist/');
