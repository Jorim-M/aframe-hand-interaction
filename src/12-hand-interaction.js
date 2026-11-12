// ═══════════════════════════════════════════════════════════
// HAND INTERACTION — the whole kit in one attribute. Put it on the
// rig (the entity holding the camera) and it sets up both hands:
//
//   <a-entity id="rig" hand-interaction>
//     <a-entity camera position="0 1.6 0" look-controls></a-entity>
//   </a-entity>
//
// Recommended split by default: teleport on the left hand, turning
// on the right, and pointer + fingertip press + grab on both.
// Change any of it with the options below, e.g.
//   hand-interaction="teleportHand: right; turnHand: left; tutorial: true"
//
// If the rig already has a hand-tracking-controls child for a hand,
// that entity is used (so you can keep your own hand model
// settings); otherwise one is created. Components you've already
// put on a hand entity are left as they are. The rig and camera get
// ids if they have none, and every component is pointed at them, so
// they don't have to be #rig and #head.
//
// Turning on hand tracking needs nothing extra: A-Frame's
// hand-tracking-controls adds the WebXR 'hand-tracking' feature
// itself. Warns in the console if a hand also carries a controller
// or gesture component that would compete for the same gestures
// (laser-controls, blink-controls, handy-controls, …).
// ═══════════════════════════════════════════════════════════
const SIDES = ['left', 'right'];
const COMPETING = ['laser-controls', 'blink-controls', 'handy-controls', 'oculus-touch-controls',
  'meta-touch-controls'];

function sidesFor(v) { return v === 'both' ? SIDES : v === 'none' ? [] : [v]; }

AFRAME.registerComponent('hand-interaction', {
  schema: {
    teleportHand: { default: 'left', oneOf: ['left', 'right', 'both', 'none'] },
    turnHand: { default: 'right', oneOf: ['left', 'right', 'both', 'none'] },
    turnStartsOn: { default: false },       // turning on from the start (no thumb tap needed)
    pointer: { default: true },             // point and trigger, both hands
    poke: { default: true },                // fingertip press, both hands
    grab: { default: true },                // whole-hand grab, both hands
    poses: { default: false },              // hand-pose events on both hands
    landable: { default: '.landable' },     // where you can teleport ('' = flat floor at y 0)
    blocked: { default: '' },               // what stops the arc and can't be landed on
    interactable: { default: '.interactable' },
    grabbable: { default: '.grabbable' },
    color: { default: '' },                 // feedback colour (arc, ray, turn indicator); '' = default blue
    missColor: { default: '' },             // arc colour with no valid landing; '' = default red
    tutorial: { default: false },           // add hand-tutorial to the scene
  },

  init: function () {
    const d = this.data, rig = this.el, scene = rig.sceneEl;
    if (!rig.id) rig.id = 'hand-interaction-rig';
    const cam = rig.querySelector('[camera]') || scene.querySelector('[camera]');
    if (!cam) console.warn('hand-interaction: no camera found inside the rig; turning and teleport need one.');
    else if (!cam.id) cam.id = 'hand-interaction-head';
    const rigSel = '#' + rig.id, headSel = cam ? '#' + cam.id : '#head';
    this.hands = {};

    const teleportSides = sidesFor(d.teleportHand), turnSides = sidesFor(d.turnHand);
    const surfaces = [d.landable, d.blocked].filter(Boolean).join(', ');

    for (const side of SIDES) {
      let el = Array.from(rig.querySelectorAll('[hand-tracking-controls]'))
        .find((e) => (e.getAttribute('hand-tracking-controls') || {}).hand === side);
      if (!el) {
        el = document.createElement('a-entity');
        el.setAttribute('hand-tracking-controls', { hand: side });
        rig.appendChild(el);
      }
      this.hands[side] = el;
      const add = (name, data) => { if (!el.hasAttribute(name)) el.setAttribute(name, Object.assign({ hand: side }, data)); };

      if (teleportSides.includes(side)) {
        const t = { cameraRig: rigSel, teleportOrigin: headSel };
        if (d.landable) t.collisionEntities = d.landable;
        if (d.blocked) t.blockEntities = d.blocked;
        if (d.color) t.hitColor = d.color;
        if (d.missColor) t.missColor = d.missColor;
        add('hand-teleport', t);
      }
      if (turnSides.includes(side)) {
        const t = { cameraRig: rigSel, head: headSel };
        if (d.color) t.indicatorColor = d.color;
        if (d.turnStartsOn && side === turnSides[0]) t.startHand = side;
        add('hand-thumb-tilt', t);
      }
      if (d.pointer) {
        const p = { cameraRig: rigSel, objects: d.interactable };
        if (surfaces) p.surfaces = surfaces;
        if (d.color) p.color = d.color;
        add('hand-pointer', p);
      }
      if (d.poke) add('hand-poke', { cameraRig: rigSel, objects: d.interactable });
      if (d.grab) add('hand-grab', { cameraRig: rigSel, objects: d.grabbable });
      if (d.poses) add('hand-pose', {});

      const clash = COMPETING.filter((n) => el.hasAttribute(n));
      if (clash.length) {
        console.warn('hand-interaction: the ' + side + ' hand also has ' + clash.join(', ') +
          ', which will compete for the same gestures.');
      }
    }

    if (d.tutorial && !scene.hasAttribute('hand-tutorial')) scene.setAttribute('hand-tutorial', { head: headSel });
  },
});
