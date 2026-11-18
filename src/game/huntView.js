import * as THREE from 'three';
import { HUNT } from '@shared/hunt.js';
import { TICK_RATE } from '@shared/config.js';
import { BoarAvatar, loadBoarAsset } from './boarAvatar.js';
import { groundHeight } from '@shared/terrain.js';
import { createSpear as createSpearModel, SPEAR } from './spearModel.js';
import { FirstPersonRig } from './firstPerson.js';
import { HANDOFF_BLEND } from './spearRig.js';
import { REMOTE_PICKUP, REMOTE_THROW } from './remoteSpear.js';

const up = new THREE.Vector3(0, 0, -1);
// Stable per-animal variety for presentation only (e.g. which foreleg paws).
const smoothstep = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _p2 = new THREE.Vector3();
const seedFor = id => [...String(id)].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7);
function material(color, firstPerson = false) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.9, flatShading: true, depthTest: !firstPerson, depthWrite: !firstPerson });
}
function mesh(geometry, mat, position, scale) {
  const object = new THREE.Mesh(geometry, mat);
  if (position) object.position.set(...position);
  if (scale) object.scale.set(...scale);
  object.castShadow = true; object.receiveShadow = true;
  return object;
}
// The spear model moved to spearModel.js (Hunt Slice 0.1 silhouette, same
// extents). Re-exported here because avatars.js and tests import it from here.
export function createSpear(firstPerson = false) { return createSpearModel(firstPerson); }

function createBoar() {
  const group = new THREE.Group(), placeholder = new THREE.Group(), legs = [];
  group.add(placeholder);
  const hide = material(0x544334), snoutMat = material(0x342b24), tuskMat = material(0xd9c8a3);
  const body = mesh(new THREE.IcosahedronGeometry(1, 1), hide, [0, 0.85, 0.1], [0.64, 0.67, 1.05]);
  const head = mesh(new THREE.IcosahedronGeometry(1, 0), hide, [0, 0.75, -0.86], [0.46, 0.42, 0.59]);
  const snout = mesh(new THREE.CylinderGeometry(0.2, 0.27, 0.35, 7), snoutMat, [0, 0.58, -1.32]);
  snout.rotation.x = Math.PI / 2;
  placeholder.add(body, head, snout);
  for (const side of [-1, 1]) {
    const tusk = mesh(new THREE.ConeGeometry(0.07, 0.33, 5), tuskMat, [side * 0.31, 0.69, -1.23]);
    tusk.rotation.z = -side * 0.5;
    const ear = mesh(new THREE.ConeGeometry(0.15, 0.33, 3), hide, [side * 0.3, 1.2, -0.83]);
    ear.rotation.z = side * 0.55;
    const eye = mesh(new THREE.SphereGeometry(0.055, 6, 4), material(0xe8aa5a), [side * 0.37, 0.88, -1.03]);
    placeholder.add(tusk, ear, eye);
    for (const z of [-0.55, 0.67]) {
      const leg = mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.5, 5), hide, [side * 0.41, 0.28, z]);
      legs.push(leg); placeholder.add(leg);
    }
  }
  const mane = mesh(new THREE.BoxGeometry(0.17, 0.18, 1.25), material(0x2a2520), [0, 1.43, 0.04]);
  placeholder.add(mane);
  return { group, placeholder, legs, hide, head, snout, mane, avatar: null };
}

// The fire at HUNT.camp. Static camp props (lean-to, seats, firewood) are part
// of the environment (world.js); the animated fire and its light live here.
function createCamp(scene, world) {
  const group = new THREE.Group();
  group.position.set(HUNT.camp.x, groundHeight(world, HUNT.camp.x, HUNT.camp.z), HUNT.camp.z);
  group.name = 'campfire';
  const stone = material(0x77736a), wood = material(0x3f2f24), charred = material(0x231c18);
  for (let i = 0; i < 11; i++) {
    const angle = i / 11 * Math.PI * 2;
    const rock = mesh(new THREE.DodecahedronGeometry(0.2, 0), stone, [Math.cos(angle) * 0.74, 0.1, Math.sin(angle) * 0.74], [1.25, 0.65, 1]);
    rock.rotation.y = angle * 2.3; group.add(rock);
  }
  for (let i = 0; i < 4; i++) {
    const log = mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.1, 6), i % 2 ? wood : charred, [0, 0.16, 0]);
    log.rotation.set(Math.PI / 2 - 0.35, i * Math.PI / 2 + 0.3, 0);
    log.position.set(Math.cos(i * Math.PI / 2 + 0.3) * 0.18, 0.18, Math.sin(i * Math.PI / 2 + 0.3) * 0.18);
    group.add(log);
  }
  const embers = mesh(new THREE.CircleGeometry(0.45, 8), new THREE.MeshBasicMaterial({ color: 0xc8521f }), [0, 0.03, 0]);
  embers.rotation.x = -Math.PI / 2; embers.castShadow = false; group.add(embers);
  const flames = [];
  for (let i = 0; i < 6; i++) {
    const fire = mesh(new THREE.ConeGeometry(0.1 + (i % 3) * 0.025, 0.5 + (i % 2) * 0.16, 5), new THREE.MeshBasicMaterial({ color: [0xffb24a, 0xff7f2e, 0xd9481f][i % 3], transparent: true, opacity: 0.7, depthWrite: false, blending: THREE.AdditiveBlending }),
      [Math.cos(i * 2.4) * 0.14, 0.34, Math.sin(i * 2.4) * 0.14]);
    fire.castShadow = false; fire.receiveShadow = false; flames.push(fire); group.add(fire);
  }
  const light = new THREE.PointLight(0xff8c3a, 9, 11, 1.8);
  light.position.set(0, 1.1, 0); group.add(light);
  scene.add(group);
  return { flames, light, embers };
}

export class HuntView {
  constructor(scene, camera, { boarMode = 'rigged', loadAsset = loadBoarAsset, world = null } = {}) {
    this.scene = scene; this.camera = camera; this.world = world;
    this.boars = new Map();
    this.camp = createCamp(scene, world);
    // Hunt Slice 0.1: hands, forearms and the held spear render in their own
    // pass (FirstPersonRig.render) with explicit right/left hand slots.
    this.viewModel = new FirstPersonRig();
    scene.add(camera);
    this.projectiles = new Map(); this.spears = new Map(); this.wounds = new Map(); this.particles = [];
    // Remote Spear Pass: resting spears that left the snapshot this frame, and
    // those being picked up by a remote hunter (shown until their hand has it).
    this.leaving = new Map(); this.pickups = new Map(); this.remotes = null;
    // A remote hunter's thrown spear flies on that hunter's own (interpolated,
    // ~INTERPOLATION_MS behind) timeline, from the authoritative samples, so it
    // leaves their hand at true speed; `landing` keeps it until it lands there.
    this.flights = new Map(); this.landing = new Map();
    this.blood = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 7), material(0x51221b), 128);
    this.blood.count = 0; this.blood.frustumCulled = false; scene.add(this.blood);
    this.bloodTransform = new THREE.Object3D(); this.bloodColor = new THREE.Color();
    this.snapshot = null; this.lastReceived = 0;
    this.throwTime = -10; this.hitTime = -10;
    this.thrustTime = -10;
    this.direction = new THREE.Vector3();
    this.asset = null; this.assetError = null;
    this.ready = boarMode === 'placeholder' ? Promise.resolve(null) : Promise.resolve().then(loadAsset).then(asset => {
      this.asset = asset;
      for (const boar of this.boars.values()) this.mountBoar(boar);
      return asset;
    }).catch(error => {
      this.assetError = error;
      console.warn('Boar visual could not load; keeping geometric fallback.', error);
      return null;
    });
  }
  // Remote Spear Pass: thrown and picked-up spears hand off to and from the
  // remote hunter who owns them (avatars.js RemotePlayers).
  linkRemotes(remotes) {
    this.remotes = remotes;
    remotes.setSpearLocator?.(position => {
      let best = null, bestDistance = 2.4;
      for (const object of this.spears.values()) {
        if (!object.parent) continue;
        object.getWorldPosition(_p2);
        const d = Math.hypot(_p2.x - position.x, _p2.z - position.z);
        if (d < bestDistance) { best = object; bestDistance = d; }
      }
      return best;
    });
  }
  mountBoar(boar) {
    if (!this.asset || boar.avatar) return;
    boar.avatar = new BoarAvatar(this.asset, { seed: seedFor(boar.id) });
    boar.group.add(boar.avatar.visual);
    this.dispose(boar.placeholder);
    for (const object of [...this.spears.values(), ...this.wounds.values()]) {
      const binding = object.userData.boarBinding;
      if (binding?.animalId === boar.id) boar.avatar.bind(object, binding);
    }
    if (boar.animal) boar.avatar.update(0, boar.animal, Math.hypot(boar.animal.vx ?? 0, boar.animal.vz ?? 0), boar.group.rotation.z, boar.group.position.y - (boar.groundY ?? boar.animal.y ?? 0));
    boar.avatar.updateAttachments();
  }
  bindVisual(object, binding) {
    const previous = object.userData.boarBinding;
    if (previous && JSON.stringify(previous) === JSON.stringify(binding)) return;
    this.unbindVisual(object);
    object.userData.boarBinding = binding;
    this.boars.get(binding.animalId)?.avatar?.bind(object, binding);
  }
  unbindVisual(object) {
    const binding = object.userData.boarBinding;
    if (binding) this.boars.get(binding.animalId)?.avatar?.unbind(object);
    delete object.userData.boarBinding;
  }
  disposeBoar(boar) {
    boar.avatar?.dispose();
    this.dispose(boar.group);
  }
  receive(snapshot, fresh = false) {
    if (!snapshot.hunt) return;
    this.snapshot = snapshot;
    this.lastReceived = performance.now();
    const animals = new Set();
    for (const animal of snapshot.hunt.animals) {
      animals.add(animal.id);
      let boar = this.boars.get(animal.id);
      const created = !boar;
      if (created) {
        boar = createBoar(); boar.id = animal.id;
        this.boars.set(animal.id, boar); this.scene.add(boar.group);
      }
      boar.animal = animal;
      if (fresh || created) {
        boar.group.position.set(animal.x, animal.y ?? 0, animal.z);
        boar.group.rotation.set(0, animal.yaw, 0);
      }
      this.mountBoar(boar);
    }
    const present = new Set();
    for (const spear of snapshot.hunt.projectiles) {
      present.add(spear.id);
      if (!this.projectiles.has(spear.id)) {
        const object = createSpear(); this.scene.add(object);
        this.projectiles.set(spear.id, object);
      }
      if (this.remotes) {
        const flight = this.flights.get(spear.id) ?? { samples: [] };
        if (flight.samples.at(-1)?.tick !== snapshot.tick) flight.samples.push({ tick: snapshot.tick, x: spear.x, y: spear.y, z: spear.z, vx: spear.vx, vy: spear.vy, vz: spear.vz });
        if (flight.samples.length > 40) flight.samples.shift();
        this.flights.set(spear.id, flight);
      }
    }
    for (const [id, object] of this.projectiles) if (!present.has(id)) {
      this.projectiles.delete(id);
      // Still in the air on its remote thrower's timeline: finish that flight.
      if (this.remotes?.ownerOf?.(id)?.human && this.flights.has(id)) this.landing.set(id, object);
      else { this.dispose(object); this.flights.delete(id); }
    }
    const resting = new Set();
    for (const spear of snapshot.hunt.spears ?? []) {
      const parent = spear.status === 'embedded' ? this.boars.get(spear.animalId)?.group : this.scene;
      if (!parent) continue;
      resting.add(spear.id);
      if (!this.spears.has(spear.id)) {
        const object = createSpear(); this.spears.set(spear.id, object);
      }
      const object = this.spears.get(spear.id);
      if (object.parent !== parent) parent.add(object);
      if (spear.status === 'embedded') {
        const wound = this.boars.get(spear.animalId).animal.wounds?.find(w => w.id === spear.woundId);
        this.bindVisual(object, { animalId: spear.animalId, kind: 'spear', region: wound?.region,
          local: { ...spear.local }, direction: { ...spear.direction } });
      } else this.unbindVisual(object);
    }
    for (const [id, object] of this.spears) if (!resting.has(id)) {
      // Kept for one more frame: a 'recovered' event in this snapshot may hand
      // it to a remote hunter's reach (event() runs after receive()).
      this.spears.delete(id);
      if (this.remotes) this.leaving.set(id, object); else this.dispose(object);
    }
    const wounded = new Set();
    for (const animal of snapshot.hunt.animals) for (const wound of animal.wounds ?? []) {
      const key = `${animal.id}:${wound.id}`;
      wounded.add(key);
      if (!this.wounds.has(key)) {
        const object = mesh(new THREE.SphereGeometry(0.065 + wound.severity * 0.045, 6, 4), material(0x581f19));
        const n = new THREE.Vector3(wound.normal.x, wound.normal.y, wound.normal.z);
        object.position.set(wound.local.x + n.x * 0.005, wound.local.y + n.y * 0.005, wound.local.z + n.z * 0.005);
        object.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
        object.scale.z = 0.25;
        this.boars.get(animal.id).group.add(object); this.wounds.set(key, object);
        this.bindVisual(object, { animalId: animal.id, kind: 'wound', region: wound.region,
          local: { ...wound.local }, normal: { ...wound.normal } });
      }
    }
    for (const [id, object] of this.wounds) if (!wounded.has(id)) { this.dispose(object); this.wounds.delete(id); }
    for (const [id, boar] of this.boars) if (!animals.has(id)) { this.disposeBoar(boar); this.boars.delete(id); }
    this.blood.count = snapshot.hunt.tracks?.length ?? 0;
    for (const [i, track] of (snapshot.hunt.tracks ?? []).entries()) {
      const transform = this.bloodTransform;
      transform.position.set(track.x, groundHeight(this.world, track.x, track.z) + 0.02 + (i % 3) * 0.001, track.z);
      transform.rotation.set(-Math.PI / 2, 0, track.id * 2.399);
      transform.scale.set(track.size * (1 + track.id % 3 * 0.2), track.size * 0.65, 1); transform.updateMatrix();
      this.blood.setMatrixAt(i, transform.matrix);
      this.bloodColor.setHex(0x51221b).lerp(new THREE.Color(0x62442e), Math.min(1, (snapshot.tick - track.born) / 7200));
      this.blood.setColorAt(i, this.bloodColor);
    }
    this.blood.instanceMatrix.needsUpdate = true;
    if (this.blood.instanceColor) this.blood.instanceColor.needsUpdate = true;
  }
  thrown() { this.throwTime = performance.now(); }
  thrust() { this.thrustTime = performance.now(); }
  event(event) {
    this.remotes?.event?.(event);
    if (event.type === 'recovered' && this.leaving.has(event.spear) && this.remotes?.players?.has(event.player)) {
      const object = this.leaving.get(event.spear);
      this.leaving.delete(event.spear);
      this.unbindVisual(object);
      object.updateWorldMatrix(true, false);
      this.scene.attach(object);           // keep its world transform; it is about to be lifted
      object.visible = true;
      // Where the hunter takes hold: the point of the shaft nearest them.
      const body = this.remotes.players.get(event.player).mesh.position;
      const local = object.worldToLocal(new THREE.Vector3(body.x, body.y + 0.9, body.z));
      const grabZ = Math.min(SPEAR.butt - 0.1, Math.max(SPEAR.rightGrip - 0.62, local.z));
      this.pickups.set(event.spear, { object, player: event.player, grabZ, rest: { position: object.position.clone(), quaternion: object.quaternion.clone() },
        grab: object.localToWorld(new THREE.Vector3(0, 0, grabZ)) });
    }
    if (event.type !== 'hit') return;
    this.hitTime = performance.now();
    for (let i = 0; i < 7; i++) {
      const object = mesh(new THREE.IcosahedronGeometry(0.045, 0), material(i % 2 ? 0x67251c : 0x4b2118), [event.x, event.y, event.z]);
      this.scene.add(object);
      this.particles.push({ object, life: 0.45, velocity: new THREE.Vector3((Math.random() - 0.5) * 3, 1.5 + Math.random(), (Math.random() - 0.5) * 3) });
    }
  }
  update(now, dt, state, active, motion = {}) {
    const seconds = now / 1000;
    this.camp.flames.forEach((flame, i) => {
      flame.scale.y = 0.72 + Math.sin(seconds * 8 + i * 1.7) * 0.2 + Math.sin(seconds * 13.7 + i) * 0.07;
      flame.scale.x = flame.scale.z = 0.9 + Math.sin(seconds * 6.1 + i * 2.2) * 0.1; flame.rotation.y = seconds * 0.7 + i;
    });
    this.camp.light.intensity = 8.2 + Math.sin(seconds * 13) * 0.8 + Math.sin(seconds * 7.3) * 0.6;
    // First-person stance follows the local hunter state and the local action
    // clocks (started on the tick the input was sent); see handSlots.js.
    this.viewModel.update(dt, seconds, state, {
      thrustAge: (now - this.thrustTime) / 1000, throwAge: (now - this.throwTime) / 1000, sprinting: !!motion.sprinting,
    }, { active, speed: motion.speed ?? 0 });
    if (this.snapshot) {
      // Server tick of the displayed snapshot, advanced by local time since it
      // arrived (bounded like projectile extrapolation). Rig body language only.
      const displayTick = Number.isFinite(this.snapshot.tick)
        ? this.snapshot.tick + Math.min(Math.max(0, (now - this.lastReceived) / 1000), 0.1) * TICK_RATE : undefined;
      for (const a of this.snapshot.hunt.animals) {
        const boar = this.boars.get(a.id);
        if (!boar) continue;
        const blend = 1 - Math.exp(-28 * dt);
        boar.group.position.x = THREE.MathUtils.lerp(boar.group.position.x, a.x, blend);
        boar.group.position.z = THREE.MathUtils.lerp(boar.group.position.z, a.z, blend);
        // Each boar stands on its own shared ground height (a.y, Hunt Slice
        // terrain). Body bob/death offsets stay relative to that ground.
        boar.groundY = THREE.MathUtils.lerp(boar.groundY ?? a.y ?? 0, a.y ?? 0, blend);
        const delta = Math.atan2(Math.sin(a.yaw - boar.group.rotation.y), Math.cos(a.yaw - boar.group.rotation.y));
        boar.group.rotation.y += delta * blend;
        boar.group.rotation.z = THREE.MathUtils.lerp(boar.group.rotation.z, !a.alive ? 1.42 : 0, blend);
        const movingSpeed = Math.hypot(a.vx ?? 0, a.vz ?? 0);
        const localY = !a.alive ? 0.25 : a.limp * Math.sin(seconds * 9) * 0.035;
        boar.group.position.y = boar.groundY + localY;
        if (boar.avatar) {
          boar.avatar.update(dt, a, movingSpeed, boar.group.rotation.z, localY, { tick: displayTick, turn: delta });
        } else {
          const speed = movingSpeed > 0.3 ? Math.min(24, movingSpeed * 3 + 3) : 0;
          const attackAge = (this.snapshot.tick - a.stateTick) / 60;
          boar.head.rotation.x = a.state === 'warning' ? -0.15 + Math.sin(seconds * 10) * 0.035
            : ['gore', 'maul'].includes(a.state) ? Math.sin(attackAge * 8) * 0.4 : a.state === 'bluff' ? -0.25 : 0;
          if (a.state === 'stagger') boar.head.rotation.x = 0.28 * Math.exp(-attackAge * 4);
          const startleAge = (this.snapshot.tick - (a.startleTick ?? -10000)) / 60;
          if (a.alive && startleAge >= 0 && startleAge < 0.36) boar.head.rotation.x += Math.sin(startleAge / 0.36 * Math.PI) * 0.24;
          boar.snout.position.y = 0.58 + boar.head.rotation.x * 0.12;
          boar.mane.scale.y = a.state === 'warning' || a.state === 'assess' ? 1.4 : 1;
          boar.legs.forEach((leg, i) => {
            leg.rotation.x = !a.alive ? 0 : Math.sin(seconds * speed + (i % 2) * Math.PI) * (speed ? 0.4 : 0) * (i === 0 ? 1 - a.limp * 0.8 : 1);
            if (a.state === 'warning' && i === 0) leg.rotation.x = Math.sin(seconds * 12) * 0.28;
            if (a.state === 'kick' && i % 2 === 1) leg.rotation.x = Math.sin(attackAge * 9) * 1.1;
          });
        }
        boar.group.scale.y = a.alive ? 1 + Math.sin(seconds * (2.5 + (1 - a.breath) * 7)) * (0.006 + a.lung * 0.009) : 1;
      }
      const extrapolate = Math.min((now - this.lastReceived) / 1000, 0.1);
      for (const spear of this.snapshot.hunt.projectiles) {
        const object = this.projectiles.get(spear.id);
        if (!object) continue;
        this.direction.set(spear.vx, spear.vy, spear.vz).normalize(); object.quaternion.setFromUnitVectors(up, this.direction);
        object.position.set(spear.x + spear.vx * extrapolate - this.direction.x * 1.13, spear.y + spear.vy * extrapolate - this.direction.y * 1.13, spear.z + spear.vz * extrapolate - this.direction.z * 1.13);
        this.remoteFlight(spear.id, object, now);
      }
      for (const [id, object] of this.landing) if (!this.remoteFlight(id, object, now)) { this.dispose(object); this.landing.delete(id); this.flights.delete(id); }
      for (const spear of this.snapshot.hunt.spears ?? []) {
        const object = this.spears.get(spear.id); if (!object) continue;
        object.visible = !this.landing.has(spear.id) && !this.remotes?.restingHeld?.(spear, now);
        if (spear.status === 'embedded' && this.boars.get(spear.animalId)?.avatar) continue;
        const p = spear.status === 'embedded' ? spear.local : spear;
        this.direction.set(spear.direction.x, spear.direction.y, spear.direction.z).normalize();
        object.quaternion.setFromUnitVectors(up, this.direction);
        object.position.set(p.x - this.direction.x * 1.02, p.y - this.direction.y * 1.02, p.z - this.direction.z * 1.02);
      }
      for (const boar of this.boars.values()) boar.avatar?.updateAttachments();
    }
    for (const object of this.leaving.values()) this.dispose(object);
    this.leaving.clear();
    for (const [id, pickup] of this.pickups) {
      const hand = this.remotes?.pickupHandoff?.(pickup.player, id, pickup.grab, now);
      const T = REMOTE_PICKUP;
      if (!hand || hand.age >= T.lift || hand.age > T.end) { this.dispose(pickup.object); this.pickups.delete(id); continue; }
      const object = pickup.object;
      if (hand.age < T.reach * 0.6) { object.position.copy(pickup.rest.position); object.quaternion.copy(pickup.rest.quaternion); continue; }
      // In the left hand: its grab point on the hand's grip, lying like the held spear.
      const inHand = _p.copy(hand.leftGrip).sub(_p2.set(0, 0, pickup.grabZ).applyQuaternion(hand.held.quaternion));
      const k = smoothstep((hand.age - T.reach * 0.6) / (T.grab - T.reach * 0.6));
      object.position.lerpVectors(pickup.rest.position, inHand, k);
      object.quaternion.copy(_q.copy(pickup.rest.quaternion).slerp(hand.held.quaternion, k));
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]; p.life -= dt; p.velocity.y -= 5 * dt;
      p.object.position.addScaledVector(p.velocity, dt); p.object.scale.setScalar(Math.max(0, p.life / 0.45));
      if (p.life <= 0) { this.dispose(p.object); this.particles.splice(i, 1); }
    }
  }
  // Place a remote hunter's thrown spear on that hunter's display timeline:
  // hidden while their hand still holds it, then from the hand (blended over
  // HANDOFF_BLEND) along the authoritative path (samples, gravity) at true
  // speed. Returns false once it has landed on that timeline (or is unknown).
  remoteFlight(id, object, now) {
    const handoff = this.remotes?.projectileHandoff?.(id, now), flight = this.flights.get(id);
    if (!handoff) return this.landing.has(id) ? false : true;
    if (handoff.held) { object.visible = false; return true; }
    if (!flight?.samples.length) return true;
    // The flight starts when the hand lets go (REMOTE_THROW.release after the
    // throw tick): the whole flight runs that much later on this timeline.
    const tick = handoff.displayTick - REMOTE_THROW.release * TICK_RATE, samples = flight.samples;
    let sample = samples[0];
    for (const s of samples) if (s.tick <= tick) sample = s;
    if (this.landing.has(id) && tick > samples.at(-1).tick + 2) return false;
    const t = (tick - sample.tick) / TICK_RATE, g = HUNT.spearGravity;
    const vy = sample.vy - g * t;
    this.direction.set(sample.vx, vy, sample.vz).normalize();
    object.quaternion.setFromUnitVectors(up, this.direction);
    object.position.set(sample.x + sample.vx * t, sample.y + sample.vy * t - 0.5 * g * t * t, sample.z + sample.vz * t).addScaledVector(this.direction, -1.13);
    if (handoff.age < HANDOFF_BLEND) {
      const k = smoothstep(handoff.age / HANDOFF_BLEND);
      object.position.lerpVectors(handoff.from.position, _p.copy(object.position), k);
      object.quaternion.copy(_q.copy(handoff.from.quaternion).slerp(object.quaternion, k));
    }
    object.visible = true;
    return true;
  }
  dispose(object) {
    this.unbindVisual(object);
    object.removeFromParent();
    object.traverse(child => { child.geometry?.dispose(); if (child.material) { child.material.map?.dispose(); child.material.dispose(); } });
  }
  clear() {
    this.snapshot = null; this.viewModel.clear();
    for (const object of this.projectiles.values()) this.dispose(object);
    this.projectiles.clear();
    for (const object of this.spears.values()) this.dispose(object);
    for (const object of this.leaving.values()) this.dispose(object);
    for (const pickup of this.pickups.values()) this.dispose(pickup.object);
    for (const object of this.landing.values()) this.dispose(object);
    this.leaving.clear(); this.pickups.clear(); this.landing.clear(); this.flights.clear();
    for (const object of this.wounds.values()) this.dispose(object);
    this.spears.clear(); this.wounds.clear(); this.blood.count = 0;
    for (const boar of this.boars.values()) this.disposeBoar(boar);
    this.boars.clear();
    for (const p of this.particles) this.dispose(p.object);
    this.particles.length = 0;
  }
}
