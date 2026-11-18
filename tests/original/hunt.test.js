import { isolateBoar } from './helpers/hunt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../../simulation/gameState.js';
import { HuntState, segmentSphere } from '../../simulation/huntState.js';
import { HUNT } from '../../shared/hunt.js';
import { neutralInput } from '../../shared/movement.js';
import { sanitizeBatch } from '../../shared/protocol.js';

function fixture() {
  const game = new GameState();
  const a = game.addPlayer('a', { room: 'BONES', name: 'Hunter A' });
  const b = game.addPlayer('b', { room: 'BONES', name: 'Hunter B' });
  isolateBoar(game.rooms.get('BONES').hunt);
  return { game, a, b, hunt: game.rooms.get('BONES').hunt };
}
function advance(game, count) { for (let i = 0; i < count; i++) game.step(game.tick * 1000 / 60 + 1); }
function command(game, player, extra = {}) {
  const input = { ...neutralInput(player.state.yaw, player.state.pitch), ...extra, seq: player.lastReceivedSequence + 1 };
  const now = game.tick * 1000 / 60 + 1;
  assert.equal(game.receiveInput(player.id, 'BONES', [input], now), true);
  game.step(now);
}
function down(hunt) { hunt.animals[0].health = 0; hunt.animals[0].state = 'dead'; hunt.animals[0].meat = HUNT.carcassMeat; }
function windup(game, player, aim = {}, frames = 54) {
  for (let i = 0; i < frames; i++) command(game, player, { ...aim, throw: false, throwHeld: true, throwStart: i === 0 });
}

test('swept spear collisions find fast crossings and reject misses', () => {
  assert.ok(Math.abs(segmentSphere({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 0.1) - 0.49) < 1e-10);
  assert.equal(segmentSphere({ x: 0, y: 2, z: 0 }, { x: 10, y: 2, z: 0 }, { x: 5, y: 0, z: 0 }, 0.1), null);
});

test('physical throws consume spears, enforce cooldown and cause a shared bleeding kill', () => {
  const { game, a, hunt } = fixture();
  Object.assign(hunt.animals[0], { x: 0, z: -3.5, yaw: 0 });
  hunt.stepAnimal = () => { hunt.animals[0].vx = hunt.animals[0].vz = 0; };
  Object.assign(a.state, { x: 3.2, z: -3.8 });
  const aim = () => ({ throw: true, yaw: Math.atan2(3.2, .3), pitch: -0.15 });
  windup(game, a, aim()); command(game, a, aim());
  const afterThrow = hunt.projectiles.length;
  command(game, a, aim());
  assert.equal(hunt.projectiles.length, afterThrow, 'cooldown rejects a second immediate throw');
  assert.equal(a.spears, 2);
  advance(game, 55);
  assert.ok(hunt.animals[0].health < HUNT.boarHealth);
  windup(game, a, aim()); command(game, a, aim()); advance(game, 55);
  windup(game, a, aim()); command(game, a, aim()); advance(game, 55);
  assert.equal(a.spears, 0);
  command(game, a, aim());
  assert.equal(hunt.events.filter(e => e.type === 'throw').length, 3);
  advance(game, 6000);
  assert.equal(hunt.animals[0].health, 0);
  assert.equal(hunt.animals[0].state, 'dead');
  assert.equal(hunt.animals[0].meat, HUNT.carcassMeat);
  assert.equal(hunt.events.filter(e => e.type === 'hit').length, 3);
  const snapshot = game.snapshot('BONES');
  assert.equal(snapshot.hunt.animals[0].alive, false);
  for (const field of ['health', 'traits', 'threats', 'hitPlayers']) assert.ok(!(field in snapshot.hunt.animals[0]));
});

test('standing obstacles stop a spear before it can hit an animal', () => {
  const world = { halfSize: 36, obstacles: [{ x: 0, z: 0, radius: 0.8 }] };
  const hunt = new HuntState(world);
  isolateBoar(hunt);
  const player = { id: 'a', state: { x: 0, y: 0, z: 3, yaw: 0, pitch: -0.1 } };
  hunt.addPlayer(player);
  const players = new Map([['a', player]]);
  hunt.action(player, { throwStart: true, throw: true }, 1, players);
  for (let tick = 1; tick < 40; tick++) hunt.stepProjectiles(tick, players);
  assert.equal(hunt.animals[0].health, HUNT.boarHealth);
  assert.equal(hunt.projectiles.length, 0);
});

test('harvesting requires a nearby carcass, awards each hunter once, and does not duplicate meat', () => {
  const { game, a, b, hunt } = fixture();
  const c = game.addPlayer('c', { room: 'BONES', name: 'Hunter C' });
  const d = game.addPlayer('d', { room: 'BONES', name: 'Hunter D' });
  down(hunt);
  command(game, a, { interact: true });
  assert.equal(a.rawMeat, 0, 'cannot harvest from the spawn');
  Object.assign(a.state, { x: hunt.animals[0].x, z: hunt.animals[0].z + 1.7 });
  Object.assign(b.state, { x: hunt.animals[0].x + 1, z: hunt.animals[0].z });
  command(game, a, { interact: true });
  command(game, a, { interact: true });
  assert.equal(a.rawMeat, 2);
  assert.equal(hunt.animals[0].meat, 6);
  command(game, b, { interact: true });
  assert.equal(b.rawMeat, 2);
  assert.equal(hunt.animals[0].meat, 4);
  Object.assign(c.state, { x: hunt.animals[0].x - 1, z: hunt.animals[0].z });
  command(game, c, { interact: true });
  command(game, c, { interact: true });
  assert.equal(c.rawMeat, 2);
  assert.equal(hunt.animals[0].meat, 2);
  Object.assign(d.state, { x: hunt.animals[0].x, z: hunt.animals[0].z - 1.7 });
  command(game, d, { interact: true }); command(game, d, { interact: true });
  assert.equal(d.rawMeat, 2);
  assert.equal(hunt.animals[0].meat, 0);
});

test('cooking reserves one meat, cancels safely when leaving, and completes a shared meal goal', () => {
  const { game, a, b, hunt } = fixture();
  down(hunt); a.rawMeat = 2; b.rawMeat = 2; a.health = 50;
  command(game, a, { interact: true });
  assert.equal(a.rawMeat, 1);
  command(game, a, { interact: true });
  assert.equal(a.rawMeat, 1, 'spamming E cannot reserve extra meat');
  Object.assign(a.state, { x: 8, z: 4 }); advance(game, 1);
  assert.equal(a.rawMeat, 2); assert.equal(a.cookUntil, 0);
  Object.assign(a.state, { x: -2, z: 5 });
  command(game, a, { interact: true }); command(game, b, { interact: true });
  advance(game, 148);
  assert.equal(hunt.complete, false, 'cooking is not instantaneous');
  advance(game, 2);
  assert.equal(a.cookedMeat, 1); assert.equal(b.cookedMeat, 1);
  assert.equal(a.health, 75); assert.equal(hunt.meals, 2); assert.equal(hunt.complete, true);
  Object.assign(a.state, { x: 20, z: 20 });
  command(game, a, { restart: true }); assert.equal(hunt.round, 1);
  Object.assign(a.state, { x: -2, z: 5 });
  command(game, a, { restart: true });
  assert.equal(hunt.round, 2); assert.equal(hunt.complete, false);
  assert.equal(hunt.animals[0].health, HUNT.boarHealth); assert.equal(a.rawMeat, 0);
  assert.equal(b.rawMeat, 0); assert.equal(a.health, 100);
});

test('a rush hits once per hunter, respects camp safety and respawns a downed hunter with inventory', () => {
  const { game, a, b, hunt } = fixture();
  hunt.stepAnimal = () => {};
  Object.assign(a.state, { x: 0, z: -5 });
  Object.assign(b.state, HUNT.camp);
  Object.assign(hunt.animals[0], { x: 0, z: -3.4, yaw: 0, state: 'charge', until: 9999 });
  hunt.rushContacts(hunt.animals[0], 1, game.rooms.get('BONES').players);
  assert.equal(a.health, 75);
  hunt.rushContacts(hunt.animals[0], 30, game.rooms.get('BONES').players);
  assert.equal(a.health, 75); assert.equal(b.health, 100);
  assert.ok(a.state.knockTicks > 0);
  a.health = 25; a.rawMeat = 2; a.lastHurt = -1000;
  Object.assign(a.state, { x: 0, z: -5 });
  hunt.animals[0].hitPlayers.clear();
  hunt.rushContacts(hunt.animals[0], 1, game.rooms.get('BONES').players);
  assert.equal(a.health, 0);
  advance(game, 121);
  assert.equal(a.health, 100); assert.equal(a.rawMeat, 2);
  assert.equal(a.state.x, game.world.spawns[0].x); assert.equal(a.state.z, game.world.spawns[0].z);
});

test('untrusted action data cannot choose damage, inventory or cooldowns, and replayed actions are rejected', () => {
  const packet = { ...neutralInput(), seq: 1, attack: true, damage: 9999, rawMeat: 999, cooldown: 0 };
  const [input] = sanitizeBatch([packet], 0);
  assert.equal(input.attack, true);
  assert.equal(input.damage, undefined); assert.equal(input.rawMeat, undefined); assert.equal(input.cooldown, undefined);
  assert.equal(sanitizeBatch([packet], 1), null);
  for (const extra of [{ attack: 'yes' }, { interact: 1 }, { restart: {} }]) assert.equal(sanitizeBatch([{ ...neutralInput(), seq: 1, ...extra }], 0), null);
});
