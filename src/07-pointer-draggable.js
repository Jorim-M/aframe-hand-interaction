// ═══════════════════════════════════════════════════════════
// POINTER-DRAGGABLE — trigger-and-hold an object with hand-pointer
// (or press it with A-Frame's cursor) and it follows the ray at the
// distance where you grabbed it, keeping the grab offset.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('pointer-draggable', {
  init: function () {
    this.getRay = null;
    this.distance = 0;
    this.offset = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._worldPos = new THREE.Vector3();

    this.onDown = (e) => {
      const cursorEl = e.detail && e.detail.cursorEl;
      const hit = e.detail && e.detail.intersection;
      if (!cursorEl || !hit) return;
      const hp = cursorEl.components['hand-pointer'];
      const rc = cursorEl.components.raycaster;
      if (hp) {
        if (hp.pressedEl !== this.el) return; // e.g. a poke, not a pointer press
        this.getRay = () => hp.ray;
      }
      else if (rc) this.getRay = () => rc.raycaster.ray;
      else return;
      const ray = this.getRay();
      this.distance = ray.origin.distanceTo(hit.point);
      this.el.object3D.getWorldPosition(this._worldPos);
      this.offset.subVectors(this._worldPos, hit.point);
      this.cursorEl = cursorEl;
      this.el.addState('dragged');
      this.el.emit('dragstart');
    };
    this.onUp = () => {
      if (!this.getRay) return;
      this.getRay = null;
      this.cursorEl = null;
      this.el.removeState('dragged');
      this.el.emit('dragend');
    };
    this.el.addEventListener('mousedown', this.onDown);
    this.el.addEventListener('mouseup', this.onUp);
  },

  tick: function () {
    if (!this.getRay) return;
    // The A-Frame cursor sends mouseup to the cursor only if the
    // mouse is released off this object; catch that case too
    if (this.cursorEl && this.cursorEl.components.cursor &&
        !this.cursorEl.components.cursor.cursorDownEl) { this.onUp(); return; }
    const ray = this.getRay();
    ray.at(this.distance, this._target).add(this.offset);
    const parent = this.el.object3D.parent;
    if (parent) { parent.updateMatrixWorld(); parent.worldToLocal(this._target); }
    this.el.object3D.position.copy(this._target);
  },

  remove: function () {
    this.el.removeEventListener('mousedown', this.onDown);
    this.el.removeEventListener('mouseup', this.onUp);
  }
});
