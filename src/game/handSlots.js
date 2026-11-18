// Hunt Slice 0.1 hand-slot foundation, rebuilt by Spear Ownership 0.1.
//
// The spear is the master object. A stance says where the SPEAR is (its
// primary grip point, the direction to its head and its roll, given as the
// direction the back of the right hand faces) and what the LEFT hand is doing.
// The hands then follow sockets on the spear and the arms solve back to the
// shoulders (armRig.js); the spear itself hangs from the right hand's socket.
//  - RIGHT is the primary hand. It owns the spear and every existing spear
//    action (thrust, wind-up/throw, brace, recovery) through the unchanged
//    controls and server-authoritative timing.
//  - LEFT is a support hand with two states: EMPTY (free, relaxed) or
//    SUPPORTING (closed on the spear's support grip, which may slide within a
//    fixed range of the shaft). It owns no item and no input. A future manual
//    two-hand toggle only needs to choose the left state; no input exists yet.
// The same stance names and left-hand states drive the first-person view
// (fpSpearMotion.js, camera space) and every third-person hunter
// (remoteSpear.js / TP_STANCES, body space), so both show the same action.
//
// Plain data and arithmetic only, so it can be tested without three.js.
// Positions are metres, x right, y up, -z forward. Directions are unit-ish
// vectors (normalised on use).

import { HUNT } from '@shared/hunt.js';

export const HAND_SLOTS = Object.freeze({
  right: Object.freeze({ id: 'right', role: 'primary', item: 'spear' }),
  left: Object.freeze({ id: 'left', role: 'support', item: null }),
});

// Controls are unchanged; every action belongs to the right-hand spear.
export const ACTION_MAP = Object.freeze({
  thrust: Object.freeze({ input: 'LMB', owner: 'right', support: 'steady-shaft' }),
  throw: Object.freeze({ input: 'RMB hold, release', owner: 'right', support: 'steady-shaft' }),
  brace: Object.freeze({ input: 'Q hold', owner: 'right', support: 'steady-shaft' }),
  recover: Object.freeze({ input: 'E near a spear', owner: 'right', support: 'pull' }),
  interact: Object.freeze({ input: 'E', owner: 'right', support: 'none' }),
});

export function canEquip(slot, item) {
  // The foundation accepts only the existing spear, only in the right hand.
  return slot === 'right' ? item === 'spear' || item === null : item === null;
}

export const LEFT_HAND = Object.freeze({ EMPTY: 'empty', SUPPORTING: 'supporting' });

// Support-grip range: metres from the primary (right-hand) grip toward the
// head. Every supporting stance keeps its slide inside this range, so the left
// hand never meets the right fist (0.14 m clearance) nor the lashing.
export const SUPPORT_RANGE = Object.freeze({ min: 0.28, max: 0.62 });

// Grip shapes the rig knows how to form with the fingers (0 = open, 1 = fist).
export const GRIPS = Object.freeze({ open: 0, relaxed: 0.2, point: 0.55, grip: 1, pull: 0.9 });

const V = (...v) => Object.freeze(v);
const free = (pos, fingers, palm) => Object.freeze({ pos: V(...pos), fingers: V(...fingers), palm: V(...palm) });
const spear = (grip, dir, back) => Object.freeze({ grip: V(...grip), dir: V(...dir), back: V(...back) });
const support = (slide, back) => Object.freeze({ state: LEFT_HAND.SUPPORTING, slide, back: V(...back), curl: 'grip' });
const empty = (pose, curl = 'relaxed') => Object.freeze({ state: LEFT_HAND.EMPTY, free: pose, curl });
const S = Object.freeze;

// First person no longer uses a stance table here: its approved poses and
// timing live in fpSpearMotion.js (First-Person Spear Live Integration).

// Third person (body space: origin at the chest bone, x to the hunter's right,
// y up, -z the way the hunter faces). Same stances, same left-hand states.
export const TP_STANCES = S({
  ready: S({ spear: spear([0.24, -0.38, -0.3], [-0.12, 0.5, -1], [0.75, 0.2, 0.6]), right: S({ curl: 'grip' }),
    left: empty(null) }),
  carry: S({ spear: spear([0.24, -0.34, -0.22], [-0.1, 0.75, -0.7], [0.8, 0.1, 0.55]), right: S({ curl: 'grip' }),
    left: empty(null) }),
  thrustCocked: S({ spear: spear([0.26, -0.18, 0.02], [-0.12, 0.08, -1], [0.6, 0.55, 0.55]), right: S({ curl: 'grip' }),
    left: support(0.44, [-0.5, -0.7, 0.5]) }),
  thrustExtended: S({ spear: spear([0.14, -0.13, -0.42], [-0.05, 0.03, -1], [0.6, 0.55, 0.55]), right: S({ curl: 'grip' }),
    left: support(0.36, [-0.5, -0.7, 0.5]) }),
  windup: S({ spear: spear([0.27, 0.16, 0.08], [-0.05, 0.1, -1], [0.3, 0.8, 0.5]), right: S({ curl: 'grip' }),
    left: support(0.52, [-0.5, -0.7, 0.5]) }),
  release: S({ spear: spear([0.18, 0.08, -0.38], [0, 0.05, -1], [0.3, 0.8, 0.5]), right: S({ curl: 'open' }),
    left: empty(null) }),
  brace: S({ spear: spear([0.24, -0.42, -0.12], [-0.1, 0.24, -1], [0.6, 0.55, 0.55]), right: S({ curl: 'grip' }),
    left: support(0.5, [-0.5, -0.7, 0.5]) }),
  recover: S({ spear: spear([0.24, -0.38, -0.3], [-0.12, 0.5, -1], [0.75, 0.2, 0.6]), right: S({ curl: 'grip' }),
    left: empty(null, 'pull') }),
  recoverEmpty: S({ spear: null, right: S({ curl: 'pull' }), left: empty(null, 'pull') }),
  cook: S({ spear: spear([0.24, -0.34, -0.22], [-0.1, 0.75, -0.7], [0.8, 0.1, 0.55]), right: S({ curl: 'grip' }),
    left: empty(null) }),
  empty: S({ spear: null, right: S({ curl: 'relaxed' }), left: empty(null) }),
  down: S({ spear: spear([0.24, -0.38, -0.3], [-0.12, 0.5, -1], [0.75, 0.2, 0.6]), right: S({ curl: 'grip' }), left: empty(null) }),
  downEmpty: S({ spear: null, right: S({ curl: 'relaxed' }), left: empty(null) }),
});

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const ease = t => t * t * (3 - 2 * t);

// Thrust phases follow the server's spear-tip timeline (shared/hunt.js and
// server/huntState.js stepThrusts): the tip starts its reach at 0.12 s, is
// fully extended by 0.35 s and the action ends at thrustCooldown (0.64 s).
export function thrustPhase(seconds) {
  if (!(seconds >= 0) || seconds >= HUNT.thrustCooldown) return { cock: 0, extend: 0 };
  if (seconds < 0.12) return { cock: ease(seconds / 0.12), extend: 0 };
  if (seconds < 0.35) return { cock: 1, extend: ease((seconds - 0.12) / 0.23) };
  if (seconds < 0.4) return { cock: 1, extend: 1 };
  const back = ease((seconds - 0.4) / (HUNT.thrustCooldown - 0.4));
  return { cock: 1 - back, extend: 1 - back };
}

// The release stance lasts this long; the spear stays in the hand until the
// world spear takes over (see RELEASE_HOLD in spearRig.js).
export const RELEASE_SECONDS = 0.45;

// Decide which stance the hands take, in priority order, from the hunter's
// state (local prediction reconciled with snapshots, or a remote hunter's
// interpolated snapshot) plus action clocks.
export function resolveStance(state, clocks = {}) {
  const armed = state?.spears > 0;
  // Knocked down or dead: a carried spear stays in the fist and drops with it.
  if (!state || state.health <= 0 || state.knockTicks > 0) return { stance: armed ? 'down' : 'downEmpty', blend: [], down: true };
  const throwAge = clocks.throwAge ?? Infinity;
  if (throwAge >= 0 && throwAge < RELEASE_SECONDS) return { stance: 'release', blend: [], progress: throwAge / RELEASE_SECONDS };
  if (state.recovering) return { stance: armed ? 'recover' : 'recoverEmpty', blend: [] };
  if (!armed) return { stance: 'empty', blend: [] };
  if (state.cooking > 0) return { stance: 'cook', blend: [] };
  if (state.bracing) return { stance: 'brace', blend: [] };
  if (state.winding) return { stance: 'windup', blend: [], charge: clamp01((state.windupTime ?? 0) / HUNT.windupSeconds) };
  const thrust = thrustPhase(clocks.thrustAge ?? Infinity);
  if (thrust.cock > 0 || thrust.extend > 0) return { stance: 'thrust', blend: [], thrust };
  return { stance: clocks.sprinting ? 'carry' : 'ready', blend: [] };
}

const lerp = (a, b, t) => a + (b - a) * t;
const ZERO = Object.freeze([0, 0, 0]);
// Default elbow hints (frame space): elbows drop down and out.
export const DEFAULT_POLE = Object.freeze({ right: Object.freeze([0.75, -1, 0.15]), left: Object.freeze([-0.75, -1, 0.15]) });
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const normalize = v => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const copySpear = s => s && { grip: [...s.grip], dir: normalize(s.dir), back: normalize(s.back) };
const lerpSpear = (a, b, t) => ({ grip: lerp3(a.grip, b.grip, t), dir: normalize(lerp3(a.dir, b.dir, t)), back: normalize(lerp3(a.back, b.back, t)) });

// Target pose for a resolved stance from one table: the spear (or null), the
// right hand's curl (and a free pose when it holds nothing) and the left
// hand's state with its support slide or free pose.
export function targetPose(resolved, table = TP_STANCES) {
  const s = table;
  if (resolved.stance === 'thrust') {
    const { cock, extend } = resolved.thrust;
    const from = s.ready, mid = s.thrustCocked, to = s.thrustExtended;
    const a = extend > 0 ? mid : from, b = extend > 0 ? to : mid, t = extend > 0 ? extend : cock;
    // The support hand joins as the spear draws back for a committed thrust
    // and stays on through the strike and the return.
    const supporting = cock > 0.25 || extend > 0;
    const left = supporting ? { ...mid.left, slide: lerp(mid.left.slide, to.left.slide, extend), pole: lerp3(mid.left.pole ?? DEFAULT_POLE.left, to.left.pole ?? DEFAULT_POLE.left, extend) } : from.left;
    return { spear: lerpSpear(a.spear, b.spear, t), body: lerp3(a.body ?? ZERO, b.body ?? ZERO, t),
      right: { curl: 'grip', pole: lerp3(a.right.pole ?? DEFAULT_POLE.right, b.right.pole ?? DEFAULT_POLE.right, t) }, left };
  }
  if (resolved.stance === 'windup') {
    const base = s.windup, charge = resolved.charge ?? 0;
    // Drawing back further as the throw charges.
    const spearPose = copySpear(base.spear);
    spearPose.grip = [spearPose.grip[0] + charge * 0.03, spearPose.grip[1] + charge * 0.04, spearPose.grip[2] + charge * 0.1];
    return { ...base, body: base.body ?? ZERO, spear: spearPose, left: { ...base.left, slide: base.left.slide + charge * 0.04 } };
  }
  const stance = s[resolved.stance] ?? s.ready;
  return { ...stance, body: stance.body ?? ZERO, spear: copySpear(stance.spear) };
}
