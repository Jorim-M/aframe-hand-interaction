// ═══════════════════════════════════════════════════════════
// HAND THUMBS-UP TILT SNAP-TURN — make a thumbs-up, then tilt
// the thumb left or right past ~35° to snap the view 45° in
// that direction. Return the thumb toward vertical to re-arm.
// Either hand does both directions — the thumb is a joystick.
//
// Built from STATIC quantities (a pose + an orientation), not
// motion, so tracking jitter cannot accumulate into phantom
// snaps the way it can with a swipe detector:
// 1. Pose check: thumb extended (tip far from its base, relative
//    to palm length) AND index + middle curled. This
//    configuration is distinctive — relaxed idle hands, points,
//    and pinches all fail it.
// 2. Tilt: the thumb direction projected onto the head's
//    horizontal right vector vs world up, as a signed angle
//    from vertical. Head-relative, so "left" is YOUR left.
// 3. Hysteresis + hold: fires only after the tilt zone is held
//    ~120ms (debounces single-frame misreads), and re-arms only
//    once the thumb returns within the neutral cone.
// 4. Thumbs-DOWN guard: if the thumb points below horizontal,
//    the tilt sign becomes meaningless — ignored entirely.
// ═══════════════════════════════════════════════════════════
// Which hand turns: only one at a time. A tap on a hand makes it
// the turning hand (and switches the other off); a tap on the
// turning hand switches turning off.
AFRAME.registerSystem('hand-thumb-tilt', {
  init: function () {
    this.activeHand = undefined; // 'left' | 'right' | null, set from startHand
    this.lastToggle = -1e9;
  }
});

AFRAME.registerComponent('hand-thumb-tilt', {
  schema: {
    hand: { default: 'right' },
    cameraRig: { default: '#rig' },
    head: { default: '#head' },
    angle: { default: 45 },
    tiltOn: { default: 35 },             // degrees from vertical to trigger
    tiltOff: { default: 20 },            // neutral cone for re-arming
    // Tilt is measured from the hand's own resting thumb angle,
    // sampled when the thumbs-up starts (clamped to ±neutralMax),
    // so a thumb that naturally leans doesn't sit near a trigger
    adaptNeutral: { default: true },
    neutralMax: { default: 20 },         // degrees
    neutralSampleMs: { default: 100 },
    poseGraceMs: { default: 150 },       // brief tracking dropouts are ignored
    holdMs: { default: 120 },            // tilt must be sustained this long
    cooldown: { default: 300 },          // ms between snaps
    // Hand-shape checks are relative, so they work for any hand size
    fingerCurled: { default: 0.7 },      // index/middle straightness below this = curled
    thumbExtended: { default: 0.58 },    // thumb tip to thumb base, in palm lengths
    showIndicator: { default: true },     // tilt indicator above the thumb
    indicatorColor: { type: 'color', default: '#ffffff' },
    indicatorOffset: { default: 0.05 },   // height above the thumb tip (m)
    // Thumb-tap toggle: tap the thumb on the middle of the curled
    // index finger to make this the turning hand, or to switch off
    toggleTap: { default: true },
    startHand: { default: 'none', oneOf: ['none', 'left', 'right'] },
    tapContact: { default: 0.32 },        // thumb tip to index side: touching (palm lengths)
    tapRelease: { default: 0.42 },        // ...clearly apart, re-arms the tap (palm lengths)
    tapApproachMs: { default: 150 },      // window for measuring the approach (ms)
    tapTravel: { default: 0.16 },         // thumb must close this much within the window (palm lengths)
    // The fist must already be closed this long before a tap counts.
    // A hand-pointer trigger pull curls the index onto the thumb, which
    // looks like a tap; but there the fist has only just closed.
    tapFistMs: { default: 200 },
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    this.headEl = document.querySelector(this.data.head);
    this.armed = true;
    this.lastSnap = -1e9;
    this.zoneCandidate = 0;   // -1 left, 0 neutral, +1 right
    this.zoneSince = 0;
    this._headPos = new THREE.Vector3();
    this._wrist = new THREE.Vector3();
    this._thumbTip = new THREE.Vector3();
    this._thumbMeta = new THREE.Vector3();
    this._idxTip = new THREE.Vector3();
    this._midTip = new THREE.Vector3();
    this._thumbDir = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.lastPoseTime = -1e9;
    this.neutral = 0;
    this.neutralReady = false;
    this.neutralSum = 0;
    this.neutralN = 0;
    this.poseStart = 0;
    this.relTilt = 0;

    if (this.system.activeHand === undefined) {
      this.system.activeHand = this.data.startHand === 'none' ? null : this.data.startHand;
    }
    this.fistSince = null;   // when index + middle became curled
    this.tapArmed = false;   // thumb must be apart from the finger first
    this.tapHist = [];       // recent [time, distance] samples
    this._toggleTime = -1e9;
    this._idxProx = new THREE.Vector3();
    this._idxDist = new THREE.Vector3();
    this._seg = new THREE.Vector3();
    this._toThumb = new THREE.Vector3();
    this._closest = new THREE.Vector3();

    // Indicator state, written by detect() each frame
    this._vis = false;
    this._tiltDeg = 0;
    this._alpha = 0;
    this._flashSide = 0;
    this._flashTime = -1e9;
    this._indPos = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    if (this.data.showIndicator) this.buildIndicator();
  },

  // Indicator: a centre dot, a track on each side that fills as
  // the thumb tilts toward the trigger angle, and an arrowhead
  // that brightens at the threshold and flashes on a snap. Drawn
  // on top of the hand (no depth test) and turned to face the
  // camera, so its +X is always the viewer's right.
  buildIndicator: function () {
    const color = new THREE.Color(this.data.indicatorColor);
    const mat = () => new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false, toneMapped: false, fog: false,
    });

    const group = new THREE.Group();
    group.renderOrder = 999;
    group.visible = false;

    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.004, 16), mat());
    group.add(dot);

    const barGeo = new THREE.PlaneGeometry(0.03, 0.003);
    barGeo.translate(0.015, 0, 0); // pivot at the inner end
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, 0.007);
    arrowShape.lineTo(0.01, 0);
    arrowShape.lineTo(0, -0.007);
    arrowShape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);

    const sides = {};
    for (const s of [-1, 1]) {
      const track = new THREE.Mesh(barGeo, mat());
      track.position.x = s * 0.009;
      track.scale.x = s;
      const fill = new THREE.Mesh(barGeo, mat());
      fill.position.x = s * 0.009;
      const arrow = new THREE.Mesh(arrowGeo, mat());
      arrow.position.x = s * 0.042;
      arrow.scale.x = s;
      group.add(track, fill, arrow);
      sides[s] = { track, fill, arrow };
    }
    group.traverse((o) => { o.renderOrder = 999; });

    this.indicator = { group, dot, sides };
    this.el.sceneEl.object3D.add(group);
  },

  updateIndicator: function (time, dt) {
    const ind = this.indicator;
    if (!ind) return;

    // Fade in/out (~60ms time constant)
    const k = 1 - Math.exp(-(dt || 16) / 60);
    this._alpha += ((this._vis ? 1 : 0) - this._alpha) * k;
    if (this._alpha < 0.01) { ind.group.visible = false; return; }
    ind.group.visible = true;

    // Above the thumb tip, facing the camera
    ind.group.position.copy(this._indPos);
    ind.group.position.y += this.data.indicatorOffset;
    this.el.sceneEl.camera.getWorldPosition(this._camPos);
    ind.group.lookAt(this._camPos);

    const a = this._alpha;
    const on = this.isActive();
    // Off: only a dim dot. On: dim until re-armed after a snap.
    const base = on ? (this.armed ? 1 : 0.35) : 0;
    const tilt = this._tiltDeg;
    const flash = Math.max(0, 1 - (time - this._flashTime) / 300);
    const toggled = Math.max(0, 1 - (time - this._toggleTime) / 600);

    // Dot pulses on every toggle; stays dim while turning is off
    ind.dot.material.opacity = Math.max(a * (on ? 0.9 * base : 0.3), a * toggled);
    ind.dot.scale.setScalar(1 + 1.5 * toggled);

    for (const s of [-1, 1]) {
      const p = (on && this.armed && Math.sign(tilt) === s)
        ? Math.min(1, Math.abs(tilt) / this.data.tiltOn) : 0;
      const parts = ind.sides[s];
      parts.track.material.opacity = a * 0.3 * base;
      parts.fill.visible = p > 0.02;
      parts.fill.scale.x = s * p;
      parts.fill.material.opacity = a * 0.95;
      // Both arrows flash when turning switches on
      const f = Math.max(this._flashSide === s ? flash : 0, on ? toggled : 0);
      parts.arrow.material.opacity =
        Math.max(a * (0.35 + 0.65 * p) * base, a * f);
      const sc = 1 + 0.5 * f;
      parts.arrow.scale.set(s * sc, sc, 1);
    }
  },

  remove: function () {
    if (this.indicator) this.el.sceneEl.object3D.remove(this.indicator.group);
  },

  reset: function () {
    this.zoneCandidate = 0;
    this.armed = true;
  },

  // Pose not measurable this frame. Within poseGraceMs it's treated
  // as a tracking blip and the tilt state (hold timer, arming) is
  // kept; after that the next thumbs-up starts fresh.
  poseDropped: function (time) {
    if (time - this.lastPoseTime > this.data.poseGraceMs) this.zoneCandidate = 0;
  },

  isActive: function () {
    return this.system.activeHand === this.data.hand;
  },

  tick: function (time, dt) {
    this._vis = false;
    this.detect(time);
    // Show toggle feedback even though the tap hand isn't a thumbs-up
    if (time - this._toggleTime < 600) this._vis = true;
    if (this.indicator) this.updateIndicator(time, dt);
  },

  // Tap = the thumb lands on the side of the curled index with a
  // quick movement: it must have closed at least tapTravel within
  // the last tapApproachMs. It fires on contact, so feedback is
  // immediate and the thumb doesn't have to lift. A thumb drifting
  // slowly onto the finger (a rest) is too slow to count, and after
  // a tap the thumb must move apart again before the next one.
  detectTap: function (time, h, input, fist) {
    const palm = h.palm;
    const thumbTip = h.local['thumb-tip'];
    const d = input.indexSideDistance(h, thumbTip);
    const hist = this.tapHist;
    hist.push([time, d]);
    while (hist.length && time - hist[0][0] > this.data.tapApproachMs) hist.shift();

    if (d > this.data.tapRelease * palm) { this.tapArmed = true; return; }
    if (!this.tapArmed || d > this.data.tapContact * palm || !fist) return;
    // Fist only just closed (e.g. a hand-pointer trigger pull): not a tap
    if (this.fistSince === null || time - this.fistSince < this.data.tapFistMs) return;
    // Nearer the fingertip than the side of the finger: a pinch
    if (thumbTip.distanceTo(h.local['index-finger-tip']) < d) return;
    // Too slow: a rest, not a tap. Needs to move apart and try again.
    let maxD = d;
    for (const s of hist) if (s[1] > maxD) maxD = s[1];
    if (maxD - d < this.data.tapTravel * palm) { this.tapArmed = false; return; }
    if (time - this.system.lastToggle < 300) return;

    this.tapArmed = false;
    this.system.activeHand = this.isActive() ? null : this.data.hand;
    this.system.lastToggle = time;
    this._toggleTime = time;
    this.reset();
    this._indPos.copy(h.world['thumb-tip']);
    this.el.emit('thumbtilttoggle', {
      enabled: this.isActive(),
      hand: this.data.hand,
      activeHand: this.system.activeHand,
    });
  },

  detect: function (time) {
    const sceneEl = this.el.sceneEl;
    if (!sceneEl.frame || !sceneEl.xrSession) { this.reset(); return; }

    // Never turn with the hand that owns the teleport arc
    const tp = sceneEl.systems['hand-teleport'];
    if (tp && tp.activeHand && tp.activeHand.data.hand === this.data.hand) {
      this.reset();
      return;
    }

    const input = sceneEl.systems['hand-input'];
    const h = input.get(this.data.hand, this.rigEl.object3D);
    // Joints missing this frame: a tracking blip unless it lasts
    if (!h || !h.ok('thumb-tip', 'thumb-metacarpal', 'index-finger-tip',
      'index-finger-phalanx-proximal', 'index-finger-phalanx-distal')) { this.poseDropped(time); return; }
    const idxS = h.straight('index'), midS = h.straight('middle');
    if (idxS === null || midS === null) { this.poseDropped(time); return; }

    const indexCurled = idxS < this.data.fingerCurled;
    const middleCurled = midS < this.data.fingerCurled;
    if (indexCurled && middleCurled) { if (this.fistSince === null) this.fistSince = time; }
    else this.fistSince = null;

    // This hand is using hand-pointer, or holding something (a grip
    // is a fist too): no taps or tilts
    const ptr = this.el.components['hand-pointer'];
    const grabC = this.el.components['hand-grab'];
    if ((ptr && ptr.isPointing()) || (grabC && grabC.heldEl)) { this.poseDropped(time); this.tapArmed = false; return; }

    // ── Thumb-tap toggle ──
    if (this.data.toggleTap) this.detectTap(time, h, input, indexCurled && middleCurled);

    // ── Pose check: is this a thumbs-up? ──
    const thumbTip = h.local['thumb-tip'], thumbMeta = h.local['thumb-metacarpal'];
    const thumbExtended = thumbTip.distanceTo(thumbMeta) > this.data.thumbExtended * h.palm;
    if (!(thumbExtended && indexCurled && middleCurled)) { this.poseDropped(time); return; }

    // ── Tilt: signed angle of the thumb from vertical, along
    //    the head's horizontal right axis ──
    this._thumbDir.subVectors(thumbTip, thumbMeta).normalize();

    // Thumbs-down guard: below horizontal, left/right is meaningless
    if (this._thumbDir.y < -0.15) { this.poseDropped(time); return; }

    this._right.set(1, 0, 0).applyQuaternion(this.headEl.object3D.quaternion);
    this._right.y = 0;
    this._right.normalize();

    const lateral = this._thumbDir.dot(this._right);

    // Thumb pointing mostly forward/back (e.g. on its way to a tap):
    // the left/right angle is unreliable, so ignore it
    if (Math.hypot(lateral, this._thumbDir.y) < 0.5) { this.poseDropped(time); return; }

    const absTilt = THREE.MathUtils.radToDeg(Math.atan2(lateral, this._thumbDir.y));

    // A new thumbs-up (after a real absence): re-arm and re-sample
    // this hand's neutral angle
    if (time - this.lastPoseTime > this.data.poseGraceMs) {
      this.armed = true;
      this.zoneCandidate = 0;
      this.neutralReady = !this.data.adaptNeutral;
      this.neutral = 0;
      this.neutralSum = 0;
      this.neutralN = 0;
      this.poseStart = time;
    }
    this.lastPoseTime = time;

    if (!this.neutralReady) {
      // Learn the resting angle only from a roughly upright thumb. A
      // thumb still swinging in from the side (e.g. straight after a
      // tap) would otherwise set neutral far off and skew both sides.
      if (Math.abs(absTilt) > this.data.neutralMax * 1.5) {
        this.neutralSum = 0;
        this.neutralN = 0;
        this.poseStart = time;
        this._vis = true;
        this._tiltDeg = 0;
        this._indPos.copy(h.world['thumb-tip']);
        return;
      }
      this.neutralSum += absTilt;
      this.neutralN++;
      const m = this.data.neutralMax;
      this.neutral = Math.max(-m, Math.min(m, this.neutralSum / this.neutralN));
      if (time - this.poseStart >= this.data.neutralSampleMs) this.neutralReady = true;
    }
    const tiltDeg = absTilt - this.neutral;
    this.relTilt = tiltDeg;

    // Indicator follows the thumb tip
    this._vis = true;
    this._tiltDeg = this.neutralReady ? tiltDeg : 0;
    this._indPos.copy(h.world['thumb-tip']);

    // Not the turning hand: indicator shows the off state, no snaps
    if (!this.isActive()) { this.zoneCandidate = 0; this.armed = true; return; }
    if (!this.neutralReady) return;

    // ── Hysteresis state machine ──
    const zone = tiltDeg > this.data.tiltOn ? 1
               : tiltDeg < -this.data.tiltOn ? -1
               : 0;

    // Re-arm only inside the neutral cone
    if (!this.armed) {
      if (Math.abs(tiltDeg) < this.data.tiltOff) this.armed = true;
      this.zoneCandidate = 0;
      return;
    }

    if (zone === 0) { this.zoneCandidate = 0; return; }

    // Debounce: the tilt zone must be held for holdMs
    if (this.zoneCandidate !== zone) {
      this.zoneCandidate = zone;
      this.zoneSince = time;
      return;
    }
    if (time - this.zoneSince < this.data.holdMs) return;
    if (time - this.lastSnap < this.data.cooldown) return;

    // Tilt right = turn right (−yaw); tilt left = turn left (+yaw)
    this._flashSide = zone;
    this._flashTime = time;
    this.snap(zone > 0 ? -1 : 1);
    this.lastSnap = time;
    this.armed = false;
    this.zoneCandidate = 0;
  },

  snap: function (dirSign) {
    const rig = this.rigEl.object3D;
    const a = THREE.MathUtils.degToRad(this.data.angle) * dirSign;

    // Pivot the rotation on the head's world XZ position:
    // compensate rig position so the head stays fixed in space
    this.headEl.object3D.getWorldPosition(this._headPos);
    const ox = this._headPos.x - rig.position.x;
    const oz = this._headPos.z - rig.position.z;
    const c = Math.cos(a), s = Math.sin(a);
    rig.position.x = this._headPos.x - (c * ox + s * oz);
    rig.position.z = this._headPos.z - (-s * ox + c * oz);
    rig.rotation.y += a;
    this.el.emit('snapturn', {
      direction: dirSign > 0 ? 'left' : 'right',
      angle: this.data.angle,
      hand: this.data.hand,
    });
  }
});
