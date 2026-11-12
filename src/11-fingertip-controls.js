// ═══════════════════════════════════════════════════════════
// FINGERTIP CONTROLS — a button that travels with your fingertip,
// and a slider you drag with one. Both read either hand's index
// fingertip directly (hand-poke leaves them alone) and work in the
// entity's own frame, so they can sit on a table, a wall or a
// wrist panel at any angle.
// ═══════════════════════════════════════════════════════════
function localHalfExtents(el, out) {
  const mesh = (el.getObject3D && el.getObject3D('mesh')) || el.object3D;
  const g = mesh && mesh.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  g.boundingBox.getSize(out).multiplyScalar(0.5);
  return out.multiply(el.object3D.scale);
}

// Fingertips of both hands in an entity's PARENT space
function fingertipsInParent(sceneEl, el, rigObj, hands, outs) {
  const input = sceneEl.systems['hand-input'];
  const parent = el.object3D.parent;
  if (parent) parent.updateMatrixWorld();
  let n = 0;
  for (const side of hands) {
    const h = input.get(side, rigObj);
    if (!h || !h.has['index-finger-tip']) continue;
    const s = h.straight('index');
    if (s === null || s < 0.75) continue;            // index must be extended
    const v = outs[n++];
    v.copy(h.world['index-finger-tip']);
    if (parent) parent.worldToLocal(v);
    v.side = side;
  }
  return n;
}

// ─────────────────────────────────────────────────────────
// PUSH BUTTON — the entity is the button cap. Pressed from its top
// (+Y side in its own frame), it moves in with your fingertip up
// to `travel`, clicks (buttondown + click) at clickAt of the
// travel, re-arms below releaseAt (buttonup), and springs back
// when you let go. Pressing in from the side or from below does
// nothing. The pointer can still click it from afar if it is
// .interactable.
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('push-button', {
  schema: {
    travel: { default: 0.012 },         // how far it can be pushed in (m)
    clickAt: { default: 0.85 },         // fraction of travel that clicks
    releaseAt: { default: 0.35 },       // fraction of travel that re-arms
    margin: { default: 0.008 },         // sideways slack around the cap (m)
    returnSpeed: { default: 0.15 },     // spring-back speed (m/s)
    hands: { type: 'array', default: ['left', 'right'] },
    cameraRig: { default: '#rig' },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.rest = this.el.object3D.position.clone();
    this.depth = 0;
    this.pressed = false;
    this.engaged = null;                // side of the finger pressing it
    this.above = { left: false, right: false };
    this._half = new THREE.Vector3();
    this._tips = [new THREE.Vector3(), new THREE.Vector3()];
    this._p = new THREE.Vector3();
    this._inv = new THREE.Quaternion();
    this._axis = new THREE.Vector3();
  },

  // Fingertip in the button's rest frame (origin at rest centre)
  toRest: function (v) {
    this._inv.copy(this.el.object3D.quaternion).invert();
    return this._p.copy(v).sub(this.rest).applyQuaternion(this._inv);
  },

  tick: function (time, dt) {
    const d = this.data;
    if (!localHalfExtents(this.el, this._half)) return;
    const top = this._half.y;
    const n = this.rigEl ? fingertipsInParent(this.el.sceneEl, this.el, this.rigEl.object3D, d.hands, this._tips) : 0;
    let target = 0, presser = null;
    const seen = { left: false, right: false };
    for (let i = 0; i < n; i++) {
      const side = this._tips[i].side;
      const p = this.toRest(this._tips[i]);
      const inside = Math.abs(p.x) <= this._half.x + d.margin && Math.abs(p.z) <= this._half.z + d.margin;
      const push = top - p.y;                       // how far below the rest top surface
      seen[side] = true;
      if (!inside) { this.above[side] = false; continue; }
      if (push <= 0) { this.above[side] = true; continue; }
      // Only a fingertip that came down from above presses it
      if (!this.above[side] && this.engaged !== side) continue;
      if (push > d.travel + 0.04) { this.above[side] = false; continue; } // pushed right through
      if (push > target) { target = push; presser = side; }
    }
    for (const s of ['left', 'right']) if (!seen[s]) this.above[s] = false;
    this.engaged = presser;

    if (presser) this.depth = Math.min(target, d.travel);
    else this.depth = Math.max(0, this.depth - d.returnSpeed * (dt || 16) / 1000);

    this._axis.set(0, 1, 0).applyQuaternion(this.el.object3D.quaternion);
    this.el.object3D.position.copy(this.rest).addScaledVector(this._axis, -this.depth);

    if (!this.pressed && this.depth >= d.travel * d.clickAt) {
      this.pressed = true;
      this.el.addState('pressed');
      this.el.emit('buttondown', { hand: presser });
      this.el.emit('click', { hand: presser, source: 'push-button' });
    } else if (this.pressed && this.depth <= d.travel * d.releaseAt) {
      this.pressed = false;
      this.el.removeState('pressed');
      this.el.emit('buttonup', {});
    }
  },
});

// ─────────────────────────────────────────────────────────
// HAND SLIDER — the entity is the knob. It slides along its
// parent's `axis` within ±length/2 of where it starts, with
// `value` (0–1) setting its starting point. Touch it with a
// fingertip and it follows the finger along the axis until the
// finger moves away. Emits slidestart / change ({ value }) /
// slideend. Set a value from code with el.components['hand-
// slider'].setValue(v).
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('hand-slider', {
  schema: {
    axis: { default: 'x', oneOf: ['x', 'y', 'z'] },
    length: { default: 0.2 },           // travel along the axis (m)
    value: { default: 0.5 },            // starting value, 0–1
    step: { default: 0 },               // snap to steps of this size (0 = smooth)
    grabMargin: { default: 0.012 },     // fingertip this close to the knob takes it (m)
    releaseMargin: { default: 0.035 },  // ...and this far off the axis lets it go (m)
    hands: { type: 'array', default: ['left', 'right'] },
    cameraRig: { default: '#rig' },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    const p = this.el.object3D.position, a = this.data.axis;
    this.center = p.clone();
    this.center[a] -= (this.data.value - 0.5) * this.data.length;
    this.value = this.data.value;
    this.engaged = null;
    this.grabOffset = 0;
    this._half = new THREE.Vector3();
    this._tips = [new THREE.Vector3(), new THREE.Vector3()];
    this._p = new THREE.Vector3();
  },

  setValue: function (v, emit) {
    const d = this.data;
    v = Math.min(1, Math.max(0, v));
    if (d.step > 0) v = Math.round(v / d.step) * d.step;
    this.el.object3D.position[d.axis] = this.center[d.axis] + (v - 0.5) * d.length;
    if (Math.abs(v - this.value) < 1e-4) return;
    this.value = v;
    if (emit !== false) this.el.emit('change', { value: v });
  },

  tick: function () {
    const d = this.data, a = d.axis, pos = this.el.object3D.position;
    if (!localHalfExtents(this.el, this._half)) return;
    const n = this.rigEl ? fingertipsInParent(this.el.sceneEl, this.el, this.rigEl.object3D, d.hands, this._tips) : 0;
    let tip = null;
    for (let i = 0; i < n; i++) {
      const t = this._tips[i];
      if (this.engaged && t.side !== this.engaged) continue;
      this._p.copy(t).sub(pos);
      const off = ['x', 'y', 'z'].filter((k) => k !== a);
      if (this.engaged) {
        // Held: let go once the finger strays off the axis
        if (off.every((k) => Math.abs(this._p[k]) <= this._half[k] + d.releaseMargin)) { tip = t; break; }
      } else if (['x', 'y', 'z'].every((k) => Math.abs(this._p[k]) <= this._half[k] + d.grabMargin)) {
        tip = t;
        this.engaged = t.side;
        this.grabOffset = pos[a] - t[a];          // no jump to the fingertip
        this.el.addState('sliding');
        this.el.emit('slidestart', { value: this.value, hand: t.side });
        break;
      }
    }
    if (!tip) {
      if (this.engaged) {
        this.engaged = null;
        this.el.removeState('sliding');
        this.el.emit('slideend', { value: this.value });
      }
      return;
    }
    const along = tip[a] + this.grabOffset - this.center[a];
    this.setValue(along / d.length + 0.5);
  },
});
