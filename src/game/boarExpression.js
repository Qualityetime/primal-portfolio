// Rigged Professor Boar body language (presentation only).
//
// This module turns the authoritative state already present in snapshots
// (state, stateTick, attackTick, startleTick, limp) into a few small posture
// channels. It never feeds anything back into gameplay, prediction or the AI,
// and it has no Three.js dependency so its timing can be tested directly.
//
// Channels (boar-local meaning, applied by BoarAvatar as additive bone offsets):
//   pitch  neck/head pitch at the chest joint, radians; + raises the snout
//   yaw    neck/head yaw at the chest joint, radians; + turns the snout to the boar's left
//   roll   neck/forequarter roll at the chest joint, radians
//   pawLeft / pawRight  0..1 front-leg paw/stomp lift
//   kick   0..1 rear-leg kick extension (both hind legs)
//   tail   0..1 tail raise
// Values are deliberately modest: a believable animal, not a boss tell.

export const EXPRESSION_CHANNELS = Object.freeze(['pitch', 'yaw', 'roll', 'pawLeft', 'pawRight', 'kick', 'tail']);

export const BOAR_EXPRESSION = Object.freeze({
  tickRate: 60,
  // Sustained postures, eased in and out (rate per second).
  postureRate: 7,
  // Timed gestures follow server timing; light easing only removes snapshot steps.
  impulseRate: 35,
  posture: Object.freeze({
    assess: Object.freeze({ pitch: 0.06, tail: 0.15 }),
    warning: Object.freeze({ pitch: -0.13, tail: 0.45 }),
    orient: Object.freeze({ pitch: -0.07, tail: 0.3 }),
    bluff: Object.freeze({ pitch: -0.15, tail: 0.6 }),
    charge: Object.freeze({ pitch: -0.2, tail: 0.7 }),
    gore: Object.freeze({ tail: 0.5 }),
    sweep: Object.freeze({ pitch: -0.05, tail: 0.5 }),
    maul: Object.freeze({ tail: 0.5 }),
    kick: Object.freeze({ tail: 0.35 }),
    stagger: Object.freeze({ tail: 0.2 }),
    recover: Object.freeze({ pitch: -0.05, tail: 0.1 }),
    pivot: Object.freeze({ tail: 0.3 }),
    reposition: Object.freeze({ tail: 0.3 }),
    flee: Object.freeze({ pitch: 0.04, tail: 0.8 }),
    breakaway: Object.freeze({ pitch: 0.02, tail: 0.8 }),
  }),
  // Server strike delays used only if a snapshot omits attackTick (older server).
  strikeFallback: Object.freeze({ gore: 0.34, sweep: 0.34, maul: 0.28, kick: 0.22 }),
  warning: Object.freeze({ pawSeconds: 0.55, tossHz: 1.8, toss: 0.03 }),
  gore: Object.freeze({ windup: -0.12, hook: 0.34, turn: 0.05 }),
  sweep: Object.freeze({ windup: 0.12, swing: 0.24 }),
  maul: Object.freeze({ windup: 0.06, stab: 0.26, second: 0.16, secondDelay: 0.18 }),
  kick: Object.freeze({ gather: 0.15, pitch: -0.05 }),
  stagger: Object.freeze({ pitch: 0.24, decay: 4, roll: 0.1, wobbleHz: 2.7 }),
  // Hunting 1.2 acute recoil lasts 0.36 s on the server.
  startle: Object.freeze({ seconds: 0.36, pitch: 0.2, roll: 0.05 }),
  limp: Object.freeze({ threshold: 0.1, pitch: 0.07 }),
  limits: Object.freeze({ pitch: 0.35, yaw: 0.35, roll: 0.2 }),
});

const ATTACKS = new Set(['gore', 'sweep', 'maul', 'kick']);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smoothstep = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
// Fast rise to 1 at `rise` seconds after the strike, then exponential release.
function pulse(s, rise = 0.07, release = 0.12) {
  if (!(s >= 0)) return 0;
  return s < rise ? s / rise : Math.exp(-(s - rise) / release);
}
export function zeroChannels() { return Object.fromEntries(EXPRESSION_CHANNELS.map(name => [name, 0])); }

// Instantaneous targets for one animal. `age(tick)` returns seconds since a
// server tick; `side` is +1/-1 (sweep direction); `pawSide` chooses the pawing leg.
export function expressionTargets(animal, { age, side = 1, pawSide = -1, walkPhase = null, moving = false } = {}) {
  const posture = zeroChannels(), impulse = zeroChannels();
  if (!animal || animal.alive === false) return { posture, impulse };
  const E = BOAR_EXPRESSION, state = animal.state;
  Object.assign(posture, E.posture[state] ?? {});
  const stateAge = age(animal.stateTick);
  if (state === 'warning') {
    // A weight shift onto one front leg: paw lifts and stomps; the head bobs low.
    const lift = Math.sin(Math.PI * Math.max(0, stateAge) / E.warning.pawSeconds) ** 2;
    impulse[pawSide < 0 ? 'pawLeft' : 'pawRight'] = lift;
    impulse.pitch += E.warning.toss * Math.sin(2 * Math.PI * E.warning.tossHz * Math.max(0, stateAge));
  }
  if (ATTACKS.has(state)) {
    const lead = Number.isFinite(animal.attackTick) && Number.isFinite(animal.stateTick) && animal.attackTick >= animal.stateTick
      ? (animal.attackTick - animal.stateTick) / E.tickRate : E.strikeFallback[state];
    const windup = smoothstep(stateAge / Math.max(lead, 1e-3)), s = stateAge - lead;
    const settle = s < 0 ? 1 : Math.exp(-s / 0.05);
    if (state === 'gore') {
      impulse.pitch = E.gore.windup * windup * settle + E.gore.hook * pulse(s);
      impulse.yaw = side * E.gore.turn * pulse(s);
    } else if (state === 'sweep') {
      impulse.yaw = side * (-E.sweep.windup * windup * settle + E.sweep.swing * pulse(s, 0.08, 0.14));
    } else if (state === 'maul') {
      impulse.pitch = E.maul.windup * windup * settle - E.maul.stab * pulse(s, 0.06, 0.1)
        - E.maul.second * pulse(s - E.maul.secondDelay, 0.06, 0.1);
    } else if (state === 'kick') {
      impulse.kick = Math.max(E.kick.gather * windup * settle, pulse(s, 0.06, 0.14));
      impulse.pitch = E.kick.pitch * Math.max(windup * settle, pulse(s, 0.06, 0.14));
    }
  }
  if (state === 'stagger') {
    const t = Math.max(0, stateAge);
    impulse.pitch += E.stagger.pitch * Math.exp(-t * E.stagger.decay);
    impulse.roll += E.stagger.roll * Math.exp(-t * (E.stagger.decay + 1)) * Math.sin(2 * Math.PI * E.stagger.wobbleHz * t);
  }
  const startle = age(animal.startleTick);
  if (startle >= 0 && startle < E.startle.seconds) {
    const phase = startle / E.startle.seconds;
    impulse.pitch += E.startle.pitch * Math.sin(Math.PI * phase);
    impulse.roll += side * E.startle.roll * Math.sin(2 * Math.PI * phase);
  }
  if (moving && walkPhase !== null && (animal.limp ?? 0) > E.limp.threshold) {
    // Head nod with each stride, scaled by the authoritative limp.
    impulse.pitch += animal.limp * E.limp.pitch * Math.sin(4 * Math.PI * walkPhase);
  }
  return { posture, impulse };
}

// Per-boar easing state. One instance per BoarAvatar; nothing is shared.
export class BoarExpression {
  constructor(seed = 0) {
    this.posture = zeroChannels(); this.impulse = zeroChannels(); this.output = zeroChannels();
    this.time = 0; this.observed = new Map();
    this.pawSide = seed % 2 ? 1 : -1; this.side = this.pawSide; this.stateKey = null;
  }
  reset() {
    for (const name of EXPRESSION_CHANNELS) { this.posture[name] = 0; this.impulse[name] = 0; this.output[name] = 0; }
    this.stateKey = null; this.observed.clear();
  }
  // cue.tick: estimated server tick of the displayed snapshot. Without it, ages
  // start when this client first observes each authoritative tick value.
  update(dt, animal, { tick, turn = 0, walkPhase = null, moving = false } = {}) {
    this.time += Math.max(0, dt);
    if (!animal || animal.alive === false) { this.reset(); return this.output; }
    const key = `${animal.state}:${animal.stateTick}`;
    if (key !== this.stateKey) {
      this.stateKey = key;
      // Latch sweep/flinch direction to the way the body is turning at onset.
      if (Math.abs(turn) > 1e-3) this.side = Math.sign(turn);
    }
    const age = value => {
      const local = typeof value === 'string';
      if (!local && !Number.isFinite(value)) return Number.NEGATIVE_INFINITY;
      if (!local && Number.isFinite(tick)) return (tick - value) / BOAR_EXPRESSION.tickRate;
      if (!this.observed.has(value)) {
        if (this.observed.size > 16) this.observed.clear();
        this.observed.set(value, this.time);
      }
      return this.time - this.observed.get(value);
    };
    // A snapshot without stateTick: time the state from when it is first seen here.
    const subject = Number.isFinite(animal.stateTick) ? animal : { ...animal, stateTick: `local:${animal.state}` };
    const { posture, impulse } = expressionTargets(subject, { age, side: this.side, pawSide: this.pawSide, walkPhase, moving });
    const E = BOAR_EXPRESSION, ease = rate => 1 - Math.exp(-rate * Math.max(0, dt));
    const a = ease(E.postureRate), b = ease(E.impulseRate);
    for (const name of EXPRESSION_CHANNELS) {
      this.posture[name] += (posture[name] - this.posture[name]) * a;
      this.impulse[name] += (impulse[name] - this.impulse[name]) * b;
      if (posture[name] === 0 && Math.abs(this.posture[name]) < 1e-4) this.posture[name] = 0;
      if (impulse[name] === 0 && Math.abs(this.impulse[name]) < 1e-4) this.impulse[name] = 0;
      let value = this.posture[name] + this.impulse[name];
      const limit = E.limits[name];
      value = limit ? clamp(value, -limit, limit) : clamp(value, 0, 1);
      this.output[name] = value;
    }
    return this.output;
  }
}
