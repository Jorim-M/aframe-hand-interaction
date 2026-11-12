// ═══════════════════════════════════════════════════════════
// NEAR-FIELD — touching and holding things within reach.
// ═══════════════════════════════════════════════════════════

// Bounding box of an entity's VISIBLE meshes only, so invisible
// far-pointing hit boxes don't make a poke fire early
const _meshBox = new THREE.Box3();
function visibleBox(obj, out) {
  out.makeEmpty();
  obj.updateMatrixWorld();
  obj.traverseVisible((o) => {
    if (!o.isMesh || !o.geometry) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    _meshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
    out.union(_meshBox);
  });
  return out;
}

// ─────────────────────────────────────────────────────────
// HAND POKE — the index fingertip presses objects it touches.
// Entering an object sends mouseenter + mousedown; leaving it
// sends mouseup + click + mouseleave, like pressing and letting
// go of a physical button. Detail: { cursorEl, intersection,
// hand, source: 'poke' }. The index finger must be extended, so
// a fist or a grab doesn't press things. Sets `near` while the
// fingertip is close to a target (hand-pointer steps aside).
// ─────────────────────────────────────────────────────────
AFRAME.registerComponent('hand-poke', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.interactable' },
    enterMargin: { default: 0.005 },   // touch counts this close to the surface (m)
    exitMargin: { default: 0.015 },    // must pull back this far to release (m)
    fingerExtended: { default: 0.8 },  // index straightness above this = extended
    nearDistance: { default: 0.15 },   // fingertip this close to a target = near-field (m)
    highlight: { default: true },      // tint the object while pressed
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.pokedEl = null;
    this.near = false;
    this.targetEls = [];
    this.lastRefresh = -1e9;
    this.boxes = new Map();
    this._tip = new THREE.Vector3();
  },

  send: function (name, el) {
    el.emit(name, {
      cursorEl: this.el,
      intersection: { point: this._tip.clone(), distance: 0, object: el.object3D },
      hand: this.data.hand,
      source: 'poke',
    });
  },

  release: function (withClick) {
    const el = this.pokedEl;
    if (!el) return;
    this.pokedEl = null;
    this.send('mouseup', el);
    if (withClick) this.send('click', el);
    if (this.data.highlight) this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, false);
    el.removeState('cursor-hovered');
    this.send('mouseleave', el);
  },

  boxOf: function (el) {
    const box = visibleBox(el.object3D, this.boxes.get(el) || new THREE.Box3());
    this.boxes.set(el, box);
    return box;
  },

  tick: function (time) {
    const h = this.el.sceneEl.systems['hand-input'].get(this.data.hand, this.rigEl.object3D);
    if (!h || !h.has['index-finger-tip']) { this.near = false; this.release(false); return; }
    this._tip.copy(h.world['index-finger-tip']);
    const straight = h.straight('index');
    const extended = straight !== null && straight > this.data.fingerExtended;
    const grab = this.el.components['hand-grab'];
    const holding = grab && grab.heldEl;

    if (time - this.lastRefresh > 500) {
      this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
      this.lastRefresh = time;
    }

    // Near-field: fingertip close to any target (hand-pointer steps aside)
    this.near = false;
    for (const el of this.targetEls) {
      if (!el.object3D.visible) continue;
      const box = this.boxOf(el);
      if (!box.isEmpty() && box.distanceToPoint(this._tip) < this.data.nearDistance) { this.near = true; break; }
    }

    // Currently pressing: release once the fingertip pulls back
    if (this.pokedEl) {
      const box = this.boxOf(this.pokedEl);
      if (!box.isEmpty() && box.expandByScalar(this.data.exitMargin).containsPoint(this._tip)) return;
      this.release(extended && !holding);
      return;
    }
    if (!extended || holding) return;

    for (const el of this.targetEls) {
      if (!el.object3D.visible || el.is('grabbed')) continue;
      // push-button and hand-slider handle the fingertip themselves
      if (el.components && (el.components['push-button'] || el.components['hand-slider'])) continue;
      const box = this.boxOf(el);
      if (box.isEmpty()) continue;
      if (box.expandByScalar(this.data.enterMargin).containsPoint(this._tip)) {
        this.pokedEl = el;
        if (this.data.highlight) this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, true);
        el.addState('cursor-hovered');
        this.send('mouseenter', el);
        this.send('mousedown', el);
        return;
      }
    }
  },

  remove: function () { this.release(false); }
});

// ─────────────────────────────────────────────────────────
// HAND GRAB — whole-hand grip. Bring an open hand to a .grabbable
// so it's against your palm, then close your hand: it's picked up
// and follows the hand rigidly (position and rotation) until you
// open your hand again. Pinches play no part, so grabbing never
// competes with teleport.
//   grip      mean straightness of index, middle and ring
//   open      grip above `openGrip` arms a grab
//   closed    grip below `closeGrip` with an object in the grasp
//             zone grabs it; above `releaseGrip` lets go
// Only an open → closed change grabs: pointing (middle and ring
// already curled), a trigger pull, a thumbs-up or a fist moved
// into an object don't pick anything up.
// Grasp zone: a point just in front of the palm; an object counts
// if its box is within `reach` palm lengths of it. Highlights what
// closing your hand would pick up. Sets `near` while an object is
// close (hand-pointer steps aside, teleport declines).
// Snug fit (snap): on grab the object eases, along the palm's
// normal only, until its nearest side rests against the palm — no
// floating a few centimetres off the hand, no sinking into it. It
// keeps its orientation and sideways position. (handy-work snaps the
// hand to the object; here the object comes to the hand, which
// needs no control over the hand model.)
// Grabbing what the other hand holds passes it over.
// Events on the object: grabstart / grabend ({ hand, handEl });
// on the hand: grabstart / grabend ({ el }). State: 'grabbed'.
// ─────────────────────────────────────────────────────────
AFRAME.registerSystem('hand-grab', {
  init: function () { this.holders = new Map(); } // el → component
});

AFRAME.registerComponent('hand-grab', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.grabbable' },
    openGrip: { default: 0.8 },         // grip above this = open hand (arms a grab)
    closeGrip: { default: 0.68 },       // grip below this = closed: grab
    releaseGrip: { default: 0.78 },     // grip above this while holding = let go
    reach: { default: 0.6 },            // grasp zone radius, in palm lengths (~6 cm)
    palmOffset: { default: 0.35 },      // grasp point in front of the palm, palm lengths
    snap: { default: true },            // ease the object against the palm on grab
    snapMs: { default: 100 },           // how long that takes
    palmThickness: { default: 0.15 },   // palm surface below the joints, palm lengths
    snapGap: { default: 0.004 },        // gap left between palm and object (m)
    snapMax: { default: 0.08 },         // never move an object further than this (m)
    nearDistance: { default: 0.15 },    // object this close to the grasp point = near-field (m)
    highlight: { default: true },       // tint what closing the hand would pick up
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.heldEl = null;
    this.nearEl = null;   // highlighted: what closing the hand would pick up
    this.near = false;
    this.armed = false;   // hand has been open since the last grab
    this.grip = null;
    this.targetEls = [];
    this.lastRefresh = -1e9;
    this.offset = new THREE.Matrix4();
    this._handM = new THREE.Matrix4();
    this._m = new THREE.Matrix4();
    this._parentInv = new THREE.Matrix4();
    this._wristPos = new THREE.Vector3();
    this._wristQuat = new THREE.Quaternion();
    this._grasp = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._box = new THREE.Box3();
    this._center = new THREE.Vector3();
    this._one = new THREE.Vector3(1, 1, 1);
    this._palmPt = new THREE.Vector3();
    this._corner = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._qInv = new THREE.Quaternion();
    this.snapFrom = new THREE.Vector3();
    this.snapTo = new THREE.Vector3();
    this.snapStart = -1;
  },

  // World-space wrist pose, grasp point and grip; false if not tracked
  readHand: function () {
    const h = this.el.sceneEl.systems['hand-input'].get(this.data.hand, this.rigEl.object3D);
    if (!h || !h.ok('wrist', 'middle-finger-phalanx-proximal')) return false;
    this._wristPos.copy(h.world.wrist);
    this._wristQuat.copy(h.wristQuatWorld);
    // Palm centre, pushed out along the palm normal (-Y of the wrist)
    this._grasp.lerpVectors(h.world.wrist, h.world['middle-finger-phalanx-proximal'], 0.6);
    this._n.set(0, -1, 0).applyQuaternion(this._wristQuat);
    this._palmPt.copy(this._grasp).addScaledVector(this._n, this.data.palmThickness * h.palm);
    this._grasp.addScaledVector(this._n, this.data.palmOffset * h.palm);
    this.palm = h.palm;
    const i = h.straight('index'), m = h.straight('middle'), r = h.straight('ring');
    this.grip = (i === null || m === null || r === null) ? null : (i + m + r) / 3;
    return true;
  },

  // Nearest grabbable within reach of the grasp point. Also sets
  // this.near. Call after readHand().
  findTarget: function () {
    this.near = false;
    const now = this.el.sceneEl.time || 0;
    if (now - this.lastRefresh > 500 || !this.targetEls.length) {
      this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
      this.lastRefresh = now;
    }
    const reach = this.data.reach * this.palm;
    let best = null, bestD = Infinity;
    for (const el of this.targetEls) {
      if (!el.object3D.visible) continue;
      visibleBox(el.object3D, this._box);
      if (this._box.isEmpty()) continue;
      const d = this._box.distanceToPoint(this._grasp);
      if (d < this.data.nearDistance) this.near = true;
      if (d > reach) continue;
      const dc = this._box.getCenter(this._center).distanceTo(this._grasp);
      if (dc < bestD) { bestD = dc; best = el; }
    }
    return best;
  },

  grab: function (el) {
    const holders = this.system.holders;
    const other = holders.get(el);
    if (other && other !== this) other.release();
    this._handM.compose(this._wristPos, this._wristQuat, this._one);
    el.object3D.updateMatrixWorld();
    this.offset.copy(this._handM).invert().multiply(el.object3D.matrixWorld);
    this.snapStart = -1;
    if (this.data.snap) this.planSnap(el);
    this.heldEl = el;
    holders.set(el, this);
    el.addState('grabbed');
    el.emit('grabstart', { hand: this.data.hand, handEl: this.el });
    this.el.emit('grabstart', { el: el });
  },

  // Where the object should sit: move it along the palm normal until
  // its box's nearest corner is snapGap from the palm surface
  planSnap: function (el) {
    visibleBox(el.object3D, this._box);
    if (this._box.isEmpty()) return;
    const b = this._box;
    let s = Infinity;
    for (let i = 0; i < 8; i++) {
      this._corner.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
      s = Math.min(s, this._corner.sub(this._palmPt).dot(this._n));
    }
    let move = this.data.snapGap - s;
    if (Math.abs(move) < 0.001) return;
    move = Math.max(-this.data.snapMax, Math.min(this.data.snapMax, move));
    // World shift → hand-local, applied to the offset's translation
    this._delta.copy(this._n).multiplyScalar(move).applyQuaternion(this._qInv.copy(this._wristQuat).invert());
    this.snapFrom.setFromMatrixPosition(this.offset);
    this.snapTo.copy(this.snapFrom).add(this._delta);
    this.snapStart = this.el.sceneEl.time || 0;
  },

  release: function () {
    const el = this.heldEl;
    if (!el) return;
    this.heldEl = null;
    this.snapStart = -1;
    if (this.system.holders.get(el) === this) this.system.holders.delete(el);
    el.removeState('grabbed');
    el.emit('grabend', { hand: this.data.hand, handEl: this.el });
    this.el.emit('grabend', { el: el });
  },

  setNear: function (el) {
    if (el === this.nearEl) return;
    const hl = this.el.sceneEl.systems['hand-highlight'];
    if (this.data.highlight && this.nearEl) hl.set(this.nearEl, this.data.highlightColor, false);
    this.nearEl = el;
    if (this.data.highlight && el) hl.set(el, this.data.highlightColor, true);
  },

  tick: function () {
    if (!this.readHand()) {
      this.near = false; this.armed = false;
      this.release();                 // tracking lost: drop it
      this.setNear(null);
      return;
    }
    const d = this.data, grip = this.grip;

    if (this.heldEl) {
      if (grip !== null && grip > d.releaseGrip) {
        this.release();
        this.armed = true;
      } else {
        this.follow();
        return;
      }
    }

    // Not holding: highlight what closing the hand here would pick up
    const target = this.findTarget();
    if (grip === null) { this.setNear(null); return; }
    if (grip > d.openGrip) this.armed = true;
    this.setNear(this.armed ? target : null);
    if (this.armed && grip < d.closeGrip) {
      this.armed = false;
      if (target) this.grab(target);
    }
  },

  // object world = hand world × grab offset, then into parent space
  follow: function () {
    if (this.snapStart >= 0) {
      const t = Math.min(1, ((this.el.sceneEl.time || 0) - this.snapStart) / Math.max(1, this.data.snapMs));
      const k = 1 - (1 - t) * (1 - t);                       // ease out
      this._delta.lerpVectors(this.snapFrom, this.snapTo, k);
      this.offset.setPosition(this._delta);
      if (t >= 1) this.snapStart = -1;
    }
    this._handM.compose(this._wristPos, this._wristQuat, this._one);
    this._m.multiplyMatrices(this._handM, this.offset);
    const obj = this.heldEl.object3D;
    if (obj.parent) {
      obj.parent.updateMatrixWorld();
      this._m.premultiply(this._parentInv.copy(obj.parent.matrixWorld).invert());
    }
    this._m.decompose(obj.position, obj.quaternion, obj.scale);
  },

  remove: function () {
    this.release();
    this.setNear(null);
  }
});
