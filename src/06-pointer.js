// ═══════════════════════════════════════════════════════════
// HAND POINTER — point and trigger, for objects out of reach.
// • Point the index finger (middle + ring curled) to show the ray.
//   It stays visible the whole time you point: on an object, a
//   bright cursor and highlight; otherwise it stops on the first
//   `surfaces` mesh with a dim cursor, or at rayLength.
// • Curl the finger like a trigger to press (mousedown), straighten
//   it to release (mouseup, then click if still on the object).
//   Holding the curl and moving drags (see pointer-draggable).
// • The ray runs along the index finger's base bone, which doesn't
//   move when the finger curls, and the target is frozen while the
//   trigger is being pulled, so selecting doesn't knock it off.
// • Off while that hand is near something it can poke or grab,
//   holding something, or aiming a teleport.
// • One hand points at a time (the system's owner).
// • Sends A-Frame cursor events to the object, with detail
//   { cursorEl, intersection, hand }, and the same events on the
//   hand with detail.intersectedEl. Exposes `ray` (world space).
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-pointer', {
  init: function () { this.owner = null; }
});

AFRAME.registerComponent('hand-pointer', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    objects: { default: '.interactable' },
    far: { default: 10 },               // max pointing distance (m)
    minDistance: { default: 0.3 },      // closer hits are left to poke/grab (m)
    // Finger straightness (1 = straight, ~0.45 = curled into a fist):
    pointStraight: { default: 0.85 },   // index this straight = pointing
    othersCurled: { default: 0.7 },     // middle + ring below this = curled
    triggerCurl: { default: 0.6 },      // index curled below this = press
    releaseStraight: { default: 0.8 },  // index back above this = release
    pointHoldMs: { default: 80 },       // pointing pose held this long first
    surfaces: { default: '' },          // where a free ray stops (e.g. .landable)
    rayLength: { default: 3 },          // free ray length with no surface (m)
    color: { type: 'color', default: '#ffffff' },
    showBeam: { default: true },        // false: only the cursor at the end
    cursorSize: { default: 0.012 },     // cursor radius at 1 m; scales with distance
                                        // so it stays the same size on screen
    highlight: { default: true },       // tint hovered objects (emissive)
    highlightColor: { type: 'color', default: HIGHLIGHT_COLOR },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.raycaster = new THREE.Raycaster();
    this.ray = this.raycaster.ray;
    this.intersection = null;
    this.hoverEl = null;
    this.pressedEl = null;
    this.pressDistance = 1;
    this.targetEls = [];
    this.targetObjs = [];
    this.surfaceObjs = [];
    this._surface = false;
    this.lastRefresh = -1e9;
    this._end = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();

    this.pState = 'idle';          // idle | pointing | curling | pressed
    this.pSince = 0;
    this._candidate = false;
    this._candSince = 0;
    this.fingers = null;           // { index, middle, ring } straightness

    const sceneObj = this.el.sceneEl.object3D;
    const color = new THREE.Color(this.data.color);

    // Beam: unit-length cylinder along +Z, scaled to the hit distance
    const beamGeo = new THREE.CylinderGeometry(0.0025, 0.0025, 1, 6, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    beamGeo.translate(0, 0, 0.5);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false, fog: false,
    }));
    this.beam.visible = false;
    this.beam.frustumCulled = false;
    sceneObj.add(this.beam);

    // Cursor dot, drawn on top so the object can't hide it, with a
    // dark outline so it also shows on light surfaces
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(this.data.cursorSize, 20), new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
      toneMapped: false, fog: false, side: THREE.DoubleSide,
    }));
    this.dot.renderOrder = 999;
    this.dot.visible = false;
    this.outline = new THREE.Mesh(
      new THREE.RingGeometry(this.data.cursorSize, this.data.cursorSize * 1.45, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false,
        toneMapped: false, fog: false, side: THREE.DoubleSide,
      })
    );
    this.outline.renderOrder = 998;
    this.dot.add(this.outline);
    sceneObj.add(this.dot);
  },

  send: function (name, targetEl) {
    const detail = { cursorEl: this.el, intersection: this.intersection, hand: this.data.hand };
    targetEl.emit(name, detail);
    this.el.emit(name, { intersectedEl: targetEl, intersection: this.intersection, hand: this.data.hand });
  },

  // End a press: mouseup, and click if the ray is still on the object
  releasePress: function (allowClick) {
    const el = this.pressedEl;
    if (!el) return;
    this.pressedEl = null;
    this.send('mouseup', el);
    if (allowClick && this.hoverEl === el) this.send('click', el);
  },

  refreshTargets: function () {
    this.targetEls = Array.from(document.querySelectorAll(this.data.objects));
    this.targetObjs = this.targetEls.map((el) => el.object3D);
    this.surfaceObjs = this.data.surfaces
      ? Array.from(document.querySelectorAll(this.data.surfaces)).map((el) => el.object3D)
      : [];
  },

  // Walk up from the hit mesh to the entity that matched the selector
  entityFor: function (obj) {
    while (obj) {
      if (obj.el && this.targetEls.indexOf(obj.el) !== -1) return obj.el;
      obj = obj.parent;
    }
    return null;
  },

  setHover: function (el) {
    if (el === this.hoverEl) return;
    const old = this.hoverEl;
    this.hoverEl = el;
    if (old) {
      old.removeState('cursor-hovered');
      this.setHighlight(old, false);
      this.send('mouseleave', old);
    }
    if (el) {
      el.addState('cursor-hovered');
      this.setHighlight(el, true);
      this.send('mouseenter', el);
    }
  },

  setHighlight: function (el, on) {
    if (!this.data.highlight) return;
    this.el.sceneEl.systems['hand-highlight'].set(el, this.data.highlightColor, on);
  },

  hideVisuals: function () {
    this.beam.visible = false;
    this.dot.visible = false;
  },

  // Ray along the index finger's base bone (metacarpal), starting
  // where the fingertip is when the finger is straight. That bone
  // doesn't move when the finger curls, so the trigger doesn't
  // swing the ray.
  pointRay: function (h) {
    const L = h.local;
    const M = L['index-finger-metacarpal'], P = L['index-finger-phalanx-proximal'];
    const fingerLen = P.distanceTo(L['index-finger-phalanx-intermediate']) +
      L['index-finger-phalanx-intermediate'].distanceTo(L['index-finger-phalanx-distal']) +
      L['index-finger-phalanx-distal'].distanceTo(L['index-finger-tip']);
    this._v2.subVectors(P, M).normalize();
    this._v1.copy(P).addScaledVector(this._v2, fingerLen);
    const rigObj = this.rigEl.object3D;
    rigObj.updateMatrixWorld();
    this.ray.origin.copy(this._v1).applyMatrix4(rigObj.matrixWorld);
    this.ray.direction.copy(this._v2).transformDirection(rigObj.matrixWorld);
  },

  // Point-and-trigger state machine (runs before the raycast):
  //   idle → pointing      index straight, middle + ring curled, held pointHoldMs
  //   pointing → curling   index starts to bend: target is frozen
  //   curling → pressed    index curled past triggerCurl: mousedown
  //   curling → pointing   index straightens again: nothing happens
  //   pressed → pointing   index straightens: mouseup (+ click if still on it)
  //   any → idle           middle/ring open (hand relaxed)
  updatePointState: function (time) {
    const d = this.data, f = this.fingers;
    const othersCurled = f.middle < d.othersCurled && f.ring < d.othersCurled;
    const set = (s) => { this.pState = s; this.pSince = time; };
    switch (this.pState) {
      case 'idle':
        if (f.index > d.pointStraight && othersCurled) {
          if (!this._candidate) { this._candidate = true; this._candSince = time; }
          if (time - this._candSince >= d.pointHoldMs) { this._candidate = false; set('pointing'); }
        } else {
          this._candidate = false;
        }
        break;
      case 'pointing':
        if (!othersCurled) set('idle');
        else if (f.index < d.releaseStraight) set('curling');
        break;
      case 'curling':
        if (!othersCurled) set('idle');
        else if (f.index > d.pointStraight) set('pointing');
        else if (f.index < d.triggerCurl) {
          if (this.hoverEl) {
            this.pressedEl = this.hoverEl;
            this.pressDistance = this.intersection ? this.intersection.distance : 1;
            this.send('mousedown', this.pressedEl);
          }
          set('pressed');
        }
        break;
      case 'pressed':
        if (f.index > d.releaseStraight || !othersCurled) {
          this.releasePress(true);
          set(othersCurled ? 'pointing' : 'idle');
        }
        break;
    }
  },

  // True while this hand is using the ray, so other gestures on the
  // same hand (thumb tap, thumb tilt, teleport) step aside
  isPointing: function () {
    return this.pState === 'pointing' || this.pState === 'curling' || !!this.pressedEl;
  },

  tick: function (time) {
    const sceneEl = this.el.sceneEl;

    // Off while aiming a teleport, holding something, or with the hand
    // near something it can poke or grab (near-field takes over)
    const tps = sceneEl.systems['hand-teleport'];
    const tp = this.el.components['hand-teleport'];
    const grabC = this.el.components['hand-grab'];
    const pokeC = this.el.components['hand-poke'];
    const blocked = (tps && tp && tps.activeHand === tp) ||
      (grabC && (grabC.heldEl || grabC.near)) || (pokeC && pokeC.near);

    const h = blocked ? null : sceneEl.systems['hand-input'].get(this.data.hand);
    let haveRay = false;
    let frozen = false;
    if (h && h.has['index-finger-metacarpal']) {
      const index = h.straight('index'), middle = h.straight('middle'), ring = h.straight('ring');
      if (index !== null && middle !== null && ring !== null) {
        this.fingers = { index, middle, ring };
        this.updatePointState(time);
        if (this.pState !== 'idle') {
          frozen = this.pState === 'curling';
          if (!frozen) this.pointRay(h);
          haveRay = true;
        }
      } else {
        this.fingers = null;
      }
    } else if (!h) {
      this.fingers = null;
    }

    if (!haveRay) {
      this.intersection = null;
      this.setHover(null);
      this.releasePress(false);               // tracking lost or blocked: no click
      if (!h) { this.pState = 'idle'; this._candidate = false; }
      if (this.system.owner === this) this.system.owner = null;
      this.hideVisuals();
      return;
    }

    let hit = this.intersection, hitEl = this.hoverEl;
    if (!frozen) {
      if (time - this.lastRefresh > 500) { this.refreshTargets(); this.lastRefresh = time; }
      // Sprites in the scene graph need a camera to be raycast;
      // without one three.js throws on every frame
      this.raycaster.camera = sceneEl.camera;
      this.raycaster.near = 0;
      this.raycaster.far = this.data.far;
      const hits = this.raycaster.intersectObjects(this.targetObjs, true);
      hit = null; hitEl = null;
      for (const x of hits) {
        if (x.distance < this.data.minDistance) continue; // within reach
        const el = this.entityFor(x.object);
        if (el && el.object3D.visible) { hit = x; hitEl = el; break; }
      }
    }

    // One hand at a time: a hand holds the ray while it's pointing
    const sys = this.system;
    if (sys.owner && sys.owner !== this) {
      this.intersection = null;
      this.setHover(null);
      this.hideVisuals();
      return;
    }
    this.intersection = hit;
    this.setHover(hitEl);
    sys.owner = this;

    if (!frozen) {
      this._surface = false;
      if (hit) this._end.copy(hit.point);
      else if (this.pressedEl) this.ray.at(this.pressDistance, this._end);
      else {
        // Free ray: stop on the first surface it meets, if any
        let s = null;
        if (this.surfaceObjs.length) {
          this.raycaster.far = this.data.rayLength * 4;
          const sh = this.raycaster.intersectObjects(this.surfaceObjs, true);
          s = sh.length ? sh[0] : null;
        }
        if (s) { this._end.copy(s.point); this._surface = true; }
        else this.ray.at(this.data.rayLength, this._end);
      }
    }

    if (this.data.showBeam) {
      this.beam.position.copy(this.ray.origin);
      this.beam.lookAt(this._end);
      this.beam.scale.set(1, 1, Math.max(0.001, this.ray.origin.distanceTo(this._end)));
      this.beam.material.opacity = hit || this.pressedEl ? 0.55 : 0.28;
      this.beam.visible = true;
    } else {
      this.beam.visible = false;
    }

    // Cursor: bright on an object, dim on a surface, none in empty air
    const showDot = hit || this.pressedEl || this._surface || (frozen && this.dot.visible);
    if (!showDot) { this.dot.visible = false; return; }
    this.dot.position.copy(this._end);
    sceneEl.camera.getWorldPosition(this._camPos);
    this.dot.lookAt(this._camPos);
    // Same size on screen at any distance; shrinks while pressing
    const camDist = Math.max(0.2, this._camPos.distanceTo(this._end));
    const pressing = this.pressedEl || this.pState === 'curling';
    this.dot.scale.setScalar(camDist * (pressing ? 0.7 : 1));
    this.dot.material.opacity = hit ? 0.95 : 0.4;
    this.outline.material.opacity = hit ? 0.45 : 0.2;
    this.dot.visible = true;
  },

  remove: function () {
    this.releasePress(false);
    this.setHover(null);
    if (this.system.owner === this) this.system.owner = null;
    const sceneObj = this.el.sceneEl.object3D;
    sceneObj.remove(this.beam);
    sceneObj.remove(this.dot);
  }
});
