import test from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../../simulation/gameState.js';
import { HuntState } from '../../simulation/huntState.js';
import { changeState } from '../../simulation/boarBrain.js';
import { BOAR_AI } from '../../simulation/boarTuning.js';
import { hitAnatomy } from '../../simulation/anatomy.js';
import { HUNT, flatDistance, interactionHint } from '../../shared/hunt.js';
import { MAX_PLAYERS, PLAYER } from '../../shared/config.js';
import { bodyContact, toWorld } from '../../shared/body.js';
import { neutralInput } from '../../shared/movement.js';

function fixture() {
  const game = new GameState();
  game.world = { ...game.world, obstacles: [] };
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: `Hunter ${id}` }));
  const { hunt, players } = game.rooms.get('BONES');
  hunt.seed = 7; hunt.spawnAnimals();
  return { game, hunt, players, hunters, a: hunt.animals[0], b: hunt.animals[1] };
}
function place(f, a, x, z, yaw = 0) {
  Object.assign(a, { x, z, yaw }); f.hunt.previousAnimals.set(a.id, { ...a });
}
function step(f, player = null, extra = {}) {
  const tick = f.game.tick + 1;
  if (player) assert.equal(f.game.receiveInput(player.id, 'BONES', [{ ...neutralInput(player.state.yaw, player.state.pitch),
    seq: player.lastReceivedSequence + 1, ...extra }], tick * 1000 / 60), true);
  f.game.step(tick * 1000 / 60);
}
function advance(f, ticks) { for (let i = 0; i < ticks; i++) step(f); }
function torso(a, region = 'chest') {
  // Integrity hotfix: aim at the refitted visible hind leg (gaskin/hock).
  const local = region === 'legs' ? { y: .45, z: 1.22 } : { y: .92, z: -.29 };
  return hitAnatomy(a, toWorld(a, { x: 2, ...local }), toWorld(a, { x: -2, ...local }));
}
function windup(f, p, aim) { for (let i = 0; i < 54; i++) step(f, p, { ...aim, throwStart: i === 0, throwHeld: true }); }
function freezeCombat(f) {
  // Combat geometry tests keep bodies stationary; separate tests below exercise
  // both real brains, with no action/tempo overrides.
  f.hunt.stepAnimal = a => { a.vx = a.vz = 0; };
}
function focus(f, index, traits) {
  const a = f.hunt.animals[index], other = f.hunt.animals[1 - index];
  place(f, a, 0, -14); place(f, other, 26, -14);
  Object.assign(a.traits, traits); a.decisionSeed = 1;
  return a;
}
function ring(f, a, radius = 5.5) {
  f.hunters.forEach((p, i) => {
    const angle = i * Math.PI / 2;
    Object.assign(p.state, { x: a.x + Math.cos(angle) * radius, z: a.z + Math.sin(angle) * radius,
      yaw: Math.atan2(Math.cos(angle), Math.sin(angle)) });
  });
}

test('1.2.2: fresh rooms have exactly two live independent boars and four safe, distinct hunter slots', () => {
  const game = new GameState();
  const hunters = Array.from({ length: MAX_PLAYERS }, (_, i) => game.addPlayer(`${i}`, { room: 'BONES', name: `Hunter ${i}` }));
  const hunt = game.rooms.get('BONES').hunt, [a, b] = hunt.animals;
  assert.equal(MAX_PLAYERS, 4); assert.equal(hunt.animals.length, 2); assert.ok(hunt.animals.every(a => a.health === HUNT.boarHealth));
  assert.equal(new Set(hunt.animals.map(a => a.id)).size, 2); assert.ok(flatDistance(a, b) < 5);
  for (const field of ['traits', 'threats', 'wounds', 'hitPlayers', 'huntMemory', 'awareHunters', 'pressureParts', 'intentTrace', 'escape']) {
    assert.notEqual(a[field], b[field], `${field} must not share a mutable reference`);
  }
  assert.notDeepEqual(a.traits, b.traits);
  assert.notEqual(hunt.brains.get(a.id), hunt.brains.get(b.id));
  assert.equal(new Set(hunters.map(p => p.color)).size, 4);
  for (const [i, p] of hunters.entries()) {
    assert.equal(p.slot, i); assert.ok(flatDistance(p.state, HUNT.camp) > 1.2, 'spawn must clear the fire');
    for (const q of hunters.slice(i + 1)) assert.ok(flatDistance(p.state, q.state) > 2 * PLAYER.radius);
    for (const boar of hunt.animals) assert.equal(bodyContact(p.state, boar), null);
    for (const o of game.world.obstacles) assert.ok(flatDistance(p.state, o) > o.radius + PLAYER.radius);
  }
  for (const boar of hunt.animals) for (const o of game.world.obstacles) assert.equal(bodyContact({ ...o, y: 0 }, boar, o.radius), null);
  assert.throws(() => game.addPlayer('fifth', { room: 'BONES', name: 'Fifth' }), /room is full/);
});

test('1.2.2: both boars perceive all four hunters and retain separate per-hunter threat and pursuit records', () => {
  const f = fixture(); place(f, f.a, 0, -14); place(f, f.b, 3.5, -14);
  const positions = [{ x: -4, z: -14 }, { x: 7.5, z: -14 }, { x: 1.75, z: -19 }, { x: 1.75, z: -10 }];
  f.hunters.forEach((p, i) => Object.assign(p.state, positions[i]));
  step(f);
  for (const a of f.hunt.animals) {
    assert.deepEqual(new Set(a.awareHunters.map(p => p.id)), new Set(f.players.keys()));
    assert.equal(a.threats.size, 4); assert.equal(a.huntMemory.size, 4);
    assert.ok(a.surrounded); assert.ok(a.pressure >= BOAR_AI.surroundPressure);
    assert.ok(Number.isFinite(a.decisionSeconds) && a.decisionSeconds < .3);
  }
  for (const p of f.hunters) {
    assert.notEqual(f.a.threats.get(p.id), f.b.threats.get(p.id));
    assert.notEqual(f.a.huntMemory.get(p.id), f.b.huntMemory.get(p.id));
  }
  f.a.threats.get('d').damage = 80;
  assert.equal(f.b.threats.get('d').damage, 0);
  f.players.delete('d'); advance(f, 4);
  for (const a of f.hunt.animals) { assert.equal(a.threats.has('d'), false); assert.equal(a.huntMemory.has('d'), false); }
});

test('1.2.2: split hunts can select different hunters without sharing targets or attack hit sets', () => {
  const f = fixture(); place(f, f.a, -6, -14); place(f, f.b, 6, -14);
  const [p, q, r, s] = f.hunters;
  Object.assign(p.state, { x: -6, z: -16 }); Object.assign(q.state, { x: -10, z: -14 });
  Object.assign(r.state, { x: 10, z: -14 }); Object.assign(s.state, { x: 6, z: -16 });
  for (const a of f.hunt.animals) Object.assign(a.traits, { courage: .9, caution: .2 });
  advance(f, 20);
  assert.equal(f.a.targetId, p.id); assert.equal(f.b.targetId, s.id);
  assert.ok(p.health < 100 && s.health < 100);
  assert.ok(f.hunt.events.some(e => e.type === 'hurt' && e.player === s.id && e.animalId === f.b.id));
  f.a.hitPlayers.add(q.id); assert.equal(f.b.hitPlayers.has(q.id), false);
});

for (const index of [0, 1]) test(`1.2.2: boar ${index + 1} commits and executes a close action under four-way pressure`, () => {
  const f = fixture(), a = focus(f, index, { courage: .9, caution: .2 }), p = f.hunters[3];
  ring(f, a, 5.5); Object.assign(p.state, { x: 0, z: -16, yaw: Math.PI });
  const dominant = f.hunters[0]; a.threats.set(dominant.id, { seen: 0, x: dominant.state.x, z: dominant.state.z, damage: 100 });
  a.targetId = dominant.id; a.targetPosition = { x: dominant.state.x, z: dominant.state.z };
  changeState(a, 'assess', 0, 3);
  for (let i = 0; i < 16 && a.state === 'assess'; i++) step(f, p);
  assert.equal(a.state, 'gore'); assert.equal(a.immediateHunter, p.id);
  const chosen = a.stateTick, strike = a.attackAt;
  while (f.game.tick < strike) {
    step(f, p, { strafe: f.game.tick % 2 ? 1 : -1, yaw: Math.PI + (f.game.tick % 2 ? .01 : -.01) });
    assert.equal(a.stateTick, chosen); assert.equal(a.attackAt, strike);
  }
  assert.ok(a.attackDone); assert.ok(p.health < 100, 'rapid analysis must result in physical contact');
});

for (const index of [0, 1]) test(`1.2.2: boar ${index + 1} retains its escape gap under four jiggling hunters`, () => {
  const f = fixture(), a = focus(f, index, { courage: .2, caution: .9 }); ring(f, a);
  step(f); assert.equal(a.state, 'flee'); assert.ok(a.surrounded && a.escapeOpen);
  const goal = { ...a.tacticGoal }, chosen = a.stateTick, start = { x: a.x, z: a.z };
  for (let i = 0; i < 30; i++) {
    f.hunters.forEach((p, j) => { p.state.z += Math.sin(i + j) * .01; }); step(f);
    assert.equal(a.stateTick, chosen); assert.deepEqual(a.tacticGoal, goal);
  }
  assert.ok(flatDistance(a, start) > 2.5); assert.ok(a.decisionSeconds < .3);
  assert.equal(a.intentTrace.length, 1, 'pressure speeds analysis without resetting locomotion');
});

test('1.2.2: the fourth hunter independently triggers existing hostile-approach sprint-away behavior on both boars', () => {
  const f = fixture(), p = f.hunters[3];
  Object.assign(p.state, { x: 0, z: -13, yaw: Math.PI });
  for (const a of f.hunt.animals) Object.assign(a.traits, { courage: .2, caution: .9 });
  for (let i = 0; i < 36; i++) step(f, p, { forward: 1, sprint: true });
  for (const a of f.hunt.animals) {
    assert.ok(a.threats.has(p.id)); assert.ok(a.huntMemory.has(p.id));
    assert.ok(a.intentTrace.some(t => t.state === 'flee'));
    assert.equal(a.wounds.length, 0); assert.ok(flatDistance(a, p.state) > HUNT.thrustReach);
  }
});

test('1.2.2: a badly injured cautious boar still prioritizes committed escape under four-way pressure', () => {
  const f = fixture(), a = focus(f, 1, { courage: .2, caution: .9 }); ring(f, a);
  f.hunt.impact(a, torso(a, 'legs'), 26, 'throw', 'd', 0);
  f.hunt.impact(a, torso(a), 26, 'throw', 'd', 0);
  Object.assign(a, { health: 25, blood: .4, lung: .7, limp: .8, breath: .04 });
  a.acuteReaction = null; // Check ongoing wounded escape priority after the acute event.
  changeState(a, 'assess', 0, 0);
  const start = { x: a.x, z: a.z }; step(f); const chosen = a.stateTick;
  assert.equal(a.state, 'flee');
  for (let i = 0; i < 30; i++) { step(f); assert.equal(a.stateTick, chosen); }
  assert.ok(flatDistance(a, start) > .15); assert.equal(a.breath, 0); assert.ok(a.health < 25 && a.health > 0);
  assert.ok(a.limp > 0 && a.lung > 0 && a.blood < .4, 'injury remains physically limiting throughout the escape');
});

test('1.2.2: wounds, trauma, lodged shafts, bleed tracks and death stay on their struck boar', () => {
  const f = fixture(); place(f, f.a, -4, -14); place(f, f.b, 4, -14);
  const untouched = structuredClone(f.b);
  const woundA = f.hunt.impact(f.a, torso(f.a, 'legs'), 26, 'throw', 'd', 1, { id: 9000, vx: -26, vy: 0, vz: 0 });
  assert.deepEqual(f.b, untouched); assert.ok(f.a.acuteReaction); assert.equal(f.b.acuteReaction, null);
  const woundB = f.hunt.impact(f.b, torso(f.b), 26, 'throw', 'b', 1, { id: 9001, vx: -26, vy: 0, vz: 0 });
  assert.notEqual(woundA.id, woundB.id);
  for (const a of f.hunt.animals) f.hunt.stepWounds(a, 2);
  assert.ok(f.a.limp > 0); assert.equal(f.a.lung, 0); assert.ok(f.b.lung > 0); assert.equal(f.b.limp, 0);
  assert.equal(f.a.wounds.length, 1); assert.equal(f.b.wounds.length, 1);
  assert.deepEqual(new Set(f.hunt.tracks.map(t => t.animalId)), new Set([f.a.id, f.b.id]));
  const shaftB = f.hunt.spears.find(s => s.animalId === f.b.id), point = f.hunt.spearPoint(shaftB);
  f.a.x += 10; assert.deepEqual(f.hunt.spearPoint(shaftB), point);
  f.b.x += 2; assert.ok(Math.abs(f.hunt.spearPoint(shaftB).x - point.x - 2) < 1e-9);
  const healthB = f.b.health; f.hunt.kill(f.a, 3, 'd');
  assert.equal(f.b.health, healthB); assert.ok(f.b.health > 0); assert.notEqual(f.b.state, 'dead');
  assert.equal(f.hunt.events.filter(e => e.type === 'kill').length, 1);
  assert.equal(f.hunt.events.find(e => e.type === 'kill').animalId, f.a.id);
});

test('1.2.2: a moving spear is advanced once and hits the first live boar along its sweep, independent of collection order', () => {
  for (const reverse of [false, true]) {
    const f = fixture(); place(f, f.a, 0, -14); place(f, f.b, 4, -14);
    if (reverse) f.hunt.animals.reverse();
    f.hunt.projectiles.push({ id: 9000, owner: 'd', born: 1, x: 8, y: .92, z: -14.29, vx: -600, vy: 0, vz: 0 });
    f.hunt.stepProjectiles(1, f.players);
    assert.equal(f.a.wounds.length, 0); assert.equal(f.b.wounds.length, 1);
    assert.equal(f.hunt.events.filter(e => e.type === 'hit').length, 1);
    assert.ok(f.hunt.spears.some(s => s.status === 'embedded' && s.animalId === f.b.id && s.owner === 'd'));
  }
  const f = fixture(); place(f, f.a, 0, -14); place(f, f.b, 4, -14);
  f.hunt.kill(f.b, 0, 'a');
  f.hunt.projectiles.push({ id: 9000, owner: 'd', born: 1, x: 8, y: .92, z: -14.29, vx: -600, vy: 0, vz: 0 });
  f.hunt.stepProjectiles(1, f.players); assert.equal(f.a.wounds.length, 1);
  assert.equal(f.hunt.spears.find(s => s.id === 9000).animalId, f.a.id);
});

test('1.2.2: obstacles stop a swept weapon before either boar', () => {
  const f = fixture(); place(f, f.a, 0, -14); place(f, f.b, 4, -14);
  f.hunt.world = { ...f.game.world, obstacles: [{ x: 6, z: -14.29, radius: .5 }] };
  f.hunt.projectiles.push({ id: 9000, owner: 'd', born: 1, x: 8, y: .92, z: -14.29, vx: -600, vy: 0, vz: 0 });
  f.hunt.stepProjectiles(1, f.players);
  assert.ok(f.hunt.animals.every(a => a.wounds.length === 0)); assert.equal(f.hunt.spears[0].status, 'ground');
});

test('1.2.2: fourth hunter throws, embeds and extracts a real spear from either boar without affecting the other wound', () => {
  const f = fixture(), p = f.hunters[3]; place(f, f.a, -4, -14); place(f, f.b, 4, -14); freezeCombat(f);
  for (const a of [f.a, f.b]) {
    Object.assign(p.state, { x: a.x + 3.2, z: a.z - .3 });
    const aim = { yaw: Math.atan2(3.2, .3), pitch: -.15 };
    windup(f, p, aim); step(f, p, { ...aim, throw: true }); advance(f, 25);
    const spear = f.hunt.spears.find(s => s.animalId === a.id);
    assert.ok(spear); assert.equal(spear.owner, p.id); assert.equal(p.spears, 2);
    Object.assign(p.state, { x: a.x + 2, z: a.z - .29 });
    const other = f.hunt.animals.find(b => b.id !== a.id), bleed = other.wounds.map(w => w.bleed);
    step(f, p, { interact: true }); assert.ok(p.recovery); advance(f, 28);
    assert.equal(p.recovery, null); assert.equal(p.spears, 3); assert.ok(!f.hunt.spears.some(s => s.id === spear.id));
    assert.deepEqual(other.wounds.map(w => w.bleed), bleed);
    assert.ok(f.hunt.events.some(e => e.type === 'recovered' && e.animalId === a.id && e.player === p.id));
  }
  assert.equal(f.a.wounds.length, 1); assert.equal(f.b.wounds.length, 1);
  f.hunt.setSpears(p, 1); f.hunt.spears.push({ id: 9002, status: 'ground', x: p.state.x + .2, y: .1, z: p.state.z });
  step(f, p, { strafe: 1, interact: true }); assert.equal(p.spears, 2); assert.equal(f.hunt.spears.length, 0);
});

test('1.2.2: fourth hunter thrusts either boar once per stroke and is targetable by either boar', () => {
  for (const index of [0, 1]) {
    const f = fixture(), a = f.hunt.animals[index], other = f.hunt.animals[1 - index], p = f.hunters[3];
    place(f, a, -4, -14); place(f, other, 4, -14); freezeCombat(f);
    Object.assign(p.state, { x: a.x + 2.3, z: a.z - .29, yaw: Math.PI / 2, pitch: -.23 });
    step(f, p, { attack: true }); advance(f, 45);
    assert.equal(a.wounds.length, 1); assert.equal(other.wounds.length, 0); assert.equal(p.spears, 3);
    assert.equal(f.hunt.events.find(e => e.type === 'hit').animalId, a.id);
    assert.ok(a.acuteReaction, 'the existing serious melee interrupt is queued on the struck entity');
    // Restore the real brain after the deterministic stroke.
    delete f.hunt.stepAnimal; Object.assign(p.state, { x: a.x, z: a.z - 2, pitch: 0 });
    step(f); assert.equal(a.targetId, p.id); assert.ok(a.acute); assert.equal(other.acute, null);
  }
});

test('1.2.2: embedded extraction consults its own boar for speed, pulling alarm and wound worsening', () => {
  const f = fixture(), p = f.hunters[3]; place(f, f.a, -4, -14); place(f, f.b, 4, -14);
  const wound = f.hunt.impact(f.a, torso(f.a), 26, 'throw', p.id, 1, { id: 9000, vx: -26, vy: 0, vz: 0 });
  f.hunt.kill(f.a, 2, p.id); f.b.vx = 8;
  Object.assign(p.state, { x: f.a.x + 2, z: f.a.z - .29 }); f.hunt.setSpears(p, 1);
  f.hunt.action(p, { interact: true }, 3, f.players); assert.equal(p.rawMeat, 2);
  f.hunt.action(p, { interact: true }, 4, f.players); assert.ok(p.recovery);
  f.hunt.stepPlayers(35, f.players); assert.equal(p.spears, 2); assert.equal(p.recovery, null);
  assert.equal(f.b.acuteReaction, null); assert.ok(wound.bleed > 0);
  const living = f.hunt.impact(f.b, torso(f.b), 26, 'throw', p.id, 40, { id: 9001, vx: -26, vy: 0, vz: 0 });
  f.b.acuteReaction = null; f.b.vx = 0;
  Object.assign(p.state, { x: f.b.x + 2, z: f.b.z - .29 });
  f.hunt.action(p, { interact: true }, 41, f.players);
  assert.equal(f.b.acuteReaction.kind, 'pull'); assert.equal(f.a.acuteReaction, null);
  const oldBleed = living.bleed; f.hunt.stepPlayers(80, f.players); assert.ok(living.bleed > oldBleed);
});

test('1.2.2: one carcass can be harvested and cooked by all four while the other boar remains alive; fresh reset restores both', () => {
  const f = fixture(); place(f, f.a, -4, -14); place(f, f.b, 4, -14); freezeCombat(f);
  const oldIds = f.hunt.animals.map(a => a.id); f.hunt.kill(f.a, 0, 'a');
  for (const p of f.hunters) {
    Object.assign(p.state, { x: f.a.x + 2, z: f.a.z });
    step(f, p, { interact: true }); step(f, p, { interact: true });
    assert.equal(p.rawMeat, 2); assert.deepEqual([...p.harvestedAnimals], [f.a.id]);
  }
  assert.equal(f.a.meat, 0); assert.equal(f.b.health, HUNT.boarHealth); assert.equal(f.b.wounds.length, 0);
  f.hunters.forEach(p => Object.assign(p.state, f.game.world.spawns[p.slot]));
  step(f, f.hunters[3], { restart: true }); assert.equal(f.hunt.round, 1, 'a live second boar cannot be erased by R');
  for (const p of f.hunters) step(f, p, { interact: true }); advance(f, 150);
  assert.equal(f.hunt.meals, 4); assert.ok(f.hunters.every(p => p.cookedMeat === 1 && p.rawMeat === 1));
  const snapshot = f.game.snapshot('BONES');
  assert.equal(interactionHint(snapshot.players[3], snapshot.hunt).includes('Start'), false);
  f.hunt.kill(f.b, f.game.tick, 'd');
  for (const p of f.hunters) {
    Object.assign(p.state, { x: f.b.x + 2, z: f.b.z }); step(f, p, { interact: true });
    assert.equal(p.rawMeat, 3); assert.deepEqual(new Set(p.harvestedAnimals), new Set(oldIds));
  }
  f.hunters.forEach(p => Object.assign(p.state, f.game.world.spawns[p.slot]));
  step(f, f.hunters[3], { restart: true });
  assert.equal(f.hunt.round, 2); assert.equal(f.hunt.animals.length, 2); assert.ok(f.hunt.animals.every(a => a.health === HUNT.boarHealth));
  assert.ok(f.hunt.animals.every(a => !oldIds.includes(a.id) && !a.wounds.length && !a.huntMemory.size && !a.threats.size));
  assert.equal(f.hunt.spears.length, 0); assert.equal(f.hunt.tracks.length, 0); assert.equal(f.hunt.meals, 0);
  assert.ok(f.hunters.every(p => p.health === 100 && p.spears === 3 && !p.harvestedAnimals.size && p.rawMeat === 0));
  assert.equal(f.players.size, 4); assert.deepEqual(f.hunters.map(p => p.slot), [0, 1, 2, 3]);
  assert.throws(() => f.game.addPlayer('fifth', { room: 'BONES', name: 'Fifth' }), /room is full/);
});

test('1.2.2: dead-boar recovery and harvest do not stop the live second brain from responding to hunter four', () => {
  const f = fixture(), p = f.hunters[3]; place(f, f.a, -6, -14); place(f, f.b, 6, -14);
  f.hunt.kill(f.a, 0, 'a'); Object.assign(f.b.traits, { courage: .9, caution: .2 });
  Object.assign(p.state, { x: 6, z: -16 }); Object.assign(f.hunters[0].state, { x: -4, z: -14 });
  step(f, f.hunters[0], { interact: true }); advance(f, 20);
  assert.equal(f.hunters[0].rawMeat, 2); assert.equal(f.a.state, 'dead');
  assert.equal(f.b.targetId, p.id); assert.ok(p.health < 100); assert.equal(f.b.wounds.length, 0);
});

test('1.2.2: public and developer snapshots identify both boars without exposing hidden AI in gameplay', () => {
  const f = fixture(); const snapshot = f.hunt.snapshot(), debug = f.hunt.debugSnapshot(1);
  assert.equal(snapshot.animal, undefined); assert.equal(snapshot.animals.length, 2); assert.equal(debug.animals.length, 2);
  assert.deepEqual(snapshot.animals.map(a => a.id), debug.animals.map(a => a.id));
  for (const a of snapshot.animals) for (const key of ['pressure', 'traits', 'acute', 'targetId', 'huntMemory', 'intentTrace', 'health']) assert.equal(a[key], undefined);
  assert.doesNotThrow(() => JSON.stringify(debug));
});

test('1.2.2: a fourth-hunter brace lodges in the rushing entity and does not stagger the other boar', () => {
  const f = fixture(), a = f.b, p = f.hunters[3]; place(f, f.a, -8, -14); place(f, a, 0, -14, Math.PI);
  Object.assign(a, { state: 'charge', vx: 0, vz: 8 });
  Object.assign(p.state, { x: 0, z: -11.1, yaw: 0, pitch: -.3, bracing: true, braceTime: 1 });
  f.hunt.stepBraces(a, 60, f.players); f.hunt.rushContacts(a, 60, f.players);
  assert.equal(a.state, 'stagger'); assert.equal(a.wounds.length, 1); assert.equal(p.spears, 2);
  assert.ok(f.hunt.spears.some(s => s.status === 'embedded' && s.animalId === a.id));
  assert.equal(f.a.wounds.length, 0); assert.equal(f.a.state, 'patrol');
  assert.equal(f.hunt.events.find(e => e.type === 'braced').animalId, a.id);
});

test('1.2.2: moving-body sweeps use the struck second boar previous transform, not the first boar history', () => {
  const f = fixture(); place(f, f.a, -4, -14); place(f, f.b, 0, -14);
  f.hunt.previousAnimals.set(f.b.id, { ...f.b, x: 2 }); f.b.vx = -120;
  f.hunt.projectiles.push({ id: 9000, owner: 'd', born: 1, x: 2, y: .92, z: -14.29, vx: 6, vy: 0, vz: 0 });
  f.hunt.stepProjectiles(1, f.players);
  assert.equal(f.a.wounds.length, 0); assert.equal(f.b.wounds.length, 1);
  assert.equal(f.hunt.events.find(e => e.type === 'hit').animalId, f.b.id);
});

test('1.2.2: fourth-hunter authoritative movement and landing cannot start inside either boar', () => {
  const f = fixture(), p = f.hunters[3]; place(f, f.a, -4, -14); place(f, f.b, 4, -14); freezeCombat(f);
  for (const a of f.hunt.animals) {
    Object.assign(p.state, { x: a.x, y: 1.41, z: a.z, vy: -10, grounded: false });
    step(f, p, { attack: true }); assert.equal(bodyContact(p.state, a), null);
    assert.ok(Number.isFinite(p.state.x) && Number.isFinite(p.state.z));
    Object.assign(p.state, { x: a.x + 3, y: 0, z: a.z, yaw: Math.PI / 2, grounded: true, knockTicks: 0 });
    for (let i = 0; i < 40; i++) { step(f, p, { forward: 1, sprint: true }); assert.equal(bodyContact(p.state, a), null); }
  }
});

test('1.2.2: two real brains and four attacking hunters sustain a finite, bounded 20-second combat simulation', () => {
  const f = fixture(); place(f, f.a, -4, -14); place(f, f.b, 4, -14);
  Object.assign(f.a.traits, { courage: .2, caution: .9 }); Object.assign(f.b.traits, { courage: .9, caution: .2 });
  const positions = [{ x: -6, z: -14 }, { x: -4, z: -18 }, { x: 6, z: -14 }, { x: 4, z: -10 }];
  f.hunters.forEach((p, i) => Object.assign(p.state, positions[i]));
  const travel = new Map(f.hunt.animals.map(a => [a.id, 0])), executed = new Set();
  for (let frame = 0; frame < 1200; frame++) {
    const tick = f.game.tick + 1, before = f.hunt.animals.map(a => ({ x: a.x, z: a.z }));
    f.hunters.forEach((p, i) => {
      const preferred = i < 2 ? f.a : f.b, a = preferred.health > 0 ? preferred : f.hunt.animals.find(a => a.health > 0);
      if (!a) return;
      const distance = flatDistance(p.state, a), flight = Math.max(0, (distance - .45) / 30);
      const target = { x: a.x - Math.sin(a.yaw) * .29 + a.vx * flight * .5, z: a.z - Math.cos(a.yaw) * .29 + a.vz * flight * .5 };
      const yaw = Math.atan2(p.state.x - target.x, p.state.z - target.z);
      const pitch = Math.atan2(.95 + HUNT.spearGravity * flight ** 2 / 2 - flight - (p.state.y + 1.54), distance);
      const phase = (frame + i * 30) % 180, drawing = distance > 3.8 && distance < 18 && phase < 54;
      const input = { ...neutralInput(yaw, pitch), seq: p.lastReceivedSequence + 1, forward: distance > 2 ? 1 : 0,
        sprint: distance > 5.5, attack: distance < 3.3 && frame % 45 === i,
        throwStart: drawing && phase === 0, throwHeld: drawing, throw: phase === 54 };
      assert.equal(f.game.receiveInput(p.id, 'BONES', [input], tick * 1000 / 60), true);
    });
    f.game.step(tick * 1000 / 60);
    assert.equal(f.players.size, 4); assert.equal(f.hunt.animals.length, 2);
    f.hunt.animals.forEach((a, i) => {
      travel.set(a.id, travel.get(a.id) + flatDistance(a, before[i]));
      if (a.attackDone || a.hitPlayers.size) executed.add(a.id);
      for (const key of ['x', 'z', 'yaw', 'vx', 'vz', 'health', 'blood', 'breath', 'decisionSeconds']) assert.ok(Number.isFinite(a[key]), `${a.id}.${key}`);
      assert.ok(a.threats.size <= 4 && a.huntMemory.size <= 4 && a.intentTrace.length <= BOAR_AI.traceLimit);
      assert.ok(a.pressure >= 0 && a.pressure <= 1);
    });
    for (const p of f.hunters) {
      for (const key of ['x', 'y', 'z', 'stamina']) assert.ok(Number.isFinite(p.state[key]));
      assert.ok(p.spears >= 0 && p.spears <= 3 && p.health >= 0 && p.health <= 100);
    }
    assert.doesNotThrow(() => JSON.stringify(f.game.snapshot('BONES')));
  }
  assert.ok([...travel.values()].every(d => d > 5), 'both animals must execute survival movement');
  assert.ok(executed.has(f.b.id), 'a bold boar still executes physical close combat');
  assert.ok(f.hunt.animals.some(a => a.wounds.length > 0), 'real validated hunter attacks must reach a body');
  assert.notEqual(f.a.threats, f.b.threats); assert.notEqual(f.a.huntMemory, f.b.huntMemory);
});
