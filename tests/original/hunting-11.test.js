import { isolateBoar } from './helpers/hunt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUNT, throwProfile } from '../../shared/hunt.js';
import { bodyContact, toWorld } from '../../shared/body.js';
import { createPlayerState, neutralInput, stepPlayer } from '../../shared/movement.js';
import { sanitizeBatch } from '../../shared/protocol.js';
import { HuntState } from '../../simulation/huntState.js';
import { changeState } from '../../simulation/boarBrain.js';
import { hitAnatomy, injuryFor } from '../../simulation/anatomy.js';

const world = { halfSize: 36, obstacles: [], spawns: [{ x: 2.4, y: 0, z: -6.3, yaw: Math.PI / 2 }] };
function fixture() {
  const hunt = new HuntState(world, { seed: 7 });
  isolateBoar(hunt);
  Object.assign(hunt.animals[0], { x: 0, z: -6, yaw: 0, decisionSeed: 1 });
  hunt.previousAnimals.set(hunt.animals[0].id, { ...hunt.animals[0] });
  const p = { id: 'a', slot: 0, state: createPlayerState(world.spawns[0]), queue: [], ack: 0, lastReceivedSequence: 0 };
  hunt.addPlayer(p);
  return { hunt, a: hunt.animals[0], p, players: new Map([['a', p]]) };
}
function hunter(f, id, x, z) {
  const p = { id, slot: 0, state: createPlayerState({ x, y: 0, z, yaw: 0 }), queue: [], ack: 0, lastReceivedSequence: 0 };
  f.hunt.addPlayer(p); f.players.set(id, p); return p;
}
function charge(f, duration, start = 1) {
  const { hunt, p, players } = f;
  for (let i = 0; i <= duration; i++) hunt.action(p, { throwHeld: true, throwStart: i === 0 }, start + i, players);
  assert.equal(hunt.projectiles.length, 0, 'holding must not throw or consume a spear');
  assert.equal(p.spears, 3);
  hunt.action(p, { throw: true }, start + duration, players);
  return hunt.projectiles[0];
}
function launchSpeed(spear) { return Math.hypot(spear.vx, spear.vy - 1, spear.vz); }
function chest(f) {
  return hitAnatomy(f.a, toWorld(f.a, { x: 2, y: .92, z: -.29 }), toWorld(f.a, { x: -2, y: .92, z: -.29 }));
}

test('server-timed release ramps physical throw velocity and penetration, then caps both', () => {
  const quick = fixture(), full = fixture(), over = fixture();
  const weak = charge(quick, 0), strong = charge(full, 54), capped = charge(over, 180);
  assert.ok(Math.abs(launchSpeed(weak) - 12) < 1e-8);
  assert.ok(Math.abs(launchSpeed(strong) - 30) < 1e-8);
  assert.ok(Math.abs(launchSpeed(capped) - launchSpeed(strong)) < 1e-8);
  const shallow = injuryFor(chest(quick), launchSpeed(weak)), deep = injuryFor(chest(full), launchSpeed(strong));
  assert.ok(deep.depth > shallow.depth * 5 && deep.trauma > shallow.trauma * 5);
  assert.equal(shallow.embedded, false); assert.equal(deep.embedded, true);
  assert.deepEqual(throwProfile(3), throwProfile(.9));
  assert.equal(full.p.windup, null); assert.equal(full.p.spears, 2);
});

test('release alone and client power/duration claims cannot manufacture a charged throw', () => {
  const f = fixture();
  const raw = { ...neutralInput(), seq: 1, throw: true, power: 999, windupTime: 999, damage: 999 };
  const [input] = sanitizeBatch([raw], 0);
  for (const key of ['power', 'windupTime', 'damage']) assert.equal(input[key], undefined);
  f.hunt.action(f.p, input, 100, f.players);
  assert.equal(f.hunt.projectiles.length, 0); assert.equal(f.p.spears, 3);
  for (const extra of [{ throwStart: 1 }, { throwHeld: 'yes' }]) assert.equal(sanitizeBatch([{ ...raw, ...extra }], 0), null);
});

test('neutral input, a hit, and stale held input cancel wind-up without spending a spear', () => {
  for (const cancel of ['neutral', 'hurt', 'timeout']) {
    const f = fixture();
    f.hunt.action(f.p, { throwStart: true, throwHeld: true }, 1, f.players);
    if (cancel === 'neutral') f.hunt.action(f.p, neutralInput(), 2, f.players);
    if (cancel === 'hurt') f.hunt.hurt(f.hunt.animals[0], f.p, 10, 2, 'gore', true);
    if (cancel === 'timeout') f.hunt.stepPlayers(22, f.players);
    f.hunt.action(f.p, { throw: true }, 23, f.players);
    assert.equal(f.p.windup, null); assert.equal(f.p.spears, 3); assert.equal(f.hunt.projectiles.length, 0);
  }
});

test('wind-up preserves walking and aiming, and excludes simultaneous bracing', () => {
  const state = createPlayerState({ x: 5, y: 0, z: -15, yaw: 0 }); state.spears = 3;
  for (let i = 0; i < 36; i++) stepPlayer(state, { ...neutralInput(.4, -.2), forward: 1, throwHeld: true, throwStart: i === 0, brace: true }, world);
  assert.ok(Math.abs(Math.hypot(state.x - 5, state.z + 15) - 4.2 * .6) < 1e-8);
  assert.equal(state.yaw, .4); assert.equal(state.pitch, -.2); assert.equal(state.bracing, false);
  assert.ok(state.windupTime > .59);
});

test('ground pickup completes during movement and is claimed by only one hunter', () => {
  const f = fixture(), q = hunter(f, 'b', 2.5, -6.3);
  f.hunt.setSpears(f.p, 1); f.hunt.setSpears(q, 1); f.p.velocityX = 4.2;
  f.hunt.spears.push({ id: 999, status: 'ground', x: 2.6, y: .1, z: -6.3 });
  stepPlayer(f.p.state, { ...neutralInput(), strafe: 1 }, world, 1 / 60, f.a);
  f.hunt.action(f.p, { interact: true }, 1, f.players); f.hunt.action(q, { interact: true }, 1, f.players);
  assert.equal(f.p.spears, 2); assert.equal(q.spears, 1); assert.equal(f.p.recovery, null);
  assert.equal(f.hunt.spears.length, 0);
});

test('embedded extraction varies with depth and stays within a short committed pull', () => {
  const durations = [];
  for (const depth of [.26, 1.3]) {
    const f = fixture(); f.hunt.setSpears(f.p, 1);
    f.hunt.spears.push({ id: 999, status: 'embedded', animalId: f.a.id, depth, local: { x: .64, y: .9, z: -.3 } });
    f.hunt.action(f.p, { interact: true }, 1, f.players);
    const end = f.p.recovery.until; durations.push((end - 1) / 60);
    f.hunt.stepPlayers(end - 1, f.players); assert.equal(f.p.spears, 1);
    f.hunt.stepPlayers(end, f.players); assert.equal(f.p.spears, 2);
  }
  assert.ok(durations[0] < .21); assert.ok(durations[1] <= .45 && durations[1] > durations[0]);
});

test('pulling from a living rear flank can provoke a kick and interrupt extraction', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 0, z: -4 }); f.hunt.setSpears(f.p, 1);
  f.hunt.spears.push({ id: 999, status: 'embedded', animalId: f.a.id, depth: 1.2, local: { x: 0, y: .9, z: .9 } });
  f.hunt.action(f.p, { interact: true }, 1, f.players);
  for (let tick = 2; tick < 16; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(f.p.health < 100); assert.equal(f.p.recovery, null);
  assert.equal(f.hunt.spears.length, 1); assert.ok(f.hunt.events.some(e => e.kind === 'kick'));
});

test('a quiet hunter behind the animal is remembered without instant body rotation or seeing through trees', () => {
  const f = fixture(); f.a.z = -12; Object.assign(f.p.state, { x: 0, z: -6 });
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players);
  assert.equal(f.a.targetId, f.p.id); assert.equal(f.a.targetPosition.z, -6);
  assert.ok(Math.abs(f.a.yaw) < .1);
  Object.assign(f.p.state, { x: 2, z: -7 }); f.hunt.stepAnimal(f.hunt.animals[0], 3, f.players);
  assert.equal(f.a.targetPosition.x, 2); assert.ok(Math.abs(f.a.yaw) < .2);
  const hidden = fixture(); hidden.a.z = -12; Object.assign(hidden.p.state, { x: 0, z: -6 });
  hidden.hunt.world = { ...world, obstacles: [{ x: 0, z: -9, radius: .8 }] };
  hidden.hunt.stepAnimal(hidden.hunt.animals[0], 1, hidden.players); assert.equal(hidden.a.targetId, null);
});

test('assessment remains a deliberate facing action throughout its timer', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 4, z: -12 });
  changeState(f.a, 'assess', 0, .8);
  for (let tick = 1; tick < 48; tick++) {
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players); assert.equal(f.a.state, 'assess');
  }
  assert.ok(Math.abs(f.a.yaw) > .3);
});

test('a surrounded cautious boar commits to a fixed escape gap despite hunter jiggling', () => {
  const f = fixture(); Object.assign(f.a.traits, { courage: .2, caution: .9 });
  Object.assign(f.p.state, { x: 4, z: -6 }); const q = hunter(f, 'b', -4, -6);
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.surrounded, true); assert.equal(f.a.state, 'flee');
  const goal = { ...f.a.tacticGoal }, target = f.a.targetId;
  for (let tick = 2; tick < 42; tick++) {
    f.p.state.z = -6 + Math.sin(tick * .7) * .25; q.state.z = -6 - Math.sin(tick * .7) * .25;
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
    assert.equal(f.a.state, 'flee'); assert.deepEqual(f.a.tacticGoal, goal); assert.equal(f.a.targetId, target);
  }
});

test('surrounded responses retain temperament variance between escape and defensive aggression', () => {
  const states = new Set();
  for (const traits of [{ courage: .2, caution: .9 }, { courage: .85, caution: .3 }, { courage: .55, caution: .4 }]) {
    const f = fixture(); Object.assign(f.a.traits, traits); Object.assign(f.p.state, { x: 4, z: -6 }); hunter(f, 'b', -4, -6);
    f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); states.add(f.a.state);
  }
  assert.ok(states.has('flee') && states.has('warning')); assert.ok(states.size >= 3);
});

test('sustained rear orbit produces bounded pivots and movement that breaks the repeated-kick cycle', () => {
  const f = fixture(); Object.assign(f.a.traits, { courage: .85, caution: .2 });
  const states = new Set(); let travel = 0;
  for (let tick = 1; tick <= 360; tick++) {
    // Maintain rear pressure even after a response, to test repeated orbit rather
    // than ending the scenario at the first kick. Attack damage is checked below.
    Object.assign(f.p.state, toWorld(f.a, { x: Math.sin(tick * .07) * .3, y: 0, z: 2.1 })); f.p.health = 100;
    const before = { x: f.a.x, z: f.a.z, yaw: f.a.yaw };
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players); states.add(f.a.state);
    travel += Math.hypot(f.a.x - before.x, f.a.z - before.z);
    assert.ok(Math.abs(f.a.yaw - before.yaw) <= .091, 'physical rotation is bounded each tick');
    assert.equal(bodyContact(f.p.state, { ...f.a, yaw: before.yaw, x: before.x, z: before.z }), null);
  }
  assert.ok(states.has('kick')); assert.ok(states.has('breakaway')); assert.ok(travel > 2);
  assert.ok(f.hunt.events.some(e => e.kind === 'kick'));
});

test('a close moving hunter creates urgency without forcing every boar to attack', () => {
  const f = fixture(); Object.assign(f.a.traits, { courage: .2, caution: .9 });
  Object.assign(f.p.state, { x: 0, z: -8.2 }); f.p.velocityZ = 5;
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.state, 'flee');
  const bold = fixture(); Object.assign(bold.a.traits, { courage: .85, caution: .2 });
  Object.assign(bold.p.state, { x: 0, z: -8.2 }); bold.p.velocityZ = 5;
  bold.hunt.stepAnimal(bold.hunt.animals[0], 1, bold.players); assert.equal(bold.a.state, 'gore');
});

test('a severely compromised boar still launches a fast dangerous close reaction under pressure', () => {
  const f = fixture(); Object.assign(f.a, { blood: .4, lung: .7, limp: .8, health: 25 });
  Object.assign(f.p.state, { x: 0, z: -8.2 });
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.state, 'gore'); assert.ok(f.a.attackAt < 15);
  for (let tick = 2; tick < 15; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(f.p.health < 100 && f.p.state.knockTicks > 0);
  assert.equal(f.a.limp, .8); assert.equal(f.a.lung, .7);
});

test('a penetrating throw first breaks contact, then an aggressive boar orients and closes on its thrower', () => {
  const f = fixture(); Object.assign(f.a.traits, { courage: .9, caution: .2 });
  Object.assign(f.p.state, { x: 5, z: -6.3 }); changeState(f.a, 'assess', 0, 3);
  f.hunt.impact(f.hunt.animals[0], chest(f), 30, 'throw', f.p.id, 1, { id: 999, vx: -30, vy: 0, vz: 0, origin: { x: 5, z: -6.3 } });
  f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players); assert.equal(f.a.state, 'breakaway'); assert.equal(f.a.targetId, f.p.id);
  const distance = Math.hypot(f.p.state.x - f.a.x, f.p.state.z - f.a.z);
  const states = new Set();
  let closest = distance;
  for (let tick = 3; tick < 180; tick++) {
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players); states.add(f.a.state);
    closest = Math.min(closest, Math.hypot(f.p.state.x - f.a.x, f.p.state.z - f.a.z));
  }
  assert.ok(states.has('orient') && states.has('charge')); assert.ok(closest < distance - 1.5);
  assert.equal(f.a.acuteReaction, null);
});

test('the same penetrating wound can instead trigger flight, while a graze does not get acute priority', () => {
  const f = fixture(); Object.assign(f.a.traits, { courage: .2, caution: .9 }); Object.assign(f.p.state, { x: 5, z: -6.3 });
  f.hunt.impact(f.hunt.animals[0], chest(f), 30, 'throw', f.p.id, 1); f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players); assert.equal(f.a.state, 'flee');
  const graze = fixture(); const tangent = hitAnatomy(graze.a, toWorld(graze.a, { x: 2, y: 1.482, z: -.29 }), toWorld(graze.a, { x: -2, y: 1.482, z: -.29 }));
  graze.hunt.impact(graze.hunt.animals[0], tangent, 30, 'throw', graze.p.id, 1); assert.equal(graze.a.acuteReaction, null);
});

test('charge steering corrects early but remains limited for a late dodge', () => {
  const turns = [];
  for (const tick of [12, 80]) {
    const f = fixture(); Object.assign(f.p.state, { x: 5, z: -11 });
    Object.assign(f.a, { state: 'charge', stateTick: 0, until: 120, targetId: f.p.id });
    f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players); turns.push(Math.abs(f.a.yaw));
  }
  assert.ok(turns[0] > turns[1] * 3); assert.ok(turns[1] <= .45 / 60 + 1e-8);
});

test('a charging boar can take a new hunter in its path without swinging after a dodged target', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 6, z: -5 }); const q = hunter(f, 'b', 0, -9.2);
  Object.assign(f.a, { state: 'charge', stateTick: 0, until: 100, targetId: f.p.id, targetPosition: { x: 6, z: -5 } });
  f.a.threats.set(f.p.id, { x: 6, z: -5, seen: 1, damage: 0 });
  f.hunt.stepAnimal(f.hunt.animals[0], 3, f.players);
  assert.equal(f.a.targetId, q.id); assert.equal(f.a.rushRetargeted, true); assert.ok(Math.abs(f.a.yaw) < .04);
});

test('late, airborne, and obstructed braces still leave the hunter exposed to a rush', () => {
  for (const mode of ['late', 'air', 'wall']) {
    const f = fixture(); Object.assign(f.a, { yaw: Math.PI, state: 'charge', vx: 0, vz: 8 });
    Object.assign(f.p.state, { x: 0, z: -4.35, yaw: 0, pitch: -.3, bracing: true, braceTime: 1 });
    if (mode === 'late') f.p.state.braceTime = .1;
    if (mode === 'air') f.p.state.grounded = false;
    if (mode === 'wall') f.hunt.world = { ...world, obstacles: [{ x: 0, z: -4.8, radius: .2 }] };
    f.hunt.stepBraces(f.hunt.animals[0], 60, f.players); f.hunt.rushContacts(f.hunt.animals[0], 60, f.players);
    assert.equal(f.p.spears, 3); assert.equal(f.a.wounds.length, 0); assert.ok(f.p.health < 100);
  }
});

test('bracing after the body is already on top of the hunter fails to provide a strong counter', () => {
  const f = fixture(); Object.assign(f.a, { yaw: Math.PI, state: 'charge', vx: 0, vz: 8 });
  Object.assign(f.p.state, { x: 0, z: -4.35, yaw: 0, pitch: -.3, bracing: true, braceTime: 1 });
  assert.ok(bodyContact(f.p.state, f.a));
  f.hunt.stepBraces(f.hunt.animals[0], 60, f.players);
  assert.ok(f.p.health < 100 && f.p.state.knockTicks > 0);
  assert.equal(f.hunt.events.find(e => e.type === 'braced').strong, false);
});

test('a wounded animal can turn acute thrown trauma into a desperate attack on a nearby escape blocker', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 5, z: -6.3 }); const blocker = hunter(f, 'b', 0, -8.2);
  Object.assign(f.a, { health: 32, blood: .55, lung: .6 });
  f.hunt.impact(f.hunt.animals[0], chest(f), 18, 'throw', f.p.id, 1);
  f.hunt.stepAnimal(f.hunt.animals[0], 2, f.players);
  assert.equal(f.a.targetId, blocker.id); assert.equal(f.a.state, 'gore');
  for (let tick = 3; tick < 16; tick++) f.hunt.stepAnimal(f.hunt.animals[0], tick, f.players);
  assert.ok(blocker.health < 100 && blocker.state.knockTicks > 0);
});

test('a deliberate escape finishes when it reaches its chosen gap instead of circling the waypoint', () => {
  const f = fixture(); Object.assign(f.p.state, { x: 5, z: -6.3 });
  changeState(f.a, 'flee', 0, 3); f.a.tacticGoal = { x: 0, z: -6.5 };
  f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players); assert.equal(f.a.state, 'assess');
});
