import { PLAYER } from './config.js';

// A capsule follows the boar's long axis. The same footprint is used in prediction,
// reconciliation, server movement and contact attacks; no visual-model hit claims.
export const BOAR_BODY = Object.freeze({ front: -0.85, rear: 0.62, radius: 0.59, height: 1.4 });
// Boar-local space is measured from the animal's own ground height (a.y, from
// the shared terrain). An animal without y stands on the original y = 0 floor,
// so these transforms are unchanged there.
export function toLocal(a, p) {
  const dx = p.x - a.x, dz = p.z - a.z, c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return { x: c * dx - s * dz, y: (p.y ?? 0) - (a.y ?? 0), z: s * dx + c * dz };
}
export function toWorld(a, p) {
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return { x: a.x + c * p.x + s * p.z, y: (p.y ?? 0) + (a.y ?? 0), z: a.z - s * p.x + c * p.z };
}
export function bodyContact(state, a, radius = PLAYER.radius) {
  if (!a || (state.y ?? 0) - (a.y ?? 0) >= (a.alive === false || a.health <= 0 ? 0.6 : BOAR_BODY.height)) return null;
  const p = toLocal(a, state);
  const closestZ = Math.max(BOAR_BODY.front, Math.min(BOAR_BODY.rear, p.z));
  const dx = p.x, dz = p.z - closestZ, distance = Math.hypot(dx, dz);
  const minimum = BOAR_BODY.radius + radius;
  if (distance >= minimum - 1e-8) return null;
  // Exact centerline overlaps get a deterministic normal rather than NaN.
  const nx = distance > 1e-8 ? dx / distance : 1, nz = distance > 1e-8 ? dz / distance : 0;
  const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
  return { overlap: minimum - distance, x: c * nx + s * nz, z: -s * nx + c * nz };
}
export function resolveBody(state, a) {
  const contact = bodyContact(state, a);
  if (contact) { state.x += contact.x * contact.overlap; state.z += contact.z * contact.overlap; }
  return contact;
}

// Production movement resolves the complete room collection. Keep the single
// capsule primitive usable for anatomy/contact checks and isolated geometry tests.
export function resolveBodies(state, bodies) {
  for (const body of Array.isArray(bodies) ? bodies : bodies ? [bodies] : []) resolveBody(state, body);
}
