import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, FIXED_DT } from '../../shared/config.js';
import { HUNT } from '../../shared/hunt.js';
import { createWorld, walkableGrid, SPAWNS } from '../../shared/world.js';
import { RAVINE_LAYOUT } from '../../shared/layouts/ravine.js';
import { TERRAIN, groundHeight, groundGradient, groundContact, waterAt } from '../../shared/terrain.js';
import { createPlayerState, neutralInput, stepPlayer } from '../../shared/movement.js';
import { bodyContact, toWorld } from '../../shared/body.js';
import { hitAnatomy } from '../../simulation/anatomy.js';
import { GameState } from '../../simulation/gameState.js';
import { HuntState } from '../../simulation/huntState.js';
import { loadClient } from './helpers/client.js';
import { createLegacyWorld } from './helpers/legacyWorld.js';
import { runAIScenario } from './helpers/aiScenario.js';

// Hunt Slice 0.1: one authored ravine with real, shared walkable elevation.
const world = createWorld();
const grid = walkableGrid(world, 0.5);
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

test('hunt slice: layout data is separate from expansion and can be rearranged without code changes', () => {
  assert.equal(world.layoutId, RAVINE_LAYOUT.id);
  assert.equal(world.terrain, RAVINE_LAYOUT.terrain, 'terrain is layout data, not code');
  assert.ok(Object.isFrozen(RAVINE_LAYOUT.terrain.features[0]));
  const moved = { ...RAVINE_LAYOUT, id: 'rearranged', boulders: RAVINE_LAYOUT.boulders.map(([x, z, r]) => [x + 0.5, z, r]),
    terrain: { base: 0, features: [] } };
  const other = createWorld(RAVINE_LAYOUT.seed, moved);
  assert.equal(other.layoutId, 'rearranged');
  assert.deepEqual(other.rocks.map(r => r.x), world.rocks.map(r => r.x + 0.5));
  assert.equal(groundHeight(other, -14.6, -20), 0, 'removing terrain features gives a flat floor');
  assert.notEqual(createWorld(), createWorld(), 'every room receives its own copy');
});

test('hunt slice: camp, spawns and the boar spawn area are flat, dry and clear; the basin floor is exactly y = 0', () => {
  for (const s of [...SPAWNS, HUNT.camp, ...HUNT.boarSpawns]) {
    assert.equal(groundHeight(world, s.x, s.z), 0); assert.equal(waterAt(world, s.x, s.z), null);
    assert.ok(grid.reachable(s.x, s.z));
  }
  for (const s of SPAWNS) for (const o of world.obstacles) assert.ok(Math.hypot(s.x - o.x, s.z - o.z) > o.radius + PLAYER.radius + 0.5);
  for (let x = -6; x <= 8; x += 0.5) for (let z = -23; z <= 12; z += 0.5) assert.equal(groundHeight(world, x, z), 0, `${x},${z}`);
  // Legacy fixtures and stub worlds without terrain keep the original floor.
  assert.equal(groundHeight(createLegacyWorld(), 5, 5), 0); assert.equal(groundHeight({ halfSize: 36, obstacles: [] }, 5, 5), 0);
});

test('hunt slice: cliffs, not the square world limit, enclose every reachable cell; key areas connect', () => {
  let reachable = 0;
  for (let gz = 0; gz < grid.size; gz++) for (let gx = 0; gx < grid.size; gx++) {
    if (!grid.reached[gz * grid.size + gx]) continue;
    reachable++;
    const x = grid.center(gx), z = grid.center(gz);
    assert.ok(Math.abs(x) < world.halfSize - 3 && Math.abs(z) < world.halfSize - 3, `reachable cell ${x},${z} touches the map edge`);
  }
  assert.ok(reachable > 3000, `${reachable} reachable cells`);
  const places = { basin: [0, -20], creekBed: [-14.6, -14], pool: [-13, -25.5], pass: [12.9, -13.2], pocket: [23, -17],
    northOpening: [13.5, -25], campForest: [-8, 12] };
  for (const [name, [x, z]] of Object.entries(places)) assert.ok(grid.reachable(x, z), `${name} must be reachable`);
  for (const [x, z] of [[-29, 0], [0, -34.5], [12.6, 2], [33, -10], [0, 22], [-30, -30]]) assert.ok(!grid.reachable(x, z), `${x},${z} lies behind rock`);
});

test('hunt slice: walkable ground stays within the authored grade and all water is shallow and wadeable', () => {
  let maxGrade = 0, wet = 0, deepest = 0;
  for (let gz = 0; gz < grid.size; gz++) for (let gx = 0; gx < grid.size; gx++) {
    if (!grid.reached[gz * grid.size + gx]) continue;
    const x = grid.center(gx), z = grid.center(gz), g = groundGradient(world, x, z);
    maxGrade = Math.max(maxGrade, Math.hypot(g.x, g.z));
    const water = waterAt(world, x, z);
    if (water) { wet++; deepest = Math.max(deepest, water.depth); }
  }
  assert.ok(maxGrade <= TERRAIN.maxWalkableGrade, `steepest walkable grade ${maxGrade}`);
  assert.ok(maxGrade > 0.05, 'there is real traversable elevation');
  assert.ok(wet > 150, `${wet} wet reachable cells`);
  assert.ok(deepest <= TERRAIN.maxWaterDepth + 1e-9, `deepest water ${deepest}`);
  const bed = groundHeight(world, -14.6, -20), pocket = groundHeight(world, 22, -15);
  assert.ok(near(bed, -0.45) && near(pocket, 0.6), `${bed} / ${pocket}`);
});

function hunterPath(game, player, waypoints, predictor, onTick) {
  let seq = player.lastReceivedSequence, tick = game.tick;
  for (const [tx, tz] of waypoints) {
    let budget = 1200;
    while (Math.hypot(player.state.x - tx, player.state.z - tz) > 0.6) {
      assert.ok(budget-- > 0, `hunter stalled near ${player.state.x.toFixed(2)},${player.state.z.toFixed(2)} heading for ${tx},${tz}`);
      const yaw = Math.atan2(-(tx - player.state.x), -(tz - player.state.z));
      const command = { ...neutralInput(yaw, 0), forward: 1, seq: ++seq };
      tick++;
      game.receiveInput(player.id, 'BONES', [command], tick * 1000 / 60);
      game.step(tick * 1000 / 60);
      if (predictor) { predictor.bodies = game.snapshot('BONES').hunt.animals; predictor.step({ ...command }); }
      onTick?.(player.state, predictor?.state);
    }
  }
}

function slice() {
  const game = new GameState();
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: `Hunter ${id}` }));
  const hunt = game.rooms.get('BONES').hunt;
  return { game, hunters, hunt };
}
const park = (hunt, ...animals) => animals.forEach((a, i) => Object.assign(a, { x: -4 + i * 8, z: 30, y: 0, health: 0, state: 'dead', meat: 0 }));

// Prediction runs the same stepPlayer and terrain code as the server. The only
// pre-existing difference is the server's extra end-of-tick obstacle pass, which
// can move a hunter brushing rock by a last-place rounding amount; reconciliation
// absorbs it. Heights must agree with the shared ground on both sides.
test('hunt slice: server movement and client prediction agree across creek, banks, pass and pocket', async () => {
  const { PredictedPlayer } = await loadClient('player.js');
  const { game, hunters, hunt } = slice(), p = hunters[3];
  park(hunt, ...hunt.animals);
  const predictor = new PredictedPlayer(game.world);
  predictor.reset({ ...p.state, ack: 0 });
  let low = Infinity, high = -Infinity, ticks = 0;
  hunterPath(game, p, [[-6, -1], [-12.5, -5], [-14.2, -11], [-6, -12], [5, -11], [12.9, -13.2], [20.5, -15], [22, -22], [12.8, -25.5], [3, -20]], predictor, (server, client) => {
    ticks++;
    assert.ok(near(client.x, server.x, 1e-9) && near(client.z, server.z, 1e-9), `prediction drifted at ${server.x},${server.z}`);
    assert.ok(near(client.y, server.y, 1e-9)); assert.equal(client.y, groundHeight(game.world, client.x, client.z));
    assert.equal(server.grounded, true, 'walking never bunny-hops off the gentle slopes');
    assert.equal(server.y, groundHeight(game.world, server.x, server.z), 'feet stay on the shared ground');
    for (const o of game.world.obstacles) assert.ok(Math.hypot(server.x - o.x, server.z - o.z) >= o.radius + PLAYER.radius - 1e-6);
    low = Math.min(low, server.y); high = Math.max(high, server.y);
  });
  assert.ok(low < -0.4 && high > 0.55, `walked from ${low} to ${high} across ${ticks} ticks`);
  // Reconciling against the authoritative state leaves no correction to smooth.
  predictor.reconcile({ ...p.state, ack: predictor.sequence });
  assert.ok(Math.hypot(predictor.correction.x, predictor.correction.y, predictor.correction.z) < 1e-9);
});

test('hunt slice: a jump on the creek bank and on the pocket ramp lands on the terrain, not on y = 0', () => {
  for (const [x, z] of [[-11.2, -12], [15.5, -13.2]]) {
    const state = createPlayerState({ x, y: groundHeight(world, x, z), z, yaw: Math.PI / 2 });
    stepPlayer(state, { ...neutralInput(Math.PI / 2), jump: true, forward: 1 }, world);
    assert.equal(state.grounded, false);
    for (let i = 0; i < 90 && !state.grounded; i++) stepPlayer(state, { ...neutralInput(Math.PI / 2), forward: 1 }, world);
    assert.equal(state.grounded, true);
    assert.equal(state.y, groundHeight(world, state.x, state.z));
    assert.notEqual(state.y, 0);
  }
});

test('hunt slice: boars stand on the shared ground everywhere they move, and snapshots publish it for prediction', () => {
  const { game, hunt } = slice(), [a, b] = hunt.animals;
  assert.equal(a.y, 0); assert.equal(b.y, 0);
  Object.assign(a, { x: -9, z: -12 }); Object.assign(b, { x: 10.5, z: -13.2 });
  for (let i = 0; i < 160; i++) {
    hunt.moveAnimal(a, -0.04, 0); hunt.moveAnimal(b, 0.06, -0.004);
    for (const boar of [a, b]) assert.equal(boar.y, groundHeight(game.world, boar.x, boar.z));
  }
  assert.ok(a.y < -0.4, `boar A wades the creek bed at ${a.y}`); assert.ok(b.y > 0.4, `boar B climbs into the pocket at ${b.y}`);
  const snapshot = game.snapshot('BONES').hunt.animals;
  assert.deepEqual(snapshot.map(s => s.y), [a.y, b.y]);
});

test('hunt slice: anatomy, body contact and rush checks are measured from each boar\'s own ground', () => {
  const { game, hunters, hunt } = slice(), [a, b] = hunt.animals, p = hunters[0];
  Object.assign(a, { x: -14.6, z: -14, yaw: Math.PI / 2 }); hunt.moveAnimal(a, 0, 0);
  Object.assign(b, { x: 22, z: -15, yaw: 0 }); hunt.moveAnimal(b, 0, 0);
  for (const boar of [a, b]) {
    // A level shot through the chest at the boar's own ground plus 0.96 m.
    const hit = hitAnatomy(boar, toWorld(boar, { x: 2, y: 0.96, z: -0.34 }), toWorld(boar, { x: -2, y: 0.96, z: -0.34 }));
    assert.equal(hit?.region.name, 'chest');
    assert.ok(near(hit.worldPoint.y, boar.y + hit.point.y), 'world hit point includes the ground height');
    // The same world-height shot that would hit a boar on the flat floor does not.
    const flat = hitAnatomy(boar, { x: boar.x + 2 * Math.cos(boar.yaw), y: 0.96, z: boar.z - 2 * Math.sin(boar.yaw) },
      { x: boar.x - 2 * Math.cos(boar.yaw), y: 0.96, z: boar.z + 2 * Math.sin(boar.yaw) });
    assert.notEqual(flat?.region.name, 'chest');
    const beside = { ...toWorld(boar, { x: 0.7, y: 0, z: 0 }) };
    assert.ok(bodyContact(beside, boar), 'a hunter standing on the same ground collides');
    assert.equal(bodyContact({ ...beside, y: boar.y + BODY_CLEARANCE }, boar), null, 'a hunter clearing the back does not');
  }
  // Rush contact on the raised pocket: grounded hunter is hit, one leaping 1.1 m above that ground is not.
  Object.assign(b, { state: 'charge', vx: 0, vz: -6 });
  const q = hunters[1];
  Object.assign(p.state, { ...toWorld(b, { x: 0, y: 0, z: -0.95 }), grounded: true });
  Object.assign(q.state, { ...toWorld(b, { x: 0.2, y: 1.1, z: -0.95 }), grounded: false });
  hunt.rushContacts(b, 100, new Map([[p.id, p], [q.id, q]]));
  assert.ok(b.hitPlayers.has(p.id)); assert.ok(!b.hitPlayers.has(q.id));
  assert.equal(game.world.terrain, RAVINE_LAYOUT.terrain);
});
const BODY_CLEARANCE = 1.45;

test('hunt slice: a thrown spear passes the water surface and rests on the creek bed, recoverable', () => {
  const { game, hunters, hunt } = slice(), p = hunters[0];
  park(hunt, ...hunt.animals);
  const from = { x: -9.5, y: 1.2, z: -12 };
  hunt.projectiles.push({ id: 7001, owner: p.id, born: 1, ...from, vx: -9, vy: -2, vz: 0 });
  for (let tick = 2; tick < 200 && hunt.projectiles.length; tick++) hunt.stepProjectiles(tick, game.rooms.get('BONES').players);
  const spear = hunt.spears.find(s => s.id === 7001);
  assert.equal(spear?.status, 'ground');
  const water = waterAt(game.world, spear.x, spear.z);
  assert.ok(water, `spear came to rest in the creek at ${spear.x},${spear.z}`);
  assert.ok(near(spear.y, groundHeight(game.world, spear.x, spear.z) + TERRAIN.spearRest, 1e-6));
  assert.ok(spear.y < water.level, 'it lies under the surface, not on it');
  // Recover it by wading in.
  Object.assign(p.state, { x: spear.x + 0.8, z: spear.z, y: groundHeight(game.world, spear.x + 0.8, spear.z) });
  hunt.setSpears(p, 2);
  hunt.action(p, { ...neutralInput(), interact: true }, 300, game.rooms.get('BONES').players);
  assert.equal(p.spears, 3); assert.ok(!hunt.spears.some(s => s.id === 7001));
});

test('hunt slice: a spear meets a rising ramp at its true height; the flat-floor contact formula is unchanged', () => {
  // March a level, low shaft east through the pass in projectile-sized steps.
  let contact = null;
  for (let x = 9.5; x < 18 && !contact; x += 0.45) {
    const from = { x, y: 0.25, z: -13.2 }, to = { x: x + 0.45, y: 0.25, z: -13.2 }, t = groundContact(world, from, to);
    if (t !== null) contact = from.x + (to.x - from.x) * t;
  }
  assert.ok(contact > 10 && contact < 16, `stopped on the ramp at x=${contact}`);
  assert.ok(near(groundHeight(world, contact, -13.2) + TERRAIN.spearSkin, 0.25, 0.005));
  assert.equal(groundContact({}, { x: 0, y: 0.25, z: 0 }, { x: 5, y: 0.25, z: 0 }), null, 'level flight above a flat floor never touches it');
  const legacy = { x: 0, y: 1, z: 0 }, low = { x: 1, y: -0.2, z: 0 };
  assert.equal(groundContact(createLegacyWorld(), legacy, low), (1 - 0.05) / (1 - -0.2));
});

test('hunt slice: a thrust on the raised pocket strikes a boar there instead of the ground skin', () => {
  const { game, hunters, hunt } = slice(), [a, b] = hunt.animals, p = hunters[0];
  park(hunt, b);
  Object.assign(a, { x: 22, z: -16.2, yaw: Math.PI / 2, state: 'patrol' }); hunt.moveAnimal(a, 0, 0);
  const y = groundHeight(game.world, 22, -14.6);
  Object.assign(p.state, { x: 22, y, z: -14.6, yaw: 0, pitch: -0.18, grounded: true, stamina: 100 });
  const players = game.rooms.get('BONES').players;
  hunt.action(p, { ...neutralInput(0, -0.18), attack: true }, 1000, players);
  for (let tick = 1001; tick < 1030; tick++) hunt.stepThrusts(tick, players);
  assert.equal(a.wounds.length, 1, 'the boar on the raised floor was struck');
  assert.ok(hunt.events.some(e => e.type === 'hit' && e.animalId === a.id));
});

test('hunt slice: the brain is unchanged on the frozen clearing, and seeded ravine hunts are deterministic and grounded', () => {
  const legacy = runAIScenario(11, 400), again = runAIScenario(11, 400);
  assert.equal(legacy.digest, again.digest);
  const ravineA = runAIScenario(7, 900, createWorld()), ravineB = runAIScenario(7, 900, createWorld());
  assert.equal(ravineA.digest, ravineB.digest);
  // Drive one more ravine hunt directly and audit every tick.
  const game = new GameState();
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: id }));
  const hunt = game.rooms.get('BONES').hunt;
  hunt.seed = 2026; hunt.spawnAnimals();
  for (let tick = 1; tick <= 900; tick++) {
    for (const [k, p] of hunters.entries()) {
      const target = hunt.animals[k % 2], yaw = Math.atan2(-(target.x - p.state.x), -(target.z - p.state.z));
      game.receiveInput(p.id, 'BONES', [{ ...neutralInput(yaw, 0), forward: 1, sprint: k % 2 === 1, seq: p.lastReceivedSequence + 1 }], tick * 1000 / 60);
    }
    game.step(tick * 1000 / 60);
    for (const a of hunt.animals) {
      assert.equal(a.y, groundHeight(game.world, a.x, a.z));
      assert.ok(Number.isFinite(a.x) && Number.isFinite(a.z));
      for (const o of game.world.obstacles) assert.equal(bodyContact({ ...o, y: a.y }, a, o.radius - 0.02), null, `boar inside ${o.x},${o.z}`);
    }
    for (const p of hunters) if (p.state.grounded) assert.equal(p.state.y, groundHeight(game.world, p.state.x, p.state.z));
  }
  assert.ok(FIXED_DT > 0);
});

test('hunt slice: HuntState accepts the legacy flat world and the ravine with identical boar spawn ground', () => {
  for (const w of [createLegacyWorld(), createWorld()]) {
    const hunt = new HuntState(w, { seed: 5 });
    assert.deepEqual(hunt.animals.map(a => a.y), [0, 0]);
    assert.deepEqual(hunt.snapshot().animals.map(a => a.y), [0, 0]);
  }
});
