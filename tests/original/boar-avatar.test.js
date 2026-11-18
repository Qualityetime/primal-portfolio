import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GameState } from '../../simulation/gameState.js';
import { hitAnatomy } from '../../simulation/anatomy.js';
import { toWorld } from '../../shared/body.js';
import { loadClient, mockDocument } from './helpers/client.js';
import { loadActualBoarGLTF } from './helpers/boarAsset.js';

const module = await loadClient('boarAvatar.js');
const gltf = await loadActualBoarGLTF();
const sourceHipValues = Array.from(gltf.animations[0].tracks.find(t => t.name === 'Hips.position').values);
const sourceTracks = gltf.animations[0].tracks.map(track => ({ name: track.name, values: Array.from(track.values) }));
const asset = module.prepareBoarAsset(gltf);
const { BoarAvatar, BOAR_AVATAR, createBoarAssetCache } = module;
const alive = { alive: true };
const almost = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

function fixture() {
  const game = new GameState();
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: `Hunter ${id}` }));
  return { game, hunters, hunt: game.rooms.get('BONES').hunt };
}
async function viewFor(t, f, options = {}) {
  mockDocument(t);
  const { HuntView } = await loadClient('huntView.js');
  const view = new HuntView(new THREE.Scene(), new THREE.PerspectiveCamera(), { loadAsset: async () => asset, ...options });
  view.receive(f.game.snapshot('BONES'), true);
  await view.ready;
  t.after(() => view.clear());
  return view;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('boar asset: actual GLB, 27 bones, skin, 2048 PNG and exact supplied walk clip load in Node', () => {
  const mesh = gltf.scene.getObjectByName('char1');
  assert.ok(mesh.isSkinnedMesh); assert.equal(mesh.skeleton.bones.length, 27);
  assert.equal(mesh.geometry.attributes.position.count, 14848);
  assert.equal(mesh.geometry.index.count / 3, 10191);
  assert.deepEqual(gltf.animations.map(c => c.name), ['Armature|Unreal Take|baselayer']);
  almost(gltf.animations[0].duration, 1); assert.equal(gltf.animations[0].tracks.length, 81);
  assert.equal(mesh.material.map.image.width, 2048); assert.equal(mesh.material.map.image.height, 2048);
  assert.equal(mesh.material.metalness, 0); assert.equal(mesh.material.emissiveIntensity, 0);
  assert.deepEqual([...asset.clips.keys()], [BOAR_AVATAR.walkClip]);
});

test('boar asset: complete visual grows uniformly by 18%, with its feet still at terrain and its entity unchanged', () => {
  const avatar = new BoarAvatar(asset);
  const root = new THREE.Group(); root.add(avatar.visual); root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(avatar.visual, true), size = box.getSize(new THREE.Vector3());
  almost(box.min.y, 0, 1e-5); almost(size.y / 1.400478637, 1.18, 1e-5);
  almost(size.x / 1.136309689, 1.18, 1e-5); almost(size.z / 2.87500021, 1.18, 1e-5);
  assert.deepEqual(avatar.sized.scale.toArray(), [1.18, 1.18, 1.18]);
  const originalFit = new THREE.Matrix4().compose(
    new THREE.Vector3(0, -0.034499664, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI),
    new THREE.Vector3(170, 110, 150),
  );
  const sourceMesh = gltf.scene.getObjectByName('char1'), previous = new THREE.Vector3(), current = new THREE.Vector3();
  for (let i = 0; i < sourceMesh.geometry.attributes.position.count; i++) {
    sourceMesh.getVertexPosition(i, previous).applyMatrix4(sourceMesh.matrixWorld).applyMatrix4(originalFit).multiplyScalar(1.18);
    avatar.mesh.getVertexPosition(i, current).applyMatrix4(avatar.mesh.matrixWorld);
    assert.ok(previous.distanceTo(current) < 1e-5, `vertex ${i} preserves the complete original proportions and ground offset`);
  }
  assert.ok(avatar.model.getObjectByName('head').getWorldPosition(new THREE.Vector3()).z < -0.8, 'head faces gameplay -Z');
  almost(root.position.length(), 0); almost(root.rotation.y, 0); avatar.dispose();
});

test('boar asset: cache shares a single load for concurrent animals, reconnects and cached failures', async () => {
  let calls = 0;
  const cache = createBoarAssetCache({ async loadAsync(path) { calls++; assert.equal(path, BOAR_AVATAR.assetPath); return gltf; } });
  const a = cache.load(), b = cache.load(); assert.equal(a, b);
  assert.equal(await a, await b); assert.equal(await cache.load(), await a); assert.equal(calls, 1);
  const failed = createBoarAssetCache({ async loadAsync() { calls++; throw new Error('missing'); } });
  await assert.rejects(failed.load(), /missing/); await assert.rejects(failed.load(), /missing/); assert.equal(calls, 2);
});

test('boar animation: two skeletons and mixers stay independent while geometry and textures are shared', () => {
  const a = new BoarAvatar(asset), b = new BoarAvatar(asset);
  const meshA = a.model.getObjectByName('char1'), meshB = b.model.getObjectByName('char1');
  assert.notEqual(a.model, b.model); assert.notEqual(a.mixer, b.mixer); assert.notEqual(meshA.skeleton, meshB.skeleton);
  for (let i = 0; i < 27; i++) assert.notEqual(meshA.skeleton.bones[i], meshB.skeleton.bones[i]);
  assert.equal(meshA.geometry, meshB.geometry); assert.equal(meshA.material, meshB.material); assert.equal(meshA.material.map, meshB.material.map);
  const restB = b.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]);
  for (let i = 0; i < 20; i++) { a.update(.03, alive, 5); b.update(.03, alive, 0); }
  assert.equal(a.state, 'walk'); assert.equal(b.state, 'rest'); assert.ok(a.walk.time > 0); assert.equal(b.walk.time, 0);
  assert.deepEqual(b.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]), restB);
  assert.notDeepEqual(a.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray()]), restB);
  a.dispose(); b.dispose();
});

test('boar animation: rate follows synchronized speed, rest fades back, and combat does not invent clips', () => {
  const avatar = new BoarAvatar(asset);
  for (const [speed, rate] of [[.5, .65], [3, 1], [9, 1.8]]) {
    avatar.update(.2, { alive: true, state: 'gore' }, speed); almost(avatar.walk.getEffectiveTimeScale(), rate);
  }
  avatar.update(.01, { alive: true, state: 'kick' }, .25); assert.equal(avatar.state, 'walk', 'tiny speed fluctuations do not restart the gait');
  avatar.update(.2, { alive: true, state: 'warning' }, 0); assert.equal(avatar.state, 'rest'); assert.equal(avatar.walk.isRunning(), false);
  assert.equal(avatar.mixer._actions.length, 1); assert.equal(avatar.walk.getClip().name, BOAR_AVATAR.walkClip);
  assert.deepEqual(avatar.model.getObjectByName('Hips').position.toArray(), gltf.scene.getObjectByName('Hips').position.toArray());
  avatar.dispose();
});

test('boar animation: controlled pelvis motion stays near the authored walk and never drives the entity', () => {
  const avatar = new BoarAvatar(asset), root = new THREE.Group();
  root.position.set(8, 0, -4); root.rotation.y = 1.23; root.add(avatar.visual); root.updateMatrixWorld(true);
  const hips = avatar.model.getObjectByName('Hips'), start = hips.getWorldPosition(new THREE.Vector3());
  const source = gltf.animations[0].tracks.find(t => t.name === 'Hips.position');
  assert.deepEqual(Array.from(source.values), sourceHipValues);
  const locked = asset.clips.get(BOAR_AVATAR.walkClip).tracks.find(t => t.name === 'Hips.position');
  for (let i = 0; i < locked.values.length; i += 3) {
    almost(locked.values[i], hips.position.x); almost(locked.values[i + 1], hips.position.y);
  }
  const rotations = asset.clips.get(BOAR_AVATAR.walkClip).tracks.find(t => t.name === 'Hips.quaternion');
  const originalRotations = gltf.animations[0].tracks.find(t => t.name === 'Hips.quaternion');
  const pitch = rotations.createInterpolant();
  for (let i = 0; i < originalRotations.times.length; i++) {
    assert.ok(new THREE.Quaternion().fromArray(pitch.evaluate(originalRotations.times[i])).normalize()
      .angleTo(new THREE.Quaternion().fromArray(originalRotations.values, i * 4).normalize()) <= .12001,
    'support correction remains within 6.9 degrees of the authored pelvis/leg relationship');
  }
  for (let i = 0; i < 600; i++) {
    avatar.update(1 / 60, alive, 7); root.updateMatrixWorld(true);
    const current = hips.getWorldPosition(new THREE.Vector3());
    almost(current.x, start.x); almost(current.z, start.z);
  }
  assert.deepEqual(root.position.toArray(), [8, 0, -4]); almost(root.rotation.y, 1.23); avatar.dispose();
});

test('boar animation: slow and fast locomotion keeps a small live body motion without pronounced bobbing', () => {
  const avatar = new BoarAvatar(asset), root = new THREE.Group(); root.add(avatar.visual);
  const names = ['Hips', 'chest', 'head', 'frontleg2', 'backleg2'];
  const point = new THREE.Vector3();
  for (const speed of [.5, 3, 9]) {
    avatar.update(.2, alive, speed);
    const heights = Object.fromEntries(names.map(name => [name, []]));
    const top = [];
    for (let i = 0; i < 240; i++) {
      avatar.update(1 / 120, alive, speed); root.updateMatrixWorld(true);
      for (const name of names) heights[name].push(avatar.model.getObjectByName(name).getWorldPosition(point).y);
      top.push(new THREE.Box3().setFromObject(avatar.visual, true).max.y);
    }
    const amplitude = values => Math.max(...values) - Math.min(...values);
    // The approved grounded gait previously moved its chest about 20 cm and
    // head about 24 cm. Check rendered motion, not just hip translation keys:
    // grounding cancels a naive change to those keys.
    assert.ok(amplitude(heights.Hips) > .008 && amplitude(heights.Hips) < .025, 'small supported pelvis rise remains');
    assert.ok(amplitude(heights.chest) > .025 && amplitude(heights.chest) < .07, 'torso no longer visibly pogoes');
    assert.ok(amplitude(heights.head) > .02 && amplitude(heights.head) < .065, 'head motion remains alive and restrained');
    assert.ok(amplitude(top) > .02 && amplitude(top) < .08, 'whole silhouette rise/fall is quieter');
    assert.ok(amplitude(heights.frontleg2) > .1 && amplitude(heights.backleg2) > .2, 'front and rear swing feet retain a readable stride');
    almost(avatar.walk.getEffectiveTimeScale(), THREE.MathUtils.clamp(speed / 3, .65, 1.8));
  }
  assert.deepEqual(root.position.toArray(), [0, 0, 0]);
  assert.deepEqual(avatar.sized.scale.toArray(), [1.18, 1.18, 1.18]);
  avatar.dispose();
});

test('boar animation: actual rig never contracts its inherited scale during walk, sprint or fades', () => {
  const avatar = new BoarAvatar(asset), root = new THREE.Group(); root.add(avatar.visual); root.updateMatrixWorld(true);
  const clip = asset.clips.get(BOAR_AVATAR.walkClip);
  assert.equal(clip.tracks.length, 54); assert.ok(clip.tracks.every(track => !track.name.endsWith('.scale')));
  assert.deepEqual(gltf.animations[0].tracks.map(track => ({ name: track.name, values: Array.from(track.values) })), sourceTracks,
    'preparation never edits the original GLB animation');
  const restScales = avatar.bones.map(bone => bone.scale.clone());
  const restVolumes = avatar.bones.map(bone => bone.matrixWorld.determinant());
  for (const speed of [.5, 7, 0, 3, 0]) {
    for (let i = 0; i < 90; i++) {
      avatar.update(1 / 60, alive, speed); root.updateMatrixWorld(true);
      for (let b = 0; b < avatar.bones.length; b++) {
        assert.deepEqual(avatar.bones[b].scale.toArray(), restScales[b].toArray(), `bone ${b} keeps its bind scale`);
        almost(avatar.bones[b].matrixWorld.determinant() / restVolumes[b], 1, 2e-5);
      }
      const box = new THREE.Box3().setFromObject(avatar.visual, true);
      assert.ok(box.min.y > -.015 && box.min.y < .08, `grounded feet at ${box.min.y}`);
      assert.ok(box.max.y > 1.42 && box.max.y < 1.8, `stable body height through the supported walk and transitions: ${box.max.y}`);
    }
  }
  avatar.dispose();
});

test('boar animation: real walk poses keep supporting feet near terrain and death restores this rig alone', () => {
  const a = new BoarAvatar(asset), b = new BoarAvatar(asset), root = new THREE.Group(); root.add(a.visual);
  for (let i = 0; i < 24; i++) {
    a.update(.05, alive, 3); root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(a.visual, true);
    assert.ok(box.min.y > -.03 && box.min.y < .08, `supporting feet at ${box.min.y}`);
  }
  b.update(.2, alive, 4); const timeB = b.walk.time;
  a.update(.1, { alive: false }, 0, 1.42, .25);
  assert.equal(a.state, 'dead'); assert.equal(a.walk.isRunning(), false); assert.equal(b.walk.time, timeB);
  assert.deepEqual(a.model.getObjectByName('Hips').position.toArray(), gltf.scene.getObjectByName('Hips').position.toArray());
  a.update(.2, alive, 3); assert.equal(a.state, 'walk'); assert.ok(a.walk.isRunning());
  almost(a.visual.position.x, 0); almost(a.visual.position.z, 0);
  assert.ok(a.visual.position.y > -.3 && a.visual.position.y < .1); a.dispose(); b.dispose();
});

test('boar animation: real front and rear support stay grounded throughout slow and sprint cycles', () => {
  const avatar = new BoarAvatar(asset), root = new THREE.Group(); root.add(avatar.visual);
  const point = new THREE.Vector3();
  // Check the full rendered leg surface independently of the cached solver
  // samples; an omitted toe/heel must not make this test falsely pass.
  const indices = avatar.mesh.geometry.attributes.skinIndex, weights = avatar.mesh.geometry.attributes.skinWeight;
  const legs = { front: [], rear: [] };
  for (let i = 0; i < avatar.mesh.geometry.attributes.position.count; i++) {
    for (const [name, pattern] of [['front', /frontleg/], ['rear', /backleg/]]) {
      if (Array.from({ length: 4 }, (_, j) => j).some(j => weights.getComponent(i, j) > 0 && pattern.test(asset.boneNames[indices.getComponent(i, j)]))) legs[name].push(i);
    }
  }
  const feet = () => Object.fromEntries(Object.entries(legs).map(([name, indices]) => [name,
    Math.min(...indices.map(index => avatar.mesh.getVertexPosition(index, point).applyMatrix4(avatar.mesh.matrixWorld).y))]));
  assert.ok(asset.supportGroups.front.length && asset.supportGroups.rear.length);
  for (const speed of [.5, 3, 9]) {
    avatar.update(.2, alive, speed);
    for (let i = 0; i < 180; i++) {
      avatar.update(1 / 60, alive, speed); root.updateMatrixWorld(true);
      for (const [name, y] of Object.entries(feet())) {
        assert.ok(y >= -.005 && y < .02, `${name} supporting hoof stays near terrain: ${y}`);
      }
    }
  }
  assert.deepEqual(root.position.toArray(), [0, 0, 0]); assert.deepEqual(root.quaternion.toArray(), [0, 0, 0, 1]);
  avatar.dispose();
});

test('boar animation: body damping leaves idle rig, remaining joint tracks, approved scale and the other mixer intact', () => {
  const a = new BoarAvatar(asset), b = new BoarAvatar(asset), root = new THREE.Group(); root.add(a.visual);
  const rest = a.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
  const sourceMesh = gltf.scene.getObjectByName('char1');
  assert.deepEqual(sourceMesh.skeleton.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]), rest,
    'private preparation sampler never changes the shared neutral rig');
  for (const track of asset.clips.get(BOAR_AVATAR.walkClip).tracks) {
    if (/^(Hips|frontleg|R_frontleg|backleg|R_backleg)\.(position|quaternion)$/.test(track.name)) continue;
    assert.deepEqual(Array.from(track.values), sourceTracks.find(source => source.name === track.name).values,
      `${track.name} retains the supplied joint motion`);
  }
  for (let i = 0; i < 60; i++) { a.update(1 / 60, alive, 5); b.update(1 / 60, alive, 0); }
  assert.deepEqual(b.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]), rest);
  const timeB = b.walk.time;
  a.update(.2, alive, 0); root.updateMatrixWorld(true);
  assert.deepEqual(a.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]), rest);
  assert.deepEqual(a.visual.position.toArray(), [0, 0, 0]); assert.equal(b.walk.time, timeB);
  assert.deepEqual(a.sized.scale.toArray(), [1.18, 1.18, 1.18]); assert.deepEqual(b.sized.scale.toArray(), a.sized.scale.toArray());
  almost(new THREE.Box3().setFromObject(a.visual, true).max.y, 1.652564791, 1e-5);
  a.dispose(); b.dispose();
});

test('boar rendering: default view mounts exactly two cached rigs and matches the original authoritative root transforms', async t => {
  const f = fixture(), rigged = await viewFor(t, f), placeholder = await viewFor(t, f, { boarMode: 'placeholder' });
  const snapshot = f.game.snapshot('BONES'); snapshot.hunt.animals[0].vx = 6; snapshot.hunt.animals[0].x += 2;
  snapshot.hunt.animals[1].alive = false; snapshot.hunt.animals[1].state = 'dead';
  const frozen = freeze(snapshot), before = JSON.stringify(frozen);
  rigged.receive(frozen); placeholder.receive(frozen);
  for (let i = 0; i < 60; i++) {
    rigged.update(1000 + i * 1000 / 60, 1 / 60, null, false); placeholder.update(1000 + i * 1000 / 60, 1 / 60, null, false);
    for (const [id, boar] of rigged.boars) {
      assert.ok(boar.avatar); assert.equal(boar.avatar.visual.parent, boar.group); assert.equal(boar.placeholder.parent, null);
      assert.deepEqual(boar.group.position.toArray(), placeholder.boars.get(id).group.position.toArray());
      assert.deepEqual(boar.group.quaternion.toArray(), placeholder.boars.get(id).group.quaternion.toArray());
      assert.deepEqual(boar.group.scale.toArray(), placeholder.boars.get(id).group.scale.toArray());
    }
  }
  assert.equal(rigged.boars.size, 2); assert.equal(JSON.stringify(frozen), before);
});

test('boar rendering: actual penetrating damage, wound and lodged spear stay on A through animation and snapshot reorder', async t => {
  const f = fixture(), [a, b] = f.hunt.animals, beforeB = f.hunt.animalDebug(b, 0);
  const from = toWorld(a, { x: 2, y: .94, z: -.29 }), to = toWorld(a, { x: 0, y: .94, z: -.29 });
  const hit = hitAnatomy(a, from, to), d = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z).normalize();
  const wound = f.hunt.impact(a, hit, 28, 'throw', f.hunters[3].id, 0, { id: 900, vx: d.x * 28, vy: d.y * 28, vz: d.z * 28 });
  assert.ok(wound.embedded); assert.deepEqual(f.hunt.animalDebug(b, 0), beforeB);
  const view = await viewFor(t, f), modelA = view.boars.get(a.id), modelB = view.boars.get(b.id);
  const spear = view.spears.get(900), marker = view.wounds.get(`${a.id}:${wound.id}`);
  assert.equal(spear.parent, modelA.group); assert.equal(marker.parent, modelA.group);
  assert.equal(modelA.avatar.attachments.size, 2); assert.equal(modelB.avatar.attachments.size, 0);
  const stateBefore = JSON.stringify(f.hunt.snapshot()), initial = spear.position.clone();
  const snapshot = f.game.snapshot('BONES'); snapshot.hunt.animals[0].vx = 4; snapshot.hunt.animals.reverse(); view.receive(freeze(snapshot));
  view.update(1000, .25, null, false); assert.ok(spear.position.distanceTo(initial) > .01, 'shaft follows animated body, not the old geometric location');
  assert.equal(spear.parent, modelA.group); assert.equal(view.boars.get(a.id), modelA); assert.equal(view.boars.get(b.id), modelB);
  assert.equal(modelB.avatar.state, 'rest'); assert.equal(JSON.stringify(f.hunt.snapshot()), stateBefore);
  const anchor = modelA.avatar.attachments.get(spear); assert.ok(asset.surface.some(sample => sample.point === anchor.point));
  assert.equal(anchor.binding.region, wound.region); assert.deepEqual(f.hunt.spears[0].local, hit.point);
});

test('boar rendering: spear recovery detaches the visual anchor and invalid entity IDs never attach to another boar', async t => {
  const f = fixture(), view = await viewFor(t, f), snapshot = f.game.snapshot('BONES'), id = snapshot.hunt.animals[0].id;
  snapshot.hunt.spears = [{ id: 12, animalId: id, status: 'embedded', local: { x: .5, y: .9, z: 0 }, direction: { x: -1, y: 0, z: 0 } }];
  view.receive(snapshot); const spear = view.spears.get(12); assert.equal(view.boars.get(id).avatar.attachments.size, 1);
  snapshot.hunt.spears[0] = { id: 12, status: 'ground', x: 2, y: .1, z: 5, direction: { x: 0, y: 0, z: -1 } };
  view.receive(snapshot); view.update(100, .1, null, false);
  assert.equal(spear.parent, view.scene); assert.equal(view.boars.get(id).avatar.attachments.size, 0); assert.equal(spear.userData.boarBinding, undefined);
  almost(spear.position.z, 6.02);
  snapshot.hunt.spears[0] = { ...snapshot.hunt.spears[0], status: 'embedded', animalId: 'missing', local: { x: 0, y: 1, z: 0 } };
  view.receive(snapshot); assert.equal(view.spears.size, 0); assert.equal(spear.parent, null);
});

test('boar rendering: corpse fits terrain, harvest stays isolated, and the other boar keeps animating', async t => {
  const f = fixture(), [a, b] = f.hunt.animals; f.hunt.kill(a, 0, f.hunters[3].id);
  const view = await viewFor(t, f), snapshot = f.game.snapshot('BONES'); snapshot.hunt.animals[1].vx = 5;
  view.receive(snapshot);
  for (let i = 0; i < 30; i++) view.update(1000 + i * 16, 1 / 60, null, false);
  const corpse = view.boars.get(a.id), live = view.boars.get(b.id); corpse.group.updateMatrixWorld(true);
  almost(new THREE.Box3().setFromObject(corpse.avatar.visual, true).min.y, .02, .003);
  assert.equal(corpse.avatar.state, 'dead'); assert.equal(corpse.avatar.walk.isRunning(), false);
  assert.equal(live.avatar.state, 'walk'); assert.ok(live.avatar.walk.time > 0);
  f.hunters[3].state.x = a.x; f.hunters[3].state.z = a.z;
  assert.equal(f.hunt.harvestable(f.hunters[3]), a);
  const healthB = b.health; a.meat -= 2;
  view.receive(f.game.snapshot('BONES')); assert.equal(b.health, healthB); assert.equal(b.state, 'patrol');
});

test('boar rendering: pending load mounts current round only and clearing one rig never disposes shared resources', async t => {
  const f = fixture(); let resolve;
  const pending = new Promise(r => { resolve = r; });
  const view = await (async () => {
    mockDocument(t); const { HuntView } = await loadClient('huntView.js');
    return new HuntView(new THREE.Scene(), new THREE.PerspectiveCamera(), { loadAsset: () => pending });
  })();
  view.receive(f.game.snapshot('BONES')); const old = [...view.boars.values()]; view.clear();
  f.hunt.round++; f.hunt.spawnAnimals(); view.receive(f.game.snapshot('BONES')); resolve(asset); await view.ready;
  assert.equal(view.boars.size, 2); assert.ok(old.every(boar => boar.group.parent === null && boar.avatar === null));
  const current = [...view.boars.values()]; assert.ok(current.every(boar => boar.avatar));
  const mesh = current[0].avatar.model.getObjectByName('char1'); let disposed = 0;
  const counted = () => disposed++;
  for (const resource of [mesh.geometry, mesh.material, mesh.material.map]) resource.addEventListener('dispose', counted);
  view.clear(); assert.equal(disposed, 0); assert.ok(current.every(boar => boar.avatar.disposed));
  for (const resource of [mesh.geometry, mesh.material, mesh.material.map]) resource.removeEventListener('dispose', counted);
});

test('boar rendering: load failure and explicit developer mode keep the original geometric boars', async t => {
  const f = fixture(), previousWarn = console.warn; console.warn = () => {}; t.after(() => { console.warn = previousWarn; });
  const failed = await viewFor(t, f, { loadAsset: async () => { throw new Error('offline'); } });
  assert.match(failed.assetError.message, /offline/); assert.equal(failed.boars.size, 2);
  assert.ok([...failed.boars.values()].every(boar => !boar.avatar && boar.placeholder.parent === boar.group));
  let called = false;
  const fallback = await viewFor(t, f, { boarMode: 'placeholder', loadAsset: async () => { called = true; return asset; } });
  assert.equal(called, false); assert.ok([...fallback.boars.values()].every(boar => !boar.avatar));
});

// ---- Integrity + expression hotfix: rigged body language -------------------
// Snapshot-shaped animals are driven with server ticks exactly as HuntView does.
function bodyRig() {
  const avatar = new BoarAvatar(asset), root = new THREE.Group(); root.add(avatar.visual);
  const at = name => { root.updateMatrixWorld(true); return avatar.model.getObjectByName(name).getWorldPosition(new THREE.Vector3()); };
  const pose = () => avatar.bones.map(bone => [...bone.position.toArray(), ...bone.quaternion.toArray(), ...bone.scale.toArray()]);
  const drive = (animal, from, to, speed = 0, sample = null) => {
    for (let tick = from; tick <= to; tick++) { avatar.update(1 / 60, animal, speed, 0, 0, { tick, turn: 0.2 }); sample?.(tick); }
  };
  return { avatar, root, at, pose, drive };
}

test('boar body language (7, 8, 9, 12, 13): trauma, assess, warning and stagger move the actual rig and restore exactly', () => {
  const { avatar, at, pose, drive } = bodyRig();
  const rest = pose(), head = at('head'), hoofs = ['frontleg2', 'R_frontleg2'].map(at), heights = { head: [], left: [], right: [] };
  const record = () => { heights.head.push(at('head').y); heights.left.push(at('frontleg2').y); heights.right.push(at('R_frontleg2').y); };
  drive({ alive: true, state: 'assess', stateTick: 0, startleTick: -10000 }, 0, 60);
  assert.ok(at('head').y > head.y + .012, 'assess raises an alert head');
  drive({ alive: true, state: 'warning', stateTick: 61, startleTick: -10000 }, 61, 120, 0, record);
  assert.ok(at('head').y < head.y - .03, 'warning lowers the head');
  const lifts = [Math.max(...heights.left) - hoofs[0].y, Math.max(...heights.right) - hoofs[1].y];
  assert.ok(Math.max(...lifts) > .04 && Math.min(...lifts) < .002, `one foreleg paws: ${lifts}`);
  assert.ok(Math.min(...heights.left) > hoofs[0].y - .005 && Math.min(...heights.right) > hoofs[1].y - .005, 'no hoof sinks');
  heights.head.length = 0;
  drive({ alive: true, state: 'patrol', stateTick: 121, startleTick: 130 }, 121, 160, 0, record);
  assert.ok(Math.max(...heights.head) > head.y + .04, 'serious trauma recoils the head/forequarter');
  heights.head.length = 0;
  drive({ alive: true, state: 'stagger', stateTick: 161, startleTick: 130 }, 161, 200, 0, record);
  assert.ok(Math.max(...heights.head) > head.y + .05, 'stagger recoils visibly');
  drive({ alive: true, state: 'patrol', stateTick: 201, startleTick: 130 }, 201, 400);
  assert.deepEqual(pose(), rest, 'neutral patrol returns every bone to its exact rest transform');
  assert.equal(avatar.mixer._actions.length, 1); avatar.dispose();
});

test('boar body language (10, 11): gore and kick follow the existing server strike tick on the rig', () => {
  const { avatar, at, drive } = bodyRig(), head = at('head'), hoof = at('backleg2');
  const samples = [];
  drive({ alive: true, state: 'gore', stateTick: 0, attackTick: 20, startleTick: -10000 }, 0, 37, 0, tick => samples.push([tick, at('head').y]));
  assert.ok(samples.filter(([t]) => t < 20).some(([, y]) => y < head.y - .02), 'head drops into the gore before the strike');
  const hook = samples.reduce((a, b) => b[1] > a[1] ? b : a);
  assert.ok(hook[1] > head.y + .05 && hook[0] >= 20 && hook[0] <= 29, `upward hook at tick ${hook[0]}`);
  const kick = [];
  drive({ alive: true, state: 'kick', stateTick: 40, attackTick: 53, startleTick: -10000 }, 40, 68, 0, tick => kick.push([tick, at('backleg2')]));
  const peak = kick.reduce((a, b) => b[1].z > a[1].z ? b : a);
  assert.ok(peak[1].z > hoof.z + .2 && peak[1].y > hoof.y + .1 && peak[0] >= 53 && peak[0] <= 60, `hind legs kick back at tick ${peak[0]}`);
  avatar.dispose();
});

test('boar body language (14, 16): repeated gestures never accumulate and walking support/bob stay intact', () => {
  const { avatar, root, pose, drive } = bodyRig(), rest = pose();
  for (let cycle = 0; cycle < 4; cycle++) {
    const t = cycle * 200;
    drive({ alive: true, state: 'warning', stateTick: t, startleTick: t + 5 }, t, t + 40);
    drive({ alive: true, state: 'gore', stateTick: t + 41, attackTick: t + 61, startleTick: t + 5 }, t + 41, t + 80);
    drive({ alive: true, state: 'patrol', stateTick: t + 81, startleTick: t + 5 }, t + 81, t + 199);
    assert.deepEqual(pose(), rest, `cycle ${cycle} ends exactly at rest`);
  }
  // Charging gait: head-low posture and raised tail over the approved walk.
  const point = new THREE.Vector3(), indices = avatar.mesh.geometry.attributes.skinIndex, weights = avatar.mesh.geometry.attributes.skinWeight;
  const legs = { front: [], rear: [] };
  for (let i = 0; i < avatar.mesh.geometry.attributes.position.count; i++) {
    for (const [name, pattern] of [['front', /frontleg/], ['rear', /backleg/]]) {
      if ([0, 1, 2, 3].some(j => weights.getComponent(i, j) > 0 && pattern.test(asset.boneNames[indices.getComponent(i, j)]))) legs[name].push(i);
    }
  }
  const hips = [];
  for (let tick = 1000; tick < 1180; tick++) {
    avatar.update(1 / 60, { alive: true, state: 'charge', stateTick: 1000, startleTick: -10000 }, 9, 0, 0, { tick });
    root.updateMatrixWorld(true);
    for (const [name, list] of Object.entries(legs)) {
      const y = Math.min(...list.map(i => avatar.mesh.getVertexPosition(i, point).applyMatrix4(avatar.mesh.matrixWorld).y));
      if (tick > 1030) assert.ok(y >= -.005 && y < .02, `${name} support stays grounded under body language: ${y}`);
    }
    hips.push(avatar.model.getObjectByName('Hips').getWorldPosition(point).y);
  }
  const travel = Math.max(...hips.slice(30)) - Math.min(...hips.slice(30));
  assert.ok(travel > .008 && travel < .025, `bob-polished pelvis travel unchanged: ${travel}`);
  assert.deepEqual(avatar.sized.scale.toArray(), [1.18, 1.18, 1.18]);
  avatar.update(.2, { alive: false, state: 'dead' }, 0, 1.42, .25);
  assert.deepEqual(avatar.model.getObjectByName('Hips').position.toArray(), gltf.scene.getObjectByName('Hips').position.toArray());
  avatar.dispose();
});

test('boar body language (15): two rigs show different states at once with no shared bones or offsets', () => {
  const a = bodyRig(), b = bodyRig(), restB = b.pose();
  const paw = name => a.avatar.model.getObjectByName(name).quaternion.toArray();
  for (let tick = 0; tick < 50; tick++) {
    a.avatar.update(1 / 60, { alive: true, state: 'warning', stateTick: 0, startleTick: -10000 }, 0, 0, 0, { tick });
    b.avatar.update(1 / 60, { alive: true, state: 'patrol', stateTick: 0, startleTick: -10000 }, 0, 0, 0, { tick });
  }
  assert.notDeepEqual([paw('frontleg1'), paw('R_frontleg1')], [b.avatar.model.getObjectByName('frontleg1').quaternion.toArray(),
    b.avatar.model.getObjectByName('R_frontleg1').quaternion.toArray()]);
  assert.deepEqual(b.pose(), restB, 'B stays at rest while A warns');
  assert.notEqual(a.avatar.expression, b.avatar.expression);
  for (let tick = 50; tick < 80; tick++) b.avatar.update(1 / 60, { alive: true, state: 'kick', stateTick: 50, attackTick: 63, startleTick: -10000 }, 0, 0, 0, { tick });
  assert.ok(b.avatar.expression.output.kick > 0 && a.avatar.expression.output.kick === 0);
  a.avatar.dispose(); b.avatar.dispose();
});

test('boar body language: HuntView feeds each rig its own snapshot state and server timing', async t => {
  const f = fixture(), view = await viewFor(t, f), [a, b] = f.hunt.animals;
  Object.assign(a, { state: 'warning', stateTick: f.game.tick });
  const snapshot = f.game.snapshot('BONES'); view.receive(freeze(snapshot));
  for (let i = 0; i < 30; i++) view.update(view.lastReceived + i * 1000 / 60, 1 / 60, null, false);
  const rigA = view.boars.get(a.id).avatar, rigB = view.boars.get(b.id).avatar;
  assert.ok(rigA.expression.output.pawLeft + rigA.expression.output.pawRight > 0, 'A paws');
  assert.equal(rigB.expression.output.pawLeft + rigB.expression.output.pawRight, 0, 'B does not');
  assert.equal(snapshot.hunt.animals.find(x => x.id === a.id).attackTick, a.attackAt ?? null);
});
