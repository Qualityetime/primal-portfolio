import { isolateBoar } from './helpers/hunt.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HUNT } from '../../shared/hunt.js';
import { BOAR_BODY, bodyContact, toWorld } from '../../shared/body.js';
import { createPlayerState, neutralInput, stepPlayer } from '../../shared/movement.js';
import { sanitizeBatch } from '../../shared/protocol.js';
import { HuntState } from '../../simulation/huntState.js';
import { hitAnatomy, injuryFor } from '../../simulation/anatomy.js';
import { temperament } from '../../simulation/boarBrain.js';

const world = { halfSize: 36, obstacles: [], spawns: [{ x: -2, y: 0, z: 5, yaw: 0 }] };
function fixture() {
  const hunt = new HuntState(world, { seed: 7 });
  isolateBoar(hunt);
  Object.assign(hunt.animals[0], { x: 0, z: -6, yaw: 0 }); hunt.previousAnimals.set(hunt.animals[0].id, { ...hunt.animals[0] });
  const p = { id: 'a', slot: 0, state: createPlayerState(world.spawns[0]), queue: [], ack: 0, lastReceivedSequence: 0 };
  hunt.addPlayer(p);
  return { hunt, a: hunt.animals[0], p, players: new Map([['a', p]]) };
}
const rays = {
  head: [{ x: 0, y: .75, z: -3 }, { x: 0, y: .75, z: 0 }],
  neck: [{ x: 2, y: 1.2, z: -.74 }, { x: 0, y: 1.2, z: -.74 }],
  chest: [{ x: 2, y: 1.1, z: -.28 }, { x: 0, y: 1.1, z: -.28 }],
  belly: [{ x: 2, y: .65, z: .25 }, { x: 0, y: .65, z: .25 }],
  rump: [{ x: 2, y: .95, z: .82 }, { x: 0, y: .95, z: .82 }],
  // Integrity hotfix: the refitted hind leg (gaskin/hock) of the visible 1.18x rig.
  legs: [{ x: 2, y: .45, z: 1.22 }, { x: 0, y: .45, z: 1.22 }],
};
for (const [region, ray] of Object.entries(rays)) test(`a swept physical spear reaches ${region} on a rotated animal`, () => {
  const { a } = fixture(); a.yaw = 1.23;
  const hit = hitAnatomy(a, ...ray.map(p => toWorld(a, p)));
  assert.equal(hit?.region.name, region);
  assert.ok(hit.directness > .8);
});

test('a tangent hit cuts shallowly while a direct hit penetrates and lodges', () => {
  const { a } = fixture();
  const direct = hitAnatomy(a, toWorld(a, { x: 2, y: .92, z: -.29 }), toWorld(a, { x: -2, y: .92, z: -.29 }));
  const tangent = hitAnatomy(a, toWorld(a, { x: 2, y: 1.482, z: -.29 }), toWorld(a, { x: -2, y: 1.482, z: -.29 }));
  const deep = injuryFor(direct, 26), shallow = injuryFor(tangent, 26);
  assert.equal(deep.glancing, false); assert.equal(deep.embedded, true);
  assert.equal(shallow.glancing, true); assert.equal(shallow.embedded, false);
  assert.ok(deep.trauma > shallow.trauma * 5); assert.ok(deep.bleed > shallow.bleed * 5);
});

test('head resistance, chest breathing and leg movement are independent injury consequences', () => {
  const head = fixture(), chest = fixture(), leg = fixture();
  for (const [f, region] of [[head, 'head'], [chest, 'chest'], [leg, 'legs']]) {
    f.hunt.impact(f.hunt.animals[0], hitAnatomy(f.a, ...rays[region].map(p => toWorld(f.a, p))), 26, 'throw', 'a', 1);
    f.hunt.stepWounds(f.hunt.animals[0], 2);
  }
  assert.ok(head.a.health > chest.a.health);
  assert.ok(chest.a.lung > 0); assert.equal(chest.a.limp, 0);
  assert.ok(leg.a.limp > 0); assert.equal(leg.a.lung, 0);
  const healthy = fixture();
  for (const f of [healthy, leg]) {
    Object.assign(f.a, { state: 'charge', until: 999, targetId: 'a', targetPosition: { x: 0, z: -20 } });
    Object.assign(f.p.state, { x: 0, z: -20 });
    f.hunt.stepAnimal(f.hunt.animals[0], 1, f.players);
  }
  assert.ok(Math.hypot(leg.a.vx, leg.a.vz) < Math.hypot(healthy.a.vx, healthy.a.vz));
});

test('a surviving wound loses blood, lays a bounded trail and eventually kills without another strike', () => {
  const { hunt, a } = fixture();
  hunt.impact(hunt.animals[0], hitAnatomy(a, ...rays.neck.map(p => toWorld(a, p))), 26, 'throw', 'a', 1);
  assert.ok(a.health > 0);
  for (let tick = 2; tick < 10000 && a.health > 0; tick++) { a.x += .003; hunt.stepWounds(hunt.animals[0], tick); }
  assert.equal(a.state, 'dead'); assert.equal(a.meat, HUNT.carcassMeat);
  assert.ok(hunt.tracks.length > 20 && hunt.tracks.length <= 128);
  assert.equal(hunt.events.filter(e => e.type === 'kill').length, 1);
});

for (const yaw of [0, Math.PI / 2, 1.23]) test(`shared collision blocks walking, sprinting and jumping at yaw ${yaw.toFixed(2)}`, () => {
  const a = { x: 0, z: 0, yaw, alive: true };
  for (const local of [{ x: 0, z: -4 }, { x: 0, z: 4 }, { x: 4, z: 0 }, { x: -4, z: 0 }]) {
    for (const sprint of [false, true]) {
      const position = toWorld(a, local), aim = Math.atan2(position.x, position.z);
      const state = createPlayerState({ ...position, y: 0, yaw: aim });
      for (let i = 0; i < 160; i++) {
        stepPlayer(state, { ...neutralInput(aim), forward: 1, sprint, jump: i % 60 === 0 }, world, 1 / 60, a);
        assert.equal(bodyContact(state, a), null, 'hunter must remain outside the body even on a landing tick');
      }
      assert.ok(Math.hypot(state.x, state.z) < 2.1);
    }
  }
});

test('centerline and landing overlaps resolve deterministically before an attack can originate inside', () => {
  const { a } = fixture();
  const state = createPlayerState({ x: a.x, y: BOAR_BODY.height + .01, z: a.z, yaw: 0 });
  state.grounded = false; state.vy = -10;
  stepPlayer(state, neutralInput(), world, 1 / 60, a);
  assert.equal(bodyContact(state, a), null);
  assert.ok(Number.isFinite(state.x) && Number.isFinite(state.z));
});

test('brace requires planted feet, time to settle, stamina, a spear and a stable facing', () => {
  const state = createPlayerState(world.spawns[0]); state.spears = 1;
  for (let i = 0; i < 30; i++) stepPlayer(state, { ...neutralInput(), brace: true }, world);
  assert.ok(state.braceTime >= HUNT.braceSeconds);
  for (const extra of [{ forward: 1 }, { strafe: 1 }, { jump: true }, { sprint: true }, { yaw: 1 }]) {
    const copy = { ...state };
    stepPlayer(copy, { ...neutralInput(), brace: true, ...extra }, world);
    assert.equal(copy.braceTime, 0);
  }
  for (const extra of [{ stamina: 8 }, { spears: 0 }, { knockTicks: 30 }, { grounded: false }, { impulseX: 3 }]) {
    const copy = { ...state, ...extra };
    stepPlayer(copy, { ...neutralInput(), brace: true }, world);
    assert.equal(copy.bracing, false);
  }
});

function braceFixture(stamina = 100) {
  const f = fixture();
  Object.assign(f.a, { x: 0, z: -6, yaw: Math.PI, state: 'charge', vx: 0, vz: 8 });
  Object.assign(f.p.state, { x: 0, z: -3.1, yaw: 0, pitch: -.3, stamina, bracing: true, braceTime: 1 });
  return f;
}
test('a planted brace turns real rushing momentum into a lodged wound and a recoil', () => {
  const { hunt, a, p, players } = braceFixture();
  hunt.stepBraces(hunt.animals[0], 60, players);
  assert.equal(a.wounds.length, 1); assert.ok(a.health < HUNT.boarHealth);
  assert.equal(p.spears, 2); assert.equal(hunt.spears[0].status, 'embedded');
  assert.equal(a.state, 'stagger', 'a settled aligned brace now interrupts a committed rush');
  assert.ok(a.wounds[0].depth > 0.8); assert.ok(HUNT.boarHealth - a.health > 12);
  assert.equal(hunt.events.find(e => e.type === 'braced').strong, true);
  assert.ok(p.state.impulseZ > 0);
});
test('an exhausted brace can wound the animal but loses the hunter balance', () => {
  const { hunt, p, players } = braceFixture(20);
  hunt.stepBraces(hunt.animals[0], 60, players);
  assert.ok(p.state.knockTicks > 0); assert.ok(p.health < 100);
});
test('a raised or sideways brace misses a rushing body', () => {
  for (const changes of [{ pitch: .4 }, { yaw: Math.PI / 2 }]) {
    const { hunt, a, p, players } = braceFixture(); Object.assign(p.state, changes);
    hunt.stepBraces(hunt.animals[0], 60, players);
    assert.equal(a.wounds.length, 0); assert.equal(p.spears, 3);
  }
});

test('a physical thrust reaches from outside the capsule and can hit once per stroke', () => {
  const { hunt, a, p, players } = fixture();
  hunt.stepAnimal = () => {};
  Object.assign(p.state, { x: 2.3, z: -6.29, yaw: Math.PI / 2, pitch: -.23 });
  assert.equal(bodyContact(p.state, a), null);
  hunt.action(p, { attack: true }, 1, players);
  for (let tick = 1; tick < 45; tick++) hunt.stepThrusts(tick, players);
  assert.equal(a.wounds.length, 1); assert.equal(p.spears, 3);
  assert.equal(hunt.events.filter(e => e.type === 'hit').length, 1);
  assert.ok(a.health < 120);
});

test('a tree stops an extended thrust before the animal', () => {
  const { hunt, a, p, players } = fixture();
  hunt.world = { ...world, obstacles: [{ x: 1.35, z: -6.29, radius: .25 }] };
  Object.assign(p.state, { x: 2.5, z: -6.29, yaw: Math.PI / 2, pitch: -.2 });
  hunt.action(p, { attack: true }, 1, players);
  for (let tick = 1; tick < 45; tick++) hunt.stepThrusts(tick, players);
  assert.equal(a.wounds.length, 0);
});

test('two hunters cannot duplicate a ground spear by recovering it on the same tick', () => {
  const { hunt, p, players } = fixture();
  Object.assign(p.state, { x: 4, z: -6 }); hunt.setSpears(p, 1);
  const q = { ...p, id: 'b', state: { ...p.state }, wounds: [], recovery: null }; players.set('b', q);
  hunt.spears.push({ id: 999, status: 'ground', x: 4.2, y: .1, z: -6 });
  hunt.action(p, { interact: true }, 1, players); hunt.action(q, { interact: true }, 1, players);
  hunt.stepPlayers(30, players);
  assert.equal(p.spears + q.spears, 3); assert.equal(hunt.spears.length, 0);
  assert.equal(hunt.events.filter(e => e.type === 'recovered').length, 1);
});

test('embedded recovery worsens the existing wound once and cancels when the animal bolts', () => {
  const { hunt, a, p, players } = fixture();
  const hit = hitAnatomy(a, ...rays.chest.map(p => toWorld(a, p)));
  const wound = hunt.impact(hunt.animals[0], hit, 26, 'throw', 'a', 1, { id: 999, vx: -26, vy: 0, vz: 0 });
  Object.assign(p.state, { x: 2, z: -6.29 }); hunt.setSpears(p, 1);
  hunt.action(p, { interact: true }, 2, players); a.vx = 5;
  hunt.stepPlayers(3, players); assert.equal(p.recovery, null); assert.equal(p.spears, 1);
  a.vx = 0; const bleed = wound.bleed;
  hunt.action(p, { interact: true }, 4, players); hunt.stepPlayers(60, players);
  assert.equal(p.spears, 2); assert.ok(wound.bleed > bleed); assert.equal(a.wounds.length, 1);
});

for (const [state, position] of [['gore', { x: 0, z: -8 }], ['sweep', { x: 1.9, z: -6.2 }], ['kick', { x: 0, z: -4.1 }], ['maul', { x: 0, z: -8 }]]) test(`${state} follows its own physical attack arc`, () => {
  const { hunt, a, p, players } = fixture();
  Object.assign(p.state, position);
  if (state === 'maul') p.state.knockTicks = 30;
  Object.assign(a, { state, attackAt: 1, attackDone: false, until: 99 });
  hunt.stepAnimal(hunt.animals[0], 1, players);
  assert.ok(p.health < 100);
  const health = p.health;
  hunt.stepAnimal(hunt.animals[0], 2, players); assert.equal(p.health, health, 'one strike does not damage every simulation tick');
});

test('the decision system answers a nearby rear hunter with a kick', () => {
  const { hunt, a, p, players } = fixture();
  Object.assign(p.state, { x: 0, z: -4.1 });
  hunt.stepAnimal(hunt.animals[0], 6, players); assert.equal(a.state, 'kick');
});

test('a real charge can steer and recover promptly rather than locking an old attack point', () => {
  const { hunt, a, p, players } = fixture();
  Object.assign(p.state, { x: 3, z: -12 });
  Object.assign(a, { state: 'charge', stateTick: 0, until: 45 });
  const yaw = a.yaw;
  for (let tick = 1; tick <= 35; tick++) hunt.stepAnimal(hunt.animals[0], tick, players);
  assert.ok(Math.abs(a.yaw - yaw) > .2); assert.ok(a.x > .3);
  for (let tick = 36; tick <= 85; tick++) hunt.stepAnimal(hunt.animals[0], tick, players);
  assert.notEqual(a.state, 'recover');
});

test('threat assessment can switch from a nearby hunter to the hunter that injured it', () => {
  const { hunt, a, p, players } = fixture();
  Object.assign(p.state, { x: 2, z: -11 });
  const q = { ...p, id: 'b', state: { ...p.state, x: -3, z: -12 }, health: 100 }; players.set('b', q);
  hunt.stepAnimal(hunt.animals[0], 6, players); assert.equal(a.targetId, 'a');
  a.threats.get('b').damage = 80;
  hunt.stepAnimal(hunt.animals[0], 12, players); assert.equal(a.targetId, 'b');
});

test('being surrounded selects a gap and an injured animal attempts an escape', () => {
  const { hunt, a, p, players } = fixture();
  Object.assign(p.state, { x: 4, z: -6 });
  players.set('b', { ...p, id: 'b', state: { ...p.state, x: -4, z: -6 } });
  players.set('c', { ...p, id: 'c', state: { ...p.state, x: 0, z: -10 } });
  hunt.stepAnimal(hunt.animals[0], 6, players);
  assert.equal(a.surrounded, true); assert.ok(a.escape.z > a.z);
  players.delete('b'); players.delete('c'); a.blood = .5; a.state = 'assess'; a.until = 0;
  hunt.stepAnimal(hunt.animals[0], 12, players); assert.equal(a.state, 'flee');
});

test('individual temperament changes across encounters and stays out of snapshots', () => {
  const { hunt } = fixture();
  assert.notDeepEqual(temperament(1), temperament(2));
  const first = hunt.animals[0].traits; hunt.round++; hunt.spawnAnimals();
  assert.notDeepEqual(hunt.animals[0].traits, first);
  assert.equal(hunt.snapshot().animals[0].traits, undefined);
});

test('new actions validate boolean inputs and ignore client injury, collider and spear claims', () => {
  const raw = { ...neutralInput(), seq: 1, brace: true, throw: true, injury: 999, spears: 999, body: null };
  const [clean] = sanitizeBatch([raw], 0);
  assert.equal(clean.brace, true); assert.equal(clean.throw, true);
  for (const field of ['injury', 'spears', 'body']) assert.equal(clean[field], undefined);
  for (const extra of [{ throw: 1 }, { brace: 'yes' }]) assert.equal(sanitizeBatch([{ ...raw, ...extra }], 0), null);
});
