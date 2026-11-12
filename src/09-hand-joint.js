// ═══════════════════════════════════════════════════════════
// HAND JOINT — put any entity on a hand joint. It follows the
// joint's position and (optionally) orientation every frame, plus
// an offset in the joint's own frame, and hides while the hand
// isn't tracked. The entity should be a child of the scene (not of
// the rig or a hand), since it is placed in world space.
//   <a-entity hand-joint="hand: left; joint: wrist; offset: 0 0.03 0">
// Joints: wrist, thumb-tip, index-finger-tip, middle-finger-phalanx-
// proximal, … (the 25 WebXR joint names). In a joint's frame -Z
// points toward the fingertips and -Y out of the palm, so offset
// "0 -0.04 0" on the wrist sits just off the palm.
// faceHead: ignore the joint's orientation and turn to face you, so
// text on it is always readable.
// palmFacing: emits 'palmup' / 'palmdown' on this entity when the
// palm turns toward / away from your face (for wrist menus), and
// sets the 'palm-facing' state.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('hand-joint', {
  schema: {
    hand: { default: 'left' },
    joint: { default: 'wrist' },
    cameraRig: { default: '#rig' },
    head: { default: '#head' },
    offset: { type: 'vec3', default: { x: 0, y: 0, z: 0 } },
    rotate: { default: true },          // follow the joint's orientation too
    faceHead: { default: false },       // instead, turn to face you (labels, menus)
    hideUntracked: { default: true },
    palmFacing: { default: false },     // emit palmup / palmdown
    facingAngle: { default: 50 },       // palm within this of facing your eyes = up (degrees)
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.headEl = document.querySelector(this.data.head);
    this.facing = false;
    this._q = new THREE.Quaternion();
    this._off = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._toHead = new THREE.Vector3();
    this._parentInv = new THREE.Matrix4();
    this._m = new THREE.Matrix4();
    this._one = new THREE.Vector3(1, 1, 1);
    this._pos = new THREE.Vector3();
    this._s = new THREE.Vector3();
  },

  tick: function () {
    const d = this.data, obj = this.el.object3D;
    const h = this.el.sceneEl.systems['hand-input'].get(d.hand, this.rigEl && this.rigEl.object3D);
    if (!h || !h.has[d.joint] || !h.jointQuatWorld(d.joint, this._q)) {
      if (d.hideUntracked) obj.visible = false;
      this.setFacing(false);
      return;
    }
    obj.visible = true;
    this._off.set(d.offset.x, d.offset.y, d.offset.z).applyQuaternion(this._q);
    this._pos.copy(h.world[d.joint]).add(this._off);
    // World pose → the entity's parent space
    this._m.compose(this._pos, this._q, this._one);
    if (obj.parent) {
      obj.parent.updateMatrixWorld();
      this._m.premultiply(this._parentInv.copy(obj.parent.matrixWorld).invert());
    }
    // Position (and rotation); the entity keeps its own scale
    if (d.rotate && !d.faceHead) this._m.decompose(obj.position, obj.quaternion, this._s);
    else obj.position.setFromMatrixPosition(this._m);
    if (d.faceHead && this.headEl) {
      obj.updateMatrixWorld();
      obj.lookAt(this.headEl.object3D.getWorldPosition(this._toHead));
    }

    if (d.palmFacing && this.headEl) {
      h.jointQuatWorld('wrist', this._q);
      this._n.set(0, -1, 0).applyQuaternion(this._q);              // out of the palm
      this.headEl.object3D.getWorldPosition(this._toHead).sub(h.world.wrist).normalize();
      const angle = THREE.MathUtils.radToDeg(this._n.angleTo(this._toHead));
      // hysteresis: on inside facingAngle, off beyond facingAngle + 15
      if (!this.facing && angle < d.facingAngle) this.setFacing(true);
      else if (this.facing && angle > d.facingAngle + 15) this.setFacing(false);
    }
  },

  setFacing: function (on) {
    if (on === this.facing) return;
    this.facing = on;
    if (on) { this.el.addState('palm-facing'); this.el.emit('palmup'); }
    else { this.el.removeState('palm-facing'); this.el.emit('palmdown'); }
  },
});
