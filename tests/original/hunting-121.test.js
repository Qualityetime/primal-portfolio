import { isolateBoar } from './helpers/hunt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../../simulation/gameState.js';
import { changeState } from '../../simulation/boarBrain.js';
import { hitAnatomy } from '../../simulation/anatomy.js';
import { toWorld } from '../../shared/body.js';
import { neutralInput } from '../../shared/movement.js';
import { HUNT } from '../../shared/hunt.js';

// Exercise the authoritative player movement, body collision, brain and combat
// together. No frozen brain, fabricated client damage, or browser runtime.
function fixture(traits = {}, obstacles = []) {
  const game = new GameState();
  game.world = { ...game.world, obstacles };
  const p = game.addPlayer('close', { room: 'BONES', name: 'Close hunter' });
  const q = game.addPlayer('other', { room: 'BONES', name: 'Other hunter' });
  const { hunt, players } = game.rooms.get('BONES'), a = isolateBoar(hunt);
  Object.assign(a, { x: 0, z: -14, yaw: 0, decisionSeed: 1 });
  Object.assign(a.traits, { courage: 0.55, caution: 0.5, persistence: 0.6, ...traits });
  Object.assign(p.state, { x: 0, z: -16, yaw: Math.PI, pitch: -0.2 });
  Object.assign(q.state, { x: 2, z: 5 }); // camp witness unless explicitly moved
  return { game, hunt, players, a, p, q };
}
function step(f, input = {}) {
  const tick = f.game.tick + 1;
  const command = { ...neutralInput(f.p.state.yaw, f.p.state.pitch), seq: tick, ...input };
  assert.equal(f.game.receiveInput(f.p.id, 'BONES', [command], tick * 1000 / 60), true);
  f.game.step(tick * 1000 / 60);
  return tick;
}
function hit(f, region = 'chest', kind = 'thrust', speed = 9) {
  const rays = {
    chest: [{ x: 2, y: 0.92, z: -0.29 }, { x: -2, y: 0.92, z: -0.29 }],
    rear: [{ x: 0, y: 0.88, z: 3 }, { x: 0, y: 0.88, z: -3 }],
    head: [{ x: 0, y: 0.75, z: -3 }, { x: 0, y: 0.75, z: 3 }],
    graze: [{ x: 2, y: 1.482, z: -0.29 }, { x: -2, y: 1.482, z: -0.29 }],
  };
  const impact = hitAnatomy(f.a, ...rays[region].map(point => toWorld(f.a, point)));
  assert.ok(impact);
  return f.hunt.impact(f.hunt.animals[0], impact, speed, kind, f.p.id, f.game.tick,
    kind === 'throw' ? { id: 9000, vx: 0, vy: 0, vz: -speed } : null);
}

test('1.2.1: a point-blank hunter gets a physical response despite a stronger distant threat', () => {
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.9, caution: 0.2 }]) {
    const f = fixture(traits);
    Object.assign(f.q.state, { x: 0, z: -28 });
    Object.assign(f.a, { targetId: f.q.id, targetPosition: { x: 0, z: -28 } });
    f.a.threats.set(f.q.id, { seen: 0, x: 0, z: -28, damage: 100 });
    changeState(f.a, 'assess', 0, 3);
    for (let i = 0; i < 12; i++) step(f, { forward: i < 2 ? 1 : 0, sprint: i < 2 });
    assert.ok(['gore', 'sweep', 'kick', 'maul', 'flee', 'breakaway', 'pivot'].includes(f.a.state));
    for (let i = 0; i < 25; i++) step(f);
    assert.ok(f.p.health < HUNT.playerHealth || Math.hypot(f.a.x, f.a.z + 14) > 1,
      'the close action must produce contact damage or meaningful separation');
  }
});

test('1.2.1: exhaustion cannot cancel a freshly chosen escape after one movement tick', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 });
  Object.assign(f.p.state, { x: 5, z: -14 });
  f.a.breath = 0.04;
  changeState(f.a, 'flee', 0, 3); f.a.tacticGoal = { x: 0, z: -24 };
  for (let i = 0; i < 36; i++) {
    step(f); assert.equal(f.a.state, 'flee', 'minimum physical commitment survives low breath');
  }
  assert.ok(Math.hypot(f.a.x, f.a.z + 14) > 2.5);
  assert.equal(f.a.breath, 0, 'forced effort spends breath instead of restoring capacity');
  assert.equal(f.a.intentTrace.length, 1);
  for (let i = 0; i < 20; i++) step(f);
  assert.notEqual(f.a.state, 'flee', 'exhaustion still limits sustained escape after the short effort');
});

test('1.2.1: tiny hunter movements do not restart a committed close attack', () => {
  const f = fixture({ courage: 0.9, caution: 0.2 });
  changeState(f.a, 'assess', 0, 3);
  for (let i = 0; i < 30 && f.a.state === 'assess'; i++) step(f);
  assert.equal(f.a.state, 'gore');
  const chosen = f.a.stateTick, strike = f.a.attackAt;
  while (f.game.tick < strike) {
    step(f, { strafe: f.game.tick % 2 ? 1 : -1, yaw: Math.PI + (f.game.tick % 2 ? 0.01 : -0.01) });
    assert.equal(f.a.stateTick, chosen); assert.equal(f.a.attackAt, strike);
  }
  assert.equal(f.a.attackDone, true); assert.ok(f.p.health < HUNT.playerHealth);
});

test('1.2.1: a real serious melee hit interrupts the action and stationary full-loop follow-ups must be earned', () => {
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.9, caution: 0.2 }]) {
    const f = fixture(traits);
    Object.assign(f.p.state, { x: 1.3, z: -14.29, yaw: Math.PI / 2, pitch: -0.3 });
    changeState(f.a, 'assess', 0, 3);
    while (!f.a.wounds.length && f.game.tick < 20) step(f, { attack: true });
    assert.equal(f.a.wounds.length, 1);
    const wound = f.a.wounds[0]; assert.ok(wound.depth > 0.32 && wound.trauma > 8);
    const previousAction = f.a.stateTick;
    step(f, { attack: true });
    assert.ok(f.a.acute); assert.ok(f.a.stateTick > previousAction);
    assert.notEqual(f.a.state, 'assess'); assert.ok(Math.hypot(f.a.vx, f.a.vz) > 1);
    let separation = 0;
    for (let i = 0; i < 80; i++) {
      step(f, { attack: true }); separation = Math.max(separation, Math.hypot(f.a.x, f.a.z + 14));
    }
    assert.ok(separation > 1.5, 'the first real hit changes geometry before a stationary follow-up');
    assert.ok(f.a.wounds.length === 1 || f.p.health < 100 || f.p.state.knockTicks > 0,
      'no stationary serious-hit chain without dealing with movement or retaliation');
  }
});

test('1.2.1: unseen lodged throw commits to survival movement with the thrower standing still', () => {
  for (const traits of [{ courage: 0.2, caution: 0.9 }, { courage: 0.9, caution: 0.2 }]) {
    const f = fixture(traits); f.a.z = -24;
    Object.assign(f.p.state, { x: 0, z: -6, yaw: 0, pitch: 0 });
    changeState(f.a, 'assess', 0, 3); step(f);
    assert.equal(f.a.targetId, null);
    const wound = hit(f, 'rear', 'throw', 30); assert.ok(wound.embedded);
    const start = { x: f.a.x, z: f.a.z }, chosen = f.game.tick + 1;
    for (let i = 0; i < 42; i++) {
      step(f);
      assert.ok(['flee', 'breakaway'].includes(f.a.state), 'pain movement must survive absent target and ordinary exits');
      assert.equal(f.a.stateTick, chosen);
      assert.equal(f.a.acute.identifiedId, null); assert.equal(f.a.targetId, null);
      assert.equal(f.p.velocityX, 0); assert.equal(f.p.velocityZ, 0);
    }
    assert.ok(Math.hypot(f.a.x - start.x, f.a.z - start.z) > 3);
    assert.ok(f.a.intentTrace.every(entry => entry.tick < chosen || entry.state !== 'assess'));
  }
});

test('1.2.1: deep lodged head penetration triggers pain movement even below the tissue-damage cutoff', () => {
  const f = fixture(); changeState(f.a, 'assess', 0, 3);
  const wound = hit(f, 'head', 'throw', 30);
  assert.ok(wound.embedded && wound.depth > 0.4 && wound.trauma < 8);
  assert.ok(f.a.acuteReaction, 'deep lodging is serious even in resistant tissue');
  step(f); assert.ok(f.a.acute);
  for (let i = 0; i < 30; i++) step(f);
  assert.ok(Math.hypot(f.a.x, f.a.z + 14) > 2);
});

test('1.2.1: pursuit pressure is evaluated during the acute commitment and governs later behavior', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 });
  Object.assign(f.p.state, { x: 5, z: -14.29, yaw: Math.PI / 2 });
  const wound = hit(f, 'chest', 'throw', 30); assert.ok(wound.embedded);
  step(f); const chosen = f.a.stateTick, start = { x: f.a.x, z: f.a.z };
  for (let i = 0; i < 30; i++) {
    const yaw = Math.atan2(f.p.state.x - f.a.x, f.p.state.z - f.a.z);
    step(f, { yaw, forward: 1, sprint: true });
  }
  assert.equal(f.a.state, 'flee'); assert.equal(f.a.stateTick, chosen);
  assert.ok(f.a.pressureParts.closing > 0);
  assert.ok(f.a.huntMemory.get(f.p.id).pursuitSeconds > 0.2);
  assert.ok(Math.hypot(f.a.x - start.x, f.a.z - start.z) > 2);
  for (let i = 0; i < 100; i++) step(f);
  assert.equal(f.a.acute, null); assert.ok(f.a.decisionSeconds > 0);
});

test('1.2.1: a graze and a shallow lodged throw do not force the serious survival response', () => {
  for (const [region, speed] of [['graze', 30], ['head', 23]]) {
    const f = fixture(); changeState(f.a, 'assess', 0, 3);
    const wound = hit(f, region, 'throw', speed);
    assert.ok(wound.glancing || (wound.embedded && wound.depth < 0.4 && wound.trauma < 8));
    assert.equal(f.a.acuteReaction, null); assert.equal(f.a.huntAlarm, 0);
  }
});

test('1.2.1: new serious trauma and genuine route obstruction remain material interrupts', () => {
  const f = fixture({ courage: 0.2, caution: 0.9 });
  Object.assign(f.p.state, { x: 5, z: -14.29 });
  changeState(f.a, 'flee', 0, 3); f.a.tacticGoal = { x: 0, z: -24 };
  for (let i = 0; i < 6; i++) step(f);
  const prior = f.a.stateTick;
  hit(f); step(f); assert.ok(f.a.stateTick > prior && f.a.acute);
  const goal = { ...f.a.tacticGoal };
  f.hunt.world = f.game.world = { ...f.game.world, obstacles: [{ x: goal.x, z: goal.z, radius: 1 }] };
  for (let i = 0; i < 18; i++) step(f);
  assert.notDeepEqual(f.a.tacticGoal, goal, 'a real obstruction can invalidate the committed route');
});

test('1.2.1: developer diagnostics explain action age and immediate arbitration without leaking into snapshots', () => {
  const f = fixture(); changeState(f.a, 'assess', 0, 3); step(f);
  const debug = f.hunt.debugSnapshot(f.game.tick).animals[0], publicState = f.hunt.snapshot().animals[0];
  assert.equal(debug.arbitration.immediateMelee, true);
  assert.equal(debug.arbitration.hunter, f.p.id);
  assert.ok(debug.intent.previous); assert.ok(debug.intent.ageSeconds >= 0);
  assert.ok(debug.intent.executionRemainingSeconds > 0);
  for (const key of ['arbitration', 'previousIntent', 'commitUntil', 'immediateMelee']) assert.equal(publicState[key], undefined);
});
