import * as THREE from 'three';
import { HUNT } from '@shared/hunt.js';
import { GRIP_DESIGN, gripWrist } from './gripHand.js';
import { RELEASE_SECONDS, resolveStance } from './handSlots.js';

// First-Person Spear Live Integration: the approved first-person spear motion.
//
// This is the production home of the approved first-person prototype (idle,
// wind-up, fast straight thrust, retract, left-hand idle; chained attacks that
// blend from the current pose). The keys below are the approved keys, unchanged.
// FirstPersonRig (firstPerson.js) draws them with the purpose-built hands in
// gripHand.js; nothing here reads input or changes combat.
//
// Space: the first-person camera (the eye at the origin, looking down -Z, a
// 62-degree camera). A spear key gives the spear's direction (yaw, pitch,
// degrees), its roll about the shaft and where the right grip sits on screen
// (screen x/y in normalised device coordinates, depth in metres along that
// ray, `shift` metres back along the shaft). A left key gives how attached the
// left hand is (1 = underhand on the shaft, 0 = cleared below the view), where
// on the shaft (slide, metres ahead of the right grip) and its roll (lroll).
//
// Timing (seconds from the thrust's input tick, the same tick the server
// stamps): wind-up 0-0.17, thrust 0.17-0.30, hold 0.30-0.38, retract
// 0.38-0.56, settle 0.56-0.82. Server truth is unchanged: hit window
// 0.12-0.40 s, full reach at 0.35 s (inside the hold), next thrust allowed
// after HUNT.thrustCooldown.

const k = (spear, left, extra = {}) => Object.freeze({ spear: Object.freeze({ ...spear, screen: Object.freeze(spear.screen) }), left: Object.freeze(left), ...extra });
const sh = right => Object.freeze({ right: Object.freeze(right) });

// The approved attack (prototype attack-rel.json, approved 2026-10-27).
export const FP_ATTACK = Object.freeze([
  k({ yaw: -4, pitch: 12, roll: 20, screen: [0.32, -0.7], depth: 0.38, shift: 0.2 }, { attach: 1, slide: 0.46, lroll: -86 }, { straight: 0, t: 0 }),
  k({ yaw: -14, pitch: 10, roll: 25, screen: [0.7, -0.8], depth: 0.46 }, { attach: 0, slide: 0.46, lroll: -81 }, { shoulder: sh([0.04, 0.02, 0.1]), straight: 1, t: 0.17, ease: 'smooth', leftEase: 'out' }),
  k({ yaw: -16, pitch: 6, roll: 30, screen: [0.32, -0.47], depth: 0.56 }, { attach: 0, slide: 0.46, lroll: -76 }, { shoulder: sh([0.02, 0.02, -0.08]), straight: 1, t: 0.3, ease: 'out' }),
  k({ yaw: -16, pitch: 6, roll: 30, screen: [0.32, -0.47], depth: 0.56 }, { attach: 0, slide: 0.46, lroll: -76 }, { shoulder: sh([0.02, 0.02, -0.08]), straight: 1, t: 0.38 }),
  k({ yaw: -10, pitch: 9, roll: 30, screen: [0.34, -0.66], depth: 0.42, shift: 0.16 }, { attach: 0.3, slide: 0.4, lroll: -76 }, { straight: 0.4, t: 0.56, ease: 'smooth', leftEase: 'in' }),
  k({ yaw: -6, pitch: 11, roll: 30, screen: [0.32, -0.7], depth: 0.38, shift: 0.14 }, { attach: 1, slide: 0.4, lroll: -76 }, { straight: 0, t: 0.7, ease: 'smooth', leftEase: 'smooth' }),
  k({ yaw: -4, pitch: 12, roll: 20, screen: [0.32, -0.7], depth: 0.38, shift: 0.2 }, { attach: 1, slide: 0.46, lroll: -86 }, { straight: 0, t: 0.82, ease: 'smooth' }),
]);
export const FP_TIMING = Object.freeze({ wind: 0.17, strike: 0.3, hold: 0.38, retract: 0.56, settle: 0.82 });
export const FP_IDLE = FP_ATTACK[0];
// Approved arm settings (prototype chain tests: limits [30, 10], right pole
// [0.2, -1, 0.3], momentum carry 0.5).
export const FP_ARM = Object.freeze({
  shoulder: Object.freeze({ right: Object.freeze([0.18, -0.24, 0.08]), left: Object.freeze([-0.18, -0.24, 0.08]) }),
  upper: 0.29, fore: 0.26,
  pole: Object.freeze({ right: Object.freeze([0.2, -1, 0.3]), left: Object.freeze([-0.55, -1, 0.25]) }),
  wristLimit: Object.freeze({ right: 30, left: 10 }),
  carry: 0.5,
  // Where the left hand goes when it lets go: below and behind its idle grip, tilted.
  cleared: Object.freeze({ offset: Object.freeze([-0.07, -0.32, 0.1]), tilt: -30 }),
});

// Holds that are not part of the approved attack. They are written in the same
// key form so every state blends with every other; none of them changes the
// approved idle or attack.
export const FP_HOLDS = Object.freeze({
  idle: FP_IDLE,
  // Sprinting: the same carry, a touch lower and tucked in.
  carry: k({ yaw: -5, pitch: 14, roll: 20, screen: [0.34, -0.76], depth: 0.37, shift: 0.2 }, { attach: 1, slide: 0.46, lroll: -86 }, { straight: 0 }),
  // Brace: both hands set on the shaft, the right fist in view low right, the
  // head held up at the charge.
  brace: k({ yaw: -8, pitch: 16, roll: 26, screen: [0.46, -0.74], depth: 0.42, shift: 0.04 }, { attach: 1, slide: 0.46, lroll: -86 }, { straight: 0.3, shoulder: sh([0.02, 0, -0.04]) }),
  // Throw preparation: the spear drawn back high beside the head, the left
  // hand forward to aim (see leftFree). windupFull: fully charged.
  windup: k({ yaw: -3, pitch: 6, roll: 25, screen: [0.74, -0.12], depth: 0.36 }, { attach: 0, slide: 0.46, lroll: -86 }, { leftRelax: 1, straight: 0.5, shoulder: sh([0.04, 0.14, 0.06]), leftFree: Object.freeze({ screen: Object.freeze([-0.32, -0.62]), depth: 0.5, yaw: 4, pitch: 14, roll: 20, lroll: -86 }) }),
  windupFull: k({ yaw: -3, pitch: 7, roll: 25, screen: [0.8, -0.04], depth: 0.33 }, { attach: 0, slide: 0.46, lroll: -86 }, { leftRelax: 1, straight: 0.5, shoulder: sh([0.05, 0.16, 0.12]), leftFree: Object.freeze({ screen: Object.freeze([-0.28, -0.58]), depth: 0.52, yaw: 4, pitch: 16, roll: 20, lroll: -86 }) }),
  // Release point (the spear leaves here) and the follow-through, low out of view.
  release: k({ yaw: -10, pitch: 6, roll: 30, screen: [0.36, -0.42], depth: 0.58 }, { attach: 0, slide: 0.46, lroll: -76 }, { leftRelax: 1, straight: 1, shoulder: sh([0.02, 0.02, -0.08]) }),
  follow: k({ yaw: -20, pitch: -6, roll: 30, screen: [0.5, -1.25], depth: 0.5 }, { attach: 0, slide: 0.46, lroll: -76 }, { leftRelax: 1, straight: 0.6 }),
  // Pulling a spear free while holding one: the left hand reaches forward and down.
  recover: k({ yaw: -4, pitch: 12, roll: 20, screen: [0.32, -0.72], depth: 0.38, shift: 0.2 }, { attach: 0, slide: 0.46, lroll: -86 }, { straight: 0, leftFree: Object.freeze({ screen: Object.freeze([0.0, -0.66]), depth: 0.5, yaw: -4, pitch: 2, roll: 20, lroll: -86 }) }),
});

const DEG = Math.PI / 180;
const EASES = Object.freeze({ smooth: t => t * t * (3 - 2 * t), out: t => 1 - (1 - t) ** 3, in: t => t * t * t, linear: t => t });
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const V3 = a => new THREE.Vector3(...(a ?? [0, 0, 0]));
const Z_AXIS = new THREE.Vector3(0, 0, 1), X_AXIS = new THREE.Vector3(1, 0, 0);

export function direction(yaw, pitch, out = new THREE.Vector3()) {
  return out.set(Math.sin(yaw * DEG) * Math.cos(pitch * DEG), Math.sin(pitch * DEG), -Math.cos(yaw * DEG) * Math.cos(pitch * DEG));
}
// Spear orientation (local -Z toward the head) from its direction and roll.
export function orient(dir, roll, out = new THREE.Quaternion()) {
  const z = dir.clone().normalize().negate();
  const up0 = new THREE.Vector3(0, 1, 0).addScaledVector(z, -z.y).normalize();
  const x0 = new THREE.Vector3().crossVectors(up0, z);
  const y = up0.clone().multiplyScalar(Math.cos(roll)).addScaledVector(x0, Math.sin(roll));
  return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z));
}

// The pose solver for one camera (screen keys unproject through it).
export class FirstPersonPoser {
  constructor(camera) {
    this.camera = camera;
    this.rest = { right: gripWrist('right', GRIP_DESIGN.right), left: gripWrist('left', GRIP_DESIGN.left) };
    this.pole = { right: V3(FP_ARM.pole.right).normalize(), left: V3(FP_ARM.pole.left).normalize() };
    this.cache = new Map();
  }

  // Projection changes (resize) invalidate cached key states.
  invalidate() { this.cache.clear(); this.cleared = null; }

  // Spear key -> right grip position + spear quaternion (camera space).
  spearPose(s) {
    const d = direction(s.yaw, s.pitch), q = orient(d, s.roll * DEG);
    this.camera.updateMatrixWorld();
    const grip = new THREE.Vector3(s.screen[0], s.screen[1], 0.5).unproject(this.camera).sub(this.camera.position).normalize()
      .multiplyScalar(s.depth).addScaledVector(d, -(s.shift ?? 0));
    return { grip, q, d };
  }
  keyState(key) {
    let state = this.cache.get(key);
    if (!state) {
      const sp = this.spearPose(key.spear);
      const lpos = sp.grip.clone().addScaledVector(sp.d, key.left.slide);
      const lq = sp.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, key.left.lroll * DEG));
      let free = null;
      if (key.leftFree) {
        // A free left hand: placed and turned like a support hand on an
        // imaginary shaft (same yaw/pitch/roll/lroll convention as on the spear).
        const f = this.spearPose(key.leftFree);
        free = { pos: f.grip, quat: f.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, (key.leftFree.lroll ?? 0) * DEG)) };
      }
      state = { sp, lpos, lq, free };
      this.cache.set(key, state);
    }
    return state;
  }
  // The left hand's let-go pose: below and behind the idle grip.
  get clearedPose() {
    if (!this.cleared) {
      const idle = this.keyState(FP_IDLE);
      this.cleared = { pos: idle.lpos.clone().add(V3(FP_ARM.cleared.offset)),
        quat: new THREE.Quaternion().setFromAxisAngle(X_AXIS, FP_ARM.cleared.tilt * DEG).multiply(idle.lq) };
    }
    return this.cleared;
  }

  // A single hold as a full state.
  holdState(key) {
    const s = this.keyState(key), free = s.free ?? this.clearedPose, att = key.left.attach;
    return { grip: s.sp.grip.clone(), q: s.sp.q.clone(), leftPos: free.pos.clone().lerp(s.lpos, att), leftQuat: free.quat.clone().slerp(s.lq, att), att,
      shR: V3(key.shoulder?.right), shL: V3(key.shoulder?.left), straight: key.straight ?? 0, drop: 0, relax: key.leftRelax ?? 0 };
  }

  // State at `t` along a keyed timeline (the approved attack). Prototype segState.
  segState(keys, t) {
    let i = 0; while (i < keys.length - 2 && t > keys[i + 1].t) i++;
    const a = keys[i], b = keys[i + 1];
    const u0 = clamp01((t - a.t) / (b.t - a.t)), u = EASES[b.ease ?? 'smooth'](u0);
    const A = this.keyState(a), B = this.keyState(b), cleared = this.clearedPose;
    const grip = A.sp.grip.clone().lerp(B.sp.grip, u), q = A.sp.q.clone().slerp(B.sp.q, u), d = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const slide = THREE.MathUtils.lerp(a.left.slide, b.left.slide, u), lroll = THREE.MathUtils.lerp(a.left.lroll, b.left.lroll, u);
    const attPos = grip.clone().addScaledVector(d, slide), attQ = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(Z_AXIS, lroll * DEG));
    const att = THREE.MathUtils.lerp(a.left.attach, b.left.attach, EASES[b.leftEase ?? 'smooth'](u0));
    return { grip, q, leftPos: cleared.pos.clone().lerp(attPos, att), leftQuat: cleared.quat.clone().slerp(attQ, att), att,
      shR: V3(a.shoulder?.right).lerp(V3(b.shoulder?.right), u), shL: V3(a.shoulder?.left).lerp(V3(b.shoulder?.left), u),
      straight: THREE.MathUtils.lerp(a.straight ?? 0, b.straight ?? 0, EASES[b.straightEase ?? b.ease ?? 'smooth'](u0)), drop: 0, relax: 0 };
  }

  // The approved chain rule (prototype chainState): an attack that starts while
  // another is still running (or from any other hold) never snaps to idle. Its
  // wind-up runs from the pose at that moment, keeping its momentum (Hermite,
  // ending at rest on the wind-up key; the left hand keeps FP_ARM.carry of its
  // momentum), and from the wind-up key on it is the single attack exactly.
  // `from` / `before`: the pose at the start and 1/240 s earlier.
  windupFrom(from, before, c) {
    const W = FP_TIMING.wind, target = this.segState(FP_ATTACK, W), wind = FP_ATTACK[1];
    const u0 = clamp01(c / W), u = EASES[wind.ease ?? 'smooth'](u0), h = 1 / 240, carry = FP_ARM.carry;
    const h00 = 2 * u0 ** 3 - 3 * u0 ** 2 + 1, h10 = u0 ** 3 - 2 * u0 ** 2 + u0, h01 = -2 * u0 ** 3 + 3 * u0 ** 2;
    const hv = (p0, v0, p1) => p0.clone().multiplyScalar(h00).addScaledVector(v0, h10 * W).addScaledVector(p1, h01);
    const vel = (a, b) => a.clone().sub(b).divideScalar(h);
    const grip = hv(from.grip, vel(from.grip, before.grip), target.grip);
    const leftPos = hv(from.leftPos, vel(from.leftPos, before.leftPos).multiplyScalar(carry), target.leftPos);
    const att1 = from.att * h00 + (from.att - before.att) / h * carry * h10 * W + target.att * h01;
    const prog = clamp01((from.att - att1) / Math.max(1e-6, from.att - target.att));
    return { grip, q: from.q.clone().slerp(target.q, u), leftPos, leftQuat: from.leftQuat.clone().slerp(target.leftQuat, prog), att: clamp01(att1),
      shR: from.shR.clone().lerp(target.shR, u), shL: from.shL.clone().lerp(target.shL, u), straight: THREE.MathUtils.lerp(from.straight, target.straight, u),
      drop: THREE.MathUtils.lerp(from.drop ?? 0, 0, u), relax: THREE.MathUtils.lerp(from.relax ?? 0, 0, u) };
  }

  // Arms: two-bone IK from each shoulder to its wrist; the forearm may swing
  // off its rest line at the wrist only within the wrist limit; the right arm
  // blends toward the straight thrust arm (forearm on the rest line, wrist
  // neutral) by `straight`. Returns wrist, forearm axis, elbow, shoulder.
  handFrame(side, pos, quat) {
    const r = this.rest[side];
    return { wrist: r.point.clone().applyQuaternion(quat).add(pos), rest: r.forearm.clone().applyQuaternion(quat), back: r.back.clone().applyQuaternion(quat) };
  }
  shoulder(side, S) {
    return V3(FP_ARM.shoulder[side]).add(side === 'right' ? S.shR : S.shL);
  }
  solveArm(side, hf, S) {
    const shoulder = this.shoulder(side, S);
    const ik = this.solveArmIK(side, hf, shoulder);
    if (side !== 'right' || !(S.straight > 0)) return ik;
    const q = new THREE.Quaternion().setFromUnitVectors(ik.axis, hf.rest), axis = ik.axis.clone().applyQuaternion(new THREE.Quaternion().slerp(q, S.straight));
    return { axis, elbow: hf.wrist.clone().addScaledVector(axis, FP_ARM.fore), shoulder, bend: axis.angleTo(hf.rest) / DEG, clamped: ik.clamped && S.straight < 0.5 };
  }
  solveArmIK(side, hf, shoulder) {
    const U = FP_ARM.upper, F = FP_ARM.fore, toW = hf.wrist.clone().sub(shoulder), dist = Math.min(toW.length(), U + F - 1e-4);
    const u = toW.clone().normalize();
    const cosA = THREE.MathUtils.clamp((U * U + dist * dist - F * F) / (2 * U * dist), -1, 1);
    const v = this.pole[side].clone().addScaledVector(u, -this.pole[side].dot(u)).normalize();
    const elbowIK = shoulder.clone().addScaledVector(u, U * cosA).addScaledVector(v, U * Math.sqrt(1 - cosA * cosA));
    let axis = elbowIK.clone().sub(hf.wrist).normalize();
    const bend = axis.angleTo(hf.rest) / DEG, limit = FP_ARM.wristLimit[side];
    if (bend > limit) axis = hf.rest.clone().applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(hf.rest, axis), limit / bend));
    return { axis, elbow: hf.wrist.clone().addScaledVector(axis, F), shoulder, bend, clamped: bend > limit };
  }
}

export function blendStates(A, B, u, ul = u) {
  return { grip: A.grip.clone().lerp(B.grip, u), q: A.q.clone().slerp(B.q, u), leftPos: A.leftPos.clone().lerp(B.leftPos, ul), leftQuat: A.leftQuat.clone().slerp(B.leftQuat, ul),
    att: THREE.MathUtils.lerp(A.att, B.att, ul), shR: A.shR.clone().lerp(B.shR, u), shL: A.shL.clone().lerp(B.shL, u),
    straight: THREE.MathUtils.lerp(A.straight, B.straight, u), drop: THREE.MathUtils.lerp(A.drop ?? 0, B.drop ?? 0, u),
    relax: THREE.MathUtils.lerp(A.relax ?? 0, B.relax ?? 0, ul) };
}
const cloneState = S => blendStates(S, S, 0);
function distance(A, B) {
  return A.grip.distanceTo(B.grip) + A.leftPos.distanceTo(B.leftPos) + Math.abs(A.att - B.att) + (1 - Math.abs(A.q.dot(B.q))) * 10 + Math.abs((A.drop ?? 0) - (B.drop ?? 0));
}

// The live state machine: which hold the hunter is in, the attacks and the
// throw on the local action clocks, and the blends between them.
//   update(seconds, dt, state, clocks) -> { S, holding, phase, stance, down }
// clocks: { thrustAge, throwAge, sprinting } — seconds since the local thrust /
// throw input (main.js starts them on the tick the input is sent).
export class FirstPersonSpearMotion {
  constructor(poser) {
    this.poser = poser;
    this.reset();
  }
  reset() {
    this.base = null; this.shown = null; this.previous = null;
    this.attacks = []; this.throw = null; this.phase = 'hold';
  }
  holdFor(resolved) {
    const H = FP_HOLDS, P = this.poser;
    switch (resolved.stance) {
      case 'carry': return P.holdState(H.carry);
      case 'brace': return P.holdState(H.brace);
      case 'windup': return blendStates(P.holdState(H.windup), P.holdState(H.windupFull), resolved.charge ?? 0);
      case 'recover': return P.holdState(H.recover);
      case 'empty': case 'recoverEmpty': case 'down': case 'downEmpty': return { ...P.holdState(H.idle), drop: 1 };
      default: return P.holdState(H.idle); // ready, cook, thrust (between attacks)
    }
  }

  // The newest attack starts at `start`; the pose shown when it began decides
  // how it begins (exactly the approved attack from a settled idle; otherwise
  // the chain rule from wherever the spear was).
  startAttack(start, seconds) {
    const P = this.poser, last = this.attacks.at(-1);
    const interrupted = last && start - last.start < FP_TIMING.settle;
    let lead = null;
    if (interrupted) {
      // Exactly as the prototype: the previous attack's own pose at that moment.
      lead = { from: this.attackState(last, start), before: this.attackState(last, start - 1 / 240) };
    } else if (this.shown && distance(this.shown, P.holdState(FP_IDLE)) > 1e-3) {
      lead = { from: cloneState(this.shown), before: cloneState(this.previous ?? this.shown) };
    }
    this.attacks = [...(last && interrupted ? [last] : []), { start, lead }].slice(-2);
  }
  attackState(attack, t) {
    const c = t - attack.start;
    if (!attack.lead || c >= FP_TIMING.wind) return this.poser.segState(FP_ATTACK, Math.min(Math.max(c, 0), FP_TIMING.settle));
    return this.poser.windupFrom(attack.lead.from, attack.lead.before, Math.max(c, 0));
  }

  update(seconds, dt, state, clocks = {}) {
    const resolved = resolveStance(state, clocks);
    const P = this.poser, target = this.holdFor(resolved);
    this.base ??= target;
    let S, phase = 'hold', holding = !!state && state.spears > 0 && !resolved.down;
    // Throw: from the pose at release, through the release point (where the
    // spear leaves the hand) and down out of view, then back to the hold.
    const throwAge = clocks.throwAge ?? Infinity;
    if (throwAge >= 0 && throwAge < RELEASE_SECONDS && !resolved.down) {
      if (!this.throw || seconds - throwAge > this.throw.start + 0.2) {
        this.throw = { start: seconds - throwAge, from: cloneState(this.shown ?? target) };
        this.attacks = [];
      }
    }
    if (this.throw) {
      const c = seconds - this.throw.start, H = FP_HOLDS;
      if (c >= RELEASE_SECONDS + 0.25 || resolved.down) { this.base = cloneState(this.shown); this.throw = null; }
      else {
        phase = 'throw';
        if (c < THROW_TIMING.release) S = blendStates(this.throw.from, P.holdState(H.release), EASES.out(c / THROW_TIMING.release));
        else if (c < THROW_TIMING.follow) S = blendStates(P.holdState(H.release), P.holdState(H.follow), EASES.smooth((c - THROW_TIMING.release) / (THROW_TIMING.follow - THROW_TIMING.release)));
        else {
          // Back up into the hold (re-armed from the remaining spears, or empty).
          const back = { ...target, drop: Math.max(target.drop ?? 0, 0) };
          S = blendStates({ ...P.holdState(H.follow), drop: 1 }, back, EASES.smooth((c - THROW_TIMING.follow) / (RELEASE_SECONDS + 0.25 - THROW_TIMING.follow)));
        }
        holding = c < THROW_TIMING.release || (c >= THROW_TIMING.rearm && state.spears > 0);
      }
    }
    // Attacks: a new local thrust clock starts a new attack.
    const attackAllowed = !this.throw && ['thrust', 'ready', 'carry', 'cook'].includes(resolved.stance);
    if (!attackAllowed) { if (this.attacks.length && this.shown) this.base = cloneState(this.shown); this.attacks = []; }
    const thrustAge = clocks.thrustAge ?? Infinity;
    if (attackAllowed && resolved.stance === 'thrust' && thrustAge >= 0 && thrustAge < HUNT.thrustCooldown) {
      const start = seconds - thrustAge, last = this.attacks.at(-1);
      if (!last || start > last.start + 0.05) this.startAttack(start, seconds);
    }
    if (!S && this.attacks.length) {
      const attack = this.attacks.at(-1), c = seconds - attack.start;
      if (c >= FP_TIMING.settle) { this.base = P.segState(FP_ATTACK, FP_TIMING.settle); this.attacks = []; }
      else { S = this.attackState(attack, seconds); phase = 'attack'; }
    }
    // Holds blend into each other (and the end of an attack/throw into the hold).
    this.base = blendStates(this.base, target, 1 - Math.exp(-(resolved.stance === 'windup' || resolved.stance === 'brace' ? 12 : 9) * dt));
    S ??= this.base;
    this.previous = this.shown; this.shown = S; this.phase = phase;
    return { S, holding, phase, stance: resolved.stance, down: !!resolved.down, resolved };
  }
}
// The throw's own clock: leaves the hand at `release` (RELEASE_HOLD), the hand
// is out of view by `follow`, re-armed (if a spear is left) from `rearm`.
export const THROW_TIMING = Object.freeze({ release: 0.07, follow: 0.25, rearm: 0.3 });
