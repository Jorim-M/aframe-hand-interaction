// ═══════════════════════════════════════════════════════════
// HAND TUTORIAL — a guided walkthrough shown on entering VR.
// Each step waits for the matching library event (teleported,
// thumbtilttoggle, snapturn, click, grabstart). Steps are only
// included for components present in the scene. The panel is fixed
// in the world: at a tutorial-mount entity for that step if there is
// one, otherwise beside the user (sideAngle, 22° to the left), moved only
// between steps and only if it ended up out of view or far away. It
// turns (yaw only) to face the user, and has a "Skip tutorial"
// button that can be pointed at or poked.
// Completion is remembered in localStorage (persist: true); call
// el.components['hand-tutorial'].restart() to show it again.
// Emits 'tutorialstep' ({ index, key }) and 'tutorialdone'.
// ═══════════════════════════════════════════════════════════
AFRAME.registerComponent('hand-tutorial', {
  schema: {
    head: { default: '#head' },
    persist: { default: true },
    storageKey: { default: 'hand-tutorial-done' },
    distance: { default: 1.2 },          // unmounted panel: distance from the head (m)
    sideAngle: { default: 22 },          // unmounted panel: degrees left of forward (negative = right).
                                         // Further out lands in the headset's low-resolution periphery (foveation)
    height: { default: -0.2 },           // unmounted panel: height relative to the eyes (m)
    viewAngle: { default: 50 },          // unmounted panel is moved if further off-forward than this...
    viewDistance: { default: 4 },        // ...or further away than this (m), checked between steps
    skipClass: { default: 'interactable' },
  },

  STEPS: {
    teleport: {
      needs: 'hand-teleport', event: 'teleported',
      text: (h) => 'Move around\n\nPoint at the ground' + (h ? ' with your ' + h + ' hand' : '') +
        ', then pinch and hold. Aim the arc and let go to jump there.',
    },
    turnOn: {
      needs: 'hand-thumb-tilt', event: 'thumbtilttoggle',
      text: (h) => 'Switch on turning\n\nMake a fist' + (h ? ' with your ' + h + ' hand' : '') +
        ' and tap your thumb on the side of your index finger.' + (h ? '' : ' Turning is now on for that hand.'),
      accept: (d) => d && d.enabled,
    },
    turn: {
      needs: 'hand-thumb-tilt', event: 'snapturn',
      text: (h) => 'Turn\n\n' + (h ? 'With your ' + h + ' hand' : 'On that hand') +
        ', give a thumbs-up, then tilt your thumb left or right.',
    },
    turnOff: {
      needs: 'hand-thumb-tilt', event: 'thumbtilttoggle',
      text: (h) => 'Switch off turning\n\nMake a fist' + (h ? ' with your ' + h + ' hand' : ' with that hand') +
        ' and tap your thumb on your index finger again. Switch turning off whenever you don\'t need it, so you don\'t turn by accident.',
      accept: (d) => d && !d.enabled,
    },
    point: {
      needs: 'hand-pointer', event: 'click',
      text: 'Select from a distance\n\nPoint your index finger at something farther away. When it lights up, curl your finger like a trigger, then straighten it.',
      accept: (d) => !!(d && d.cursorEl && d.cursorEl.components &&
        d.cursorEl.components['hand-pointer'] && d.source !== 'poke'),
    },
    poke: {
      needs: 'hand-poke', event: 'click',
      text: 'Press\n\nPress a button within reach with your fingertip.',
      accept: (d) => !!(d && (d.source === 'poke' || d.source === 'push-button')),
    },
    grab: {
      needs: 'hand-grab', event: 'grabstart',
      text: 'Pick things up\n\nReach out with an open hand and close it around an object. Open your hand to let go.',
      accept: (d) => !!(d && d.hand),
    },
  },
  ORDER: ['teleport', 'turnOn', 'turn', 'turnOff', 'point', 'poke', 'grab'],

  init: function () {
    this.headEl = document.querySelector(this.data.head);
    this.steps = [];
    this.index = -1;
    this.active = false;
    this.doneAt = 0;
    this.allDone = false;
    this.mountEl = null;
    this.scaleT = 1;
    this._head = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this._toPanel = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._up = new THREE.Vector3(0, 1, 0);

    this.buildPanel();

    this.onEvent = (e) => {
      if (!this.active || this.doneAt) return;
      if (e.target === this.skipEl) return;
      const step = this.STEPS[this.steps[this.index]];
      if (!step || e.type !== step.event) return;
      if (step.accept && !step.accept(e.detail)) return;
      this.completeStep();
    };
    const sceneEl = this.el.sceneEl;
    this.eventNames = new Set(this.ORDER.map((k) => this.STEPS[k].event));
    this.eventNames.forEach((n) => sceneEl.addEventListener(n, this.onEvent));

    this.onEnterVR = () => this.start();
    this.onExitVR = () => { this.active = false; this.panel.setAttribute('visible', false); };
    sceneEl.addEventListener('enter-vr', this.onEnterVR);
    sceneEl.addEventListener('exit-vr', this.onExitVR);
  },

  buildPanel: function () {
    const panel = document.createElement('a-entity');
    panel.setAttribute('visible', false);
    // Sized so body text is ~2 cm tall: smaller MSDF text breaks up
    // into jagged edges on a headset's display
    panel.setAttribute('geometry', 'primitive: plane; width: 0.8; height: 0.44');
    panel.setAttribute('material', 'shader: flat; color: #11161d; opacity: 0.88; transparent: true; fog: false');

    const progress = document.createElement('a-entity');
    progress.setAttribute('position', '0 0.175 0.002');
    progress.setAttribute('text', 'value: ; align: center; width: 0.73; wrapCount: 40; color: #8fb4e8');

    const body = document.createElement('a-entity');
    body.setAttribute('position', '0 0.01 0.002');
    body.setAttribute('text', 'value: ; align: center; width: 0.73; wrapCount: 32; color: #ffffff');

    const skip = document.createElement('a-entity');
    skip.classList.add(this.data.skipClass);
    skip.setAttribute('position', '0 -0.17 0.004');
    skip.setAttribute('geometry', 'primitive: plane; width: 0.26; height: 0.065');
    skip.setAttribute('material', 'color: #2b3542; fog: false');
    skip.setAttribute('text', 'value: Skip tutorial; align: center; width: 0.65; wrapCount: 30; color: #c9d3df; zOffset: 0.002');
    skip.addEventListener('click', () => this.finish());

    panel.appendChild(progress);
    panel.appendChild(body);
    panel.appendChild(skip);
    this.el.sceneEl.appendChild(panel);
    this.panel = panel;
    this.progressEl = progress;
    this.bodyEl = body;
    this.skipEl = skip;
  },

  isDone: function () {
    if (!this.data.persist) return false;
    try { return localStorage.getItem(this.data.storageKey) === '1'; } catch (e) { return false; }
  },

  restart: function () {
    try { localStorage.removeItem(this.data.storageKey); } catch (e) { /* storage unavailable */ }
    if (this.el.sceneEl.is('vr-mode')) this.start();
  },

  // 'left' / 'right' if exactly one hand has the component, else null
  onlyHand: function (compName) {
    const hands = Array.from(document.querySelectorAll('[' + compName + ']'))
      .map((el) => el.components && el.components[compName] && el.components[compName].data.hand)
      .filter(Boolean);
    const unique = Array.from(new Set(hands));
    return unique.length === 1 ? unique[0] : null;
  },

  // A step is possible if a hand has the component and, for
  // point / poke / grab, the scene has objects it can act on
  // (other than this tutorial's own Skip button)
  stepPossible: function (key) {
    const handEl = document.querySelector('[' + this.STEPS[key].needs + ']');
    if (!handEl) return false;
    const comp = handEl.components && handEl.components[this.STEPS[key].needs];
    const selector = comp && comp.data && comp.data.objects;
    if (!selector) return true;
    return Array.from(document.querySelectorAll(selector)).some((el) => el !== this.skipEl);
  },

  start: function () {
    if (this.isDone()) return;
    this.steps = this.ORDER.filter((k) => this.stepPossible(k));
    // Turning already on (startHand set): no need to teach the switch
    const tilt = this.el.sceneEl.systems['hand-thumb-tilt'];
    if (tilt && tilt.activeHand) this.steps = this.steps.filter((k) => k !== 'turnOn');
    if (!this.steps.length) return;
    this.active = true;
    this.allDone = false;
    this.mountEl = null;
    this.besideUser(this.panel.object3D.position);
    this.panel.setAttribute('visible', true);
    this.showStep(0);
  },

  showStep: function (i) {
    this.index = i;
    this.doneAt = 0;
    const key = this.steps[i];
    this.progressEl.setAttribute('text', 'value', 'Step ' + (i + 1) + ' of ' + this.steps.length);
    const step = this.STEPS[key];
    const text = typeof step.text === 'function' ? step.text(this.onlyHand(step.needs)) : step.text;
    this.bodyEl.setAttribute('text', 'value', text);
    this.place(key);
    this.el.emit('tutorialstep', { index: i, key: key });
  },

  completeStep: function () {
    this.doneAt = performance.now();
    this.bodyEl.setAttribute('text', 'value', 'Done!');
  },

  finish: function () {
    this.active = false;
    this.panel.setAttribute('visible', false);
    if (this.data.persist) {
      try { localStorage.setItem(this.data.storageKey, '1'); } catch (e) { /* storage unavailable */ }
    }
    this.el.emit('tutorialdone');
  },

  // The tutorial-mount entity for a step, if any
  mountFor: function (key) {
    const sys = this.el.sceneEl.systems['tutorial-mount'];
    if (!sys) return null;
    for (const m of sys.mounts) {
      if (m.data.steps.indexOf(key) !== -1) return m;
    }
    return null;
  },

  // Put the panel for this step somewhere fixed in the world
  place: function (key) {
    const obj = this.panel.object3D;
    const mount = this.mountFor(key);
    const prevMount = this.mountEl;
    this.mountEl = mount ? mount.el : null;
    if (mount) {
      mount.el.object3D.getWorldPosition(obj.position);
      this.scaleT = mount.data.scale;
      if (mount.el !== prevMount) obj.scale.setScalar(this.scaleT * 0.6); // small scale-in on a move
    } else {
      this.scaleT = 1;
      // Coming back from a mount, or the panel has drifted out of
      // view or far away while the user moved: put it beside them
      // (besideUser starts the scale-in)
      if (prevMount || !this.inView()) this.besideUser(obj.position);
    }
  },

  // Is the panel roughly ahead of the user and not too far away?
  inView: function () {
    const head = this.headEl.object3D;
    head.getWorldPosition(this._head);
    head.getWorldQuaternion(this._q);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q).setY(0);
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._toPanel.subVectors(this.panel.object3D.position, this._head).setY(0);
    const dist = this._toPanel.length();
    if (dist > this.data.viewDistance) return false;
    if (dist < 1e-3) return false;
    const angle = THREE.MathUtils.radToDeg(this._toPanel.multiplyScalar(1 / dist).angleTo(this._fwd));
    return angle <= this.data.viewAngle;
  },

  // Off to one side of where the user is looking, a little below the
  // eyes, so it never sits in the middle of the view
  besideUser: function (out) {
    const head = this.headEl.object3D;
    head.getWorldPosition(this._head);
    head.getWorldQuaternion(this._q);
    this._fwd.set(0, 0, -1).applyQuaternion(this._q).setY(0);
    if (this._fwd.lengthSq() < 1e-6) this._fwd.set(0, 0, -1);
    this._fwd.normalize();
    this._fwd.applyAxisAngle(this._up, THREE.MathUtils.degToRad(this.data.sideAngle));
    out.copy(this._head).addScaledVector(this._fwd, this.data.distance);
    out.y = this._head.y + this.data.height;
    this.panel.object3D.scale.setScalar(0.6);
    return out;
  },

  tick: function (time, dt) {
    if (!this.active) return;

    // After a completed step: show "Done!" briefly, then move on
    if (this.doneAt && performance.now() - this.doneAt > 900) {
      if (this.allDone) {
        this.finish();
        return;
      }
      if (this.index + 1 < this.steps.length) {
        this.showStep(this.index + 1);
      } else {
        this.allDone = true;
        this.progressEl.setAttribute('text', 'value', '');
        this.bodyEl.setAttribute('text', 'value', this.steps.indexOf('turnOff') !== -1
          ? "You're all set\n\nTurning is off for now. Tap your thumb on your index finger to switch it back on."
          : "You're all set");
        this.doneAt = performance.now() + 3000; // final message stays ~4s
      }
    }

    // The panel stays where it is; it only turns (yaw) to face the
    // user, and finishes a short scale-in after a move
    const panelObj = this.panel.object3D;
    if (this.mountEl) this.mountEl.object3D.getWorldPosition(panelObj.position);
    this.headEl.object3D.getWorldPosition(this._head);
    const dx = this._head.x - panelObj.position.x, dz = this._head.z - panelObj.position.z;
    if (dx * dx + dz * dz > 1e-6) panelObj.rotation.set(0, Math.atan2(dx, dz), 0);
    const sc = panelObj.scale.x;
    if (Math.abs(sc - this.scaleT) > 1e-3) {
      panelObj.scale.setScalar(sc + (this.scaleT - sc) * (1 - Math.exp(-(dt || 16) / 70)));
    }
  },

  remove: function () {
    const sceneEl = this.el.sceneEl;
    this.eventNames.forEach((n) => sceneEl.removeEventListener(n, this.onEvent));
    sceneEl.removeEventListener('enter-vr', this.onEnterVR);
    sceneEl.removeEventListener('exit-vr', this.onExitVR);
    if (this.panel.parentNode) this.panel.parentNode.removeChild(this.panel);
  }
});


// ═══════════════════════════════════════════════════════════
// TUTORIAL MOUNT — marks where the hand-tutorial panel appears for
// the listed steps (teleport, turnOn, turn, turnOff, point, poke,
// grab). The panel sits at this entity's world position and turns
// to face the user. `scale` enlarges it for mounts seen from afar.
//   <a-entity position="6 1.5 -13"
//             tutorial-mount="steps: turnOn, turn, turnOff; scale: 1.4">
// ═══════════════════════════════════════════════════════════
AFRAME.registerSystem('tutorial-mount', {
  init: function () { this.mounts = []; },
});

AFRAME.registerComponent('tutorial-mount', {
  schema: {
    steps: { type: 'array', default: [] },
    scale: { default: 1 },
  },
  init: function () { this.system.mounts.push(this); },
  remove: function () {
    const i = this.system.mounts.indexOf(this);
    if (i !== -1) this.system.mounts.splice(i, 1);
  },
});
