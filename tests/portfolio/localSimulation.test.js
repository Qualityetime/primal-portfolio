// Portfolio Edition: the single-player simulation layer and the data React reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalSimulation, SOLO_PLAYER_ID } from '../../src/engine/LocalSimulation.js';
import { hudModel, objectiveStage } from '../../src/engine/hudModel.js';
import { TelemetrySampler, mapSample, BEHAVIOUR } from '../../src/engine/telemetry.js';
import { createStats, applyEvent, summarise } from '../../src/engine/huntStats.js';
import { createStore, shallowEqual } from '../../src/engine/store.js';
import { createWorld } from '../../shared/world.js';
import { groundHeight } from '../../shared/terrain.js';
import { neutralInput } from '../../shared/movement.js';
import { HUNT } from '../../shared/hunt.js';
import { PLAYER } from '../../shared/config.js';

let seq = 0;
const command = (overrides = {}) => ({ ...neutralInput(0, 0), seq: ++seq, throwStart: false, throwHeld: false, throw: false, attack: false, brace: false, interact: false, restart: false, ...overrides });
const step = (sim, overrides) => sim.step(command(overrides));
const idle = (sim, ticks) => { for (let i = 0; i < ticks; i++) step(sim); };
const place = (sim, x, z, yaw = 0) => Object.assign(sim.player.state, { x, z, y: groundHeight(sim.world, x, z), yaw, vy: 0, impulseX: 0, impulseZ: 0 });
const aimAt = (from, to, height) => {
  const yaw = Math.atan2(-(to.x - from.x), -(to.z - from.z));
  const pitch = Math.atan2(height - (from.y + PLAYER.eyeHeight - 0.08), Math.hypot(to.x - from.x, to.z - from.z));
  return { yaw, pitch };
};

// Thrust at a boar from its flank until it dies (the hunter is repositioned
// beside it before each thrust; the brain, anatomy and wounds are unchanged).
function huntDown(sim, animal, maxThrusts = 80) {
  for (let i = 0; i < maxThrusts && animal.health > 0; i++) {
    const side = animal.yaw + Math.PI / 2;
    place(sim, animal.x + Math.cos(side) * 1.9, animal.z - Math.sin(side) * 1.9);
    sim.player.health = HUNT.playerHealth; sim.player.state.stamina = 100;
    const aim = aimAt(sim.player.state, animal, animal.y + 0.95);
    sim.player.state.yaw = aim.yaw; sim.player.state.pitch = aim.pitch;
    step(sim, { ...aim, attack: true });
    for (let t = 0; t < 40 && animal.health > 0; t++) step(sim, aim);
    if (sim.player.spears === 0) { place(sim, HUNT.camp.x, HUNT.camp.z + 1); step(sim, { interact: true }); }
  }
  return animal.health <= 0;
}

test('local simulation: runs the original GameState with one hunter and no network', () => {
  seq = 0;
  const sim = new LocalSimulation({ world: createWorld(), seed: 1234 });
  const welcome = sim.welcome();
  assert.equal(welcome.id, SOLO_PLAYER_ID);
  assert.equal(welcome.snapshot.players.length, 1);
  assert.equal(welcome.snapshot.hunt.animals.length, 2);
  idle(sim, 120);
  assert.equal(sim.tick, 120);
  assert.ok(sim.snapshot().hunt.animals.every(a => Number.isFinite(a.x) && Number.isFinite(a.z)));
});

test('local simulation: boar count setting spawns one boar, also after an in-game reset', () => {
  seq = 0;
  const sim = new LocalSimulation({ boarCount: 1, seed: 99 });
  assert.equal(sim.hunt.animals.length, 1);
  assert.equal(sim.hunt.brains.size, 1);
  assert.ok(huntDown(sim, sim.hunt.animals[0]), 'boar killed');
  place(sim, HUNT.camp.x, HUNT.camp.z + 1);
  idle(sim, 130);
  step(sim, { restart: true });
  assert.equal(sim.hunt.round, 2);
  assert.equal(sim.hunt.animals.length, 1);
  assert.equal(sim.hunt.brains.size, 1);
  assert.ok(sim.hunt.animals[0].health > 0);
});

test('local simulation: complete hunt loop — kill, harvest, cook twice, complete', () => {
  seq = 0;
  const sim = new LocalSimulation({ boarCount: 1, seed: 7 });
  const stats = createStats();
  let lastEvent = 0;
  const collect = () => { for (const e of sim.hunt.events) if (e.id > lastEvent) { applyEvent(stats, e, SOLO_PLAYER_ID); lastEvent = e.id; } };
  const boar = sim.hunt.animals[0];
  assert.ok(huntDown(sim, boar), 'boar killed by thrusts');
  collect();
  assert.ok(stats.hits > 0 && stats.kills === 1 && stats.thrusts > 0);
  assert.equal(objectiveStage(sim.snapshot(), sim.snapshot().players[0]), 1);
  place(sim, boar.x + 1.2, boar.z);
  step(sim, { interact: true });
  assert.equal(sim.player.rawMeat, HUNT.meatPerHunter);
  place(sim, HUNT.camp.x, HUNT.camp.z + 1);
  for (let meal = 0; meal < HUNT.mealGoal; meal++) {
    step(sim, { interact: true });
    idle(sim, Math.ceil(HUNT.cookSeconds * 60) + 2);
  }
  collect();
  assert.equal(sim.hunt.complete, true);
  assert.equal(stats.cooked, HUNT.mealGoal);
  assert.ok(stats.completeTick !== null);
  const summary = summarise(stats, sim, 'complete');
  assert.equal(summary.outcome, 'complete');
  assert.equal(summary.boars[0].fate, 'Killed');
  assert.ok(summary.accuracy > 0 && summary.accuracy <= 100);
  assert.equal(objectiveStage(sim.snapshot(), sim.snapshot().players[0]), 3);
});

test('hud model: derives readings from the snapshot and rounds for stable comparison', () => {
  seq = 0;
  const sim = new LocalSimulation({ seed: 5 });
  const snap = sim.snapshot(), self = snap.players[0];
  const local = { position: { x: self.x, y: self.y, z: self.z }, yaw: 0, state: { ...self, grounded: true }, sprinting: false };
  const a = hudModel(snap, SOLO_PLAYER_ID, local, true), b = hudModel(snap, SOLO_PLAYER_ID, local, true);
  assert.ok(shallowEqual(a, b));
  assert.equal(a.health, 100);
  assert.equal(a.spears, HUNT.spearCapacity);
  assert.equal(a.stage, 0);
  assert.equal(a.boarsAlive, 2);
  assert.equal(a.movement, 'ON FOOT');
  assert.equal(typeof a.campTurn, 'number');
  assert.equal(hudModel(snap, 'nobody', local, true), null);
});

test('telemetry: samples real brain values, keeps bounded history, maps every state', () => {
  seq = 0;
  const sim = new LocalSimulation({ seed: 11 });
  const sampler = new TelemetrySampler();
  const boar = sim.hunt.animals[0];
  let sample, seen = false;
  for (let i = 0; i < 100; i++) {
    // Keep the hunter 6 m in front of the boar, in its view.
    place(sim, boar.x - Math.sin(boar.yaw) * 6, boar.z - Math.cos(boar.yaw) * 6);
    idle(sim, 12);
    sample = sampler.sample(sim, sim.player.state);
    seen ||= sample.animals[0].perceivesHunter;
  }
  assert.equal(sample.animals.length, 2);
  const t = sample.animals[0];
  assert.equal(t.state, boar.state);
  assert.ok(t.pressure >= 0 && t.pressure <= 1);
  assert.ok(t.history.pressure.length <= 72);
  assert.ok(['courage', 'caution', 'persistence', 'bluff'].every(k => t.temperament[k] >= 0));
  assert.ok(seen, 'a hunter 6 m in front of the boar is perceived');
  const map = mapSample(sim, sim.player.state);
  assert.equal(map.animals.length, 2);
  // Every state the brain can enter has a telemetry label.
  const states = new Set(['patrol', 'assess', 'orient', 'pivot', 'warning', 'recover', 'stagger', 'charge', 'bluff', 'gore', 'sweep', 'maul', 'kick', 'flee', 'breakaway', 'reposition', 'dead']);
  for (const s of states) assert.ok(BEHAVIOUR[s], s);
});

test('store: notifies only on change and supports unsubscribe', () => {
  const store = createStore({ a: 1 });
  let calls = 0;
  const off = store.subscribe(() => calls++);
  store.patch({ a: 1 }); assert.equal(calls, 0);
  store.patch({ a: 2 }); assert.equal(calls, 1);
  off(); store.patch({ a: 3 }); assert.equal(calls, 1);
});
