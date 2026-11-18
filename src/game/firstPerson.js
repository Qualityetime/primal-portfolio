import * as THREE from 'three';
import { createSpear, SPEAR } from './spearModel.js';
import { HAND_SLOTS, GRIPS, LEFT_HAND, canEquip, RELEASE_SECONDS } from './handSlots.js';
import { SPEAR_SOCKETS } from './spearRig.js';
import { buildRightGrip, buildLeftSupport, buildForearm, buildUpperArm, GRIP_DESIGN, FP_SHAFT_SCALE } from './gripHand.js';
import { FirstPersonPoser, FirstPersonSpearMotion, THROW_TIMING } from './fpSpearMotion.js';

// First-person presentation: the hunter's own hands, arms and held spear.
//
// First-Person Spear Live Integration: this is the approved first-person
// spear (formerly only in the prototype harness), running live:
//   IDLE (low carry, left hand underhand under the shaft, right hand back and
//   mostly out of view) -> WIND-UP -> FAST STRAIGHT THRUST (right forearm,
//   wrist, hand and spear on one line; the left hand clears) -> RETRACT ->
//   LEFT-HAND IDLE, with chained attacks blending from the current pose.
// Poses and timing: fpSpearMotion.js. Hands and arms: gripHand.js (built for
// this camera, textured from the character's own skin and bracers).
//
// Ownership: the right hand is fixed in the spear's own space at its primary
// grip (it owns the spear and every spear action); the left hand only ever
// supports (underhand) or lets go. Each forearm runs out of its wrist and the
// arm solves back to a shoulder, so no hand floats.
//
// It renders in its own pass after the world (depth cleared in between), so
// it never clips into rock, foliage or boars. Only presentation lives here:
// stances come from handSlots.resolveStance() on the local predicted /
// authoritative state plus the local action clocks main.js starts on the
// input tick. Nothing here changes combat, prediction or the network.

export class FirstPersonRig {
  constructor({ fov = 62 } = {}) {
    this.scene = new THREE.Scene();
    this.scene.name = 'first-person';
    this.camera = new THREE.PerspectiveCamera(fov, 16 / 9, 0.01, 10);
    // Matched by eye to how the world reads: the world is also darkened by
    // shadows, so the unshadowed hands use a gentler rig of the same lights.
    this.hemi = new THREE.HemisphereLight(0xbac7cc, 0x3d3a2b, 1.45);
    this.sun = new THREE.DirectionalLight(0xffe2b8, 1.25);
    this.sun.position.set(-0.4, 0.75, 0.5).multiplyScalar(5);
    this.fire = new THREE.DirectionalLight(0xff9a4a, 0);
    this.scene.add(this.hemi, this.sun, this.sun.target, this.fire, this.fire.target);
    this.root = new THREE.Group(); this.root.name = 'view'; this.scene.add(this.root);

    // The spear (master object) with the right hand fixed at its primary grip.
    this.assembly = new THREE.Group(); this.assembly.name = 'spear-assembly'; this.root.add(this.assembly);
    this.spear = createSpear(true);
    // Up close the knapped head is shown a little larger and lighter so its
    // flaked silhouette reads; the shaft is drawn slimmer across (presentation
    // only; world spears are unchanged).
    const head = this.spear.children[1];
    head.scale.setScalar(1.45); head.material.color.setHex(0x8a877f);
    this.spear.scale.set(FP_SHAFT_SCALE, FP_SHAFT_SCALE, 1);
    this.spear.name = 'first-person-spear';
    this.assembly.add(this.spear);
    this.rightHand = buildRightGrip({ forearm: false });
    this.rightHand.position.copy(SPEAR_SOCKETS.primaryGrip);
    this.assembly.add(this.rightHand);
    // The support hand, free of the spear's transform (it supports or lets go).
    this.leftHand = new THREE.Group(); this.leftHand.name = 'left-hand'; this.root.add(this.leftHand);
    this.leftMeshes = new Map(); this.leftShown = null;
    this.armParts = {
      right: { fore: buildForearm({ length: 0.27 }), upper: buildUpperArm({ length: 0.29 }) },
      left: { fore: buildForearm({ length: 0.27 }), upper: buildUpperArm({ length: 0.29 }) },
    };
    for (const part of Object.values(this.armParts)) this.root.add(part.fore, part.upper);

    this.poser = new FirstPersonPoser(this.camera);
    this.motion = new FirstPersonSpearMotion(this.poser);
    // Slot ownership: the right hand holds the spear, the left holds nothing.
    this.slots = { right: { ...HAND_SLOTS.right }, left: { ...HAND_SLOTS.left } };
    this.visible = false; this.stance = 'ready'; this.phase = 'hold'; this.pose = null;
    this.walkPhase = 0; this.hurtAt = -10; this.lastSpears = null; this.drawFrom = -10;
    this.root.visible = false;
    this.resize(16 / 9);
  }

  // The support hand, opening as it lets go (fine steps, built once each).
  // relax (throw prep only): the open fingers ease into a natural relaxed
  // curl instead of following the spear shaft the hand has let go of.
  leftMesh(open, relax = 0) {
    const step = Math.round(open * 20) / 20, rstep = Math.round(relax * 20) / 20;
    const key = rstep > 0 ? `${step}|${rstep}` : step;
    let mesh = this.leftMeshes.get(key);
    if (!mesh) {
      const d = GRIP_DESIGN.left;
      mesh = buildLeftSupport({ forearm: false, design: { ...d, closure: [1 - 0.3 * step, 1 - 0.45 * step, 1 - 0.55 * step], lift: d.lift.map((v, j) => v + step * [0.004, 0.008, 0.012][j]), ...(rstep > 0 ? { relax: rstep } : {}) } });
      this.leftMeshes.set(key, mesh);
    }
    return mesh;
  }

  // Each hand's object (the right hand rides the spear; the left is free).
  get hands() { return { right: this.rightHand, left: this.leftHand }; }
  get leftState() { return (this.pose?.att ?? 0) > 0.5 && this.spear.visible ? LEFT_HAND.SUPPORTING : LEFT_HAND.EMPTY; }

  equip(slot, item) {
    if (!canEquip(slot, item)) throw new Error(`The ${slot} hand cannot hold ${item} in this slice.`);
    this.slots[slot].item = item;
  }

  resize(aspect) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); this.poser?.invalidate(); }
  hurt(seconds) { this.hurtAt = seconds; }

  // Keep the view-space lights consistent with the world: rotate the world sun
  // (and the campfire, when near) into the camera's frame.
  light(worldCamera, sunDirection, fire) {
    const inverse = new THREE.Quaternion().copy(worldCamera.quaternion).invert();
    this.sun.position.copy(sunDirection).applyQuaternion(inverse).multiplyScalar(5);
    if (fire) {
      const toFire = new THREE.Vector3(fire.x - worldCamera.position.x, 0.6 - 0.9, fire.z - worldCamera.position.z);
      const distance = toFire.length();
      this.fire.position.copy(toFire.normalize()).applyQuaternion(inverse).multiplyScalar(5);
      this.fire.intensity = Math.max(0, 1 - distance / 7) * 1.6;
    }
  }

  // state: local hunter state; clocks: { thrustAge, throwAge, sprinting }; speed m/s.
  update(dt, seconds, state, clocks = {}, { active = true, speed = 0 } = {}) {
    const out = this.motion.update(seconds, dt, state, clocks);
    const S = out.S;
    this.stance = out.phase === 'attack' ? 'thrust' : out.phase === 'throw' ? 'release' : out.stance;
    this.phase = out.phase; this.pose = S;
    this.visible = active && !out.down;
    this.root.visible = active;
    // A new spear is drawn up into the hand after a resupply or a recovery.
    if (this.lastSpears !== null && state && state.spears > this.lastSpears && out.phase !== 'throw') this.drawFrom = seconds;
    this.lastSpears = state?.spears ?? null;
    const holding = this.slots.right.item === 'spear' && out.holding;

    // Walk/sprint bob, a hurt jolt and the draw, all small, applied to the
    // whole view model (hands, arms and spear move together).
    const moving = Math.min(1, speed / 4.2), sprint = clocks.sprinting ? 1 : 0;
    this.walkPhase += dt * (5.5 + sprint * 3.5) * (moving > 0.05 ? 1 : 0);
    const offset = new THREE.Vector3(Math.sin(this.walkPhase) * 0.009 * moving, -Math.abs(Math.cos(this.walkPhase)) * 0.014 * moving * (1 + sprint * 0.6), 0);
    offset.y += Math.sin(seconds * 1.6) * 0.003;
    const hurt = Math.max(0, 1 - (seconds - this.hurtAt) / 0.35);
    offset.y -= hurt * 0.05; offset.x += hurt * 0.02;
    const draw = Math.max(0, 1 - (seconds - this.drawFrom) / 0.35);
    offset.add(new THREE.Vector3(0.04 * draw, -0.3 * draw, 0.05 * draw));
    // Lowered out of view (no spear, knocked down, dead).
    offset.add(new THREE.Vector3(0, -0.5 * (S.drop ?? 0), 0.12 * (S.drop ?? 0)));
    this.root.position.copy(offset);
    this.place(S, holding);
    this.scene.updateMatrixWorld(true);
  }

  // Pose the whole rig from a motion state (camera space).
  place(S, holding) {
    this.assembly.quaternion.copy(S.q);
    this.assembly.position.copy(S.grip).sub(SPEAR_SOCKETS.primaryGrip.clone().applyQuaternion(S.q));
    const mesh = this.leftMesh(1 - S.att, S.relax ?? 0);
    if (this.leftShown !== mesh) { this.leftHand.clear(); this.leftHand.add(mesh); this.leftShown = mesh; }
    this.leftHand.position.copy(S.leftPos); this.leftHand.quaternion.copy(S.leftQuat);
    const gone = (S.drop ?? 0) > 0.98;
    this.spear.visible = holding && !gone;
    // The right hand and arm belong to the spear; with no spear in hand (after
    // a throw, or none left) they are out of view with it.
    const rightShown = !gone && (holding || this.phase === 'throw');
    this.rightHand.visible = this.armParts.right.fore.visible = this.armParts.right.upper.visible = rightShown;
    this.leftHand.visible = this.armParts.left.fore.visible = this.armParts.left.upper.visible = !gone;
    this.arms = {};
    for (const [side, pos, quat] of [['right', S.grip, S.q], ['left', S.leftPos, S.leftQuat]]) {
      const hf = this.poser.handFrame(side, pos, quat), arm = this.poser.solveArm(side, hf, S);
      this.placeArm(side, hf, arm);
      this.arms[side] = { wrist: hf.wrist, axis: arm.axis, elbow: arm.elbow, shoulder: arm.shoulder, rest: hf.rest, back: hf.back, bend: arm.bend, clamped: arm.clamped };
    }
  }

  // Forearm out of the wrist along the solved axis (its back kept to the back
  // of the hand, so it never candy-wraps), upper arm from the elbow to the shoulder.
  placeArm(side, hf, arm) {
    const { fore, upper } = this.armParts[side];
    const twist = new THREE.Quaternion().setFromUnitVectors(hf.rest, arm.axis), dorsal = hf.back.clone().applyQuaternion(twist);
    const y = arm.axis.clone().negate(), z = dorsal.addScaledVector(y, -dorsal.dot(y)).normalize(), x = new THREE.Vector3().crossVectors(y, z);
    fore.position.copy(hf.wrist); fore.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    const y2 = arm.shoulder.clone().sub(arm.elbow).normalize().negate();
    const z2 = z.clone().addScaledVector(y2, -z.dot(y2)).normalize(), x2 = new THREE.Vector3().crossVectors(y2, z2);
    upper.position.copy(arm.elbow); upper.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x2, y2, z2));
  }

  // ---- Throw handoff ----
  // True once the throw has run long enough for the spear to leave the hand.
  releaseReady() { return this.phase !== 'throw' || !this.spear.visible; }
  // The held spear's tip and direction, converted from this view's camera into
  // the world camera's frame at the same screen position.
  takeRelease(worldCamera) {
    if (this.phase !== 'throw') return null;
    this.scene.updateMatrixWorld(true);
    const tip = this.spear.localToWorld(SPEAR_SOCKETS.tip.clone()), butt = this.spear.localToWorld(SPEAR_SOCKETS.butt.clone());
    const k = Math.tan(THREE.MathUtils.degToRad(worldCamera.fov) / 2) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    for (const p of [tip, butt]) { p.x *= k; p.y *= k; }
    worldCamera.updateMatrixWorld();
    tip.applyMatrix4(worldCamera.matrixWorld); butt.applyMatrix4(worldCamera.matrixWorld);
    return { tip, direction: tip.clone().sub(butt).normalize() };
  }

  render(renderer) {
    if (!this.root.visible) return;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  clear() { this.motion.reset(); this.root.visible = false; this.visible = false; this.lastSpears = null; this.pose = null; }
}

export { GRIPS, LEFT_HAND, RELEASE_SECONDS, THROW_TIMING };
