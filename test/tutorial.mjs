// Tutorial: steps, order, panel placement (fixed in the world, mounts).
// Usage: node tutorial.mjs <library.js>
import * as THREE from 'three';
import fs from 'fs';
globalThis.THREE = THREE;
let now = 0; Object.defineProperty(globalThis, 'performance', { value: { now: () => now }, configurable: true });
const store = {}; globalThis.localStorage = { getItem:k=>store[k]??null, setItem:(k,v)=>store[k]=v, removeItem:k=>delete store[k] };
const comps = {}, systems = {};
globalThis.AFRAME = { registerComponent:(n,d)=>comps[n]=d, registerSystem:(n,d)=>systems[n]=d };
const mkEl = () => { const el = { object3D:new THREE.Object3D(), attrs:{}, listeners:{}, children:[], classList:{ add(){} },
  setAttribute(n,a,b){ if (b!==undefined) { if (typeof this.attrs[n]!=='object') this.attrs[n]={}; this.attrs[n][a]=b; } else this.attrs[n]=a; },
  appendChild(c){ this.children.push(c); c.parentNode=this; }, addEventListener(n,f){ (this.listeners[n] ||= []).push(f); },
  removeEventListener(){}, emit(n,d){ (this.listeners[n]||[]).forEach(f=>f({type:n,detail:d,target:this})); } }; return el; };
const head = mkEl(); head.object3D.position.set(0,1.6,0);
const present = ['hand-teleport','hand-thumb-tilt','hand-pointer','hand-poke','hand-grab'];
const handFor = { 'hand-teleport': ['left'], 'hand-thumb-tilt': ['right'], 'hand-pointer': ['left','right'], 'hand-poke': ['left','right'], 'hand-grab': ['left','right'] };
const fakeHands = c => (handFor[c] || []).map(h => ({ components: { [c]: { data: { hand: h } } } }));
globalThis.document = { createElement: mkEl,
  querySelector: s => s==='#head' ? head : (present.some(p=>s==='['+p+']') ? {} : null),
  querySelectorAll: s => { const m = /^\[(.+)\]$/.exec(s); return m ? fakeHands(m[1]) : []; } };
eval(fs.readFileSync(process.argv[2],'utf8'));
const sceneEl = mkEl(); sceneEl.systems = { 'hand-thumb-tilt': { activeHand: null }, 'tutorial-mount': { mounts: [] } };
const mountEl = mkEl(); mountEl.object3D.position.set(5,1.5,-5); mountEl.object3D.updateMatrixWorld();
sceneEl.systems['tutorial-mount'].mounts.push({ el: mountEl, data: { steps: ['point'], scale: 1.5 } }); sceneEl.is = () => true;
const tut = Object.create(comps['hand-tutorial']); tut.data = {}; for (const k in comps['hand-tutorial'].schema) tut.data[k] = comps['hand-tutorial'].schema[k].default;
const emitted = []; tut.el = { sceneEl, emit:(n,d)=>emitted.push(n+(d?':'+d.key:'')) }; tut.init();
const body = () => tut.bodyEl.attrs.text.value.split('\n')[0];
const full = () => tut.bodyEl.attrs.text.value.split('\n').slice(2).join(' ');
const step = () => tut.progressEl.attrs.text.value;
const wait = ms => { for (let e = now + ms; now < e; now += 16) tut.tick(now, 16); };
const fire = (n, d, target = sceneEl) => sceneEl.listeners[n]?.forEach(f => f({ type:n, detail:d, target }));
const ptrHand = { components: { 'hand-pointer': {} } };

sceneEl.emit('enter-vr'); wait(50); console.log('enter VR:', step(), '-', body(), '| panel visible', tut.panel.attrs.visible);
console.log('  text:', full());
fire('teleported', {}); console.log('teleported ->', body()); wait(1000); console.log('then:', step(), '-', body());
console.log('  text:', full());
fire('thumbtilttoggle', { enabled:false }); console.log('toggle OFF ignored ->', body());
fire('thumbtilttoggle', { enabled:true }); wait(1000); console.log('toggle ON ->', step(), '-', body());
console.log('  text:', full());
fire('snapturn', { direction:'left' }); wait(1000); console.log('snapturn ->', step(), '-', body());
console.log('  text:', full());
fire('thumbtilttoggle', { enabled:true }); console.log('toggle ON again ignored ->', body());
fire('thumbtilttoggle', { enabled:false }); wait(1000); console.log('toggle OFF ->', step(), '-', body());
fire('click', { source:'poke', cursorEl: ptrHand }); console.log('poke click on point step ignored ->', body());
fire('click', { cursorEl: ptrHand }); wait(1000); console.log('pointer click ->', step(), '-', body());
fire('click', { source:'poke', cursorEl: ptrHand }); wait(1000); console.log('poke click ->', step(), '-', body());
fire('grabstart', { hand:'right' }); wait(1000); console.log('grab ->', body()); console.log('  text:', full());
wait(4000); console.log('after final message: active', tut.active, '| visible', tut.panel.attrs.visible, '| stored', store['hand-tutorial-done']);
sceneEl.emit('enter-vr'); console.log('re-enter VR: active', tut.active);
tut.restart(); console.log('restart():', step(), '-', body());
tut.skipEl.emit('click'); console.log('skip: active', tut.active);
console.log('events', emitted.join(', '));

const P = () => tut.panel.object3D.position.toArray().map(v=>v.toFixed(2)).join(',');
let nPass = 0, nFail = 0;
const ok = (n, c) => { c ? nPass++ : nFail++; console.log((c?'PASS ':'FAIL ') + n); };
head.object3D.rotation.y = 0; head.object3D.updateMatrixWorld();
tut.restart(); wait(400);
const p0 = tut.panel.object3D.position.clone();
const ang = THREE.MathUtils.radToDeg(Math.atan2(-p0.x, -p0.z));
ok('unmounted panel to the side (' + ang.toFixed(0) + '° left), ' + p0.distanceTo(new THREE.Vector3(0,1.6,0)).toFixed(2) + ' m: ' + P(), Math.abs(ang - 22) < 2);
ok('panel scaled in to 1', Math.abs(tut.panel.object3D.scale.x - 1) < 0.01);
head.object3D.rotation.y = Math.PI/2; head.object3D.updateMatrixWorld(); wait(1500);
ok('head turned 90° mid-step: panel stays ' + P(), tut.panel.object3D.position.distanceTo(p0) < 1e-6);
ok('...but turns to face the user (yaw ' + THREE.MathUtils.radToDeg(tut.panel.object3D.rotation.y).toFixed(0) + '°)', Math.abs(tut.panel.object3D.rotation.y - Math.atan2(-p0.x, -p0.z)) < 1e-3);
fire('teleported', {}); wait(1000);
const p1 = tut.panel.object3D.position.clone();
ok('next step, panel was out of view: moved beside the new view ' + P(), p1.distanceTo(p0) > 0.5);
head.object3D.rotation.y = Math.PI/2 + 0.3; head.object3D.updateMatrixWorld();
fire('thumbtilttoggle', { enabled:true }); wait(1000);
ok('next step, panel still in view (17° turn): not moved', tut.panel.object3D.position.distanceTo(p1) < 1e-6);
fire('snapturn', {}); wait(1000); fire('thumbtilttoggle', { enabled:false }); wait(1000);
ok('point step: panel at its mount ' + P(), tut.panel.object3D.position.distanceTo(mountEl.object3D.position) < 1e-6);
wait(500); ok('mount scale 1.5 (' + tut.panel.object3D.scale.x.toFixed(2) + ')', Math.abs(tut.panel.object3D.scale.x - 1.5) < 0.01);
fire('click', { cursorEl: ptrHand }); wait(1000);
ok('poke step (no mount): back beside the user ' + P(), tut.panel.object3D.position.distanceTo(new THREE.Vector3(0,1.6,0)) < 1.3);
console.log(nFail ? nFail + ' failed' : 'all ' + nPass + ' passed');
process.exitCode = nFail ? 1 : 0;
