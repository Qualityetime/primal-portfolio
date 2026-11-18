import { FIXED_DT, PLAYER, TICK_RATE } from '../shared/config.js';
import { HUNT, flatDistance, throwProfile } from '../shared/hunt.js';
import { createPlayerState, followGround, resolveObstacles } from '../shared/movement.js';
import { bodyContact, toLocal, toWorld } from '../shared/body.js';
import { hitAnatomy, injuryFor } from './anatomy.js';
import { stepBoar, temperament, changeState } from './boarBrain.js';
import { BOAR_AI } from './boarTuning.js';
import { rememberTrauma } from './boarContext.js';
import { TERRAIN, groundContact, groundHeight } from '../shared/terrain.js';

const ticks = seconds => Math.ceil(seconds * TICK_RATE);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const direction = (yaw, pitch) => ({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
const tipAt = (state, dir, reach) => ({ x: state.x + dir.x * reach, y: state.y + PLAYER.eyeHeight - 0.08 + dir.y * reach, z: state.z + dir.z * reach });

// First intersection along a segment. Swept tests keep fast spears from skipping targets.
export function segmentSphere(from, to, center, radius) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const ox = from.x - center.x, oy = from.y - center.y, oz = from.z - center.z;
  const a = dx * dx + dy * dy + dz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c <= 0) return 0;
  if (a < 1e-12) return null;
  const b = 2 * (ox * dx + oy * dy + oz * dz);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / (2 * a);
  return t >= 0 && t <= 1 ? t : null;
}

export class HuntState {
  constructor(world, { seed = Math.floor(Math.random() * 0xffffffff) } = {}) {
    this.world = world; this.seed = seed;
    this.round = 1; this.meals = 0; this.complete = false;
    this.nextId = 0; this.events = []; this.projectiles = []; this.spears = []; this.tracks = [];
    this.lastReset = -ticks(5);
    this.spawnAnimals();
  }

  spawnAnimals() {
    this.animals = HUNT.boarSpawns.map((spawn, index) => {
      const seed = (this.seed + this.round * 71931 + index * 104729) >>> 0;
      return {
        id: `boar-${this.round}-${index + 1}`, ...spawn, y: groundHeight(this.world, spawn.x, spawn.z), yaw: Math.PI / 2, health: HUNT.boarHealth,
        state: 'patrol', until: 0, stateTick: 0, meat: 0, hitTick: -1000,
        hitPlayers: new Set(), traits: temperament(seed), threats: new Map(),
        wounds: [], blood: 1, breath: 1, limp: 0, lung: 0, stress: 0,
        vx: 0, vz: 0, blocked: 0, targetId: null, targetPosition: null,
        targetChanged: 0, lastThreat: 0, lastTrack: -1000,
        escape: { x: 0, z: -18 }, surrounded: false,
        intentUntil: 0, commitUntil: 0, previousIntent: null, tacticGoal: null, awareHunters: [], rearPressure: 0,
        immediateMelee: false, immediateHunter: null,
        lastBreakaway: -1000, lastDesperate: -1000, acuteReaction: null,
        acute: null, lastTraumaTick: -10000, traumaMoveTick: -1,
        huntMemory: new Map(), huntAlarm: 0, huntAwareness: 0,
        pressure: 0, pressureParts: {}, closePressureSeconds: 0, decisionSeconds: BOAR_AI.calmDecisionSeconds,
        intentReason: 'undisturbed', intentTrace: [],
        decisionSeed: seed,
      };
    });
    this.previousAnimals = new Map(this.animals.map(a => [a.id, { ...a }]));
    // The unchanged Professor Boar brain gets an entity-local facade. Its movement
    // and damage callbacks cannot accidentally act on the other boar's state.
    const hunt = this;
    this.brains = new Map(this.animals.map(a => [a.id, {
      animal: a, get world() { return hunt.world; },
      moveAnimal: (dx, dz) => hunt.moveAnimal(a, dx, dz),
      hurt: (...args) => hunt.hurt(a, ...args),
    }]));
  }

  animalById(id) { return this.animals.find(a => a.id === id); }
  harvestable(player) {
    return this.animals.filter(a => a.health <= 0 && a.meat > 0 && !player.harvestedAnimals.has(a.id)
      && flatDistance(player.state, a) <= HUNT.harvestRange)
      .sort((a, b) => flatDistance(player.state, a) - flatDistance(player.state, b))[0];
  }

  setSpears(player, count) { player.spears = count; player.state.spears = count; }
  addPlayer(player) {
    Object.assign(player, {
      health: HUNT.playerHealth, rawMeat: 0, cookedMeat: 0, harvestedAnimals: new Set(),
      cookUntil: 0, respawnAt: 0, lastThrow: -ticks(5), lastAttack: -ticks(5),
      thrust: null, windup: null, recovery: null, wounds: [], lastHurt: -1000, lastBrace: -1000,
    });
    Object.assign(player.state, { stamina: 100, injurySlow: 0, knockTicks: 0, impulseX: 0, impulseZ: 0, braceTime: 0, bracing: false, winding: false, windupTime: 0 });
    this.setSpears(player, HUNT.spearCapacity);
  }

  event(type, tick, detail = {}) {
    this.events.push({ id: ++this.nextId, type, tick, ...detail });
    if (this.events.length > 64) this.events.shift();
  }
  cancelCooking(player) {
    if (!player.cookUntil) return;
    player.rawMeat++; player.cookUntil = 0;
  }
  cancelWindup(player) {
    player.windup = null; player.state.winding = false; player.state.windupTime = 0;
  }

  action(player, input, tick, players) {
    if (player.health <= 0 || player.state.knockTicks > 0) { this.cancelWindup(player); return; }
    if (input.attack || input.interact || player.state.stamina < 12 || player.spears <= 0
      || (player.windup && tick - player.windup.lastHeld > ticks(0.3))) this.cancelWindup(player);
    if ((input.throwStart || input.throwHeld) && !input.attack && !input.interact && !player.windup
      && player.spears > 0 && !player.thrust && !player.recovery && !player.cookUntil
      && tick - player.lastAttack >= ticks(HUNT.throwCooldown) && player.state.stamina >= 12) {
      player.windup = { born: tick, lastHeld: tick };
    }
    if (player.windup && input.throwHeld) player.windup.lastHeld = tick;
    if (input.throw && player.windup) {
      const profile = throwProfile((tick - player.windup.born) / TICK_RATE);
      this.cancelWindup(player);
      player.lastThrow = player.lastAttack = tick; player.recovery = null;
      player.state.stamina -= 12; player.state.braceTime = 0; player.state.bracing = false;
      this.setSpears(player, player.spears - 1);
      const id = ++this.nextId;
      const spread = profile.spread + Math.hypot(player.velocityX ?? 0, player.velocityZ ?? 0) * 0.001 + (player.state.grounded ? 0 : 0.012);
      const dir = direction(player.state.yaw + Math.sin(id * 2.399) * spread,
        clamp(player.state.pitch + Math.cos(id * 1.71) * spread, -1.45, 1.45));
      const tip = tipAt(player.state, dir, 0.45);
      this.projectiles.push({ id, owner: player.id, born: tick, ...tip,
        origin: { x: player.state.x, z: player.state.z },
        vx: dir.x * profile.speed, vy: dir.y * profile.speed + 1, vz: dir.z * profile.speed });
      this.event('throw', tick, { player: player.id, ...tip });
    } else if (input.attack && player.spears > 0 && !player.thrust && tick - player.lastAttack >= ticks(HUNT.thrustCooldown) && player.state.stamina >= 7) {
      player.lastAttack = tick; player.recovery = null; player.state.stamina -= 7;
      player.state.braceTime = 0; player.state.bracing = false;
      player.thrust = { born: tick, yaw: player.state.yaw, pitch: player.state.pitch, previous: null, hit: false };
      this.event('thrust', tick, { player: player.id });
    }
    if (player.windup && !input.throwHeld && !input.throwStart) this.cancelWindup(player);
    player.state.winding = !!player.windup;
    player.state.windupTime = player.windup ? Math.min(HUNT.windupSeconds, (tick - player.windup.born) / TICK_RATE) : 0;
    if (input.interact && !player.cookUntil && !player.recovery) {
      const carcass = this.harvestable(player);
      if (flatDistance(player.state, HUNT.camp) <= HUNT.campRange) {
        if (player.rawMeat > 0) {
          player.rawMeat--; player.cookUntil = tick + ticks(HUNT.cookSeconds);
          this.event('cooking', tick, { player: player.id });
        } else if (player.spears < HUNT.spearCapacity) {
          this.setSpears(player, HUNT.spearCapacity); this.event('resupplied', tick, { player: player.id });
        }
      } else if (carcass) {
        const animal = carcass, amount = Math.min(HUNT.meatPerHunter, animal.meat);
        animal.meat -= amount; player.rawMeat += amount; player.harvestedAnimals.add(animal.id);
        this.event('harvest', tick, { animalId: animal.id, player: player.id, amount });
      } else if (player.spears < HUNT.spearCapacity) {
        const available = this.spears.filter(s => this.spearPoint(s) && flatDistance(player.state, this.spearPoint(s)) < 2.4)
          .sort((a, b) => flatDistance(player.state, this.spearPoint(a)) - flatDistance(player.state, this.spearPoint(b)));
        const spear = available[0];
        if (spear?.status === 'ground') {
          // One authoritative action claims it immediately, including while moving.
          this.spears.splice(this.spears.indexOf(spear), 1); this.setSpears(player, player.spears + 1);
          this.event('recovered', tick, { player: player.id, spear: spear.id });
        } else if (spear) {
          const depth = clamp((spear.depth ?? 0.7) / 1.25, 0, 1);
          const duration = HUNT.recoverShallowSeconds + (HUNT.recoverSeconds - HUNT.recoverShallowSeconds) * depth;
          player.recovery = { id: spear.id, until: tick + ticks(duration), x: player.state.x, z: player.state.z };
          const animal = this.animalById(spear.animalId);
          if (animal?.health > 0) animal.acuteReaction ??= { owner: player.id, kind: 'pull', tick, severity: depth };
        }
      }
    }
    if (input.restart && this.animals.every(a => a.health <= 0) && flatDistance(player.state, HUNT.camp) <= HUNT.campRange
      && tick - this.lastReset >= ticks(2) && ![...players.values()].some(p => p.cookUntil)) {
      this.lastReset = tick; this.round++; this.meals = 0; this.complete = false;
      this.projectiles.length = 0; this.spears.length = 0; this.tracks.length = 0; this.spawnAnimals();
      for (const p of players.values()) this.addPlayer(p);
      this.event('reset', tick, { player: player.id, round: this.round });
    }
  }

  spearPoint(spear) {
    if (spear.status !== 'embedded') return spear;
    const animal = this.animalById(spear.animalId);
    return animal ? toWorld(animal, spear.local) : null;
  }

  stepPlayers(tick, players) {
    for (const player of players.values()) {
      if (player.health <= 0 && tick >= player.respawnAt) {
        player.health = HUNT.playerHealth; player.wounds = []; player.recovery = player.thrust = null; this.cancelWindup(player);
        player.state = createPlayerState(this.world.spawns[player.slot]); this.setSpears(player, player.spears);
        player.queue.length = 0; player.ack = player.lastReceivedSequence;
        this.event('respawn', tick, { player: player.id });
      }
      const safe = flatDistance(player.state, HUNT.camp) <= HUNT.campSafeRange;
      if (player.windup && (tick - player.windup.lastHeld > ticks(0.3) || player.health <= 0
        || player.state.knockTicks > 0 || player.state.stamina < 12)) this.cancelWindup(player);
      player.state.winding = !!player.windup;
      player.state.windupTime = player.windup ? Math.min(HUNT.windupSeconds, (tick - player.windup.born) / TICK_RATE) : 0;
      if (player.health > 0) {
        for (const wound of player.wounds) if (safe) wound.bleed = Math.max(0, wound.bleed - FIXED_DT * 0.07);
        const bleeding = player.wounds.reduce((sum, w) => sum + w.bleed, 0);
        player.health = Math.max(0, player.health - bleeding * FIXED_DT);
        player.state.injurySlow = Math.min(0.8, player.wounds.reduce((sum, w) => sum + w.severity, 0) * 0.12);
        if (safe) for (const wound of player.wounds) wound.severity = Math.max(0, wound.severity - FIXED_DT * 0.05);
        if (player.health <= 0) this.downPlayer(player, tick);
      }
      if (player.cookUntil) {
        if (flatDistance(player.state, HUNT.camp) > HUNT.campRange || player.health <= 0) {
          this.cancelCooking(player); this.event('cook-cancelled', tick, { player: player.id });
        } else if (tick >= player.cookUntil) {
          player.cookUntil = 0; player.cookedMeat++; player.health = Math.min(HUNT.playerHealth, player.health + 25);
          this.meals++; this.event('cooked', tick, { player: player.id });
          if (!this.complete && this.meals >= HUNT.mealGoal) { this.complete = true; this.event('complete', tick, { round: this.round }); }
        }
      }
      if (player.recovery) {
        const r = player.recovery, spear = this.spears.find(s => s.id === r.id), animal = this.animalById(spear?.animalId);
        const moved = Math.hypot(player.state.x - r.x, player.state.z - r.z) > 0.5;
        const unsafePull = animal?.health > 0 && Math.hypot(animal.vx, animal.vz) > 2.2;
        if (!spear || moved || unsafePull || player.health <= 0 || player.state.knockTicks > 0
          || player.spears >= HUNT.spearCapacity || !this.spearPoint(spear)
          || flatDistance(player.state, this.spearPoint(spear)) > 2.4) player.recovery = null;
        else if (tick >= r.until) {
          this.spears.splice(this.spears.indexOf(spear), 1); this.setSpears(player, player.spears + 1);
          const wound = animal?.wounds.find(w => w.id === spear.woundId);
          if (wound && animal.health > 0) { wound.bleed *= 1.35; animal.stress = Math.min(1, animal.stress + 0.2); }
          player.recovery = null; this.event('recovered', tick, { animalId: spear.animalId, player: player.id, spear: spear.id });
        }
      }
    }
  }

  step(tick, players) {
    this.stepPlayers(tick, players);
    this.previousAnimals = new Map(this.animals.map(a => [a.id, { ...a }]));
    for (const animal of this.animals) {
      this.stepWounds(animal, tick);
      this.stepAnimal(animal, tick, players);
    }
    this.stepProjectiles(tick, players);
    this.stepThrusts(tick, players);
    for (const animal of this.animals) this.stepBraces(animal, tick, players);
    for (const animal of this.animals) this.rushContacts(animal, tick, players);
    for (const player of players.values()) {
      resolveObstacles(player.state, this.world, this.animals);
      followGround(player.state, this.world); // a push sideways keeps the feet on the shared ground
    }
    this.tracks = this.tracks.filter(t => tick - t.born < ticks(120));
    // Cap discarded camp-stock spears. Embedded spears and in-flight weapons are
    // retained; hunter supply can always be restored at the existing camp.
    while (this.spears.filter(s => s.status === 'ground').length > 36) {
      this.spears.splice(this.spears.findIndex(s => s.status === 'ground'), 1);
    }
  }

  stepWounds(a, tick) {
    if (a.health <= 0) return;
    const bleeding = a.wounds.reduce((sum, w) => sum + w.bleed, 0);
    a.blood = Math.max(0, a.blood - bleeding * FIXED_DT);
    a.health = Math.max(0, a.health - bleeding * 42 * FIXED_DT);
    a.limp = Math.min(0.9, a.wounds.reduce((sum, w) => sum + (w.region === 'legs' ? w.severity * 0.48 : w.region === 'rump' ? w.severity * 0.08 : 0), 0));
    a.lung = Math.min(0.85, a.wounds.reduce((sum, w) => sum + (w.region === 'chest' ? w.severity * 0.4 : 0), 0));
    a.stress = Math.max(0, a.stress - FIXED_DT * 0.008);
    if (bleeding > 0.0001 && tick - a.lastTrack >= ticks(clamp(0.65 - bleeding * 9, 0.22, 0.65))) {
      a.lastTrack = tick;
      const wound = a.wounds.reduce((best, w) => !best || w.bleed > best.bleed ? w : best, null);
      const point = toWorld(a, wound.local);
      this.tracks.push({ id: ++this.nextId, animalId: a.id, x: point.x, z: point.z, born: tick, size: clamp(bleeding * 9, 0.06, 0.24) });
      if (this.tracks.length > 128) this.tracks.shift();
    }
    if (a.blood <= 0.25 || a.health <= 0) this.kill(a, tick, a.lastWoundedBy);
  }

  moveAnimal(a, dx, dz) {
    const beforeX = a.x, beforeZ = a.z;
    a.x += dx; a.z += dz;
    for (let pass = 0; pass < 3; pass++) {
      for (const obstacle of this.world.obstacles) {
        // Rock and trunks are full-height columns: test them at the boar's own ground.
        const contact = bodyContact({ ...obstacle, y: a.y ?? 0 }, a, obstacle.radius);
        if (contact) { a.x -= contact.x * contact.overlap; a.z -= contact.z * contact.overlap; }
      }
      const cx = a.x - HUNT.camp.x, cz = a.z - HUNT.camp.z, distance = Math.hypot(cx, cz);
      if (distance < HUNT.campSafeRange) {
        a.x = HUNT.camp.x + (distance > 1e-5 ? cx / distance : 0) * HUNT.campSafeRange;
        a.z = HUNT.camp.z + (distance > 1e-5 ? cz / distance : -1) * HUNT.campSafeRange;
      }
    }
    a.x = clamp(a.x, -this.world.halfSize + 1.8, this.world.halfSize - 1.8);
    a.z = clamp(a.z, -this.world.halfSize + 1.8, this.world.halfSize - 1.8);
    // The boar stands on the same shared ground hunters walk on.
    a.y = groundHeight(this.world, a.x, a.z);
    a.blocked = Math.hypot(a.x - beforeX, a.z - beforeZ) < Math.hypot(dx, dz) * 0.3 ? a.blocked + 1 : 0;
  }
  stepAnimal(a, tick, players) {
    const x = a.x, z = a.z;
    stepBoar(this.brains.get(a.id), tick, players);
    a.vx = (a.x - x) / FIXED_DT; a.vz = (a.z - z) / FIXED_DT;
  }

  downPlayer(player, tick) {
    this.cancelWindup(player);
    this.cancelCooking(player); player.respawnAt = tick + ticks(2); player.thrust = player.recovery = null;
    player.state.bracing = false; player.state.braceTime = 0;
  }
  hurt(a, player, amount, tick, kind, knock = false) {
    if (player.health <= 0 || tick - player.lastHurt < ticks(0.22)) return;
    player.lastHurt = tick; player.health = Math.max(0, player.health - amount);
    this.cancelWindup(player);
    player.wounds.push({ severity: amount / 25, bleed: kind === 'kick' || kind === 'bluff' ? 0 : amount * 0.006 });
    if (player.wounds.length > 12) player.wounds.shift();
    player.recovery = player.thrust = null; player.state.bracing = false; player.state.braceTime = 0;
    const dx = player.state.x - a.x, dz = player.state.z - a.z, d = Math.hypot(dx, dz) || 1;
    player.state.impulseX += dx / d * (knock ? 4 : 2); player.state.impulseZ += dz / d * (knock ? 4 : 2);
    if (knock && player.state.grounded) player.state.knockTicks = ticks(0.9);
    this.event('hurt', tick, { animalId: a.id, player: player.id, amount, kind, knocked: knock });
    if (!player.health) this.downPlayer(player, tick);
  }
  rushContacts(a, tick, players) {
    if (a.health <= 0 || !['charge', 'bluff', 'breakaway'].includes(a.state)) return;
    for (const p of players.values()) {
      if (a.hitPlayers.has(p.id) || p.health <= 0 || flatDistance(p.state, HUNT.camp) <= HUNT.campSafeRange || p.state.y - (a.y ?? 0) > 1.05) continue;
      if (!bodyContact(p.state, a, 0.52)) continue;
      a.hitPlayers.add(p.id);
      this.hurt(a, p, a.state === 'bluff' ? 8 : a.state === 'breakaway' ? 20 : HUNT.boarDamage, tick, a.state, a.state !== 'bluff');
    }
  }

  obstruction(from, to) {
    // The ground skin follows the shared terrain (the original 0.05 m skin over a
    // flat floor). Water never stops a spear; it rests on the creek bed.
    let collision = groundContact(this.world, from, to);
    for (const obstacle of this.world.obstacles) {
      const hit = segmentSphere({ ...from, y: 0 }, { ...to, y: 0 }, { ...obstacle, y: 0 }, obstacle.radius + 0.04);
      if (hit !== null && (collision === null || hit < collision)) collision = hit;
    }
    return collision;
  }

  impact(a, hit, speed, kind, owner, tick, spear = null) {
    if (a.health <= 0) return null;
    const wound = { id: ++this.nextId, ...injuryFor(hit, speed, kind) };
    a.wounds.push(wound); if (a.wounds.length > 32) a.wounds.shift();
    a.health = Math.max(0, a.health - wound.trauma); a.hitTick = tick; a.lastWoundedBy = owner;
    a.stress = Math.min(1, a.stress + 0.1 + wound.trauma / 90);
    const memory = a.threats.get(owner);
    // A wound is not sight. Keep real threat attribution when available, but do
    // not invent a seen timestamp or track the launch origin through cover.
    if (memory && tick - memory.seen < ticks(12)) memory.damage += wound.trauma;
    this.event('hit', tick, { animalId: a.id, player: owner, region: wound.region, glancing: wound.glancing, ...hit.worldPoint });
    if (spear) {
      if (wound.embedded) {
        const len = Math.hypot(spear.vx, spear.vy, spear.vz) || 1;
        const dir = toLocal({ x: 0, z: 0, yaw: a.yaw }, { x: spear.vx / len, y: spear.vy / len, z: spear.vz / len });
        this.spears.push({ id: spear.id, animalId: a.id, owner, born: tick, status: 'embedded', local: hit.point, direction: dir, woundId: wound.id, depth: wound.depth });
      } else {
        // A glancing shaft deflects and falls, rather than disappearing or applying
        // the same injury as a perpendicular strike.
        const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
        const n = { x: c * hit.normal.x + s * hit.normal.z, y: hit.normal.y, z: -s * hit.normal.x + c * hit.normal.z };
        const dot = spear.vx * n.x + spear.vy * n.y + spear.vz * n.z;
        Object.assign(spear, hit.worldPoint, { vx: (spear.vx - 2 * dot * n.x) * 0.22, vy: Math.max(0.8, (spear.vy - 2 * dot * n.y) * 0.22), vz: (spear.vz - 2 * dot * n.z) * 0.22, deflected: true });
      }
    }
    if (a.health <= 0) this.kill(a, tick, owner);
    else if (!wound.glancing && wound.severity > 0.5 && (kind === 'brace' || wound.region === 'legs')) changeState(a, 'stagger', tick, 0.22 + wound.severity * 0.1);
    const serious = !wound.glancing && wound.depth >= BOAR_AI.traumaDepth
      && (wound.trauma >= BOAR_AI.traumaMinimum || (kind === 'throw' && wound.embedded && wound.depth >= BOAR_AI.lodgedTraumaDepth));
    if (a.health > 0 && serious
      && (!a.acuteReaction || wound.trauma >= (a.acuteReaction.trauma ?? 0))) {
      const sourceDirection = { x: Math.cos(a.yaw) * hit.normal.x + Math.sin(a.yaw) * hit.normal.z,
        z: -Math.sin(a.yaw) * hit.normal.x + Math.cos(a.yaw) * hit.normal.z };
      a.acuteReaction = { owner, tick, kind, severity: wound.severity, trauma: wound.trauma, depth: wound.depth, embedded: wound.embedded, sourceDirection,
        identifiedId: a.awareHunters.find(p => p.id === owner)?.id ?? null, remembered: true };
      rememberTrauma(a, a.acuteReaction, tick);
    }
    return wound;
  }
  kill(a, tick, owner) {
    if (a.state === 'dead') return;
    a.health = 0; a.state = 'dead'; a.meat = HUNT.carcassMeat; a.vx = a.vz = 0;
    a.acute = a.acuteReaction = null; a.intentUntil = a.commitUntil = tick; a.tacticGoal = null;
    a.immediateMelee = false; a.immediateHunter = null;
    this.event('kill', tick, { animalId: a.id, player: owner, x: a.x, z: a.z });
  }

  stepProjectiles(tick, players) {
    const survivors = [];
    for (const spear of this.projectiles) {
      const previous = { x: spear.x, y: spear.y, z: spear.z };
      spear.vy -= HUNT.spearGravity * FIXED_DT;
      spear.x += spear.vx * FIXED_DT; spear.y += spear.vy * FIXED_DT; spear.z += spear.vz * FIXED_DT;
      const collision = this.obstruction(previous, spear);
      const contact = !spear.deflected ? this.firstAnimalHit(previous, spear, true) : null;
      const { animal: a, hit } = contact ?? {};
      if (hit && (collision === null || hit.t < collision)) {
        const wound = this.impact(a, hit, Math.hypot(spear.vx - a.vx, spear.vy, spear.vz - a.vz), 'throw', spear.owner, tick, spear);
        if (!wound?.embedded) survivors.push(spear);
      } else if (collision !== null || tick - spear.born > ticks(HUNT.projectileLifetime)
        || Math.abs(spear.x) > this.world.halfSize - 0.5 || Math.abs(spear.z) > this.world.halfSize - 0.5) {
        const t = collision ?? 1;
        const x = clamp(previous.x + (spear.x - previous.x) * t, -this.world.halfSize + 0.5, this.world.halfSize - 0.5);
        const z = clamp(previous.z + (spear.z - previous.z) * t, -this.world.halfSize + 0.5, this.world.halfSize - 0.5);
        this.spears.push({ id: spear.id, owner: spear.owner, born: tick, status: 'ground', x,
          y: Math.max(groundHeight(this.world, x, z) + TERRAIN.spearRest, previous.y + (spear.y - previous.y) * t), z,
          direction: collision !== null ? direction(Math.atan2(-spear.vx, -spear.vz), -0.2) : direction(Math.atan2(-spear.vx, -spear.vz), 0) });
      } else survivors.push(spear);
    }
    this.projectiles = survivors;
  }

  firstAnimalHit(from, to, moving = false) {
    let closest = null;
    for (const animal of this.animals) {
      if (animal.health <= 0) continue;
      const start = moving ? toWorld(animal, toLocal(this.previousAnimals.get(animal.id) ?? animal, from)) : from;
      const hit = hitAnatomy(animal, start, to);
      if (hit && (!closest || hit.t < closest.hit.t)) closest = { animal, hit };
    }
    return closest;
  }

  stepThrusts(tick, players) {
    for (const p of players.values()) {
      const thrust = p.thrust;
      if (!thrust) continue;
      const age = (tick - thrust.born) / TICK_RATE;
      if (age > HUNT.thrustCooldown || p.health <= 0 || p.state.knockTicks > 0) { p.thrust = null; continue; }
      if (age < 0.12 || age > 0.4 || thrust.hit) continue;
      const yawDelta = Math.atan2(Math.sin(p.state.yaw - thrust.yaw), Math.cos(p.state.yaw - thrust.yaw));
      thrust.yaw += clamp(yawDelta, -0.025, 0.025);
      thrust.pitch += clamp(p.state.pitch - thrust.pitch, -0.02, 0.02);
      const dir = direction(thrust.yaw, thrust.pitch), reach = 0.65 + (HUNT.thrustReach - 0.65) * clamp((age - 0.12) / 0.23, 0, 1);
      const tip = tipAt(p.state, dir, reach), priorTip = thrust.previous;
      const old = priorTip ?? tipAt(p.state, dir, 0.18);
      thrust.previous = tip;
      const obstruction = this.obstruction(old, tip);
      const { animal: a, hit } = this.firstAnimalHit(old, tip, true) ?? {};
      if (hit && (obstruction === null || hit.t < obstruction)) {
        const velocity = priorTip ? Math.hypot(tip.x - old.x, tip.y - old.y, tip.z - old.z) / FIXED_DT : (HUNT.thrustReach - 0.65) / 0.23;
        const approaching = Math.max(0, -(a.vx * dir.x + a.vz * dir.z));
        this.impact(a, hit, Math.min(18, Math.max(7, velocity) + approaching), 'thrust', p.id, tick);
        thrust.hit = true;
      } else if (obstruction !== null) thrust.hit = true;
    }
  }

  stepBraces(a, tick, players) {
    if (a.health <= 0 || !['charge', 'bluff', 'breakaway'].includes(a.state)) return;
    const speed = Math.hypot(a.vx, a.vz);
    if (speed < 4) return;
    for (const p of players.values()) {
      if (!p.state.bracing || !p.state.grounded || p.state.braceTime < HUNT.braceSeconds || p.spears <= 0 || p.thrust || p.windup
        || p.recovery || p.health <= 0 || tick - p.lastBrace < ticks(0.8) || tick - p.lastAttack < ticks(HUNT.thrustCooldown)) continue;
      const dir = direction(p.state.yaw, p.state.pitch);
      const toward = ((p.state.x - a.x) * a.vx + (p.state.z - a.z) * a.vz) / ((flatDistance(p.state, a) || 1) * speed);
      if (toward < 0.65) continue;
      const alignment = clamp(-(dir.x * a.vx + dir.z * a.vz) / (speed * (Math.cos(p.state.pitch) || 1)), 0, 1);
      const from = tipAt(p.state, dir, 0.45), to = tipAt(p.state, dir, HUNT.thrustReach);
      const contact = this.firstAnimalHit(from, to), hit = contact?.animal.id === a.id ? contact.hit : null;
      const wall = this.obstruction(from, to);
      if (!hit || (wall !== null && wall < hit.t)) continue;
      p.lastBrace = tick;
      const space = bodyContact(p.state, a) ? 0.45 : flatDistance(p.state, a) < 1.5 ? 0.55 : 1;
      const stability = clamp(p.state.stamina / 60, 0.25, 1) * (1 - p.state.injurySlow * 0.65) * space;
      const settled = 0.8 + 0.2 * clamp((p.state.braceTime - HUNT.braceSeconds) / 0.3, 0, 1);
      const committed = a.state === 'charge' && speed >= 6;
      this.setSpears(p, p.spears - 1); p.state.stamina = Math.max(0, p.state.stamina - 28);
      const spear = { id: ++this.nextId, vx: dir.x * speed, vy: dir.y * speed, vz: dir.z * speed };
      const wound = this.impact(a, hit, speed * (committed ? 2.45 : 1.5) * stability * settled * alignment ** 2, 'brace', p.id, tick, spear);
      if (!wound?.embedded) this.spears.push({ id: spear.id, owner: p.id, born: tick, status: 'ground', ...hit.worldPoint,
        y: groundHeight(this.world, hit.worldPoint.x, hit.worldPoint.z) + 0.08, direction: dir });
      const strong = committed && stability > 0.7 && alignment > 0.85 && !wound.glancing && wound.depth > 0.5;
      this.event('braced', tick, { animalId: a.id, player: p.id, stable: stability > 0.7, strong });
      if (stability < 0.65 || alignment < 0.75 || wound.glancing) this.hurt(a, p, 14, tick, 'brace', true);
      else { p.state.impulseX -= dir.x * (strong ? 3.4 : 1.6); p.state.impulseZ -= dir.z * (strong ? 3.4 : 1.6); }
      if (strong && a.health > 0) {
        changeState(a, 'stagger', tick, 0.45 + Math.min(0.2, wound.depth * 0.15));
        a.acute = null; a.rushSpeed = 0;
        this.moveAnimal(a, -a.vx / speed * 0.16, -a.vz / speed * 0.16);
      }
      p.state.braceTime = 0; p.state.bracing = false;
      if (a.state !== 'charge' && a.state !== 'bluff') break;
    }
  }

  playerSnapshot(player, tick) {
    return {
      health: Math.ceil(player.health), rawMeat: player.rawMeat, cookedMeat: player.cookedMeat, harvestedAnimals: [...player.harvestedAnimals],
      cooking: player.cookUntil ? clamp((player.cookUntil - tick) / ticks(HUNT.cookSeconds), 0, 1) : 0,
      spearReady: player.spears > 0 ? clamp((tick - player.lastAttack) / ticks(HUNT.thrustCooldown), 0, 1) : 0,
      spears: player.spears, bleeding: player.wounds.some(w => w.bleed > 0.01),
      thrust: player.thrust ? clamp((tick - player.thrust.born) / ticks(HUNT.thrustCooldown), 0, 1) : 0,
      recovering: !!player.recovery,
      winding: !!player.windup, windupTime: player.windup ? Math.min(HUNT.windupSeconds, (tick - player.windup.born) / TICK_RATE) : 0,
      throwing: tick - player.lastThrow < ticks(0.45) ? clamp((tick - player.lastThrow) / ticks(0.45), 0, 1) : 0,
    };
  }
  debugSnapshot(tick) {
    return { tick, round: this.round, animals: this.animals.map(a => this.animalDebug(a, tick)) };
  }
  animalDebug(a, tick) {
    const remaining = until => Math.max(0, (until - tick) / TICK_RATE);
    const vector = goal => {
      if (!goal) return null;
      const dx = goal.x - a.x, dz = goal.z - a.z, d = Math.hypot(dx, dz) || 1;
      return { x: dx / d, z: dz / d };
    };
    return {
      id: a.id, state: a.state, position: { x: a.x, z: a.z, yaw: a.yaw },
      perceived: a.awareHunters.map(p => ({ ...p })),
      threats: [...a.threats.entries()].filter(([, m]) => m.seen > -10000).map(([id, m]) => ({ id, ...m, ageSeconds: (tick - m.seen) / TICK_RATE })),
      pressure: a.pressure, pressureParts: { ...a.pressureParts }, decisionSeconds: a.decisionSeconds,
      intent: { state: a.state, reason: a.intentReason, commitmentSeconds: remaining(a.intentUntil),
        previous: a.previousIntent ? { ...a.previousIntent } : null, ageSeconds: Math.max(0, (tick - a.stateTick) / TICK_RATE),
        executionRemainingSeconds: remaining(a.commitUntil),
        decisionRemainingSeconds: remaining(a.until), target: a.targetId, targetPosition: a.targetPosition },
      arbitration: { immediateMelee: a.immediateMelee, hunter: a.immediateHunter, reason: a.intentReason },
      acute: { active: !!a.acute, pending: a.acuteReaction ? { ...a.acuteReaction } : null,
        response: a.acute ? { ...a.acute, remainingSeconds: remaining(a.acute.until), burstSeconds: remaining(a.acute.burstUntil),
          movementCommitmentSeconds: remaining(a.acute.commitUntil) } : null },
      hunt: { awareness: a.huntAwareness, unidentifiedAlarm: a.huntAlarm,
        hunters: [...a.huntMemory].map(([id, m]) => ({ id, ...m, unseenSeconds: (tick - m.lastSeen) / TICK_RATE })) },
      escape: { open: a.escapeOpen, goal: a.escape, direction: vector(a.escape), committedGoal: a.tacticGoal, committedDirection: vector(a.tacticGoal) },
      temperament: { ...a.traits }, body: { blood: a.blood, limp: a.limp, lung: a.lung, breath: a.breath },
      trace: a.intentTrace.map(entry => ({ ...entry })),
    };
  }
  snapshot() {
    return {
      round: this.round, meals: this.meals, complete: this.complete,
      animals: this.animals.map(a => ({ id: a.id, x: a.x, y: a.y ?? 0, z: a.z, yaw: a.yaw, vx: a.vx, vz: a.vz, alive: a.health > 0,
        state: a.state, stateTick: a.stateTick, meat: a.meat, hitTick: a.hitTick, startleTick: a.lastTraumaTick,
        // Existing strike tick of the current close attack, published so the rig's
        // gore/sweep/maul/kick gesture follows server timing. Read-only presentation data.
        attackTick: a.attackAt ?? null,
        limp: a.limp, lung: a.lung, breath: a.breath,
        wounds: a.wounds.map(({ id, region, severity, local, normal }) => ({ id, region, severity, local, normal })) })),
      projectiles: this.projectiles.map(({ id, x, y, z, vx, vy, vz }) => ({ id, x, y, z, vx, vy, vz })),
      spears: this.spears.map(s => ({ ...s })), tracks: this.tracks.map(t => ({ ...t })),
      events: this.events.map(event => ({ ...event })),
    };
  }
}
