/*!
 * aframe-hand-interaction v{{VERSION}}
 * Controller-free movement and interaction for WebXR hand
 * tracking in A-Frame 1.7+. Full documentation: README.md
 *
 * Quick start — the whole kit on your rig:
 *   <a-entity hand-interaction>
 *     <a-entity camera position="0 1.6 0" look-controls></a-entity>
 *   </a-entity>
 *   <a-plane class="landable" ...>     where you can teleport
 *   <a-box class="interactable" ...>   point at it / press it
 *   <a-box class="grabbable" ...>      pick it up
 *
 * Components:
 *   hand-interaction — on the rig: sets up both hands (below)
 *   hand-teleport    — pinch, aim the arc, release to teleport
 *   hand-thumb-tilt  — thumb tap switches turning on; thumbs-up
 *                      and tilt to snap-turn
 *   hand-pointer     — point, curl the finger to select (A-Frame
 *                      cursor events); pointer-draggable to drag
 *   hand-poke        — press things with your fingertip
 *   hand-grab        — open hand, close it around an object
 *   hand-joint       — attach any entity to a hand joint; palm-up
 *                      events for wrist menus
 *   hand-pose        — events for hand shapes you record
 *   push-button      — a button that travels with your fingertip
 *   hand-slider      — a slider knob you drag with a fingertip
 *   hand-tutorial    — on the scene: guided first-time walkthrough
 *   tutorial-mount   — where the tutorial panel shows for a step
 *
 * Pinching is only for teleport; grabbing uses the whole hand; a
 * thumb tap on a curled index (the turning switch) is never a
 * pinch. Hand-shape checks are relative to your palm, so they work
 * for any hand size.
 *
 * Author: Jorim M. Oduo (Beamport Story Labs)
 * License: MIT
 */
if (typeof AFRAME === 'undefined') {
  throw new Error('aframe-hand-interaction: AFRAME not found. Load A-Frame before this file.');
}
