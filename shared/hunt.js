// Gameplay rules shared with the HUD. Damage and inventory are decided by the server.
import { MAX_PLAYERS } from './config.js';

export const HUNT = Object.freeze({
  boarHealth: 120,
  spearDamage: 40,
  spearSpeed: 26,
  spearMinSpeed: 12,
  spearMaxSpeed: 30,
  windupSeconds: 0.9,
  spearGravity: 10,
  throwCooldown: 0.8,
  thrustCooldown: 0.64,
  thrustReach: 2.65,
  spearCapacity: 3,
  recoverSeconds: 0.45,
  recoverShallowSeconds: 0.12,
  braceSeconds: 0.32,
  projectileLifetime: 8,
  playerHealth: 100,
  boarDamage: 25,
  harvestRange: 2.8,
  meatPerHunter: 2,
  carcassMeat: MAX_PLAYERS * 2,
  campRange: 3,
  campSafeRange: 4.3,
  cookSeconds: 2.5,
  mealGoal: 2,
  camp: Object.freeze({ x: 0, z: 3 }),
  boarSpawns: Object.freeze([
    Object.freeze({ x: 0, z: -3.5 }),
    Object.freeze({ x: 3.5, z: -4.5 }),
  ]),
});

export function flatDistance(a, b) { return Math.hypot(a.x - b.x, a.z - b.z); }

// Only elapsed authoritative ticks supply this duration in combat. Clients use
// the same curve for the spear pose, never to send a power or damage claim.
export function throwProfile(seconds) {
  const charge = Math.max(0, Math.min(1, seconds / HUNT.windupSeconds));
  const effort = charge * charge * (3 - 2 * charge);
  return { charge, speed: HUNT.spearMinSpeed + (HUNT.spearMaxSpeed - HUNT.spearMinSpeed) * effort,
    spread: 0.045 * (1 - effort) + 0.004 };
}

export function interactionHint(state, hunt) {
  if (!hunt) return '';
  if (state.health <= 0) return 'Returning to camp…';
  if (state.knockTicks > 0) return '';
  if (state.recovering) return 'Pulling the spear free…';
  if (state.cooking > 0) return 'Cooking… stay by the fire';
  if (flatDistance(state, HUNT.camp) <= HUNT.campRange) {
    if (state.rawMeat > 0) return 'E · Cook one piece of meat';
    if (hunt.animals.every(a => !a.alive)) return hunt.complete ? 'Meal shared. R · Start the next hunt' : 'R · Start a fresh hunt';
    if (state.spears < HUNT.spearCapacity) return 'E · Take spears from camp';
    return '';
  }
  const carcasses = hunt.animals.filter(a => !a.alive && flatDistance(state, a) <= HUNT.harvestRange);
  if (carcasses.some(a => a.meat > 0 && !(state.harvestedAnimals ?? []).includes(a.id))) {
    return 'E · Harvest meat';
  }
  if (state.spears < HUNT.spearCapacity && (hunt.spears ?? []).some(s => {
    const animal = hunt.animals.find(a => a.id === s.animalId);
    const point = s.status === 'embedded' ? animal && boarPoint(animal, s.local) : s;
    return point && flatDistance(state, point) < 2.4;
  })) return 'E · Recover spear';
  if (carcasses.length) return 'Return to the campfire';
  return '';
}

function boarPoint(a, p) {
  return { x: a.x + Math.cos(a.yaw) * p.x + Math.sin(a.yaw) * p.z, z: a.z - Math.sin(a.yaw) * p.x + Math.cos(a.yaw) * p.z };
}
