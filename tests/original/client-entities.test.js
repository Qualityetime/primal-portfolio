import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GameState } from '../../simulation/gameState.js';
import { bodyContact, toWorld } from '../../shared/body.js';
import { neutralInput } from '../../shared/movement.js';
import { loadClient, mockDocument } from './helpers/client.js';

function fixture() {
  const game = new GameState();
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: `Hunter ${id}` }));
  return { game, hunters, hunt: game.rooms.get('BONES').hunt, snapshot: game.snapshot('BONES') };
}

test('client: two boar poses, wounds and lodged shafts remain attached by ID when snapshots reorder', async t => {
  mockDocument(t); const { HuntView } = await loadClient('huntView.js');
  const f = fixture(), scene = new THREE.Scene(), view = new HuntView(scene, new THREE.PerspectiveCamera(), { boarMode: 'placeholder' });
  const [a, b] = f.snapshot.hunt.animals;
  const wound = { id: 42, region: 'chest', severity: .8, local: { x: .4, y: 1, z: 0 }, normal: { x: 1, y: 0, z: 0 } };
  a.wounds = [{ ...wound }]; b.wounds = [{ ...wound }];
  f.snapshot.hunt.spears = [a, b].map((a, i) => ({ id: 50 + i, animalId: a.id, status: 'embedded',
    local: { x: .4, y: 1, z: 0 }, direction: { x: -1, y: 0, z: 0 } }));
  view.receive(f.snapshot, true);
  const modelA = view.boars.get(a.id), modelB = view.boars.get(b.id);
  assert.equal(view.boars.size, 2); assert.notEqual(modelA, modelB);
  assert.equal(view.spears.get(50).parent, modelA.group); assert.equal(view.spears.get(51).parent, modelB.group);
  assert.equal(view.wounds.get(`${a.id}:42`).parent, modelA.group);
  assert.equal(view.wounds.get(`${b.id}:42`).parent, modelB.group);
  a.alive = false; a.state = 'dead'; b.x += 2; b.state = 'warning';
  f.snapshot.hunt.animals.reverse(); view.receive(f.snapshot); view.update(performance.now(), .1, null, false);
  assert.equal(view.boars.get(a.id), modelA); assert.equal(view.boars.get(b.id), modelB);
  assert.ok(modelA.group.rotation.z > 1); assert.equal(modelB.group.rotation.z, 0);
  assert.ok(modelB.group.position.x > b.x - .2); assert.equal(modelB.mane.scale.y, 1.4);
  f.snapshot.hunt.spears[0] = { id: 50, status: 'ground', x: -3, y: .1, z: -7, direction: { x: 0, y: 0, z: -1 } };
  view.receive(f.snapshot); assert.equal(view.spears.get(50).parent, scene);
  view.clear(); assert.equal(view.boars.size, 0); assert.equal(view.wounds.size, 0); assert.equal(view.spears.size, 0);
  assert.equal(modelA.group.parent, null); assert.equal(modelB.group.parent, null);
});

test('client: a fresh round removes both old models and attachments and creates exactly two new models', async t => {
  mockDocument(t); const { HuntView } = await loadClient('huntView.js');
  const f = fixture(), view = new HuntView(new THREE.Scene(), new THREE.PerspectiveCamera(), { boarMode: 'placeholder' });
  view.receive(f.snapshot, true); const old = [...view.boars.values()];
  f.hunt.round++; f.hunt.spawnAnimals(); view.receive(f.game.snapshot('BONES'));
  assert.equal(view.boars.size, 2); assert.ok(old.every(b => b.group.parent === null));
  assert.deepEqual(new Set(view.boars.keys()), new Set(f.hunt.animals.map(a => a.id))); view.clear();
});

test('client: Bean fallback still renders all three peers for each of four hunters, including their spears', async t => {
  mockDocument(t); const { RemotePlayers } = await loadClient('avatars.js'); const f = fixture();
  for (const self of f.hunters) {
    const scene = new THREE.Scene(), remotes = new RemotePlayers(scene, { mode: 'bean' }); remotes.receive(f.snapshot, self.id, 0); remotes.update(100);
    assert.deepEqual(new Set(remotes.players.keys()), new Set(f.hunters.filter(p => p.id !== self.id).map(p => p.id)));
    for (const [id, remote] of remotes.players) {
      const player = f.hunters.find(p => p.id === id);
      assert.equal(remote.mesh.parent, scene); assert.equal(remote.mesh.children[0].material.color.getHex(), player.color);
      assert.equal(remote.mesh.userData.spear.visible, true);
    }
    remotes.clear(); assert.equal(remotes.players.size, 0);
  }
});

test('client: fourth-hunter prediction, reconciliation and camera correction collide with both boar bodies', async () => {
  const { PredictedPlayer } = await loadClient('player.js'); const f = fixture(), p = f.hunters[3];
  for (const a of f.snapshot.hunt.animals) {
    const predictor = new PredictedPlayer(f.game.world); predictor.bodies = f.snapshot.hunt.animals;
    const position = toWorld(a, { x: 3, y: 0, z: 0 }), yaw = Math.atan2(position.x - a.x, position.z - a.z);
    predictor.reset({ ...p.state, ...position, yaw, health: 100, spears: 3, ack: 0 });
    for (let i = 0; i < 45; i++) {
      predictor.step({ ...neutralInput(yaw), forward: 1, sprint: true });
      assert.equal(bodyContact(predictor.state, a), null); assert.equal(bodyContact(predictor.visualPosition, a), null);
    }
    predictor.reconcile({ ...predictor.state, ack: predictor.sequence });
    assert.equal(bodyContact(predictor.state, a), null);
    predictor.correction = { x: a.x - predictor.state.x, y: 0, z: a.z - predictor.state.z };
    assert.equal(bodyContact(predictor.visualPosition, a), null, 'camera smoothing must not cross the second collider');
  }
});

