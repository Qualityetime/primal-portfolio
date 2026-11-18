import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { HUNT } from '../../shared/hunt.js';
import { PLAYER } from '../../shared/config.js';
import { createWorld } from '../../shared/world.js';
import { groundHeight } from '../../shared/terrain.js';
import { GameState } from '../../simulation/gameState.js';
import { loadClient, mockDocument } from './helpers/client.js';

// Hunt Slice 0.1 presentation checks. The renderer, first-person rig and hand
// slots run in Node (no WebGL): geometry and poses are inspected directly.
const world = createWorld();
let built;
async function environment() {
  if (!built) {
    const { buildWorld } = await loadClient('world.js');
    const scene = new THREE.Scene();
    built = { scene, env: buildWorld(scene, world) };
  }
  return built;
}

test('ravine renderer: the ground mesh is the gameplay terrain, sampled exactly at its vertices', async () => {
  const { env } = await environment();
  const p = env.terrain.geometry.attributes.position;
  let checked = 0, low = Infinity, high = -Infinity;
  for (let i = 0; i < p.count; i += 37) {
    // Stored as float32: compare within that precision of the sampled position.
    assert.ok(Math.abs(p.getY(i) - groundHeight(world, p.getX(i), p.getZ(i))) < 1e-3);
    low = Math.min(low, p.getY(i)); high = Math.max(high, p.getY(i)); checked++;
  }
  assert.ok(checked > 200 && low < -0.4 && high > 0.55, `${checked} samples spanning ${low}..${high}`);
  assert.ok(env.terrain.receiveShadow);
});

test('ravine renderer: every rock collider is drawn, its face between the collider edge and where a hunter stops', async () => {
  const { env } = await environment();
  assert.equal(env.columns.length, world.cliffs.length);
  for (const { rock, rings } of env.columns) {
    // Rings 1 and 2 are the touchable band (0.6 m and 2.7 m above ground).
    for (const ring of [rings[1], rings[2]]) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const vertex = Math.hypot(a[0] - rock.x, a[2] - rock.z), mid = Math.hypot((a[0] + b[0]) / 2 - rock.x, (a[2] + b[2]) / 2 - rock.z);
        assert.ok(vertex <= rock.radius + 0.2 + 1e-6, `vertex ${vertex} beyond ${rock.radius + 0.2}`);
        assert.ok(vertex < rock.radius + PLAYER.radius - 0.1, 'the camera can never enter drawn rock');
        assert.ok(mid >= rock.radius - 0.08, `face ${mid} leaves an invisible gap at ${rock.id}`);
      }
    }
  }
});

test('ravine renderer: water is a flat surface over the carved bed, never drawn over dry ground', async () => {
  const { env } = await environment();
  assert.equal(env.water.length, world.water.length);
  const mesh = env.water[0], p = mesh.geometry.attributes.position, depth = mesh.geometry.attributes.depth, index = mesh.geometry.index.array;
  for (let i = 0; i < p.count; i++) assert.equal(p.getY(i), Math.fround(world.water[0].level));
  for (let t = 0; t < index.length; t += 3) {
    assert.ok([0, 1, 2].some(k => depth.getX(index[t + k]) >= -0.02), 'no water triangle lies wholly above the bank');
  }
  assert.ok(mesh.material.transparent && mesh.material.uniforms.time && mesh.material.fog);
  assert.ok(env.falls?.getObjectByName('falls-main') && env.falls.getObjectByName('falls-mist'));
  env.update(12.5);
  assert.equal(mesh.material.uniforms.time.value, 12.5);
});

test('ravine renderer: soft foliage and solid trees match the shared layout and need no DOM', async () => {
  const { scene, env } = await environment();
  for (const kind of ['fern', 'broadleaf', 'grass']) {
    const mesh = scene.getObjectByName(`foliage-${kind}`);
    assert.equal(mesh.count, world.foliage.filter(f => f.kind === kind).length);
  }
  assert.ok(scene.getObjectByName('tree-trunks').geometry.attributes.position.count > world.trees.length * 30);
  assert.ok(scene.getObjectByName('camp-props').children.length >= world.props.length);
  assert.ok(env.sounds.falls && env.sounds.creek.length > 3);
  assert.ok(scene.fog.isFogExp2);
});

test('hand slots: the right hand owns the spear and every action; the left hand only supports', async () => {
  const { HAND_SLOTS, ACTION_MAP, canEquip } = await loadClient('handSlots.js');
  assert.equal(HAND_SLOTS.right.item, 'spear'); assert.equal(HAND_SLOTS.left.item, null);
  assert.equal(HAND_SLOTS.left.role, 'support');
  for (const action of Object.values(ACTION_MAP)) assert.equal(action.owner, 'right');
  assert.equal(canEquip('right', 'spear'), true); assert.equal(canEquip('left', 'spear'), false);
  assert.equal(canEquip('left', 'torch'), false); assert.equal(canEquip('right', 'torch'), false);
});

test('hand slots: stance priority follows the authoritative state, and thrust phases follow the server tip timeline', async () => {
  const { resolveStance, thrustPhase } = await loadClient('handSlots.js');
  const ready = { health: 100, spears: 3, knockTicks: 0 };
  assert.equal(resolveStance(ready).stance, 'ready');
  assert.equal(resolveStance(ready, { sprinting: true }).stance, 'carry');
  assert.equal(resolveStance({ ...ready, health: 0 }).stance, 'down');
  assert.equal(resolveStance({ ...ready, knockTicks: 4 }).stance, 'down');
  assert.equal(resolveStance({ ...ready, recovering: true, bracing: true }).stance, 'recover');
  assert.equal(resolveStance({ ...ready, spears: 0 }).stance, 'empty');
  assert.equal(resolveStance({ ...ready, bracing: true }).stance, 'brace');
  assert.equal(resolveStance({ ...ready, winding: true, windupTime: 0.45 }).charge, 0.5);
  assert.equal(resolveStance(ready, { throwAge: 0.1 }).stance, 'release');
  assert.equal(resolveStance({ ...ready, spears: 0 }, { throwAge: 0.1 }).stance, 'release', 'the last spear still leaves the hand');
  assert.equal(resolveStance(ready, { thrustAge: 0.2 }).stance, 'thrust');
  // Server: reach starts at 0.12 s, completes by 0.35 s, the action ends at 0.64 s.
  assert.deepEqual(thrustPhase(0.12), { cock: 1, extend: 0 });
  assert.ok(thrustPhase(0.2).extend > 0 && thrustPhase(0.2).extend < 1);
  assert.deepEqual(thrustPhase(0.35), { cock: 1, extend: 1 });
  assert.deepEqual(thrustPhase(HUNT.thrustCooldown), { cock: 0, extend: 0 });
});

// First-Person Spear Live Integration: the live first-person rig is the
// approved first-person spear (fpSpearMotion.js + gripHand.js hands). These
// checks replace the Hunt Slice 0.1 block-hand expectations (both hands in
// view at idle, the support hand glued on through the thrust) with the
// approved behaviour, and keep protecting ownership, the left underhand
// support, the right-hand attack and valid spear states.
async function rigFor(state, clocks = {}, seconds = 0.7) {
  const { FirstPersonRig } = await loadClient('firstPerson.js');
  const rig = new FirstPersonRig();
  rig.resize(16 / 9);
  // Clocks given as functions of time run live; plain values are held.
  const n = Math.round(seconds * 60);
  for (let i = 0; i <= n; i++) {
    const t = 10 + i / 60, c = typeof clocks === 'function' ? clocks(t - 10) : clocks;
    rig.update(1 / 60, t, state, c, { active: true });
  }
  rig.scene.updateMatrixWorld(true);
  return rig;
}
function inView(rig, point) {
  const p = point.clone().project(rig.camera);
  return Math.abs(p.x) < 1 && Math.abs(p.y) < 1 && p.z > -1 && p.z < 1;
}
function spearAxis(rig) {
  const origin = rig.spear.getWorldPosition(new THREE.Vector3()), dir = new THREE.Vector3(0, 0, -1).applyQuaternion(rig.spear.getWorldQuaternion(new THREE.Quaternion()));
  return { origin, dir, offset: p => { const v = p.clone().sub(origin); return v.sub(dir.clone().multiplyScalar(v.dot(dir))); } };
}
// The hands are built in grip space: the shaft runs along the hand group's
// local Z through its origin, so a hand on the spear has its origin on the axis.
function onShaft(rig, side) { return spearAxis(rig).offset(rig.hands[side].getWorldPosition(new THREE.Vector3())).length(); }
function handBack(rig, side) {
  return rig.hands[side].children.at(-1)?.userData?.grip?.back?.clone().transformDirection(rig.hands[side].children.at(-1).matrixWorld)
    ?? rig.hands[side].userData.grip.back.clone().transformDirection(rig.hands[side].matrixWorld);
}

test('first-person rig: the approved idle — left hand underhand under the shaft, the right hand owns the spear from back out of view', async () => {
  const rig = await rigFor({ health: 100, spears: 3, knockTicks: 0 });
  assert.equal(rig.stance, 'ready'); assert.equal(rig.spear.visible, true); assert.equal(rig.root.visible, true);
  // Ownership: the right hand is fixed in the spear's own space at its primary grip.
  assert.ok(rig.rightHand.parent === rig.assembly && rig.spear.parent === rig.assembly);
  assert.ok(rig.rightHand.position.distanceTo(new THREE.Vector3(0, 0, 0.3)) < 1e-9, 'right hand on the primary grip');
  // Left support: on the shaft, palm up (the back of the hand faces down), in view.
  assert.ok(onShaft(rig, 'left') < 1e-6, `left hand on the shaft (${onShaft(rig, 'left')})`);
  assert.ok(handBack(rig, 'left').y < -0.5, 'support hand palm-up under the shaft');
  assert.ok(inView(rig, rig.hands.left.getWorldPosition(new THREE.Vector3())), 'the left hand is the visible support hand');
  // The right hand stays mechanically present but back out of view in idle.
  assert.ok(!inView(rig, rig.arms.right.wrist), 'the right wrist sits out of view');
  const head = new THREE.Vector3(0, 0, -1.1).applyMatrix4(rig.spear.matrixWorld);
  assert.ok(inView(rig, head), 'the knapped head reads in view');
  assert.equal(rig.slots.left.item, null);
  assert.throws(() => rig.equip('left', 'spear'), /cannot hold/);
});

test('first-person rig: the thrust drives the spear with the right arm on one line while the left hand clears; brace sets both hands; recovery and empty hands', async () => {
  const thrust = await rigFor({ health: 100, spears: 3, knockTicks: 0 }, t => ({ thrustAge: t - 0.4 }), 0.73);
  assert.equal(thrust.stance, 'thrust'); assert.equal(thrust.phase, 'attack');
  assert.ok(thrust.pose.att < 0.01, 'the left hand has let go during the strike');
  assert.ok(inView(thrust, thrust.arms.right.wrist), 'the right hand drives into view');
  assert.ok(thrust.arms.right.bend < 0.5, 'wrist neutral: the forearm runs straight out of the hand');
  // Screen line check (approved: forearm 19 deg vs spear 32 deg, a 13 deg difference, no hook).
  const P = v => v.clone().project(thrust.camera), a = thrust.arms.right, ang = (p, q) => Math.atan2(q.y - p.y, (q.x - p.x) * 16 / 9) * 180 / Math.PI;
  const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(thrust.pose.q);
  const forearm = ang(P(a.wrist), P(a.wrist.clone().addScaledVector(a.axis, 0.2))), spear = ang(P(thrust.pose.grip.clone().addScaledVector(dir, 1.4)), P(thrust.pose.grip.clone().addScaledVector(dir, -0.35)));
  assert.ok(Math.abs(forearm - spear) < 15, `forearm ${forearm.toFixed(1)} vs spear ${spear.toFixed(1)}`);
  const brace = await rigFor({ health: 100, spears: 3, knockTicks: 0, bracing: true });
  assert.equal(brace.stance, 'brace');
  assert.ok(onShaft(brace, 'left') < 1e-6 && brace.pose.att > 0.99, 'both hands set the braced spear');
  assert.ok(inView(brace, brace.rightHand.getWorldPosition(new THREE.Vector3())), 'the right fist is set in view');
  const recover = await rigFor({ health: 100, spears: 2, knockTicks: 0, recovering: true });
  assert.equal(recover.spear.visible, true, 'pulling another spear free, the held one stays in hand');
  assert.ok(recover.pose.att < 0.01 && inView(recover, recover.hands.left.getWorldPosition(new THREE.Vector3())), 'the left hand reaches out to pull');
  for (const state of [{ health: 100, spears: 0, knockTicks: 0, recovering: true }, { health: 100, spears: 0, knockTicks: 0 }]) {
    const rig = await rigFor(state);
    assert.equal(rig.spear.visible, false);
    assert.equal(rig.hands.right.visible, false); assert.equal(rig.hands.left.visible, false);
    for (const side of ['right', 'left']) for (const v of rig.hands[side].position.toArray()) assert.ok(Number.isFinite(v));
  }
  const down = await rigFor({ health: 0, spears: 3, knockTicks: 0 });
  assert.equal(down.visible, false);
  assert.ok(!inView(down, down.hands.left.getWorldPosition(new THREE.Vector3())), 'a downed hunter\'s hands drop out of view');
});

test('first-person rig: a wind-up raises the spear and the left hand leads the aim; the throw releases it once and re-arms', async () => {
  const windup = await rigFor({ health: 100, spears: 3, knockTicks: 0, winding: true, windupTime: 0.9 });
  assert.equal(windup.stance, 'windup');
  assert.ok(windup.pose.grip.clone().project(windup.camera).y > -0.3, 'spear raised beside the head');
  assert.ok(windup.pose.att < 0.01 && inView(windup, windup.hands.left.getWorldPosition(new THREE.Vector3())), 'left hand off the shaft, forward and in view');
  const held = await rigFor({ health: 100, spears: 2, knockTicks: 0 }, t => ({ throwAge: t - 0.65 }), 0.68);
  assert.equal(held.stance, 'release'); assert.equal(held.spear.visible, true, 'still in the hand before the release point');
  const released = await rigFor({ health: 100, spears: 2, knockTicks: 0 }, t => ({ throwAge: t - 0.45 }), 0.6);
  assert.equal(released.stance, 'release'); assert.equal(released.spear.visible, false, 'gone from the hand once released');
  const rearmed = await rigFor({ health: 100, spears: 2, knockTicks: 0 }, t => ({ throwAge: t - 0.1 }), 0.9);
  assert.equal(rearmed.spear.visible, true, 'a spear left in the count is back in the fist');
  const last = await rigFor({ health: 100, spears: 0, knockTicks: 0 }, t => ({ throwAge: t - 0.1 }), 0.9);
  assert.equal(last.spear.visible, false, 'the last spear thrown: empty-handed');
});

// Hotfix 0.4.1, kept: the right hand must read as a right hand in every spear state.
test('first-person hotfix: the right hand grips as a right hand (owning the spear, thumb on top, fingers under) in every spear state', async () => {
  const ready = { health: 100, spears: 3, knockTicks: 0 };
  const states = {
    idle: [ready, {}], walking: [ready, {}, 4.2], sprinting: [ready, { sprinting: true }, 7.4], windingUp: [ready, t => ({ thrustAge: t - 0.6 }), 0, 0.68],
    thrustExtended: [ready, t => ({ thrustAge: t - 0.4 }), 0, 0.73], windup: [{ ...ready, winding: true, windupTime: 0.8 }, {}], brace: [{ ...ready, bracing: true }, {}],
    cooking: [{ ...ready, cooking: 0.5 }, {}],
  };
  const { FirstPersonRig } = await loadClient('firstPerson.js');
  for (const [name, [state, clocks, speed = 0, seconds = 0.8]] of Object.entries(states)) {
    const rig = new FirstPersonRig(); rig.resize(16 / 9);
    for (let i = 0; i <= Math.round(seconds * 60); i++) rig.update(1 / 60, 10 + i / 60, state, typeof clocks === 'function' ? clocks(i / 60) : clocks, { active: true, speed });
    rig.scene.updateMatrixWorld(true);
    assert.equal(rig.rightHand.name, 'right-grip', `${name}: the right-hand model`);
    assert.ok(rig.rightHand.scale.x > 0, `${name}: never mirrored`);
    assert.ok(rig.rightHand.parent === rig.assembly && rig.rightHand.position.distanceTo(new THREE.Vector3(0, 0, 0.3)) < 1e-9, `${name}: right hand owns the spear at its primary grip`);
    // Camera space: +Y is up on screen, +X to the right.
    const axis = spearAxis(rig), grip = rig.rightHand.userData.grip;
    const thumb = axis.offset(rig.rightHand.localToWorld(grip.thumbTip.clone()));
    assert.ok(thumb.y > grip.shaftRadius * 0.8, `${name}: thumb over the top of the shaft (${thumb.y.toFixed(3)})`);
    const tips = grip.fingertips.map(f => axis.offset(rig.rightHand.localToWorld(f.clone())).y);
    assert.ok(tips.every(y => y < thumb.y - 0.02), `${name}: every fingertip below the thumb, curled up from under the shaft`);
    const palm = grip.palmNormal.clone().transformDirection(rig.rightHand.matrixWorld);
    assert.ok(palm.y > 0.25 && palm.x < -0.5, `${name}: palm below and outside the shaft, facing up and in (back of the hand out and down, never inward like a left hand)`);
    if (rig.pose.att > 0.99) {
      assert.equal(rig.leftHand.children[0].name, 'left-support', `${name}: the left-hand model`);
      assert.ok(onShaft(rig, 'left') < 1e-6 && handBack(rig, 'left').y < -0.3, `${name}: support hand cradles the shaft palm-up`);
    }
  }
});

test('HuntView: boars, tracks and the camp fire stand on the shared terrain', async t => {
  mockDocument(t);
  const { HuntView } = await loadClient('huntView.js');
  const game = new GameState();
  ['a', 'b', 'c', 'd'].forEach(id => game.addPlayer(id, { room: 'BONES', name: id }));
  const hunt = game.rooms.get('BONES').hunt, [a, b] = hunt.animals;
  Object.assign(a, { x: -14.6, z: -14 }); hunt.moveAnimal(a, 0, 0);
  Object.assign(b, { x: 22, z: -15 }); hunt.moveAnimal(b, 0, 0);
  hunt.tracks.push({ id: 1, animalId: a.id, x: -14.6, z: -14, born: 0, size: 0.2 });
  const scene = new THREE.Scene(), view = new HuntView(scene, new THREE.PerspectiveCamera(), { boarMode: 'placeholder', world: game.world });
  view.receive(game.snapshot('BONES'), true);
  for (let i = 0; i < 30; i++) view.update(1000 + i * 16, 1 / 60, null, false);
  assert.ok(Math.abs(view.boars.get(a.id).group.position.y - a.y) < 0.04, 'boar in the creek bed');
  assert.ok(Math.abs(view.boars.get(b.id).group.position.y - b.y) < 0.04, 'boar on the raised pocket');
  const m = new THREE.Matrix4(); view.blood.getMatrixAt(0, m);
  assert.ok(Math.abs(new THREE.Vector3().setFromMatrixPosition(m).y - (a.y + 0.02)) < 0.005, 'blood lies on the creek bed');
  assert.equal(scene.getObjectByName('campfire').position.y, groundHeight(game.world, HUNT.camp.x, HUNT.camp.z));
  assert.ok(view.viewModel.scene.isScene, 'hands render in their own pass');
  view.clear();
});
