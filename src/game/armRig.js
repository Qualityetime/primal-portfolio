import * as THREE from 'three';

// Spear Ownership 0.1: the arm solution for every third-person hunter, driven
// by the bones of the existing Neanderthal asset
// (stonehide-human.glb, a Mixamo-named "SmartRigArmature").
//
// Rig findings (inspected from the asset itself, see SPEAR_OWNERSHIP_REPORT.md):
//  - chain per side: mixamorig{Side}Shoulder (clavicle) -> {Side}Arm (upper arm,
//    0.264/0.258 m) -> {Side}ForeArm (0.25/0.252 m) -> {Side}Hand (+ 4-bone thumb,
//    index, middle, ring and pinky chains); every bone's +Y runs along the bone.
//  - both hand frames are right-handed: +Y wrist->knuckles, palm toward -Z,
//    back of the hand toward +Z, thumb on -X (right hand) / +X (left hand). The
//    left hand is a true left hand, never a mirrored right hand.
//  - the elbow is a clean hinge: across all six clips the forearm turns about a
//    single forearm-local axis (singular values 39.6 / 0.05 / 0.01).
//  - the whole body is one 10,427-triangle skinned mesh with one baked material.
//
// Everything here is presentation. Nothing in this file is read by the server,
// the shared simulation, prediction or combat.

const SIDE_NAME = { right: 'Right', left: 'Left' };
export const ARM_BONES = Object.freeze({
  right: Object.freeze({ clavicle: 'mixamorigRightShoulder', upper: 'mixamorigRightArm', fore: 'mixamorigRightForeArm', hand: 'mixamorigRightHand' }),
  left: Object.freeze({ clavicle: 'mixamorigLeftShoulder', upper: 'mixamorigLeftArm', fore: 'mixamorigLeftForeArm', hand: 'mixamorigLeftHand' }),
});
// Elbow hinge axes in each forearm's local frame (principal axis of every
// forearm rotation in the asset's clips; positive rotation flexes the elbow).
export const ELBOW_HINGE = Object.freeze({
  right: Object.freeze(new THREE.Vector3(0.477, 0, 0.879).normalize()),
  left: Object.freeze(new THREE.Vector3(0.871, 0, -0.492).normalize()),
});

// Where a closed hand holds a shaft, in that hand's bone frame: the shaft
// centre passes `point`, crossing the palm diagonally (`diagonal` radians: the
// end of the shaft on the thumb side lies toward the knuckles, from the heel of
// the hand to the base of the index finger, as a real power grip does). The
// shaft never enters the palm: `point` lies one grip-wrap radius (0.036 m) plus
// skin in front of the palm surface (z = -0.049 at the knuckle crease).
export const HAND_GRIP = {
  right: { point: new THREE.Vector3(0.006, 0.15, -0.03), diagonal: 0.7 },
  left: { point: new THREE.Vector3(-0.006, 0.15, -0.03), diagonal: 0.7 },
};

const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

function perpendicular(v, out) {
  // Any unit vector perpendicular to v (stable choice).
  return Math.abs(v.y) < 0.9 ? out.set(0, 1, 0).cross(v).normalize() : out.set(1, 0, 0).cross(v).normalize();
}

// World/view-space orientation of a hand closed on a shaft. `shaft` points
// from this hand toward the spear head; `back` is where the back of the hand
// should face (only its part perpendicular to the shaft matters). The thumb
// side always faces the head. Returns the hand bone's world quaternion.
export function gripQuaternion(side, shaft, back, out = new THREE.Quaternion(), diagonal = HAND_GRIP[side].diagonal) {
  const s = _v.copy(shaft).normalize();
  const z = _v2.copy(back).addScaledVector(s, -_v2.copy(back).dot(s));
  if (z.lengthSq() < 1e-6) perpendicular(s, z); else z.normalize();
  // Before the diagonal: thumb axis along the shaft (right thumb is -X, left +X).
  const x0 = _v3.copy(s).multiplyScalar(side === 'right' ? -1 : 1);
  const y0 = _v4.crossVectors(z, x0);
  const c = Math.cos(diagonal), n = Math.sin(diagonal) * (side === 'right' ? 1 : -1);
  const x = new THREE.Vector3().copy(x0).multiplyScalar(c).addScaledVector(y0, n);
  const y = new THREE.Vector3().copy(y0).multiplyScalar(c).addScaledVector(x0, -n);
  _m.makeBasis(x, y, z);
  return out.setFromRotationMatrix(_m);
}

// Shaft direction (toward the head) implied by a hand bone orientation.
export function shaftFromHand(side, handQuaternion, out = new THREE.Vector3()) {
  const a = HAND_GRIP[side].diagonal;
  return out.set(side === 'right' ? -Math.cos(a) : Math.cos(a), Math.sin(a), 0).applyQuaternion(handQuaternion).normalize();
}

// Analytic two-bone solution. Returns the elbow and the (possibly clamped)
// wrist; the elbow bends toward `pole`. Never folds backward, never NaN.
export function solveTwoBone(shoulder, target, upperLength, foreLength, pole, out = {}) {
  const d = (out.direction ??= new THREE.Vector3()).copy(target).sub(shoulder);
  let distance = d.length();
  if (distance < 1e-6) { d.set(0, -1, 0); distance = 1e-6; } else d.divideScalar(distance);
  const min = Math.abs(upperLength - foreLength) * 1.05 + 1e-4, max = (upperLength + foreLength) * 0.9995;
  out.reached = distance <= max + 1e-9 && distance >= min - 1e-9;
  distance = Math.min(max, Math.max(min, distance));
  const p = (out.pole ??= new THREE.Vector3()).copy(pole).addScaledVector(d, -pole.dot(d));
  if (p.lengthSq() < 1e-8) perpendicular(d, p); else p.normalize();
  const a = (upperLength * upperLength - foreLength * foreLength + distance * distance) / (2 * distance);
  const h = Math.sqrt(Math.max(0, upperLength * upperLength - a * a));
  out.wrist = (out.wrist ?? new THREE.Vector3()).copy(shoulder).addScaledVector(d, distance);
  out.elbow = (out.elbow ?? new THREE.Vector3()).copy(shoulder).addScaledVector(d, a).addScaledVector(p, h);
  out.upperDir = (out.upperDir ?? new THREE.Vector3()).copy(out.elbow).sub(shoulder).normalize();
  out.foreDir = (out.foreDir ?? new THREE.Vector3()).copy(out.wrist).sub(out.elbow).normalize();
  // Bend-plane normal (positive elbow flexion), exact for any pose: p x d.
  out.hinge = (out.hinge ?? new THREE.Vector3()).crossVectors(p, d).normalize();
  out.distance = distance;
  return out;
}

// Rotation taking unit vectors a1 -> b1 and (a2, orthogonalised) -> (b2, orthogonalised).
function alignTwo(a1, a2, b1, b2, out) {
  const a2o = _v.copy(a2).addScaledVector(a1, -a2.dot(a1)).normalize();
  const b2o = _v2.copy(b2).addScaledVector(b1, -b2.dot(b1)).normalize();
  _m.makeBasis(a1, a2o, _v3.crossVectors(a1, a2o));
  _m2.makeBasis(b1, b2o, _v4.crossVectors(b1, b2o));
  _m.transpose(); // orthonormal: inverse == transpose
  _m2.multiply(_m);
  return out.setFromRotationMatrix(_m2);
}

function setWorldQuaternion(bone, world) {
  bone.parent.getWorldQuaternion(_q3);
  bone.quaternion.copy(_q3.invert().multiply(world));
  bone.updateMatrixWorld(true);
}

// Finger chains and how far each joint closes for a full grip (radians about
// the hand's own thumb-to-pinky axis, toward the palm).
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'];
export let CURL_REST = 0.35;
export function setCurlRest(v) { CURL_REST = v; }
export const FINGER_CURL = [1, 1, 0.8];
// Closed-thumb aim, hand-local: across the front of the gripped shaft, over the
// index and middle fingers (power grip).
export const THUMB_TIP_GRIP = { right: new THREE.Vector3(-0.01, 0.17, -0.08), left: new THREE.Vector3(0.01, 0.17, -0.08) };

export class CharacterArm {
  constructor(root, side) {
    const names = ARM_BONES[side], find = name => {
      const bone = root.getObjectByName(name);
      if (!bone) throw new Error(`Character arm is missing ${name}.`);
      return bone;
    };
    this.side = side;
    this.clavicle = find(names.clavicle); this.upper = find(names.upper); this.fore = find(names.fore); this.hand = find(names.hand);
    this.upperLength = this.fore.position.length(); this.foreLength = this.hand.position.length();
    this.rest = { upper: this.upper.quaternion.clone(), fore: this.fore.quaternion.clone(), hand: this.hand.quaternion.clone() };
    this.hingeFore = ELBOW_HINGE[side].clone();
    this.hingeUpper = this.hingeFore.clone().applyQuaternion(this.rest.fore);
    const S = SIDE_NAME[side];
    this.fingers = FINGERS.map(f => [1, 2, 3].map(i => find(`mixamorig${S}Hand${f}${i}`)).map(bone => ({ bone, rest: bone.quaternion.clone() })));
    this.thumb = [1, 2, 3].map(i => find(`mixamorig${S}HandThumb${i}`)).map(bone => ({ bone, rest: bone.quaternion.clone() }));
    // Hand-frame curl axis expressed in each finger bone's parent frame (rest).
    for (const chain of this.fingers) {
      const toParent = new THREE.Quaternion(); // hand -> parent-of-joint
      for (const joint of chain) {
        joint.axis = new THREE.Vector3(1, 0, 0).applyQuaternion(toParent.clone().invert()).normalize();
        toParent.multiply(joint.rest);
      }
    }
    const t1 = this.thumb[0].bone, t4 = root.getObjectByName(`mixamorig${S}HandThumb4`);
    this.thumbBase = t1.position.clone();
    this.thumbRestTip = t4 ? t4.position.clone().applyQuaternion(this.thumb[2].rest).add(this.thumb[2].bone.position)
      .applyQuaternion(this.thumb[1].rest).add(this.thumb[1].bone.position).applyQuaternion(this.thumb[0].rest).add(t1.position) : t1.position.clone().add(Y.clone().multiplyScalar(0.07));
    this.curl = -1; this.result = {};
    this.twistShare = 0.5;
  }

  shoulderPosition(out = new THREE.Vector3()) {
    this.upper.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.upper.matrixWorld);
  }

  // Place the hand bone (wrist) at `wrist` with world orientation `handQuat`,
  // solving the elbow toward `pole`. If the target is out of reach the hand
  // stops at full extension along the same line; callers read hand.matrixWorld
  // for where it actually went (the spear follows the hand, never the target).
  solve(wrist, handQuat, pole) {
    const S = this.shoulderPosition(_v);
    const r = solveTwoBone(S, wrist, this.upperLength, this.foreLength, pole, this.result);
    const qu = alignTwo(Y, this.hingeUpper, r.upperDir, r.hinge, new THREE.Quaternion());
    setWorldQuaternion(this.upper, qu);
    const qf = alignTwo(Y, this.hingeFore, r.foreDir, r.hinge, new THREE.Quaternion());
    // Share the wrist's twist with the forearm so neither candy-wraps.
    const expected = _q.copy(qf).multiply(this.rest.hand);
    const delta = _q2.copy(expected).invert().multiply(handQuat);
    // q and -q are the same rotation: take the short way round (|twist| <= PI).
    // Without this, a sign flip in the target quaternion read as a 2*PI twist
    // and rolled the forearm half a turn (the elbow then looked broken).
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    const twist = 2 * Math.atan2(delta.y, delta.w);
    qf.multiply(_q.setFromAxisAngle(Y, twist * this.twistShare));
    setWorldQuaternion(this.fore, qf);
    setWorldQuaternion(this.hand, handQuat);
    return r;
  }

  // 0 = open, 1 = closed power grip around a 0.036 m wrap. `point` keeps the
  // index finger straight (aiming during a wind-up).
  setCurl(curl, point = false) {
    // Always applied: a third-person mixer rewrites the finger bones each frame.
    this.curl = curl; this.point = point;
    const open = curl - CURL_REST; // the rest pose is already a loose, part-closed hand
    this.fingers.forEach((chain, f) => chain.forEach((joint, j) => {
      const amount = point && f === 0 ? Math.min(open, -0.25) : open;
      joint.bone.quaternion.copy(_q.setFromAxisAngle(joint.axis, -amount * FINGER_CURL[j])).multiply(joint.rest);
    }));
    // Thumb: swing the whole thumb from its rest line toward the grip line.
    const target = _v.copy(this.thumbRestTip).lerp(THUMB_TIP_GRIP[this.side], Math.max(0, Math.min(1, curl)));
    const from = _v2.copy(this.thumbRestTip).sub(this.thumbBase).normalize();
    const to = target.sub(this.thumbBase).normalize();
    this.thumb[0].bone.quaternion.copy(_q.setFromUnitVectors(from, to)).multiply(this.thumb[0].rest);
    for (const [i, joint] of this.thumb.entries()) if (i > 0) joint.bone.quaternion.copy(_q.setFromAxisAngle(_v3.set(1, 0, 0), -Math.max(0, curl) * 0.35)).multiply(joint.rest);
  }
}

// Hand world transform that puts the grip point of `side`'s hand on `point`
// along a shaft running toward `shaft`, back of the hand toward `back`.
// `diagonal` (optional) overrides how the shaft crosses the palm: the default
// power grip, or close to PI/2 for a straight-wrist thrusting grip where the
// shaft continues the forearm line (third-person remote hunters).
export function handOnShaft(side, point, shaft, back, outPosition = new THREE.Vector3(), outQuaternion = new THREE.Quaternion(), diagonal = HAND_GRIP[side].diagonal) {
  gripQuaternion(side, shaft, back, outQuaternion, diagonal);
  const px = point.x, py = point.y, pz = point.z; // point may alias outPosition
  outPosition.copy(HAND_GRIP[side].point).applyQuaternion(outQuaternion).negate().add(_v.set(px, py, pz));
  return { position: outPosition, quaternion: outQuaternion };
}
