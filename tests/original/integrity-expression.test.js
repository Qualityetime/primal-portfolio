import test from 'node:test';
import assert from 'node:assert/strict';
import { BoarExpression, BOAR_EXPRESSION, EXPRESSION_CHANNELS, expressionTargets } from '../../src/game/boarExpression.js';
import { GameState } from '../../simulation/gameState.js';
import { HuntState } from '../../simulation/huntState.js';
import { createWorld } from '../../shared/world.js';
import { runAIScenario } from './helpers/aiScenario.js';

// Integrity + expression hotfix: rigged Professor Boar body language. These
// checks exercise the dependency-free presentation logic directly; the rig
// application itself is covered in boar-avatar.test.js.
const TICK = 60;
const live = (state, extra = {}) => ({ alive: true, state, stateTick: 1000, ...extra });
// Drive one expression with server ticks, as HuntView does, and record channels.
function run(expression, animal, fromTick, toTick, step = 1, extra = {}) {
  const out = [];
  for (let tick = fromTick; tick <= toTick; tick += step) out.push({ tick, ...expression.update(step / TICK, animal, { tick, ...extra }) });
  return out;
}
const peak = (rows, channel, sign = 1) => rows.reduce((best, row) => sign * row[channel] > sign * best[channel] ? row : best, rows[0]);
const zero = output => EXPRESSION_CHANNELS.every(name => output[name] === 0);

test('integrity expression (7): trauma/startle gives a visible head/forequarter recoil within the 0.36 s server recoil', () => {
  const e = new BoarExpression(1);
  run(e, live('patrol', { startleTick: -10000 }), 900, 1000);
  assert.ok(zero(e.output), 'calm patrol has no offset');
  const rows = run(e, live('patrol', { startleTick: 1000 }), 1000, 1060);
  const top = peak(rows, 'pitch');
  assert.ok(top.pitch > 0.12, `snout recoils upward: ${top.pitch}`);
  assert.ok(top.tick > 1000 && top.tick <= 1000 + 0.36 * TICK, `peak inside the recoil window at ${top.tick}`);
  run(e, live('patrol', { startleTick: 1000 }), 1061, 1200);
  assert.ok(zero(e.output), 'recoil fully returns once the window passes');
});

test('integrity expression (8): warning lowers the head, raises the tail and paws one front leg', () => {
  const left = new BoarExpression(0), right = new BoarExpression(1);
  const a = run(left, live('warning'), 1000, 1060), b = run(right, live('warning'), 1000, 1060);
  assert.ok(left.output.pitch < -0.08 && left.output.tail > 0.3);
  assert.ok(peak(a, 'pawLeft').pawLeft > 0.6 && a.every(r => r.pawRight === 0), 'one foreleg paws');
  assert.ok(peak(b, 'pawRight').pawRight > 0.6 && b.every(r => r.pawLeft === 0), 'another boar may favour the other foreleg');
  // Even the 0.16 s minimum warning shows a partial lift.
  const short = run(new BoarExpression(0), live('warning'), 1000, 1000 + 0.16 * TICK);
  assert.ok(peak(short, 'pawLeft').pawLeft > 0.3);
  // Restrained: never a large exaggerated pose.
  assert.ok(a.every(r => Math.abs(r.pitch) <= 0.2));
});

test('integrity expression (9): assess holds an alert raised head without attack cues', () => {
  const e = new BoarExpression(0);
  const rows = run(e, live('assess'), 1000, 1060);
  assert.ok(e.output.pitch > 0.04 && e.output.pitch < 0.1, `alert head ${e.output.pitch}`);
  assert.ok(rows.every(r => r.pawLeft === 0 && r.pawRight === 0 && r.kick === 0 && r.yaw === 0));
});

test('integrity expression (10): gore, maul and sweep gestures peak at the server strike tick', () => {
  for (const [state, lead] of [['gore', 0.34], ['gore', 0.17], ['maul', 0.28], ['sweep', 0.34], ['sweep', 0.17]]) {
    const attackTick = 1000 + Math.round(lead * TICK);
    const e = new BoarExpression(0);
    const rows = run(e, live(state, { attackTick }), 1000, 1000 + 0.63 * TICK, 1, { turn: 0.2 });
    const before = rows.filter(r => r.tick < attackTick), after = rows.filter(r => r.tick >= attackTick);
    if (state === 'gore') {
      assert.ok(Math.min(...before.map(r => r.pitch)) < -0.05, 'head lowers into the gore');
      const hook = peak(after, 'pitch');
      assert.ok(hook.pitch > 0.12 && hook.tick - attackTick <= 0.15 * TICK, `${state}/${lead}: upward hook at +${(hook.tick - attackTick) / TICK}s`);
    } else if (state === 'maul') {
      assert.ok(Math.max(...before.map(r => r.pitch)) > 0.02, 'head lifts before the stab');
      const stab = peak(after, 'pitch', -1);
      assert.ok(stab.pitch < -0.15 && stab.tick - attackTick <= 0.12 * TICK, `maul stab at +${(stab.tick - attackTick) / TICK}s`);
    } else {
      assert.ok(Math.min(...before.map(r => r.yaw)) < -0.04, 'sweep winds away from the turn');
      const swing = peak(after, 'yaw');
      assert.ok(swing.yaw > 0.12 && swing.tick - attackTick <= 0.16 * TICK, `sweep swings with the turn at +${(swing.tick - attackTick) / TICK}s`);
    }
  }
  // Without attackTick (older snapshot) the original server delays are used.
  const legacy = run(new BoarExpression(0), live('gore'), 1000, 1040);
  assert.ok(peak(legacy, 'pitch').tick >= 1000 + 0.34 * TICK);
});

test('integrity expression (11): kick extends the hind legs at the server kick strike', () => {
  for (const lead of [0.22, 0.17]) {
    const attackTick = 1000 + Math.round(lead * TICK), e = new BoarExpression(0);
    const rows = run(e, live('kick', { attackTick }), 1000, 1000 + 0.48 * TICK);
    const strike = peak(rows, 'kick');
    assert.ok(strike.kick > 0.7 && strike.tick >= attackTick && strike.tick - attackTick <= 0.1 * TICK, `kick at +${(strike.tick - attackTick) / TICK}s`);
    assert.ok(rows.filter(r => r.tick < attackTick).every(r => r.kick <= 0.2), 'only a small gather before the strike');
  }
});

test('integrity expression (12): stagger shows a brief recoil with a decaying wobble', () => {
  const e = new BoarExpression(0);
  const rows = run(e, live('stagger'), 1000, 1000 + 0.6 * TICK);
  assert.ok(peak(rows, 'pitch').pitch > 0.15);
  assert.ok(rows.some(r => r.roll > 0.01) && rows.some(r => r.roll < -0.005), 'imbalance wobbles both ways');
  assert.ok(Math.abs(rows.at(-1).roll) < 0.02);
});

test('integrity expression (13, 14): offsets return cleanly to zero and repeated cycles never accumulate', () => {
  const e = new BoarExpression(0), cycles = [];
  let tick = 1000;
  for (let cycle = 0; cycle < 5; cycle++) {
    const rows = [];
    for (const [state, seconds] of [['warning', 0.5], ['orient', 0.3], ['charge', 0.8], ['gore', 0.63], ['recover', 0.4], ['patrol', 2]]) {
      const animal = live(state, { stateTick: tick, attackTick: tick + 20, startleTick: cycle === 2 ? tick : -10000 });
      rows.push(...run(e, animal, tick, tick + seconds * TICK - 1));
      tick += seconds * TICK;
    }
    assert.ok(zero(e.output), `cycle ${cycle} settles exactly at neutral`);
    cycles.push(rows.map(({ tick: t, ...channels }) => channels));
  }
  assert.deepEqual(cycles[4], cycles[0], 'identical input cycles give identical body language');
  for (const name of EXPRESSION_CHANNELS) {
    const values = cycles.flat().map(row => row[name]);
    assert.ok(Math.max(...values.map(Math.abs)) <= (BOAR_EXPRESSION.limits[name] ?? 1) + 1e-12, `${name} stays bounded`);
  }
  e.update(0.016, { alive: false, state: 'dead' }, { tick });
  assert.ok(zero(e.output), 'death clears every offset immediately');
});

test('integrity expression (15): two boars express different states at the same time without sharing', () => {
  const a = new BoarExpression(3), b = new BoarExpression(4);
  for (let tick = 1000; tick < 1040; tick++) {
    a.update(1 / TICK, live('warning'), { tick }); b.update(1 / TICK, live('charge'), { tick });
  }
  assert.notEqual(a.output, b.output);
  assert.ok(a.output.pawLeft + a.output.pawRight > 0 && b.output.pawLeft + b.output.pawRight === 0);
  assert.ok(b.output.pitch < a.output.pitch && b.output.tail > a.output.tail);
  const snapshot = { ...b.output };
  for (let tick = 1040; tick < 1100; tick++) a.update(1 / TICK, live('kick', { attackTick: 1052, stateTick: 1040 }), { tick });
  b.update(0, live('charge'), { tick: 1040 });
  assert.deepEqual({ ...b.output }, snapshot, 'B is unaffected by A');
});

test('integrity expression: limp nods with the stride only while walking; targets are pure', () => {
  const age = () => 0;
  const still = expressionTargets(live('patrol', { limp: 0.6 }), { age, walkPhase: 0.125, moving: false });
  const walking = expressionTargets(live('patrol', { limp: 0.6 }), { age, walkPhase: 0.125, moving: true });
  const healthy = expressionTargets(live('patrol', { limp: 0 }), { age, walkPhase: 0.125, moving: true });
  assert.equal(still.impulse.pitch, 0); assert.equal(healthy.impulse.pitch, 0);
  assert.ok(Math.abs(walking.impulse.pitch - 0.6 * BOAR_EXPRESSION.limp.pitch) < 1e-12);
  const animal = Object.freeze(live('warning', { wounds: Object.freeze([]) }));
  assert.doesNotThrow(() => new BoarExpression(0).update(0.1, animal, { tick: 1010 }), 'snapshot data is only read');
});

test('integrity expression: snapshots publish the existing server strike tick for each boar', () => {
  const game = new GameState();
  ['a', 'b', 'c', 'd'].forEach(id => game.addPlayer(id, { room: 'BONES', name: id }));
  const { hunt } = game.rooms.get('BONES');
  const [a, b] = hunt.animals;
  Object.assign(a, { state: 'gore', stateTick: 50, attackAt: 60 }); Object.assign(b, { state: 'kick', stateTick: 51, attackAt: 64 });
  const animals = game.snapshot('BONES').hunt.animals;
  assert.deepEqual(animals.map(x => [x.id, x.state, x.stateTick, x.attackTick]), [[a.id, 'gore', 50, 60], [b.id, 'kick', 51, 64]]);
  const fresh = new HuntState(createWorld(), { seed: 7 }).snapshot().animals;
  assert.ok(fresh.every(x => x.attackTick === null), 'no attack yet');
  assert.doesNotThrow(() => JSON.stringify(game.snapshot('BONES')));
});

test('integrity expression: Professor Boar decisions are unchanged for seeded four-hunter encounters', () => {
  // Digests recorded from the unmodified 0.3.4 / Hunting 1.2.2 source with this
  // exact scenario (1500 ticks each); see CLAUDE_IMPLEMENTATION_REPORT.md.
  const expected = {
    7: '025661208313939df976719af5ff565f50c5ff7d4e76c35d0ae41b7fdd8e027d',
    11: 'e416b0b0bfe124939c367b7a23cfc60e7eae8ee2364cd4d371d5dd08d168e9f8',
    2026: '43df89af3c6b0332dcebd76127f7be45f6531081514dd7bd26278069d0dd11d3',
  };
  const seen = new Set();
  for (const [seed, digest] of Object.entries(expected)) {
    const run = runAIScenario(Number(seed));
    assert.equal(run.digest, digest, `seed ${seed}: brain trace drifted`);
    run.states.forEach(state => seen.add(state));
  }
  for (const state of ['assess', 'warning', 'orient', 'bluff', 'charge', 'gore', 'sweep', 'maul', 'kick', 'recover', 'pivot', 'flee', 'breakaway', 'reposition']) {
    assert.ok(seen.has(state), `scenario exercised ${state}`);
  }
});
