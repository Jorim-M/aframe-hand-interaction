# aframe-hand-interaction

Controller-free movement and interaction for WebXR hand tracking in [A-Frame](https://aframe.io) 1.7+.

- **Teleport**: pinch, aim a ballistic arc, release. Lands on the meshes you choose, refuses steep slopes and "no landing" surfaces, and puts your head (not the rig origin) on the target.
- **Snap-turn**: tap your thumb on the side of your curled index finger to switch turning on, then thumbs-up and tilt left or right.
- **Point and select**: point your index finger to show a ray, then curl it like a trigger to select. Sends ordinary A-Frame cursor events.
- **Fingertip press**: press things within reach with your fingertip. Push-buttons travel with your finger, and sliders follow it.
- **Whole-hand grab**: reach out with an open hand and close it around an object. It settles against your palm.
- **Hand joints and poses**: attach anything to a joint (wrist menus that appear when you look at your palm), and get events for hand shapes you record.
- **Tutorial**: a short guided walkthrough on first entry to VR, with panels fixed in the world rather than following your gaze.

Gestures don't compete with each other. Pinching only teleports; grabbing uses the whole hand; a thumb tap is never mistaken for a pinch; and the ray steps aside when your hand is at something it could press or grab. Hand-shape checks are measured relative to your palm, so they work for any hand size.

One file, no dependencies besides A-Frame.

---

## Quick start

```html
<script src="https://aframe.io/releases/1.7.0/aframe.min.js"></script>
<script src="aframe-hand-interaction.min.js"></script>

<a-scene>
  <a-entity hand-interaction>
    <a-entity camera position="0 1.6 0" look-controls></a-entity>
  </a-entity>

  <a-plane class="landable" rotation="-90 0 0" width="40" height="40"></a-plane>
  <a-box class="interactable" position="0 1.5 -3"></a-box>                   <!-- point at it, press it -->
  <a-box class="grabbable" position="0.3 1 -0.5" scale="0.1 0.1 0.1"></a-box> <!-- pick it up -->
</a-scene>
```

That's all you need. `hand-interaction` creates both hands (using A-Frame's `hand-tracking-controls`, which also asks the browser for hand tracking) and sets them up:

| | Left hand | Right hand |
|---|---|---|
| Teleport (pinch) | ✓ | |
| Snap-turn (thumb tap, then thumbs-up tilt) | | ✓ |
| Point and select | ✓ | ✓ |
| Fingertip press | ✓ | ✓ |
| Whole-hand grab | ✓ | ✓ |

Mark your objects with three classes (or choose your own selectors):

| Class | Meaning |
|---|---|
| `.landable` | Teleport arcs land here. Without any, the arc lands on a flat floor at y = 0. |
| `.interactable` | The pointer and fingertip press send events here. |
| `.grabbable` | Hands can pick these up. |

Then use normal A-Frame events:

```js
box.addEventListener('click', () => { /* pointed and selected, or pressed */ });
block.addEventListener('grabstart', (e) => { /* e.detail.hand */ });
```

### Options for `hand-interaction`

| Option | Default | |
|---|---|---|
| `teleportHand` | `left` | `left`, `right`, `both` or `none` |
| `turnHand` | `right` | `left`, `right`, `both` or `none` |
| `turnStartsOn` | `false` | turning starts switched on, with no thumb tap needed |
| `pointer` | `true` | point and select on both hands |
| `poke` | `true` | fingertip press on both hands |
| `grab` | `true` | whole-hand grab on both hands |
| `poses` | `false` | `hand-pose` events on both hands |
| `landable` | `.landable` | where you can teleport (`''` = flat floor at y = 0) |
| `blocked` | `''` | surfaces that stop the arc and can't be landed on (water, walls) |
| `interactable` | `.interactable` | pointer and press targets |
| `grabbable` | `.grabbable` | grab targets |
| `color` | `''` | feedback colour for the arc, ray and turn indicator (`''` = default blue) |
| `missColor` | `''` | arc colour when there's nowhere valid to land (`''` = default red) |
| `tutorial` | `false` | add the guided tutorial to the scene |

```html
<a-entity hand-interaction="teleportHand: right; turnHand: left; blocked: .water; color: #ff9a1f; tutorial: true">
```

If the rig already contains a `hand-tracking-controls` entity for a hand, that entity is used, so your own hand-model settings are kept. Components you've already put on it are left alone. The rig and camera don't need particular ids. The console warns if a hand also has `laser-controls`, `blink-controls`, `handy-controls` or controller components, which would compete for the same gestures.

### Setting up hands by hand

The individual components work without the wrapper. Put them on `hand-tracking-controls` entities inside a rig. They expect the rig to be `#rig` and the camera `#head`, or you set `cameraRig` / `head` / `teleportOrigin`:

```html
<a-entity id="rig">
  <a-entity id="head" camera position="0 1.6 0" look-controls></a-entity>
  <a-entity hand-tracking-controls="hand: left"
            hand-teleport="hand: left; collisionEntities: .landable"
            hand-pointer="hand: left; surfaces: .landable"
            hand-poke="hand: left" hand-grab="hand: left"></a-entity>
  <a-entity hand-tracking-controls="hand: right"
            hand-thumb-tilt="hand: right"
            hand-pointer="hand: right; surfaces: .landable"
            hand-poke="hand: right" hand-grab="hand: right"></a-entity>
</a-entity>
```

Teleport needs `hand-tracking-controls` on the same entity, because it starts from that component's pinch events.

---

## The gestures

### Teleport: `hand-teleport`
Pinch and hold: an arc appears from your hand, blue where you can land, red where you can't. Release to go there. Only one hand aims at a time. A pinch made while your hand is pointing, at a grabbable object, or holding one doesn't teleport. Emits `teleported` on the hand.

| Option | Default | |
|---|---|---|
| `hand` | `right` | |
| `collisionEntities` | `''` | selector for landable meshes; empty = flat y = 0 plane |
| `blockEntities` | `''` | meshes that stop the arc and can't be landed on |
| `curveShootingSpeed` | `7.5` | launch speed (m/s); sets the range |
| `gravity` | `-9.8` | arc curvature |
| `landingMaxAngle` | `45` | refuse slopes steeper than this (degrees) |
| `landingNormal` | `0 1 0` | "up" for the slope test |
| `planeRadius` | `0` | with the flat-plane fallback, how far you can go (0 = unlimited) |
| `rayFloor` | `-20` | how far below y = 0 the arc is traced (for valleys) |
| `hitColor` / `missColor` | `#4d93fd` / `#e86a6a` | |
| `cameraRig` | `#rig` | the entity that moves |
| `teleportOrigin` | `#head` | the point placed on the target (your head, not the rig origin) |

### Snap-turn: `hand-thumb-tilt`
Turning starts **off**, so a resting thumbs-up never turns you by surprise. To switch it on or off, curl your fingers into a fist and tap your thumb on the side of your index finger. Then make a thumbs-up and tilt your thumb past about 35° to turn 45° that way. Bring it back toward upright to turn again. An indicator above your thumb shows the tilt, and turning is active on one hand at a time. Emits `thumbtilttoggle` ({ enabled, hand, activeHand }) and `snapturn` ({ direction, angle, hand }).

| Option | Default | |
|---|---|---|
| `angle` | `45` | degrees per turn |
| `tiltOn` / `tiltOff` | `35` / `20` | tilt that turns / neutral zone that re-arms (degrees) |
| `holdMs` | `120` | tilt must be held this long |
| `cooldown` | `300` | ms between turns |
| `adaptNeutral` | `true` | learn your resting thumb angle each time |
| `neutralMax`, `neutralSampleMs` | `20`, `100` | limits on that learning |
| `toggleTap` | `true` | thumb tap switches turning on and off |
| `startHand` | `none` | `left` / `right`: turning starts on for that hand |
| `showIndicator`, `indicatorColor`, `indicatorOffset` | `true`, `#ffffff`, `0.05` | |
| `fingerCurled`, `thumbExtended` | `0.7`, `0.58` | pose thresholds (straightness; palm lengths) |
| `tapContact`, `tapRelease`, `tapApproachMs`, `tapTravel`, `tapFistMs`, `poseGraceMs` | | tap and tracking-dropout tuning |
| `cameraRig`, `head` | `#rig`, `#head` | |

### Point and select: `hand-pointer`
Point your index finger with the other fingers curled. A ray appears, with a cursor where it hits. Curl your index like a trigger to press (`mousedown`), and straighten it to release (`mouseup` + `click`). Objects receive `mouseenter` / `mouseleave` too, just as with A-Frame's `cursor`. Only one hand points at a time. The ray hides when your hand is close to something it could press or grab. Add `pointer-draggable` to an `.interactable` to drag it with the ray (`dragstart` / `dragend`).

| Option | Default | |
|---|---|---|
| `objects` | `.interactable` | targets |
| `surfaces` | `''` | where a ray that hits nothing stops (e.g. `.landable`) |
| `far` | `10` | maximum distance (m) |
| `minDistance` | `0.3` | anything nearer is left to press and grab (m) |
| `rayLength` | `3` | ray length when nothing is hit (m) |
| `pointStraight`, `othersCurled` | `0.85`, `0.7` | pointing pose |
| `triggerCurl`, `releaseStraight` | `0.6`, `0.8` | press and release |
| `pointHoldMs` | `80` | pose held this long before the ray shows |
| `color`, `showBeam`, `cursorSize` | `#ffffff`, `true`, `0.012` | |
| `highlight`, `highlightColor` | `true`, `#2b4f80` | tint what you're pointing at |

### Fingertip press: `hand-poke`
Touch an `.interactable` with your extended index fingertip: `mouseenter` + `mousedown`. Pull back: `mouseup` + `click` + `mouseleave`. The `click` detail has `source: 'poke'`.

| Option | Default | |
|---|---|---|
| `objects` | `.interactable` | |
| `enterMargin` / `exitMargin` | `0.005` / `0.015` | touch and release distances (m) |
| `fingerExtended` | `0.8` | index straightness needed |
| `nearDistance` | `0.15` | within this, the pointer steps aside (m) |
| `highlight`, `highlightColor` | `true`, `#2b4f80` | |

### Whole-hand grab: `hand-grab`
Bring an open hand to a `.grabbable` so it's against your palm, and close your hand. The object eases against your palm and follows your hand until you open it. Only a change from open to closed grabs, so pointing, a trigger pull, a thumbs-up, or a fist moved into something doesn't pick it up. Grabbing what your other hand holds passes it across. Events: `grabstart` / `grabend` on the object ({ hand, handEl }) and on the hand ({ el }). The object gets the `grabbed` state.

| Option | Default | |
|---|---|---|
| `objects` | `.grabbable` | |
| `openGrip` / `closeGrip` / `releaseGrip` | `0.8` / `0.68` / `0.78` | finger straightness for open, closed, let go |
| `reach` | `0.6` | how close to your palm an object must be (palm lengths, about 6 cm) |
| `palmOffset` | `0.35` | grasp point in front of the palm (palm lengths) |
| `snap`, `snapMs`, `snapGap`, `snapMax` | `true`, `100`, `0.004`, `0.08` | ease the object against the palm |
| `palmThickness` | `0.15` | palm surface below the joints (palm lengths) |
| `nearDistance` | `0.15` | within this, the pointer steps aside and pinches don't teleport (m) |
| `highlight`, `highlightColor` | `true`, `#2b4f80` | tint what closing your hand would pick up |

---

## Building blocks

### `hand-joint`: attach things to your hand
Put it on any entity that's a child of the scene (not of the rig). It follows a joint every frame and hides while the hand isn't tracked.

```html
<!-- a wrist menu that appears when you turn your left palm toward your face -->
<a-entity hand-joint="hand: left; joint: wrist; offset: 0 -0.07 -0.02; faceHead: true; palmFacing: true">
  ...panel and push-buttons...
</a-entity>
```

| Option | Default | |
|---|---|---|
| `hand`, `joint` | `left`, `wrist` | any of the 25 WebXR joint names, e.g. `index-finger-tip` |
| `offset` | `0 0 0` | in the joint's frame: −Z toward the fingertips, −Y out of the palm |
| `rotate` | `true` | take the joint's orientation |
| `faceHead` | `false` | turn to face you instead, which keeps text readable |
| `palmFacing`, `facingAngle` | `false`, `50` | emit `palmup` / `palmdown` and set the `palm-facing` state |
| `hideUntracked` | `true` | |

### `hand-pose`: shapes you record
A pose is the finger joints' positions relative to the wrist, in palm lengths. It doesn't depend on where your hand is, which way it points, or how big it is. Poses are stored as a right hand and mirrored, so one recording works for both hands.

```js
const poses = sceneEl.systems['hand-pose'];
const shape = poses.capture('right');      // the right hand's current shape, as plain JSON
poses.define('ok-sign', shape);            // or load JSON saved earlier
poses.define('rock', { joints: [...], threshold: 0.15 });   // a looser match for this one
```
```html
<a-entity hand-tracking-controls="hand: right" hand-pose="hand: right; poses: ok-sign, rock">
```
It emits `posestart` / `poseend` ({ pose, hand, distance }) on the hand. A pose starts only when it's within `threshold` and clearly nearer than the next closest pose, and when it has been held for `holdMs`. Otherwise there's no pose at all; it doesn't guess.

| Option | Default | |
|---|---|---|
| `poses` | all defined | which poses to look for |
| `threshold` / `exitThreshold` | `0.1` / `0.14` | start / end distance (palm lengths) |
| `margin` | `0.03` | how much nearer than the next pose it must be |
| `holdMs` | `80` | |

For scale, on simulated hands: open vs fist is about 0.57, open vs point about 0.43, and two shapes that differ only in the pinky about 0.12.

### `push-button` and `hand-slider`
```html
<a-cylinder push-button radius="0.04" height="0.03"></a-cylinder>
<a-box hand-slider="axis: x; length: 0.24; value: 0.5" width="0.03" height="0.03" depth="0.04"></a-box>
```
- **`push-button`**: the entity is the button cap. Pressed from its top (its own +Y), it moves in with your fingertip, sends `buttondown` + `click` near the bottom, then springs back (`buttonup`). Pressing in from the side does nothing. Options: `travel` (`0.012` m), `clickAt` (`0.85`), `releaseAt` (`0.35`), `margin`, `returnSpeed`, `hands`.
- **`hand-slider`**: the entity is the knob. It slides along its parent's `axis` within ±`length`/2 of where it starts. Touch it and it follows your fingertip, with no jump. Emits `slidestart`, `change` ({ value 0–1 }) and `slideend`; `setValue(v)` sets it from code. Options: `axis`, `length`, `value`, `step`, `grabMargin`, `releaseMargin`, `hands`.

These two handle the fingertip themselves (`hand-poke` leaves them alone), and both work at any angle.

### `hand-tutorial` and `tutorial-mount`
Add `hand-tutorial` to the scene, or set `tutorial: true` on `hand-interaction`. On the first entry to VR it walks through the gestures your scene actually has, and remembers it's been done (`localStorage`, key `hand-tutorial-done`; call `restart()` to show it again). Steps: teleport, switch turning on, turn, switch turning off, point, press, grab.

The panel is fixed in the world. By default it sits about 22° to your left and only moves between steps, if it ended up out of view. To place a step's panel at a spot in your scene, use `tutorial-mount`:

```html
<a-entity position="6 1.5 -12" tutorial-mount="steps: turnOn, turn, turnOff; scale: 1.2"></a-entity>
```

Emits `tutorialstep` ({ index, key }) and `tutorialdone` on the scene.

---

## Tips

- **Sharper text in VR:** A-Frame turns on fixed foveation by default, which blurs the edges of your view, and panels off to the side look pixelated there. `renderer="foveationLevel: 0"` fixes this, at some GPU cost.
- **Mist and fog:** the arc, ray, cursor and indicators ignore scene fog, so they stay visible.
- **Desktop testing:** these components only act on tracked hands. For mouse testing, add A-Frame's `cursor="rayOrigin: mouse"` to the scene. It sends the same events your objects already listen for.

## Status and limits

- **Testing:** an automated suite (`npm test`) of simulated 25-joint hands at 75–125% hand size, covering every gesture, the conflicts between them, and both ways browsers report hand joints. Real-device testing so far has been one person on a Meta Quest. Other people's hands, and other headsets (Apple Vision Pro, Pico, Android XR), are untested.
- **Assumption:** joint orientation follows the WebXR convention, with −Y out of the palm. `hand-joint`'s palm-facing and grab's palm snap rely on it.
- **No controller support.** It's hands only. Use A-Frame's `laser-controls` or `blink-controls` on controller entities alongside it.

## Development

```
src/        source, in order (00-header … 13-tutorial); one shared scope
dist/       built single file + minified (npm run build)
test/       simulated-hand harness and scenarios (npm test)
examples/   minimal.html, playground.html
```

`npm test` first checks that `dist/` matches `src/`, then runs every scenario against both builds, with both ways of reading joints. Serve the folder over HTTPS (WebXR requires it) to try the examples on a headset.

## Licence

[MIT](LICENSE) © 2026 Jorim M. Oduo (Beamport Story Labs)
