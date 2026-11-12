// ═══════════════════════════════════════════════════════════
// HAND TELEPORT — pinch and hold to aim, release to teleport.
// While pinching, the aim comes from the input source's
// targetRaySpace: the platform-native pointing ray (the same
// one Quest uses for its system UI), which stays stable while
// the fingers are pinched.
// The ray is a ballistic arc — p(t) = origin + v·t + ½g·t² —
// like classic controller teleport, so no downward-pointing is
// required: aim anywhere and the parabola finds the ground.
// Poses are in XR reference space == rig-local space, so they
// are transformed by the rig's world matrix before simulating
// the arc. The system tracks which hand owns the arc, so only
// one hand aims at a time.
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('hand-teleport', {
  init: function () {
    this.activeHand = null;
  }
});

AFRAME.registerComponent('hand-teleport', {
  schema: {
    hand: { default: 'right' },
    curveShootingSpeed: { default: 7.5 }, // arc launch speed (m/s) — controls range
    gravity: { default: -9.8 },
    // blink-controls-style additions:
    cameraRig: { default: '#rig' },      // rig element moved on teleport
    hitColor: { type: 'color', default: '#4d93fd' },
    missColor: { type: 'color', default: '#e86a6a' },
    planeRadius: { default: 0 },         // plane-fallback landing boundary (0 = unlimited)
    collisionEntities: { default: '' },  // selector for landable meshes; empty = flat y=0 plane
    blockEntities: { default: '' },      // selector for meshes that stop the arc and can't be landed on (water, walls)
    teleportOrigin: { default: '#head' },// land THIS on the target (the camera, not the rig origin)
    landingNormal: { type: 'vec3', default: { x: 0, y: 1, z: 0 } },
    landingMaxAngle: { default: 45 },    // reject slopes steeper than this (degrees)
    rayFloor: { default: -20 },          // arc simulation horizon below y=0 (for valleys)
  },

  init: function () {
    this.rigEl = document.querySelector(this.data.cameraRig);
    const sceneObj = this.el.sceneEl.object3D;

    // Ballistic arc rendered as a camera-facing ribbon, tapering
    // toward the tip like the classic teleport curve. Geometry is
    // pre-allocated once; positions update in place each tick.
    // Sample count along the arc — more points = smoother arch.
    // 64 is plenty since every point lies on the visible curve.
    this.numPoints = 64;
    this.arcPoints = [];
    for (let i = 0; i < this.numPoints; i++) this.arcPoints.push(new THREE.Vector3());

    const arcGeo = new THREE.BufferGeometry();
    this.arcPositions = new Float32Array(this.numPoints * 2 * 3);
    arcGeo.setAttribute('position', new THREE.BufferAttribute(this.arcPositions, 3));
    const arcIndices = [];
    for (let i = 0; i < this.numPoints - 1; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      arcIndices.push(a, b, c, b, d, c);
    }
    arcGeo.setIndex(arcIndices);
    this.arcMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd, transparent: true, opacity: 0.85,
      side: THREE.DoubleSide, depthWrite: false, fog: false, // feedback never fades into scene fog
    });
    this.arc = new THREE.Mesh(arcGeo, this.arcMat);
    this.arc.frustumCulled = false;
    this.arc.visible = false;
    sceneObj.add(this.arc);

    // Target ring marker, flat on the ground
    const ringGeo = new THREE.RingGeometry(0.14, 0.2, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd, transparent: true, opacity: 0.9,
      side: THREE.DoubleSide, depthWrite: false, fog: false,
    });
    this.ring = new THREE.Mesh(ringGeo, this.ringMat);
    this.ring.visible = false;
    sceneObj.add(this.ring);

    // Halo: a vertical light pillar rising from the ring, so the
    // target reads from any viewing angle — a flat ring seen
    // edge-on (e.g. aiming at an elevated platform) all but
    // disappears. Additive-blended cylinder with a vertical
    // gradient fading to nothing at the top.
    const haloCanvas = document.createElement('canvas');
    haloCanvas.width = 1; haloCanvas.height = 64;
    const hctx = haloCanvas.getContext('2d');
    const hgrad = hctx.createLinearGradient(0, 64, 0, 0);
    hgrad.addColorStop(0.0, 'rgba(255,255,255,0.85)');
    hgrad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    hgrad.addColorStop(1.0, 'rgba(255,255,255,0)');
    hctx.fillStyle = hgrad;
    hctx.fillRect(0, 0, 1, 64);
    const haloTex = new THREE.CanvasTexture(haloCanvas);

    const haloGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.55, 24, 1, true);
    haloGeo.translate(0, 0.275, 0); // pivot at the base, on the ring
    this.haloMat = new THREE.MeshBasicMaterial({
      color: 0x4d93fd,
      map: haloTex,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.Mesh(haloGeo, this.haloMat);
    this.halo.visible = false;
    sceneObj.add(this.halo);

    this.target = new THREE.Vector3();
    this.hasValidTarget = false;
    this.pinching = false;

    // Scratch vectors
    this._origin = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._camPos = new THREE.Vector3();
    this._tangent = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
    this._side = new THREE.Vector3();

    // Collision + arrival (blink-controls-style)
    this.originEl = document.querySelector(this.data.teleportOrigin) || this.rigEl;
    this.raycaster = new THREE.Raycaster();
    this.collisionMeshes = [];
    this.castMeshes = [];                // landable + blocking, raycast together
    this.blockMeshes = new Set();
    this.hitFound = false;
    this._landingNormal = new THREE.Vector3(
      this.data.landingNormal.x, this.data.landingNormal.y, this.data.landingNormal.z
    ).normalize();
    this._hitNormal = new THREE.Vector3(0, 1, 0);
    this._normalMatrix = new THREE.Matrix3();
    this._up = new THREE.Vector3(0, 1, 0);
    this._segStart = new THREE.Vector3();
    this._segEnd = new THREE.Vector3();
    this._segDir = new THREE.Vector3();
    this._originPos = new THREE.Vector3();

    // Pinches come from the shared arbiter (hand-pinch), which drops
    // thumb taps and asks wantsPinch() below
    this.el.sceneEl.systems['hand-pinch'].register(this.el, this.data.hand);
  },

  // ── Pinch arbiter interface ──
  // Not while the other hand is aiming, or while this hand is
  // pointing (a trigger pull can look like a pinch)
  wantsPinch: function () {
    if (this.system.activeHand && this.system.activeHand !== this) return false;
    const ptr = this.el.components['hand-pointer'];
    if (ptr && ptr.pState !== 'idle') return false;
    // Hand at something it could grab, or holding it: not a teleport
    const grab = this.el.components['hand-grab'];
    if (grab && (grab.heldEl || grab.near)) return false;
    return true;
  },

  pinchStart: function () {
    this.system.activeHand = this;
    this.pinching = true;
    this.refreshCollisionMeshes();
  },

  // Release = teleport, if the arc found somewhere to land
  pinchEnd: function () {
    if (!this.pinching) return;
    this.pinching = false;
    if (this.system.activeHand === this) this.system.activeHand = null;
    if (this.hasValidTarget) {
      // teleportOrigin: land the CAMERA on the target, not the rig
      // origin — if you've physically walked away from the rig
      // center, you still arrive exactly where you aimed.
      const target = this.target.clone();
      const rigPos = this.rigEl.object3D.position;
      const oldPosition = rigPos.clone();
      this.originEl.object3D.getWorldPosition(this._originPos);
      rigPos.x += target.x - this._originPos.x;
      rigPos.z += target.z - this._originPos.z;
      rigPos.y = target.y; // rig floor onto the landing height
      this.el.emit('teleported', {
        oldPosition: oldPosition,
        newPosition: rigPos.clone(),
        hitPoint: target,
        hand: this.data.hand,
      });
    }
    this.hide();
  },

  // Gather landable meshes from the collisionEntities selector.
  // InstancedMesh children (grass, flowers) are skipped — you land
  // on terrain, not on a blade of grass.
  // blockEntities meshes are raycast too: a hit on one ends the arc
  // there and is never a valid landing.
  refreshCollisionMeshes: function () {
    this.collisionMeshes.length = 0;
    this.castMeshes.length = 0;
    this.blockMeshes.clear();
    const gather = (selector, fn) => {
      if (!selector) return;
      for (const el of document.querySelectorAll(selector)) {
        if (!el.object3D) continue;
        el.object3D.traverse((obj) => { if (obj.isMesh && !obj.isInstancedMesh) fn(obj); });
      }
    };
    gather(this.data.blockEntities, (m) => this.blockMeshes.add(m));
    gather(this.data.collisionEntities, (m) => { if (!this.blockMeshes.has(m)) this.collisionMeshes.push(m); });
    if (!this.collisionMeshes.length) return; // plane fallback: blockers need landable meshes
    this.castMeshes.push(...this.collisionMeshes, ...this.blockMeshes);
  },

  hide: function () {
    this.arc.visible = false;
    this.ring.visible = false;
    this.halo.visible = false;
    this.hasValidTarget = false;
  },

  // Called when tracking is lost mid-pinch: releases the aim and
  // frees the shared lock so the other hand isn't locked out.
  cancelPinch: function () {
    this.pinching = false;
    if (this.system.activeHand === this) this.system.activeHand = null;
    this.hide();
  },

  tick: function () {
    if (!this.pinching) { this.hide(); return; }

    const sceneEl = this.el.sceneEl;
    const frame = sceneEl.frame;
    const session = sceneEl.xrSession;
    if (!frame || !session) { this.cancelPinch(); return; }

    const source = sceneEl.systems['hand-input'].source(this.data.hand);
    // Source gone = hand tracking lost — cancel rather than hold the lock
    if (!source || !source.targetRaySpace) { this.cancelPinch(); return; }

    const refSpace = sceneEl.renderer.xr.getReferenceSpace();
    const rayPose = frame.getPose(source.targetRaySpace, refSpace);
    if (!rayPose) { this.hide(); return; }

    // Pose is rig-local: bring it into world space
    const rigObj = this.rigEl.object3D;
    rigObj.updateMatrixWorld();

    this._origin.set(
      rayPose.transform.position.x,
      rayPose.transform.position.y,
      rayPose.transform.position.z
    ).applyMatrix4(rigObj.matrixWorld);

    // Ray direction = -Z of the target-ray pose orientation
    this._quat.set(
      rayPose.transform.orientation.x,
      rayPose.transform.orientation.y,
      rayPose.transform.orientation.z,
      rayPose.transform.orientation.w
    );
    this._dir.set(0, 0, -1)
      .applyQuaternion(this._quat)
      .transformDirection(rigObj.matrixWorld);

    // Ballistic arc, two-pass:
    // PASS 1 (collision): march the parabola in coarse segments and
    // raycast each against the collision meshes to find the hit time.
    // With no collisionEntities, fall back to the closed-form flat
    // ground plane (y = 0) hit.
    // PASS 2 (rendering): redistribute all N points evenly over
    // [0, tHit] — every point lies on the visible curve, which is
    // what keeps the arch smooth instead of polygonal.
    const speed = this.data.curveShootingSpeed;
    const gravity = this.data.gravity;
    const N = this.numPoints;

    const vy = this._dir.y * speed;
    const y0 = this._origin.y;
    const useMeshes = this.collisionMeshes.length > 0;
    // Simulation horizon: flight time down to the floor plane
    // (y=0 without meshes; a deep rayFloor with them, so the arc
    // can descend into valleys below y=0)
    const floorY = useMeshes ? this.data.rayFloor : 0;
    const tEnd = (-vy - Math.sqrt(vy * vy - 2 * gravity * (y0 - floorY))) / gravity;
    // Hand below the simulated floor: no arc can land
    if (!(tEnd > 0)) { this.hide(); return; }

    const parab = (t, out) => out.set(
      this._origin.x + this._dir.x * speed * t,
      this._origin.y + vy * t + 0.5 * gravity * t * t,
      this._origin.z + this._dir.z * speed * t
    );

    let tHit = tEnd;
    this.hitFound = !useMeshes; // plane fallback always lands at y=0
    let blocked = false;
    this._hitNormal.copy(this._up);

    if (useMeshes) {
      const SEGMENTS = 24;
      parab(0, this._segStart);
      for (let s = 1; s <= SEGMENTS; s++) {
        parab((s / SEGMENTS) * tEnd, this._segEnd);
        this._segDir.subVectors(this._segEnd, this._segStart);
        const segLen = this._segDir.length();
        if (segLen > 1e-6) {
          this._segDir.multiplyScalar(1 / segLen);
          this.raycaster.set(this._segStart, this._segDir);
          this.raycaster.near = 0;
          this.raycaster.far = segLen;
          const hits = this.raycaster.intersectObjects(this.castMeshes, false);
          if (hits.length) {
            const hit = hits[0];
            tHit = ((s - 1) + hit.distance / segLen) / SEGMENTS * tEnd;
            this.hitFound = true;
            blocked = this.blockMeshes.has(hit.object);
            if (hit.face) {
              this._normalMatrix.getNormalMatrix(hit.object.matrixWorld);
              this._hitNormal.copy(hit.face.normal)
                .applyMatrix3(this._normalMatrix).normalize();
            } else {
              this._hitNormal.copy(this._up);
            }
            break;
          }
        }
        this._segStart.copy(this._segEnd);
      }
    }

    // PASS 2: even resampling over the actual flight
    for (let i = 0; i < N; i++) {
      parab((i / (N - 1)) * tHit, this.arcPoints[i]);
    }
    if (!useMeshes) this.arcPoints[N - 1].y = 0; // land exactly on the plane

    this.target.copy(this.arcPoints[N - 1]);

    // Validity: must have hit something, and the landing surface
    // must not be steeper than landingMaxAngle
    let valid = this.hitFound && !blocked;
    if (valid && useMeshes) {
      const slope = THREE.MathUtils.radToDeg(this._hitNormal.angleTo(this._landingNormal));
      valid = slope <= this.data.landingMaxAngle;
    }
    if (valid && !useMeshes && this.data.planeRadius > 0) {
      // optional circular boundary for the flat-plane fallback
      const distFromCenter = Math.sqrt(
        this.target.x * this.target.x + this.target.z * this.target.z
      );
      valid = distFromCenter < this.data.planeRadius;
    }
    this.hasValidTarget = valid;

    const color = valid ? this.data.hitColor : this.data.missColor;
    this.arcMat.color.set(color);
    this.ringMat.color.set(color);
    this.haloMat.color.set(color);

    // Build the camera-facing ribbon: at each arc point, offset two
    // vertices sideways along cross(tangent, toCamera), tapering
    // from thick at the hand to a point at the target.
    sceneEl.camera.getWorldPosition(this._camPos);
    for (let i = 0; i < N; i++) {
      const p = this.arcPoints[i];
      const next = this.arcPoints[Math.min(i + 1, N - 1)];
      const prev = this.arcPoints[Math.max(i - 1, 0)];
      this._tangent.subVectors(next, prev);
      this._toCam.subVectors(this._camPos, p);
      this._side.crossVectors(this._tangent, this._toCam);
      const len = this._side.length();
      if (len > 1e-6) { this._side.multiplyScalar(1 / len); }
      else { this._side.set(0, 1, 0); }

      const k = i / (N - 1);
      const halfWidth = 0.028 * (1 - k) + 0.004;

      this.arcPositions[i * 6]     = p.x + this._side.x * halfWidth;
      this.arcPositions[i * 6 + 1] = p.y + this._side.y * halfWidth;
      this.arcPositions[i * 6 + 2] = p.z + this._side.z * halfWidth;
      this.arcPositions[i * 6 + 3] = p.x - this._side.x * halfWidth;
      this.arcPositions[i * 6 + 4] = p.y - this._side.y * halfWidth;
      this.arcPositions[i * 6 + 5] = p.z - this._side.z * halfWidth;
    }
    this.arc.geometry.attributes.position.needsUpdate = true;
    this.arc.visible = true;

    // Ring at the target, oriented to the landing surface (flat on
    // ground, tilted on slopes). Hidden entirely on a total miss —
    // the red arc alone signals "nothing to land on there".
    if (this.hitFound) {
      this.ring.position.copy(this.target).addScaledVector(this._hitNormal, 0.02);
      this.ring.quaternion.setFromUnitVectors(this._up, this._hitNormal);
      const pulse = 1 + Math.sin(performance.now() * 0.006) * 0.08;
      this.ring.scale.set(pulse, 1, pulse);
      this.ring.visible = true;
      // Halo rises from the ring along the surface normal, with a
      // slow breathing motion on its height
      this.halo.position.copy(this.ring.position);
      this.halo.quaternion.copy(this.ring.quaternion);
      this.halo.scale.set(pulse, 1 + Math.sin(performance.now() * 0.004) * 0.12, pulse);
      this.halo.visible = true;
    } else {
      this.ring.visible = false;
      this.halo.visible = false;
    }
  },

  remove: function () {
    this.cancelPinch();
    const sceneObj = this.el.sceneEl.object3D;
    sceneObj.remove(this.arc);
    sceneObj.remove(this.ring);
    sceneObj.remove(this.halo);
  }
});
