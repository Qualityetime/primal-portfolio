import { isolateBoar } from './helpers/hunt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HuntState } from '../../simulation/huntState.js';
import { changeState } from '../../simulation/boarBrain.js';
import { BOAR_AI } from '../../simulation/boarTuning.js';
import { preferredSeparation } from '../../simulation/boarContext.js';
import { hitAnatomy } from '../../simulation/anatomy.js';
import { toWorld } from '../../shared/body.js';
import { createPlayerState } from '../../shared/movement.js';
import { HUNT } from '../../shared/hunt.js';

const world = { halfSize: 36, obstacles: [], spawns: [{ x: 2.3, y: 0, z: -14.29, yaw: Math.PI / 2 }] };
function fixture(traits = {}) {
  const hunt = new HuntState(world, { seed: 7 });
  isolateBoar(hunt);
  const a = hunt.animals[0];
  Object.assign(a, { x: 0, z: -14, yaw: 0, decisionSeed: 1 });
  Object.assign(a.traits, { courage: 0.55, caution: 0.5, persistence: 0.6, ...traits });
  const p = { id: 'a', slot: 0, state: createPlayerState(world.spawns[0]), queue: [], ack: 0, lastReceivedSequence: 0 };
  hunt.addPlayer(p);
  return { hunt, a, p, players: new Map([[p.id, p]]) };
}
function second(f, x, z) {
  const p = { id: 'b', slot: 0, state: createPlayerState({ x, z, y: 0, yaw: 0 }), queue: [], ack: 0, lastReceivedSequence: 0 };
  f.hunt.addPlayer(p); f.players.set(p.id, p); return p;
}
function chest(f, glancing = false) {
  return hitAnatomy(f.a, toWorld(f.a, { x: 2, y: glancing ? 1.482 : 0.92, z: -0.29 }),
    toWorld(f.a, { x: -2, y: glancing ? 1.482 : 0.92, z: -0.29 }));
}
function rear(f) {
  return hitAnatomy(f.a, toWorld(f.a, { x: 0, y: 0.88, z: 3 }), toWorld(f.a, { x: 0, y: 0.88, z: -3 }));
}

test('A1: open approach changes behavior at 20 metres for every temperament, without automatic attack', () => {
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.9, caution: 0.2 }, { courage: 0.6, caution: 0.6 }]) {
    const f = fixture(traits); Object.assign(f.p.state, { x: 4, z: -34, yaw: Math.PI });
    f.p.velocityZ = 4.2;
    f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players);
    assert.ok(f.a.awareHunters[0].distance > 18);
    assert.equal(f.a.awareHunters[0].stage, 'suspicious');
    assert.equal(f.a.state, 'assess'); assert.ok(Math.abs(f.a.yaw) > 0);
    assert.ok(f.a.pressure < BOAR_AI.mediumPressure);
  }
});

test('awareness is graded and bounded: disturbance at 27m, cover blocks it, quiet unseen rear stays unknown', () => {
  const f = fixture(); f.a.z = -6; Object.assign(f.p.state, { x: 0, z: -33, yaw: Math.PI }); f.p.velocityZ = 4.2;
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.awareHunters[0].stage, 'disturbance');
  const blocked = fixture(); Object.assign(blocked.p.state, { x: 0, z: -34 });
  blocked.hunt.world = { ...world, obstacles: [{ x: 0, z: -24, radius: 0.8 }] };
  blocked.hunt.stepAnimal(blocked.hunt.animals[0], 1, blocked.players); assert.equal(blocked.a.awareHunters.length, 0); assert.equal(blocked.a.targetId, null);
  const behind = fixture(); Object.assign(behind.a, { z: -24 }); Object.assign(behind.p.state, { x: 0, z: -6 });
  behind.hunt.stepAnimal(behind.hunt.animals[0], 1, behind.players); assert.equal(behind.a.awareHunters.length, 0);
  const far = fixture(); far.a.z = -6; Object.assign(far.p.state, { x: 0, z: -36 }); far.p.velocityZ = 7;
  far.hunt.stepAnimal(far.hunt.animals[0], 1, far.players); assert.equal(far.a.awareHunters.length, 0);
});

test('B1: pressure shortens a pending assessment by over 4x and produces a survival action within 0.25s', () => {
  const calm = fixture(), close = fixture({ courage: 0.9, caution: 0.2 }), fearful = fixture({ courage: 0.2, caution: 0.9 });
  for (const f of [calm, close, fearful]) changeState(f.a, 'assess', 0, 3);
  Object.assign(calm.p.state, { x: 0, z: -32 });
  for (const f of [close, fearful]) { Object.assign(f.p.state, { x: 0, z: -16.2 }); f.p.velocityZ = 3; }
  for (const f of [calm, close, fearful]) f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players);
  assert.ok(close.a.pressure >= BOAR_AI.highPressure);
  assert.ok(close.a.decisionSeconds < calm.a.decisionSeconds / 4);
  assert.ok(close.a.until < calm.a.until / 4);
  for (let tick = 2; tick <= 15; tick++) {
    for (const f of [close, fearful]) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  }
  assert.notEqual(close.a.state, 'assess'); assert.equal(fearful.a.state, 'flee');
  assert.ok(Math.hypot(fearful.a.x, fearful.a.z + 14) > 0.1);
});

test('B1: two-sided non-attacking pressure has an urgent tempo and retains a committed escape goal', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 });
  Object.assign(f.p.state, { x: 4, z: -14 }); const q = second(f, -4, -14);
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players);
  assert.ok(f.a.pressure >= BOAR_AI.surroundPressure); assert.equal(f.a.state, 'flee');
  const goal = { ...f.a.tacticGoal }, target = f.a.targetId;
  for (let tick = 2; tick <= 36; tick++) {
    f.p.state.z = -14 + Math.sin(tick) * 0.2; q.state.z = -14 - Math.sin(tick) * 0.2;
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
    assert.equal(f.a.state, 'flee'); assert.deepEqual(f.a.tacticGoal, goal); assert.equal(f.a.targetId, target);
  }
  assert.ok(Math.hypot(f.a.x, f.a.z + 14) > 1.5);
  assert.equal(f.a.intentTrace.length, 1, 'faster reasoning does not repeatedly restart a chosen move');
});

test('a hunter cutting off a committed route is a material interrupt, unlike harmless jiggling', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 }); Object.assign(f.p.state, { x: 5, z: -14 });
  changeState(f.a, 'flee', 0, 3); f.a.tacticGoal = { x: 0, z: -24 };
  for (let tick = 1; tick <= 9; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  const old = { ...f.a.tacticGoal };
  Object.assign(f.p.state, { x: f.a.x, z: f.a.z - 2 });
  for (let tick = 10; tick <= 12; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(['gore', 'sweep', 'kick', 'breakaway'].includes(f.a.state) || JSON.stringify(f.a.tacticGoal) !== JSON.stringify(old));
  assert.ok(f.a.intentTrace.length >= 2);
});

test('C1: serious thrust penetration interrupts all low-priority intents and moves on the next simulation tick', () => {
  for (const state of ['patrol', 'assess', 'warning', 'reposition', 'bluff']) {
    const f = fixture({ courage: 0.2, caution: 0.9 }); Object.assign(f.p.state, { x: 5, z: -14.3 });
    changeState(f.a, state, 0, 3); f.a.tacticGoal = { x: 0, z: -22 };
    const wound = f.hunt.impact(f.hunt.animals[0], chest(f), 9, 'thrust', f.p.id, 1);
    assert.ok(wound.trauma >= BOAR_AI.traumaMinimum && wound.depth >= BOAR_AI.traumaDepth);
    assert.equal(f.a.acuteReaction.kind, 'thrust');
    f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players);
    assert.notEqual(f.a.state, state); assert.ok(f.a.acute);
    assert.ok(Math.hypot(f.a.vx, f.a.vz) > 1);
    assert.ok(f.a.huntAwareness > 0.2);
  }
});

test('C1: a real thrust invokes the trauma path and stationary follow-up spam cannot farm free serious hits', () => {
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.55, caution: 0.5 }, { courage: 0.9, caution: 0.2 }]) {
    const f = fixture(traits); f.p.state.pitch = -0.23; changeState(f.a, 'assess', 0, 3);
    f.hunt.action(f.p, { attack: true }, 1, f.players);
    // Find a real tip/body intersection without letting fixture setup rotate the
    // hit away; all following behavior and attempts use the full hunt step.
    let impactTick = 1;
    while (!f.a.wounds.length && impactTick < 24) f.hunt.stepThrusts(impactTick++, f.players);
    assert.equal(f.a.wounds.length, 1); assert.ok(f.a.acuteReaction);
    const initial = { x: f.a.x, z: f.a.z };
    for (let tick = impactTick; tick <= 80; tick++) {
      f.hunt.action(f.p, { attack: true }, tick, f.players); f.hunt.step(tick, f.players);
    }
    assert.ok(Math.hypot(f.a.x - initial.x, f.a.z - initial.z) > 1);
    assert.ok(f.a.wounds.length === 1 || f.p.health < 100 || f.p.state.knockTicks > 0,
      'another hit requires dealing with repositioning or retaliation, not continued passive assessment');
    assert.ok(f.a.intentTrace.some(entry => ['flee', 'sweep', 'gore', 'breakaway', 'orient'].includes(entry.state)));
  }
});

test('C2: unseen rear penetration reacts to pain immediately without knowing or tracking the thrower', () => {
  const f = fixture({ courage: 0.9, caution: 0.2 }); f.a.z = -24;
  Object.assign(f.p.state, { x: 0, z: -6 }); changeState(f.a, 'assess', 0, 3);
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.targetId, null);
  const wound = f.hunt.impact(f.hunt.animals[0], rear(f), 30, 'throw', f.p.id, 2, { id: 999, vx: 0, vy: 0, vz: -30, origin: { x: 0, z: -6 } });
  assert.ok(wound.embedded); assert.equal(f.a.acuteReaction.identifiedId, null);
  assert.equal(f.a.threats.get(f.p.id).seen, -10000, 'a weapon owner is not a sensory observation');
  f.hunt.stepAnimal(f.hunt.animals[0], 3, f.players);
  assert.ok(f.a.acute); assert.equal(f.a.acute.identifiedId, null); assert.equal(f.a.targetId, null);
  assert.ok(Math.hypot(f.a.vx, f.a.vz) > 1); assert.ok(f.a.vz < 0, 'pain launches separation away from the struck rear');
  assert.ok(f.a.huntAwareness > 0.2);
});

test('C: a graze or a shallow quick throw does not get the maximum trauma interrupt', () => {
  for (const [speed, tangent] of [[30, true], [12, false]]) {
    const f = fixture(); changeState(f.a, 'assess', 0, 3);
    const wound = f.hunt.impact(f.hunt.animals[0], chest(f, tangent), speed, 'throw', f.p.id, 1);
    assert.ok(wound.glancing || wound.trauma < BOAR_AI.traumaMinimum);
    assert.equal(f.a.acuteReaction, null); assert.equal(f.a.huntAlarm, 0);
  }
});

test('C: acute effort respects leg, lung and blood impairment and spends remaining breath', () => {
  const healthy = fixture(), wounded = fixture();
  const travel = [];
  for (const f of [healthy, wounded]) {
    f.a.z = -24; Object.assign(f.p.state, { x: 0, z: -6 });
    if (f === wounded) Object.assign(f.a, { limp: 0.9, lung: 0.7, blood: 0.4, breath: 0.12 });
    f.hunt.impact(f.hunt.animals[0], rear(f), 30, 'throw', f.p.id, 1);
    for (let tick = 2; tick <= 22; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
    travel.push(Math.hypot(f.a.x, f.a.z + 24));
  }
  assert.ok(travel[1] > 0.1 && travel[1] < travel[0] * 0.6);
  assert.equal(wounded.a.limp, 0.9); assert.equal(wounded.a.lung, 0.7); assert.equal(wounded.a.blood, 0.4);
  assert.ok(wounded.a.breath < 0.12);
  wounded.hunt.stepAnimal(wounded.hunt.animals[0], 90, wounded.players); assert.equal(wounded.a.acute, null);
});

test('D1: pursuing and reappearing hunters retain context and cause earlier avoidance than a fresh encounter', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 }); changeState(f.a, 'flee', 0, 3); f.a.tacticGoal = { x: -15, z: -20 };
  for (let tick = 1; tick <= 120; tick++) {
    Object.assign(f.p.state, { x: f.a.x + 7, z: f.a.z }); f.p.velocityX = -4;
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  }
  const awareness = f.a.huntAwareness, separation = preferredSeparation(f.a);
  assert.ok(awareness > 0.15); assert.ok(f.a.huntMemory.get(f.p.id).pursuitSeconds > 0.5);
  Object.assign(f.p.state, { x: 35, z: 35 }); f.p.velocityX = 0;
  for (let tick = 121; tick <= 480; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(f.a.huntAwareness > awareness * 0.7);
  const fresh = fixture({ courage: 0.2, caution: 0.9 }); Object.assign(fresh.a, { x: f.a.x, z: f.a.z, yaw: f.a.yaw });
  for (const candidate of [f, fresh]) {
    changeState(candidate.a, 'assess', 480, 0);
    Object.assign(candidate.p.state, { x: candidate.a.x + 9.5, z: candidate.a.z }); candidate.p.velocityX = -2;
    for (let tick = 481; tick <= 505; tick++) candidate.hunt.stepAnimal(candidate.hunt.animals[0], tick, candidate.players);
  }
  assert.equal(f.a.huntMemory.get(f.p.id).reapproaches, 1);
  assert.ok(preferredSeparation(f.a) >= separation);
  assert.equal(f.a.state, 'flee'); assert.equal(fresh.a.state, 'assess');
});

test('D: longer hunt memory decays to calm and never supplies invisible permanent aggro', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 35, z: 35 });
  f.a.huntMemory.set(f.p.id, { awareness: 0.8, lastSeen: 0, reapproaches: 1, pursuitSeconds: 3, cutoffs: 0, wounds: 0 });
  f.a.huntAlarm = 0.4; f.a.lastTraumaTick = 0;
  for (let tick = 1; tick <= 600; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(f.a.huntAwareness > 0.6); assert.equal(f.a.targetId, null); assert.equal(f.a.state, 'patrol');
  for (let tick = 601; tick <= 18000; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.equal(f.a.huntMemory.size, 0); assert.equal(f.a.huntAlarm, 0); assert.equal(f.a.huntAwareness, 0);
  assert.equal(f.a.targetId, null); assert.equal(f.a.state, 'patrol');
});

test('E1: suspicious non-contact presence naturally activates focused facing and separation movement', () => {
  const f = fixture({ courage: 0.65, caution: 0.6 }); Object.assign(f.p.state, { x: 5.5, z: -20 });
  f.p.state.yaw = Math.atan2(f.p.state.x - f.a.x, f.p.state.z - f.a.z);
  const states = new Set();
  for (let tick = 1; tick <= 60; tick++) { f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players); states.add(f.a.state); }
  assert.deepEqual([...states], ['assess']); assert.equal(f.p.health, HUNT.playerHealth);
  assert.ok(Math.hypot(f.a.x, f.a.z + 14) > 0.2); assert.ok(f.a.yaw < -0.4);
  assert.ok(f.a.awareHunters[0].suspicion > 0.2);
});

test('F: the same penetrating trauma yields flight or a breakaway then retaliation with identical perception capability', () => {
  const outcomes = [];
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.9, caution: 0.2 }]) {
    const f = fixture(traits); Object.assign(f.p.state, { x: 5, z: -14.3 });
    f.hunt.impact(f.hunt.animals[0], chest(f), 30, 'throw', f.p.id, 1); f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players);
    assert.equal(f.a.awareHunters.length, 1); assert.ok(Math.hypot(f.a.vx, f.a.vz) > 1);
    outcomes.push(f.a.state);
  }
  assert.deepEqual(outcomes, ['flee', 'breakaway']);
});

test('G: diagnostics explain the AI while ordinary snapshots contain no hidden tactical HUD data', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 5, z: -14.3 });
  f.hunt.impact(f.hunt.animals[0], chest(f), 30, 'throw', f.p.id, 1); f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players);
  const debug = f.hunt.debugSnapshot(2).animals[0], publicState = f.hunt.snapshot().animals[0];
  assert.ok(debug.perceived.length); assert.ok(debug.pressure > 0); assert.ok(debug.intent.commitmentSeconds > 0);
  assert.ok(debug.acute.active); assert.ok(debug.hunt.awareness > 0); assert.ok(debug.escape.direction);
  assert.equal(debug.intent.target, f.a.targetId); assert.ok(debug.trace.length);
  assert.doesNotThrow(() => JSON.stringify(debug));
  for (const field of ['traits', 'temperament', 'threats', 'pressure', 'intent', 'acute', 'huntMemory', 'huntAwareness', 'escape', 'targetId']) {
    assert.equal(publicState[field], undefined);
  }
  for (let tick = 3; tick < 200; tick++) changeState(f.a, 'assess', tick, 0.1);
  assert.equal(f.a.intentTrace.length, BOAR_AI.traceLimit);
});
