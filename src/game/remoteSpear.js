import * as THREE from 'three';
import { HUNT } from '@shared/hunt.js';
import { TICK_RATE } from '@shared/config.js';
import { LEFT_HAND } from './handSlots.js';
import { solveTwoBone } from './armRig.js';

// Remote Spear Pass: how OTHER hunters carry and use their spear.
//
// The game stays first person; this file is presentation for remote hunters
// only. It never reads input, never changes combat and uses only replicated
// state (spears, health, knockTicks, recovering, cooking, bracing, winding,
// windupTime, thrust, throwing, pitch) plus the existing hunt events
// ('throw', 'recovered'). Ownership is unchanged:
//
//   hunter skeleton -> right hand bone -> primaryGrip socket -> held spear
//                   -> left hand on the spear's support grip (when supporting)
//
// RemoteSpearMotion turns that state into one continuous upper-body pose per
// hunter, written in the chest "stance frame" (x right, y up, -z forward) and
// applied by HeldSpearRig in its exact mode. Legs, hips and feet always keep
// the existing locomotion clips (Casual_Walk / Walking / Running / Dead).
//
// Timing. The thrust uses the approved first-person cycle: wind-up 0-0.17 s,
// strike 0.17-0.30, hold 0.30-0.38, retract 0.38-0.56, settle 0.56-0.82, on
// the server's own timeline (hit window 0.12-0.40 s, full reach 0.35 s, next
// thrust no sooner than THRUST_TICKS). A thrust that starts before the
// previous settle ends blends from the current pose (with half its momentum),
// so chained thrusts never snap back to the carry.

export const THRUST_TICKS = Math.ceil(HUNT.thrustCooldown * TICK_RATE);
export const THRUST_SECONDS = THRUST_TICKS / TICK_RATE;
export const REMOTE_THRUST = Object.freeze({ wind: 0.17, strike: 0.30, hold: 0.38, retract: 0.56, settle: 0.82 });
// Throw: the spear leaves the hand `release` after the authoritative throw
// tick, as the arm passes its forward release point; a spear left in the
// quiver count is back in the right hand at `rearm`.
export const REMOTE_THROW = Object.freeze({ release: 0.07, follow: 0.24, rearm: 0.52, end: 0.66 });
// Picking a spear up off the ground: stoop and reach, grab, rise.
export const REMOTE_PICKUP = Object.freeze({ reach: 0.2, grab: 0.26, lift: 0.46, end: 0.62 });
// Momentum kept when a new thrust interrupts the previous one (as first person).
export const CHAIN_CARRY = 0.5;

// Meshy motion donor (Meshy_AI_Stonehide_Hu_biped, "retarget_clip"): local
// rotation deltas from its neutral first frame to full extension (t = 1.133 s).
// Its bind frames equal stonehide-human.glb's exactly (smartrig* ==
// mixamorig*), so the deltas transfer bone for bone. Only the upper-body
// drive is kept: spine/chest contribution, the right clavicle's forward
// drive and the left clavicle's counter-pull. Its fencing stance, lunge
// footwork, crouch, hips/root motion and arm path are not used; the arm is
// driven by the spear (IK) and the spine is scaled right down.
export const DONOR_DRIVE = Object.freeze({
  mixamorigSpine: Object.freeze({ q: [0.0307, 0.0347, -0.0305, 0.9984], scale: 0.3 }), // 6.4 deg in the donor
  mixamorigSpine1: Object.freeze({ q: [-0.0038, 0.0708, -0.0149, 0.9974], scale: 0.3 }), // 8.3 deg
  mixamorigSpine2: Object.freeze({ q: [0.0649, 0.0503, -0.0759, 0.9937], scale: 0.3 }), // 12.9 deg
  mixamorigRightShoulder: Object.freeze({ q: [0.0497, 0.2287, 0.1682, 0.9575], scale: 0.6 }), // 33.5 deg
  mixamorigLeftShoulder: Object.freeze({ q: [0.0267, -0.1923, 0.0347, 0.9804], scale: 0.35 }), // 22.7 deg
});

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = t => { t = clamp01(t); return t * t * (3 - 2 * t); };

// ---- Poses -------------------------------------------------------------
// A pose is plain numbers so any two can be blended:
//   g grip (right hand, frame space), d shaft direction toward the head,
//   b where the back of the right hand faces, dg right grip diagonal,
//   on right hand on the spear (0 = locomotion arm), reach straight-arm line,
//   s support slide, w left support weight, bl back of the left hand,
//   lf/lfd/lfp left free pose (position, fingers, palm), lfw free weight
//   (0 = locomotion arm), lc/rc finger curls, drive donor weight,
//   lean forward stoop (rad), crouch hip drop (m, feet stay planted),
//   aim share of the hunter's pitch,
//   pr/pl elbow poles, wn natural-wrist weight (thrust only: how far the
//   right elbow pole leans to keep the wrist near neutral; 0 = pr as given).
const VEC = ['g', 'd', 'b', 'bl', 'lf', 'lfd', 'lfp', 'pr', 'pl'];
const NUM = ['dg', 'on', 'reach', 's', 'w', 'lfw', 'lc', 'rc', 'drive', 'lean', 'crouch', 'aim', 'wn'];
const DIRS = ['d', 'b', 'bl', 'lfd', 'lfp'];
const P = o => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? Object.freeze(v) : v])));

const BASE = {
  dg: 0.8, on: 1, reach: 0, s: 0.33, w: 1, lfw: 1, lc: 1, rc: 1, drive: 0, lean: 0, crouch: 0, aim: 0.15, wn: 0,
  b: [0.9, -0.5, 0.1], bl: [0.15, -1, 0.1],
  lf: [-0.17, -0.34, -0.2], lfd: [0.15, -1, -0.3], lfp: [0.85, 0, 0.3], pr: [0.2, -1, 0.4], pl: [-0.4, -1, 0.3],
};
// Frame: origin at the chest bone (shoulder height), x right, y up, -z ahead;
// shoulders at x = +-0.22, hips at y = -0.41. An arm reaches ~0.55 m.
// Low carry: right fist in front of the right hip (rear, dominant grip, thumb
// on top, fingers under), the shaft a shallow forward diagonal across the
// body at stomach height, left hand forward under it (palm up, supporting).
export const TP_POSES = Object.freeze({
  carry: P({ ...BASE, g: [0.19, -0.33, -0.16], d: [-0.15, 0.055, -0.28] }),
  // Sprinting: tucked closer and a little higher.
  run: P({ ...BASE, g: [0.19, -0.3, -0.13], d: [-0.15, 0.07, -0.28], s: 0.31 }),
  // Thrust keys. WIND: compact prep (draw back a hand's width, left lets go).
  wind: P({ ...BASE, g: [0.2, -0.3, -0.06], d: [-0.1, 0.06, -0.3], b: [1, -0.4, 0], dg: 0.9, w: 0.15, lc: 0.35, drive: -0.25, aim: 0.5 }),
  // STRIKE: the right arm drives out from the shoulder close to the spear's
  // line (`reach`: HumanAvatar places the wrist; a natural arm comes before an
  // exact straight line); the left hand drops back by the hip.
  strike: P({ ...BASE, g: [0.12, -0.14, -0.55], d: [-0.04, -0.12, -1], b: [1, -0.15, 0], dg: 1.0, w: 0,
    lf: [-0.2, -0.34, -0.06], lfd: [0.15, -1, 0.1], lc: 0.35, reach: 1, drive: 1, aim: 0.65, wn: 1 }),
  // RETRACT: back toward the body, the left hand coming back under the shaft.
  retract: P({ ...BASE, g: [0.18, -0.3, -0.24], d: [-0.12, 0.05, -0.3], w: 0.55, lf: [-0.12, -0.3, -0.3], lc: 0.6, drive: 0.15, aim: 0.4, wn: 0.6 }),
  // Brace: lower and more committed, both hands closed, shaft angled up at
  // the charge, chest forward.
  brace: P({ ...BASE, g: [0.18, -0.4, -0.1], d: [-0.16, 0.13, -0.32], s: 0.38, b: [0.9, -0.4, 0.2], lean: 0.2, drive: 0.15, aim: 0.5 }),
  // Throw preparation: the spear drawn back above the right shoulder (palm
  // under the shaft), the left arm forward to aim. windupFull: fully drawn.
  windup: P({ ...BASE, g: [0.25, 0.1, 0.06], d: [-0.05, 0.12, -1], b: [0.3, -1, 0.2], dg: 0.7, w: 0,
    lf: [-0.1, 0.0, -0.48], lfd: [0.1, 0.1, -1], lfp: [0.3, -0.9, 0.1], lc: 0.55, drive: -0.4, aim: 0.65 }),
  windupFull: P({ ...BASE, g: [0.27, 0.13, 0.15], d: [-0.04, 0.16, -1], b: [0.3, -1, 0.2], dg: 0.7, w: 0,
    lf: [-0.08, 0.03, -0.5], lfd: [0.1, 0.15, -1], lfp: [0.3, -0.9, 0.1], lc: 0.55, drive: -0.7, lean: -0.05, aim: 0.65 }),
  // Release point: the hand passing forward of the shoulder.
  release: P({ ...BASE, g: [0.17, 0.05, -0.4], d: [-0.03, 0.1, -1], b: [0.3, -0.6, 0.6], dg: 0.7, w: 0,
    lf: [-0.2, -0.24, -0.1], lfd: [0.1, -1, -0.2], lc: 0.4, rc: 0.1, drive: 0.9, aim: 0.65 }),
  // Follow-through: the empty hand carries on down and across.
  follow: P({ ...BASE, g: [0.02, -0.26, -0.38], d: [-0.3, -0.3, -1], b: [0.5, 0.5, 0.6], dg: 0.7, w: 0,
    lf: [-0.22, -0.32, 0.0], lfd: [0.1, -1, 0.1], lc: 0.4, rc: 0.2, drive: 0.5, lean: 0.08, aim: 0.3 }),
  // Pulling a spear free: the left hand forward and down on the shaft
  // (target filled in from the spear itself), leaning back into it.
  pull: P({ ...BASE, g: [0.19, -0.33, -0.16], d: [-0.15, 0.08, -0.28], w: 0,
    lf: [-0.05, -0.45, -0.36], lfd: [0.1, -0.6, -1], lfp: [0.6, -0.3, 0.4], lc: 0.9, lean: 0.15 }),
  // Reaching down for a spear on the ground.
  stoop: P({ ...BASE, g: [0.19, -0.35, -0.12], d: [-0.15, 0.08, -0.28], w: 0,
    lf: [-0.08, -0.5, -0.3], lfd: [0, -1, 0.15], lfp: [0.3, -0.3, 0.9], lc: 0.15, lean: 1.2, crouch: 0.3 }),
});

// No spear: both arms belong to the locomotion clip again.
const EMPTY_OVERRIDE = { on: 0, w: 0, lfw: 0, reach: 0, drive: 0, lean: 0, crouch: 0, rc: 0.25, lc: 0.25 };

export function clonePose(p) {
  const out = {};
  for (const k of VEC) out[k] = [...p[k]];
  for (const k of NUM) out[k] = p[k];
  return out;
}
export function blendPose(a, b, t, out = {}) {
  for (const k of VEC) { const x = a[k], y = b[k]; out[k] = [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]; }
  for (const k of NUM) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}
function normalizeDirs(p) {
  for (const k of DIRS) { const v = p[k], l = Math.hypot(v[0], v[1], v[2]) || 1; p[k] = [v[0] / l, v[1] / l, v[2] / l]; }
  return p;
}
// Cubic Hermite from a (with velocity va, per second) to b (at rest) over T s.
function hermite(a, va, b, u, T, out = {}) {
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2;
  for (const k of VEC) out[k] = [0, 1, 2].map(i => a[k][i] * h00 + (va?.[k]?.[i] ?? 0) * T * h10 + b[k][i] * h01);
  for (const k of NUM) out[k] = a[k] * h00 + (va?.[k] ?? 0) * T * h10 + b[k] * h01;
  return out;
}
function withEmpty(p) { return { ...clonePose(p), ...EMPTY_OVERRIDE }; }

// Thrust cycle pose at `age` seconds, starting from `from` (moving at `vel`)
// and settling into `base`.
export function thrustPose(age, from, vel, base) {
  const K = TP_POSES, T = REMOTE_THRUST;
  if (age < T.wind) return hermite(from, vel && scaleVel(vel, CHAIN_CARRY), K.wind, smooth(age / T.wind) * 0.35 + (age / T.wind) * 0.65, T.wind);
  if (age < T.strike) { const u = (age - T.wind) / (T.strike - T.wind); return blendPose(K.wind, K.strike, u * u * (3 - 2 * u) * 0.6 + u * u * 0.4); }
  if (age < T.hold) return clonePose(K.strike);
  if (age < T.retract) return blendPose(K.strike, K.retract, smooth((age - T.hold) / (T.retract - T.hold)));
  if (age < T.settle) return blendPose(K.retract, base, smooth((age - T.retract) / (T.settle - T.retract)));
  return clonePose(base);
}
function scaleVel(v, s) {
  const out = {};
  for (const k of VEC) out[k] = v[k].map(x => x * s);
  for (const k of NUM) out[k] = v[k] * s;
  return out;
}

// Throw release pose at `age` seconds after the authoritative release.
export function throwPose(age, from, base) {
  const K = TP_POSES, T = REMOTE_THROW;
  if (age < T.release) return blendPose(from, K.release, smooth(age / T.release) * 0.5 + age / T.release * 0.5);
  if (age < T.follow) return blendPose(K.release, K.follow, smooth((age - T.release) / (T.follow - T.release)));
  if (age < T.end) return blendPose(K.follow, base, smooth((age - T.follow) / (T.end - T.follow)));
  return clonePose(base);
}

// One per remote hunter. `update` is called every frame with that hunter's
// displayed (interpolated) state and display-timeline clock (seconds).
export class RemoteSpearMotion {
  constructor() {
    this.base = null; this.out = null; this.vel = null; this.prev = null;
    this.thrust = null;   // { start, from, vel }
    this.throw = null;    // { start, from }
    this.pickup = null;   // { start, target, armedBefore }
    this.lastThrustStart = -Infinity;
  }

  reset() { this.base = this.out = this.vel = this.prev = this.thrust = this.throw = this.pickup = null; this.lastThrustStart = -Infinity; }

  baseTarget(state, { sprinting = false, pullTarget = null } = {}) {
    const K = TP_POSES;
    if (!state || state.health <= 0) return withEmpty(K.carry);
    const armed = state.spears > 0;
    if (state.recovering && !(state.knockTicks > 0)) {
      const pose = clonePose(K.pull);
      if (pullTarget) pose.lf = [pullTarget[0], pullTarget[1], pullTarget[2]];
      if (!armed) Object.assign(pose, { on: 0 });
      return pose;
    }
    if (!armed) return withEmpty(K.carry);
    if (state.knockTicks > 0) return clonePose(K.carry);
    if (state.bracing) return clonePose(K.brace);
    if (state.winding) return blendPose(K.windup, K.windupFull, clamp01((state.windupTime ?? 0) / HUNT.windupSeconds));
    return clonePose(sprinting ? K.run : K.carry);
  }

  // clock: display-timeline seconds. ctx: { state, dt, sprinting,
  //   thrustStart (display seconds of the shown thrust's start, or null),
  //   releaseAt (display seconds of the shown throw's release, or null),
  //   pickupAt / pickupTarget (frame-space) for a spear being picked up,
  //   pullTarget (frame-space) while pulling a spear free }.
  update(clock, ctx) {
    const { state, dt = 0 } = ctx;
    const target = this.baseTarget(state, ctx);
    if (!this.base) this.base = target;
    else this.base = blendPose(this.base, target, 1 - Math.exp(-(state?.bracing || state?.winding ? 12 : 9) * dt));
    const alive = state && state.health > 0 && !(state.knockTicks > 0);
    // New thrust: a start later than the shown one (a held attack restarts
    // after THRUST_TICKS; anything closer is the same thrust re-estimated).
    if (alive && ctx.thrustStart !== null && ctx.thrustStart !== undefined && ctx.thrustStart > this.lastThrustStart + 0.25) {
      this.lastThrustStart = ctx.thrustStart;
      this.thrust = { start: ctx.thrustStart, from: this.out ? clonePose(this.out) : clonePose(this.base), vel: this.vel };
    } else if (this.thrust && ctx.thrustStart !== null && ctx.thrustStart !== undefined && Math.abs(ctx.thrustStart - this.thrust.start) < 0.25) {
      this.thrust.start = Math.min(this.thrust.start, ctx.thrustStart); // keep the earliest estimate; never jump forward
    }
    if (alive && ctx.releaseAt !== null && ctx.releaseAt !== undefined && (!this.throw || ctx.releaseAt > this.throw.start + 0.2)) {
      this.throw = { start: ctx.releaseAt, from: this.out ? clonePose(this.out) : clonePose(this.base) };
      this.thrust = null;
    }
    if (ctx.pickupAt !== null && ctx.pickupAt !== undefined && (!this.pickup || ctx.pickupAt > this.pickup.start + 0.2)) {
      this.pickup = { start: ctx.pickupAt, target: ctx.pickupTarget ?? null, armedBefore: !!ctx.pickupArmed, from: this.out ? clonePose(this.out) : clonePose(this.base) };
    }
    if (this.pickup && ctx.pickupTarget) this.pickup.target = ctx.pickupTarget;
    if (!alive) { this.thrust = this.throw = null; }

    let pose = this.base, holding = !!state && state.spears > 0 && state.health > 0, phase = 'base';
    if (this.throw) {
      const age = clock - this.throw.start;
      if (age >= REMOTE_THROW.end || age < -0.5) this.throw = null;
      else if (age >= 0) {
        pose = throwPose(age, this.throw.from, this.base); phase = 'throw';
        // The thrown spear leaves at the release point; one still in the
        // quiver is back in the fist as the hand returns low.
        if (age >= REMOTE_THROW.release) holding = holding && age >= REMOTE_THROW.rearm;
        else holding = true;
      }
    }
    if (phase === 'base' && this.thrust) {
      const age = clock - this.thrust.start;
      if (age >= REMOTE_THRUST.settle || age < -0.5) this.thrust = null;
      else if (age >= 0) { pose = thrustPose(age, this.thrust.from, this.thrust.vel, this.base); phase = 'thrust'; }
    }
    if (phase === 'base' && this.pickup) {
      const age = clock - this.pickup.start, T = REMOTE_PICKUP;
      if (age >= T.end || age < -1) this.pickup = null;
      else if (age >= 0) {
        const stoop = clonePose(TP_POSES.stoop);
        if (this.pickup.target) stoop.lf = [...this.pickup.target];
        if (!(state?.spears > 0) || !this.pickup.armedBefore) Object.assign(stoop, { on: this.base.on });
        pose = age < T.reach ? blendPose(this.pickup.from, stoop, smooth(age / T.reach))
          : age < T.grab ? stoop : blendPose(stoop, this.base, smooth((age - T.grab) / (T.end - T.grab)));
        if (age >= T.reach * 0.6 && age < T.lift) pose.lc = 1;
        phase = 'pickup';
        if (!this.pickup.armedBefore && age < T.lift) holding = false;
      }
    }
    const out = normalizeDirs(phase === 'base' ? clonePose(pose) : pose);
    if (this.out && dt > 0) {
      const v = {};
      for (const k of VEC) v[k] = out[k].map((x, i) => (x - this.out[k][i]) / dt);
      for (const k of NUM) v[k] = (out[k] - this.out[k]) / dt;
      this.vel = v;
    }
    this.out = out; this.phase = phase; this.holding = holding;
    return { pose: out, holding, phase };
  }
}

// Pose (above) -> the shape HeldSpearRig consumes (handSlots.targetPose()).
export function rigPose(p) {
  const supporting = p.w > 1e-3;
  return {
    spear: { grip: p.g, dir: p.d, back: p.b }, body: [0, 0, 0], onShaft: p.on,
    right: { curl: p.rc, pole: p.pr, diagonal: p.dg },
    left: { state: supporting ? LEFT_HAND.SUPPORTING : LEFT_HAND.EMPTY, slide: p.s, back: p.bl, curl: p.lc, weight: p.w,
      free: { pos: p.lf, fingers: p.lfd, palm: p.lfp }, freeWeight: p.lfw, pole: p.pl },
  };
}

// ---- Upper-body layer --------------------------------------------------
// Applied after the locomotion mixer and before the arms are solved: the
// donor's shoulder/chest drive (scaled by `drive`; negative = the small
// draw-back before a strike or throw) and a forward stoop (`lean`). The head
// is held steady (neck compensation). Only a pickup also bends the knees
// (`crouch`): the hips drop and each leg is re-solved so both feet stay
// exactly where the locomotion clip put them (no sliding, no root motion).
const LAYER_BONES = ['mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2', 'mixamorigNeck', 'mixamorigRightShoulder', 'mixamorigLeftShoulder'];
const LEAN_SHARE = { mixamorigSpine: 0.45, mixamorigSpine1: 0.3, mixamorigSpine2: 0.25 };
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _h0 = new THREE.Quaternion(), _axis = new THREE.Vector3();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3();
const IDENTITY = new THREE.Quaternion();
const DONOR_Q = Object.fromEntries(Object.entries(DONOR_DRIVE).map(([name, d]) => [name, new THREE.Quaternion(...d.q)]));

export class UpperBodyLayer {
  constructor(model) {
    this.model = model;
    this.bones = Object.fromEntries(LAYER_BONES.map(name => [name, model.getObjectByName(name)]));
    this.head = model.getObjectByName('mixamorigHead');
    this.hips = model.getObjectByName('mixamorigHips');
    this.legs = ['Left', 'Right'].map(side => ['UpLeg', 'Leg', 'Foot'].map(part => model.getObjectByName(`mixamorig${side}${part}`)))
      .filter(chain => chain.every(Boolean));
    this.saved = new Map();
    this.savedHips = null;
  }
  // Undo last frame's layer (before the mixer runs; a mixer with no action
  // playing would otherwise leave the layered pose in place and accumulate).
  restore() {
    for (const [bone, q] of this.saved) bone.quaternion.copy(q);
    this.saved.clear();
    if (this.savedHips) { this.hips.position.copy(this.savedHips); this.savedHips = null; }
  }
  apply(drive = 0, lean = 0, root, crouch = 0) {
    this.restore();
    if (Math.abs(drive) < 1e-3 && Math.abs(lean) < 1e-3 && crouch < 1e-3) return;
    for (const bone of Object.values(this.bones)) if (bone) this.saved.set(bone, bone.quaternion.clone());
    this.model.updateWorldMatrix(true, true);
    if (crouch > 1e-3 && this.hips) this.crouch(crouch, root);
    this.head?.getWorldQuaternion(_h0);
    // Stoop: rotate the spine about the hunter's own right axis.
    if (Math.abs(lean) > 1e-3) {
      _axis.set(1, 0, 0).transformDirection(root.matrixWorld).normalize();
      for (const [name, share] of Object.entries(LEAN_SHARE)) {
        const bone = this.bones[name]; if (!bone) continue;
        bone.parent.getWorldQuaternion(_q2);
        _q.setFromAxisAngle(_axis, lean * share);                  // world rotation (root +X is the hunter's left: positive = forward)
        _q3.copy(_q2).invert().multiply(_q).multiply(_q2);          // in the parent's frame
        bone.quaternion.premultiply(_q3);
        bone.updateWorldMatrix(false, true);
      }
    }
    for (const [name, base] of Object.entries(DONOR_Q)) {
      const bone = this.bones[name]; if (!bone) continue;
      const w = drive * DONOR_DRIVE[name].scale;
      _q.copy(IDENTITY).slerp(w >= 0 ? base : _q2.copy(base).invert(), Math.min(1, Math.abs(w)));
      bone.quaternion.multiply(_q);
    }
    // Keep the head looking where it was (the donor's own neck counter-turn).
    const neck = this.bones.mixamorigNeck;
    if (neck && this.head) {
      this.model.updateWorldMatrix(true, true);
      const now = this.head.getWorldQuaternion(_q);
      const fix = _q2.copy(_h0).multiply(now.invert());               // world correction
      neck.parent.getWorldQuaternion(_q3);
      const local = _q3.clone().invert().multiply(fix).multiply(_q3);  // in the neck's parent frame
      neck.quaternion.premultiply(local.slerp(IDENTITY, 0.15));
    }
    this.model.updateWorldMatrix(true, true);
  }

  crouch(drop, root) {
    const feet = this.legs.map(([, , foot]) => ({ p: foot.getWorldPosition(new THREE.Vector3()), q: foot.getWorldQuaternion(new THREE.Quaternion()) }));
    for (const chain of this.legs) for (const bone of chain) this.saved.set(bone, bone.quaternion.clone());
    this.savedHips = this.hips.position.clone();
    const world = this.hips.getWorldPosition(_v1);
    world.y -= drop;
    this.hips.position.copy(this.hips.parent.worldToLocal(world));
    this.hips.updateWorldMatrix(false, true);
    const forward = _v2.set(0, 0, 1).transformDirection(root.matrixWorld); // the visual faces +Z: knees go forward
    this.legs.forEach(([thigh, shin, foot], i) => {
      const hip = thigh.getWorldPosition(new THREE.Vector3()), knee = shin.getWorldPosition(new THREE.Vector3()), ankle = foot.getWorldPosition(new THREE.Vector3());
      const r = solveTwoBone(hip, feet[i].p, hip.distanceTo(knee), knee.distanceTo(ankle), forward, {});
      turnToward(thigh, knee.sub(hip).normalize(), r.upperDir);
      const knee2 = shin.getWorldPosition(new THREE.Vector3()), ankle2 = foot.getWorldPosition(new THREE.Vector3());
      turnToward(shin, ankle2.sub(knee2).normalize(), r.foreDir);
      foot.parent.getWorldQuaternion(_q3);
      foot.quaternion.copy(_q3.invert().multiply(feet[i].q));           // the foot keeps its own orientation
      foot.updateWorldMatrix(false, true);
    });
  }
}

// Rotate `bone` (in world terms, about its own pivot) so world direction `from` becomes `to`.
function turnToward(bone, from, to) {
  _q.setFromUnitVectors(from, to);
  bone.parent.getWorldQuaternion(_q2);
  _q3.copy(_q2).invert().multiply(_q).multiply(_q2);
  bone.quaternion.premultiply(_q3);
  bone.updateWorldMatrix(false, true);
}
