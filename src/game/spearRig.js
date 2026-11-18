import * as THREE from 'three';
import { SPEAR } from './spearModel.js';
import { gripQuaternion, handOnShaft } from './armRig.js';
import { DEFAULT_POLE, GRIPS, LEFT_HAND, SUPPORT_RANGE, targetPose } from './handSlots.js';

// Spear Ownership 0.1: the held-spear arrangement for every third-person
// hunter. (First person now draws the approved first-person spear with its
// own hands: firstPerson.js + fpSpearMotion.js; it shares SPEAR_SOCKETS.)
//
//   ARM RIG ── right hand ── primaryGrip socket ── SPEAR (master pose)
//          └── left hand  ── supportGrip (only while SUPPORTING)
//
// Each frame the stance gives the spear's target pose (in a "stance frame":
// the camera for first person, the chest for third person). The right hand is
// placed on the spear's primary grip and the arm solves back to the shoulder;
// the spear object is a child of that hand's socket, so it can never float
// away from the fist. The left hand then closes on the actual spear's support
// grip (or rests free) and its arm solves the same way.

// Spear-local sockets. The shaft runs along local Z with the head toward -Z;
// local +Y is the shaft's roll reference (the way the back of the right hand faces).
export const SPEAR_SOCKETS = Object.freeze({
  primaryGrip: Object.freeze(new THREE.Vector3(0, 0, SPEAR.rightGrip)),
  supportRange: SUPPORT_RANGE,
  tip: Object.freeze(new THREE.Vector3(0, 0, SPEAR.tip)),
  butt: Object.freeze(new THREE.Vector3(0, 0, SPEAR.butt)),
});
export function supportGripLocal(slide, out = new THREE.Vector3()) {
  const s = Math.min(SUPPORT_RANGE.max, Math.max(SUPPORT_RANGE.min, slide));
  return out.set(0, 0, SPEAR.rightGrip - s);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

// Spear orientation from the direction to its head and its roll reference.
export function spearQuaternion(dir, back, out = new THREE.Quaternion()) {
  const z = _v.copy(dir).normalize().negate();
  const y = _v2.copy(back).addScaledVector(z, -_v2.copy(back).dot(z));
  if (y.lengthSq() < 1e-6) y.set(0, 1, 0).addScaledVector(z, -z.y);
  y.normalize();
  const x = _v3.crossVectors(y, z);
  return out.setFromRotationMatrix(_m.makeBasis(x, y, z));
}

// The fixed transform of the spear relative to the right hand that holds it
// (the primaryGrip socket). Independent of the pose, because the hand's
// orientation is built from the same shaft direction and roll as the spear's.
// `diagonal` (optional): the hand's grip diagonal (armRig.handOnShaft).
export function primarySocket(diagonal) {
  const dir = new THREE.Vector3(0, 0, -1), back = new THREE.Vector3(0, 1, 0);
  const hand = handOnShaft('right', new THREE.Vector3(0, 0, 0), dir, back, undefined, undefined, diagonal);
  const spearQ = spearQuaternion(dir, back);
  const spearPos = SPEAR_SOCKETS.primaryGrip.clone().applyQuaternion(spearQ).negate();
  const handInv = new THREE.Matrix4().compose(hand.position, hand.quaternion, new THREE.Vector3(1, 1, 1)).invert();
  const local = handInv.multiply(new THREE.Matrix4().compose(spearPos, spearQ, new THREE.Vector3(1, 1, 1)));
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  local.decompose(position, quaternion, new THREE.Vector3());
  return { position, quaternion };
}

// Attach a spear to a hand bone through a primaryGrip socket object.
export function attachToHand(hand, spearObject) {
  const socket = new THREE.Object3D(), SOCKET = primarySocket();
  socket.name = 'primaryGrip';
  socket.position.copy(SOCKET.position); socket.quaternion.copy(SOCKET.quaternion);
  hand.add(socket); socket.add(spearObject);
  spearObject.position.set(0, 0, 0); spearObject.quaternion.identity();
  return socket;
}

// How long the spear stays in the hand once a release starts, at the least.
// The world spear (the server projectile) takes over at the later of this and
// its arrival on this client; see HuntView.handOff.
export const RELEASE_HOLD = 0.07;
// Seconds over which a released world spear blends from the hand to its
// authoritative flight path.
export const HANDOFF_BLEND = 0.18;

const ease = t => t * t * (3 - 2 * t);
const qFrom = (fingers, palm, side, out) => {
  // Hand frame from where the fingers point and where the palm faces.
  const y = _v.fromArray(fingers).normalize();
  const z = _v2.fromArray(palm).negate().addScaledVector(y, -_v2.fromArray(palm).negate().dot(y)).normalize();
  const x = _v3.crossVectors(y, z);
  return out.setFromRotationMatrix(_m.makeBasis(x, y, z));
};

// Shared by first and third person. `arms` = { right, left } CharacterArm (or
// the block fallback with the same API). `frame` is the Object3D whose local
// space the stance table is written in. Smoothing happens in that frame, so
// a moving body carries the spear rigidly and only stance changes blend.
export class HeldSpearRig {
  constructor({ arms, spear, frame, table, rates = { slow: 14, fast: 34 }, body = null }) {
    this.arms = arms; this.frame = frame; this.table = table; this.rates = rates; this.applyBody = body;
    this.spear = spear;
    this.socket = attachToHand(arms.right.hand, spear);
    this.diagonal = undefined;
    this.c = null; this.holding = true; this.stance = 'ready'; this.leftState = LEFT_HAND.EMPTY;
    this.tmp = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), pos2: new THREE.Vector3(), quat2: new THREE.Quaternion(), frameQ: new THREE.Quaternion(),
      inv: new THREE.Quaternion(), grip: new THREE.Vector3(), point: new THREE.Vector3(), dir: new THREE.Vector3(), dirFrame: new THREE.Vector3(), back: new THREE.Vector3(),
      fore: new THREE.Vector3(), aligned: new THREE.Vector3() };
  }

  snapshot(pose) {
    const sp = pose.spear ?? this.table.ready.spear;
    return { grip: new THREE.Vector3().fromArray(sp.grip), dir: new THREE.Vector3().fromArray(sp.dir).normalize(), back: new THREE.Vector3().fromArray(sp.back).normalize(),
      onShaft: pose.spear ? 1 : 0, support: 0, slide: pose.left.slide ?? SUPPORT_RANGE.min, backL: new THREE.Vector3(-0.5, -0.7, 0.5).normalize(),
      rightFree: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), set: false }, leftFree: { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), set: false },
      curl: { right: GRIPS.grip, left: GRIPS.relaxed }, body: new THREE.Vector3().fromArray(pose.body ?? [0, 0, 0]),
      pole: { right: new THREE.Vector3().fromArray(pose.right.pole ?? DEFAULT_POLE.right), left: new THREE.Vector3().fromArray(pose.left.pole ?? DEFAULT_POLE.left) } };
  }

  // resolved: handSlots.resolveStance(); opts.holding: the spear is in the
  // hand (not yet handed to the world spear); opts.offset: frame-space bob;
  // opts.animated: { right, left } pose fallbacks for free hands (third person
  // keeps the locomotion arm swing for a hand with no free pose).
  //
  // Remote Spear Pass: `resolved.pose` (optional) is a ready pose in the same
  // shape targetPose() returns, already blended by its caller (remoteSpear.js).
  // With `exact` it is applied as given (no extra smoothing); `pose.onShaft`
  // and `pose.left.weight` then give the right hand's spear weight and the
  // left hand's support weight directly, and `pose.right.diagonal` the grip.
  // Without them (first person, older callers) nothing below changes.
  update(dt, resolved, { holding = true, offset = null, fast = false, exact = false } = {}) {
    const pose = resolved.pose ?? targetPose(resolved, this.table);
    this.stance = resolved.stance; this.holding = holding;
    const c = this.c ??= this.snapshot(pose);
    const k = exact ? 1 : 1 - Math.exp(-(fast ? this.rates.fast : this.rates.slow) * dt);
    if (exact) this.setDiagonal(pose.right.diagonal);
    if (pose.spear) {
      c.grip.lerp(_v.fromArray(pose.spear.grip), k);
      c.dir.lerp(_v.fromArray(pose.spear.dir), k).normalize();
      c.back.lerp(_v.fromArray(pose.spear.back), k).normalize();
    }
    c.body.lerp(_v.fromArray(pose.body ?? [0, 0, 0]), k);
    c.pole.right.lerp(_v.fromArray(pose.right.pole ?? DEFAULT_POLE.right), k);
    c.pole.left.lerp(_v.fromArray(pose.left.pole ?? DEFAULT_POLE.left), k);
    const armed = !!pose.spear;
    c.onShaft += ((armed ? 1 : 0) - c.onShaft) * k;
    if (exact && pose.onShaft !== undefined) c.onShaft = pose.onShaft;
    const supporting = armed && holding && pose.left.state === LEFT_HAND.SUPPORTING;
    this.leftState = supporting ? LEFT_HAND.SUPPORTING : LEFT_HAND.EMPTY;
    c.support += ((supporting ? 1 : 0) - c.support) * k;
    if (exact && pose.left.weight !== undefined) c.support = armed && holding ? pose.left.weight : 0;
    if (pose.left.slide !== undefined) c.slide += (pose.left.slide - c.slide) * k;
    if (pose.left.back) c.backL.lerp(_v.fromArray(pose.left.back), k).normalize();
    for (const side of ['right', 'left']) {
      const freePose = pose[side].free, slot = side === 'right' ? c.rightFree : c.leftFree;
      if (!freePose) { if (exact) slot.set = false; continue; }
      const quat = qFrom(freePose.fingers, freePose.palm, side, _q), pos = _v.fromArray(freePose.pos);
      if (!slot.set) { slot.pos.copy(pos); slot.quat.copy(quat); slot.set = true; }
      slot.pos.lerp(pos, k); slot.quat.slerp(quat, k);
    }
    // Fingers: a fist while the spear is held; the release opens the hand only
    // once the world spear has taken over.
    const curlOf = v => typeof v === 'number' ? v : GRIPS[v];
    const curlR = curlOf(holding && armed ? 'grip' : pose.right.curl) ?? GRIPS.relaxed;
    const curlL = (exact ? curlOf(pose.left.curl) : supporting ? GRIPS.grip : curlOf(pose.left.curl)) ?? GRIPS.relaxed;
    // Fingers always close/open over a few frames, even for an exact pose.
    const kc = exact ? 1 - Math.exp(-this.rates.fast * dt) : k;
    c.curl.right += (curlR - c.curl.right) * kc; c.curl.left += (curlL - c.curl.left) * kc;
    c.leftFreeWeight = exact && pose.left.freeWeight !== undefined ? pose.left.freeWeight : 1;

    this.applyBody?.(c.body);
    this.frame.updateWorldMatrix(true, false);
    const frameQ = this.frame.getWorldQuaternion(this.tmp.frameQ);
    // Right hand: on the spear's primary grip (the master pose), or free. The
    // stance's roll (`back`) turns the fist about the shaft; stances are tuned
    // so the wrist stays in line with the solved forearm (tests check it).
    const grip = this.tmp.grip.copy(c.grip); if (offset) grip.add(offset);
    const target = handOnShaft('right', grip, c.dir, c.back, this.tmp.pos, this.tmp.quat, this.diagonal);
    this.place('right', target.position, target.quaternion, c.onShaft, c.rightFree, frameQ);
    this.arms.right.setCurl(c.curl.right);
    this.spear.visible = holding && armed;
    // Left hand: on the actual spear's support grip, blended with its free pose.
    this.spear.updateWorldMatrix(true, false);
    const point = this.spear.localToWorld(supportGripLocal(c.slide, this.tmp.point));
    const dir = this.tmp.dir.set(0, 0, -1).transformDirection(this.spear.matrixWorld);
    const backWorld = this.tmp.back.copy(c.backL).applyQuaternion(frameQ);
    const left = handOnShaft('left', point, dir, backWorld, this.tmp.pos2, this.tmp.quat2);
    this.placeWorld('left', left.position, left.quaternion, ease(Math.min(1, Math.max(0, c.support))), c.leftFree, frameQ, c.leftFreeWeight);
    this.arms.left.setCurl(c.curl.left, pose.left.curl === 'point' && c.support < 0.5);
    return pose;
  }

  // Frame-space target (blended with a frame-space free pose) -> world -> solve.
  place(side, position, quaternion, weight, freeSlot, frameQ) {
    const pos = position.clone(), quat = quaternion.clone();
    if (freeSlot.set && weight < 1) { pos.lerp(freeSlot.pos, 1 - weight); quat.slerp(freeSlot.quat, 1 - weight); }
    const worldPos = this.frame.localToWorld(pos), worldQ = _q2.copy(frameQ).multiply(quat);
    if (!freeSlot.set && weight < 1) {
      if (weight <= 1e-3) return null; // keep the animated (locomotion) arm untouched
      this.blendAnimated(side, worldPos, worldQ, weight);
    }
    return this.arms[side].solve(worldPos, worldQ, this.pole(side, frameQ));
  }

  // World-space target (support grip) blended with a frame-space free pose.
  // freeWeight < 1 (exact poses only) fades the free pose itself back to the
  // animated (locomotion) arm.
  placeWorld(side, position, quaternion, weight, freeSlot, frameQ, freeWeight = 1) {
    const pos = position.clone(), quat = quaternion.clone();
    if (freeSlot.set) {
      const freePos = this.frame.localToWorld(freeSlot.pos.clone()), freeQ = _q.copy(frameQ).multiply(freeSlot.quat);
      pos.lerp(freePos, 1 - weight); quat.slerp(freeQ, 1 - weight);
      const effective = weight + (1 - weight) * freeWeight;
      if (effective < 1) {
        if (effective <= 1e-3) return null;
        this.blendAnimated(side, pos, quat, effective);
      }
    } else if (weight < 1) {
      if (weight <= 1e-3) return null; // keep the animated (locomotion) arm untouched
      this.blendAnimated(side, pos, quat, weight);
    }
    return this.arms[side].solve(pos, quat, this.pole(side, frameQ));
  }

  // Blend a target with where the animation currently has the hand.
  blendAnimated(side, pos, quat, weight) {
    const hand = this.arms[side].hand;
    hand.updateWorldMatrix(true, false);
    pos.lerp(_v.setFromMatrixPosition(hand.matrixWorld), 1 - weight);
    quat.slerp(hand.getWorldQuaternion(_q), 1 - weight);
  }

  // Grip diagonal of the right hand (undefined = the default power grip). The
  // socket is rebuilt so the spear stays exactly where the stance puts it.
  setDiagonal(diagonal) {
    const value = diagonal === undefined ? undefined : Math.round(diagonal * 200) / 200;
    if (value === this.diagonal) return;
    this.diagonal = value;
    const socket = primarySocket(value);
    this.socket.position.copy(socket.position); this.socket.quaternion.copy(socket.quaternion);
  }

  pole(side, frameQ) { return _v.copy(this.c.pole[side]).applyQuaternion(frameQ); }

  // Where the held spear is right now, in world space (for the throw handoff).
  spearWorld(position = new THREE.Vector3(), quaternion = new THREE.Quaternion()) {
    this.spear.updateWorldMatrix(true, false);
    this.spear.matrixWorld.decompose(position, quaternion, _v);
    return { position, quaternion };
  }
}

export { gripQuaternion };
