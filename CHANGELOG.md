# Changelog

## 2.6.0
- Released under the MIT licence.
- **`hand-interaction`**: the whole kit from one attribute on the rig. It creates or uses both hand entities with the recommended split (teleport left, turning right, pointer/press/grab on both), with options for every choice, and warns about competing controller or gesture components.
- The source is split into `src/` modules, built into one file plus a minified copy (`npm run build`).
- The test suite ships with the package (`npm test`): 156 checks, run against both builds and both joint-reading paths.

## 2.5.0
- `hand-pose`: events for hand shapes you record (wrist-relative joint positions in palm lengths, mirrored between hands, with a real "no pose").
- `push-button` (travels with your fingertip, clicks at the bottom) and `hand-slider`.
- The tutorial's press step accepts push-buttons.
- Cleanup: out-of-date comments, and one shared highlight colour.

## 2.4.0
- `hand-joint`: attach entities to joints; `faceHead`; palm-up / palm-down events for wrist menus.
- Grab: the object eases snugly against the palm (`snap`).
- `hand-input` keeps every joint's orientation (`jointQuatWorld`).

## 2.3.0
- Grab is whole-hand (open, then close), no longer a pinch, so it never competes with teleport. Pinches at or while holding an object don't teleport. Holding blocks turning.

## 2.2.x
- 2.2.3: larger tutorial panel text; panel moved 22° to the side (out of the blurry foveated area).
- 2.2.2: fix: the pointer threw an error every frame in scenes with sprites (raycaster had no camera), which could make pointing lag.
- 2.2.1: arc, ray, cursor, indicators and tutorial panel ignore scene fog.
- 2.2.0: tutorial panels fixed in the world (`tutorial-mount`); teleport `blockEntities`.

## 2.1.0
- Tutorial step to switch turning off again.

## 2.0.0
- Renamed from aframe-hand-locomotion. Point-and-trigger pointer, fingertip press, pinch grab, the pinch arbiter, and joints read once per frame for all components.
