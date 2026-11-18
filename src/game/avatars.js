import * as THREE from 'three';
import { INTERPOLATION_MS, PLAYER, TICK_RATE } from '@shared/config.js';
import { HUNT } from '@shared/hunt.js';
import { createSpear } from './huntView.js';
import { HumanAvatar, loadHumanAsset } from './humanAvatar.js';
import { RELEASE_SECONDS } from './handSlots.js';
import { SPEAR } from './spearModel.js';
import { RemoteSpearMotion, REMOTE_PICKUP, REMOTE_THROW, THRUST_SECONDS } from './remoteSpear.js';

const THROW_TICKS = Math.ceil(RELEASE_SECONDS * TICK_RATE); // server: throwing runs 0..1 over ticks(0.45)
const _w = new THREE.Vector3(), _w2 = new THREE.Vector3();

function nameSprite(name) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  // Hunt Slice 0.1: a quieter tag (smaller, translucent) so hunters stay
  // identifiable without banners filling the view up close.
  ctx.fillStyle = '#0d1612a0';
  ctx.fillRect(96, 18, 320, 60);
  ctx.font = '600 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#e9e2cf';
  ctx.fillText(name, 256, 49, 300);
  const texture = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, transparent: true, opacity: 0.85 }));
  sprite.scale.set(1.6, 0.3, 1);
  sprite.position.y = 2.2;
  return sprite;
}

// Keep the original geometry for development comparison and asset-load failures.
export function createBeanAvatar(player) {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: player.color, roughness: 0.88 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER.radius, 0.85, 4, 8), material);
  body.position.y = 0.85;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8), new THREE.MeshStandardMaterial({ color: 0xcab58d, roughness: 1 }));
  head.position.y = 1.58;
  head.castShadow = true;
  group.add(head);
  // A dark face mark shows which way the other hunter is looking.
  const face = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.075, 0.06), new THREE.MeshStandardMaterial({ color: 0x263a2a }));
  face.position.set(0, 1.63, -0.235);
  group.add(face, nameSprite(player.name));
  const spear = createSpear();
  spear.position.set(0.45, 1.15, -0.28);
  spear.rotation.x = -0.18;
  group.add(spear);
  group.userData.spear = spear;
  group.userData.avatarType = 'bean';
  return group;
}

function disposeOwnedObjects(root) {
  root.traverse(object => {
    object.geometry?.dispose();
    if (object.material) { object.material.map?.dispose(); object.material.dispose(); }
  });
}

function movementSpeed(a, b, seconds) {
  if (!(seconds > 0)) return 0;
  const speed = Math.hypot(b.x - a.x, b.z - a.z) / seconds;
  // Respawn/correction discontinuities are not locomotion. Never move the root
  // to accommodate an animation or a large authoritative position change.
  return Number.isFinite(speed) && speed <= PLAYER.sprintSpeed * 2 ? speed : 0;
}

export class RemotePlayers {
  constructor(scene, { mode = 'human', loadAsset = loadHumanAsset, onAssetError = error => console.warn('Human avatar unavailable; using Bean fallback.', error) } = {}) {
    this.scene = scene;
    this.players = new Map();
    this.local = null;
    this.asset = null;
    this.lastUpdate = null;
    this.ready = mode === 'bean' ? Promise.resolve(null) : Promise.resolve().then(loadAsset).then(asset => {
      this.asset = asset;
      for (const remote of this.players.values()) this.mountHuman(remote);
      if (this.local) this.mountHuman(this.local);
      return asset;
    }).catch(error => { onAssetError(error); return null; });
  }

  create(player, local = false) {
    const mesh = createBeanAvatar(player);
    const remote = { id: player.id, mesh, samples: [], human: null, previous: null, isLocal: local,
      motion: new RemoteSpearMotion(), throws: [], pickups: [], released: null, wasAlive: true,
      beanParts: mesh.children.filter(object => object.isMesh) };
    mesh.position.set(player.x, player.y, player.z);
    mesh.rotation.y = player.yaw;
    // Preserve the existing first-person camera/hand/spear treatment. The local
    // rig exists independently, but its full body is hidden from its own view.
    mesh.visible = !local;
    this.scene.add(mesh);
    if (this.asset) this.mountHuman(remote);
    return remote;
  }

  mountHuman(remote) {
    if (remote.human) return;
    const human = new HumanAvatar(this.asset);
    // The Bean's spear floated beside the body; a human hunter's spear hangs
    // from their right hand bone instead (HumanAvatar.enableSpear).
    for (const part of [...remote.beanParts, remote.mesh.userData.spear]) {
      part.removeFromParent();
      disposeOwnedObjects(part);
    }
    remote.beanParts = [];
    remote.human = human;
    remote.mesh.add(human.visual);
    remote.mesh.userData.avatarType = 'human';
    // Only other hunters carry a third-person spear; the local hunter's body
    // is hidden and its spear is the first-person one.
    if (remote !== this.local && !remote.isLocal) remote.mesh.userData.spear = human.enableSpear().spear;
    else remote.mesh.userData.spear = null;
  }

  // ---- Remote Spear Pass: handoffs with HuntView ----
  // Replicated events tie world spears to the hunter whose hand they are in:
  // 'throw' (the projectile is the id just before the event's, the server
  // pushes both in the same step) and 'recovered' (a resting spear picked up
  // or pulled free). Each remote hunter's own timeline is the interpolated
  // display time (INTERPOLATION_MS behind), so its world spear must not leave
  // or arrive before its body shows it.
  event(event) {
    if (!event || event.id <= (this.lastEventId ?? 0)) return;
    this.lastEventId = event.id;
    const remote = this.players.get(event.player);
    if (!remote) return;
    if (event.type === 'throw') {
      remote.throws.push({ tick: event.tick, projectile: event.id - 1 });
      if (remote.throws.length > 6) remote.throws.shift();
    } else if (event.type === 'recovered') {
      remote.pickups.push({ tick: event.tick, spear: event.spear, target: null, armedBefore: null });
      if (remote.pickups.length > 6) remote.pickups.shift();
    }
  }
  // Display time (ms, same clock as `now - INTERPOLATION_MS`) of a server tick.
  displayTime(remote, tick) {
    const s = remote.samples.at(-1);
    return s ? s.receivedAt + (tick - s.serverTick) * 1000 / TICK_RATE : -Infinity;
  }
  ownerOf(projectileId) {
    for (const remote of this.players.values()) if (remote.throws.some(t => t.projectile === projectileId)) return remote;
    return null;
  }
  // HuntView: how a remote hunter's thrown spear should be shown now.
  //   null                      -> not a remote throw: render as before
  //   { held: true }            -> still in the thrower's hand (hide it)
  //   { held: false, age, from } -> released `age` s ago; `from` is the held
  //                                spear's world transform at the release
  projectileHandoff(projectileId, now = performance.now()) {
    const remote = this.ownerOf(projectileId);
    if (!remote?.human) return null;
    const entry = remote.throws.find(t => t.projectile === projectileId);
    const age = (now - INTERPOLATION_MS - this.displayTime(remote, entry.tick)) / 1000 - REMOTE_THROW.release;
    if (age < 0) return { held: true };
    if (!entry.from) {
      // Normally captured on the frame the hand lets go; fall back to the hand now.
      const spear = remote.human.heldSpear;
      spear.updateWorldMatrix(true, false);
      entry.from = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
      spear.matrixWorld.decompose(entry.from.position, entry.from.quaternion, _w);
    }
    // How far (s) this hunter's shown timeline trails the snapshot the world
    // spear is drawn from; HuntView winds that lag out over the first flight.
    const latest = remote.samples.at(-1);
    const shownTick = latest ? latest.serverTick + ((now - INTERPOLATION_MS) - latest.receivedAt) * TICK_RATE / 1000 : 0;
    return { held: false, age, from: entry.from, displayTick: shownTick };
  }
  // HuntView: a resting spear still flying in its owner's (delayed) view.
  restingHeld(spear, now = performance.now()) {
    const remote = this.players.get(spear.owner);
    const entry = remote?.throws.find(t => t.projectile === spear.id);
    return !!entry && (now - INTERPOLATION_MS - this.displayTime(remote, entry.tick)) / 1000 < REMOTE_THROW.release;
  }
  // HuntView: a resting spear this remote hunter picked up. `world` is where
  // it lay (set once). Returns the pickup's age on the hunter's timeline, the
  // left hand's grip and the held spear's transform, or null when unknown.
  pickupHandoff(playerId, spearId, world, now = performance.now()) {
    const remote = this.players.get(playerId), entry = remote?.pickups.find(p => p.spear === spearId);
    if (!entry || !remote.human) return null;
    if (world && !entry.target) entry.target = world.clone();
    const age = (now - INTERPOLATION_MS - this.displayTime(remote, entry.tick)) / 1000;
    const human = remote.human, hand = human.arms.left.hand;
    hand.updateWorldMatrix(true, false);
    const leftGrip = new THREE.Vector3(0.006 * -1, 0.15, -0.03).applyMatrix4(hand.matrixWorld);
    const held = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    human.heldSpear.updateWorldMatrix(true, false);
    human.heldSpear.matrixWorld.decompose(held.position, held.quaternion, _w);
    return { age, leftGrip, held, armedBefore: entry.armedBefore !== false, pulled: !!entry.pulled };
  }
  // HuntView: a resting spear lookup for pull-recovery hand targets.
  setSpearLocator(locate) { this.locateSpear = locate; }

  receive(snapshot, selfId, receivedAt = performance.now()) {
    const present = new Set();
    let selfPresent = false;
    for (const player of snapshot.players) {
      if (player.id === selfId) {
        selfPresent = true;
        if (this.local?.id !== selfId) {
          this.removeLocal();
          this.local = this.create(player, true);
        }
        continue;
      }
      present.add(player.id);
      let remote = this.players.get(player.id);
      if (!remote) {
        remote = this.create(player);
        this.players.set(player.id, remote);
      }
      remote.samples.push({ ...player, serverTick: snapshot.tick, receivedAt });
      if (remote.samples.length > 20) remote.samples.shift();
    }
    for (const id of this.players.keys()) if (!present.has(id)) this.remove(id);
    if (!selfPresent) this.removeLocal();
  }

  update(now, elapsed) {
    const dt = elapsed ?? (this.lastUpdate === null ? 0 : Math.min(0.1, Math.max(0, (now - this.lastUpdate) / 1000)));
    this.lastUpdate = now;
    const target = now - INTERPOLATION_MS;
    for (const remote of this.players.values()) {
      const samples = remote.samples;
      while (samples.length > 2 && samples[1].receivedAt <= target) samples.shift();
      const a = samples[0];
      const b = samples[1] ?? a;
      if (!a) continue;
      const duration = b.receivedAt - a.receivedAt;
      const t = duration > 0 ? THREE.MathUtils.clamp((target - a.receivedAt) / duration, 0, 1) : 1;
      remote.mesh.position.set(
        THREE.MathUtils.lerp(a.x, b.x, t),
        THREE.MathUtils.lerp(a.y, b.y, t),
        THREE.MathUtils.lerp(a.z, b.z, t),
      );
      const yawDelta = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
      remote.mesh.rotation.y = a.yaw + yawDelta * t;
      remote.mesh.rotation.z = b.knockTicks > 0 && b.health > 0 || !remote.human && b.health === 0 ? 0.9 : 0;
      const seconds = b.serverTick > a.serverTick ? (b.serverTick - a.serverTick) / TICK_RATE : duration / 1000;
      const speed = target > b.receivedAt ? 0 : movementSpeed(a, b, seconds);
      remote.human?.update(dt, b, speed);
      this.updateSpear(remote, a, b, t, now, dt);
    }
  }

  // The remote hunter's spear presentation from replicated state only:
  // spears, health, knockTicks, recovering, cooking, bracing, winding,
  // windupTime, thrust, throwing and pitch (no new network fields), on that
  // hunter's display timeline (remoteSpear.js). Samples a/b bracket it.
  updateSpear(remote, a, b, t, now, dt) {
    const spear = remote.mesh.userData.spear;
    if (!spear) return;
    const display = now - INTERPOLATION_MS;
    if (!remote.human) return this.beanSpear(remote, a, b, t);
    const human = remote.human, motion = remote.motion;
    const alive = b.health > 0;
    if (!alive || (!remote.wasAlive && alive)) motion.reset();  // death clears; respawn starts clean
    remote.wasAlive = alive;
    // Action starts on the display timeline, from whichever bracketing sample
    // already shows the action (a sample is displayed at its receivedAt).
    const startOf = (field, seconds) => {
      const s = b[field] > 0 ? b : a[field] > 0 ? a : null;
      return s ? s.receivedAt / 1000 - s[field] * seconds : null;
    };
    const thrustStart = startOf('thrust', THRUST_SECONDS);
    const throwStart = startOf('throwing', THROW_TICKS / TICK_RATE);
    // Picking up: the newest pickup whose time has come on this timeline.
    let pickup = null;
    for (const entry of remote.pickups) {
      const at = this.displayTime(remote, entry.tick);
      if (entry.armedBefore === null) {
        const before = remote.samples.filter(s => s.serverTick < entry.tick).at(-1) ?? a;
        entry.armedBefore = (before.spears ?? 0) > 0;
      }
      if (display >= at - 50 && display - at < REMOTE_PICKUP.end * 1000) pickup = { entry, at };
    }
    // A world point in this hunter's stance frame (the arm's reach is limited
    // in HumanAvatar.carryMotion, against the shoulder as posed this frame).
    const frameTarget = world => {
      human.stanceFrame.updateWorldMatrix(true, false);
      return human.stanceFrame.worldToLocal(world.clone()).toArray();
    };
    let pullTarget = null;
    if (b.recovering && this.locateSpear) {
      const object = this.locateSpear(remote.mesh.position);
      if (object) pullTarget = frameTarget(object.localToWorld(_w2.set(0, 0, SPEAR.rightGrip)));
    }
    const state = { ...b, windupTime: THREE.MathUtils.lerp(a.windupTime ?? 0, b.windupTime ?? 0, t) };
    const result = motion.update(display / 1000, {
      state, dt, sprinting: human.state === 'run', thrustStart, releaseAt: throwStart, pullTarget,
      pickupAt: pickup ? pickup.at / 1000 : null, pickupTarget: pickup?.entry.target ? frameTarget(pickup.entry.target) : null,
      pickupArmed: pickup?.entry.armedBefore,
    });
    // A spear picked up by an empty-handed hunter is not in the fist before
    // their body has reached for it.
    const awaiting = remote.pickups.some(e => e.armedBefore === false && display < this.displayTime(remote, e.tick));
    const holding = result.holding && alive && !awaiting;
    // Capture the exact held-spear transform on the frame the hand lets go.
    const wasHolding = human.heldSpear.visible;
    human.carrySpear(dt, { stance: result.phase, motion: result.pose }, { holding, pitch: b.pitch ?? 0 });
    if (wasHolding && !holding && result.phase === 'throw') {
      const entry = remote.throws.at(-1);
      if (entry && !entry.from) {
        human.heldSpear.updateWorldMatrix(true, false);
        entry.from = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
        // The rig hid the spear this frame but its transform is still the hand's.
        human.heldSpear.matrixWorld.decompose(entry.from.position, entry.from.quaternion, _w);
      }
    }
    remote.phase = result.phase;
  }

  // Bean fallback: no skeleton, so the spear rides the body at the old offsets.
  beanSpear(remote, a, b) {
    const spear = remote.mesh.userData.spear;
    spear.visible = b.health > 0 && b.spears > 0 && !b.recovering;
    const windup = b.winding ? Math.min(1, b.windupTime / HUNT.windupSeconds) : 0;
    const swing = Math.sin(Math.min(1, (b.throwing ?? 0)) * Math.PI);
    spear.position.set(0.45, 1.15 + windup * 0.22, b.bracing ? -0.9 : -0.28 + windup * 0.5 - Math.sin((b.thrust ?? 0) * Math.PI) * 0.6 - swing * 0.7);
    spear.rotation.x = b.pitch - windup * 0.45 + swing * 0.25;
  }

  updateLocal(state, position, dt) {
    if (!this.local) return;
    const local = this.local;
    local.mesh.position.set(position.x, position.y, position.z);
    local.mesh.rotation.y = state.yaw;
    local.mesh.rotation.z = state.knockTicks > 0 && state.health > 0 ? 0.9 : 0;
    const speed = local.previous ? movementSpeed(local.previous, state, dt) : 0;
    local.human?.update(dt, state, speed);
    local.previous = { x: state.x, z: state.z };
  }

  dispose(remote) {
    this.scene.remove(remote.mesh);
    remote.human?.dispose(); // Detach shared GPU resources before disposing owned attachments.
    disposeOwnedObjects(remote.mesh);
  }

  remove(id) {
    const remote = this.players.get(id);
    if (!remote) return;
    this.dispose(remote);
    this.players.delete(id);
  }
  removeLocal() {
    if (this.local) this.dispose(this.local);
    this.local = null;
  }
  clear() {
    for (const id of this.players.keys()) this.remove(id);
    this.removeLocal();
    this.lastUpdate = null;
  }
}
