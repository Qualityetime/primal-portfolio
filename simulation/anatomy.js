import { toLocal, toWorld } from '../shared/body.js';

// Simplified authoritative anatomy: axis-aligned ellipsoids in boar-local space
// (front is -Z, +X is the animal's right). The rendered mesh is never authoritative.
// Integrity hotfix: shapes were refitted to the approved 1.18x Ironhide boar from
// its actual skinned surface (neutral stance weighted with the walking cycle).
// Mane bristles, ears and tail are presentation, not flesh. Tissue properties
// (resistance, trauma, bleed) and every formula below are unchanged.
const TISSUE = Object.freeze({
  head: { resistance: 2.8, trauma: 16, bleed: 0.0015 },
  neck: { resistance: 0.9, trauma: 42, bleed: 0.014 },
  chest: { resistance: 1.2, trauma: 35, bleed: 0.008 },
  belly: { resistance: 0.75, trauma: 25, bleed: 0.006 },
  rump: { resistance: 1.6, trauma: 18, bleed: 0.003 },
  legs: { resistance: 1, trauma: 15, bleed: 0.0025 },
});
const region = (name, id, center, radii) => Object.freeze({ name, id, center: Object.freeze(center), radii: Object.freeze(radii), ...TISSUE[name] });
// Each leg is two segments of the one existing `legs` tissue: lower (hoof/cannon)
// and upper (forearm or gaskin/hock). `id` records side and limb for tests and
// diagnostics only; injuries still report the semantic region name.
const leg = (side, limb, segment, center, radii) => region('legs', `${side < 0 ? 'left' : 'right'}-${limb}-leg-${segment}`,
  { x: side * center.x, y: center.y, z: center.z }, radii);
export const REGIONS = Object.freeze([
  region('head', 'head', { x: 0, y: 0.90, z: -1.24 }, { x: 0.40, y: 0.42, z: 0.42 }),
  region('neck', 'neck', { x: 0, y: 1.10, z: -0.78 }, { x: 0.42, y: 0.38, z: 0.26 }),
  region('chest', 'chest', { x: 0, y: 0.96, z: -0.34 }, { x: 0.56, y: 0.56, z: 0.48 }),
  region('belly', 'belly', { x: 0, y: 0.97, z: 0.21 }, { x: 0.44, y: 0.52, z: 0.29 }),
  region('rump', 'rump', { x: 0, y: 0.90, z: 0.80 }, { x: 0.52, y: 0.44, z: 0.50 }),
  ...[-1, 1].flatMap(side => [
    leg(side, 'front', 'upper', { x: 0.39, y: 0.495, z: -0.38 }, { x: 0.22, y: 0.20, z: 0.29 }),
    leg(side, 'front', 'lower', { x: 0.47, y: 0.13, z: -0.585 }, { x: 0.17, y: 0.19, z: 0.33 }),
    leg(side, 'hind', 'upper', { x: 0.30, y: 0.45, z: 1.22 }, { x: 0.18, y: 0.16, z: 0.46 }),
    leg(side, 'hind', 'lower', { x: 0.34, y: 0.12, z: 1.33 }, { x: 0.16, y: 0.165, z: 0.31 }),
  ]),
]);

function ellipsoid(from, to, region) {
  const { center: c, radii: r } = region;
  const o = { x: (from.x - c.x) / r.x, y: (from.y - c.y) / r.y, z: (from.z - c.z) / r.z };
  const d = { x: (to.x - from.x) / r.x, y: (to.y - from.y) / r.y, z: (to.z - from.z) / r.z };
  const aa = d.x ** 2 + d.y ** 2 + d.z ** 2, bb = 2 * (o.x * d.x + o.y * d.y + o.z * d.z);
  const cc = o.x ** 2 + o.y ** 2 + o.z ** 2 - 1;
  if (aa < 1e-12) return null;
  const disc = bb * bb - 4 * aa * cc;
  if (disc < 0) return null;
  const t = cc <= 0 ? 0 : (-bb - Math.sqrt(disc)) / (2 * aa);
  if (t < 0 || t > 1) return null;
  const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t };
  const n = { x: (point.x - c.x) / r.x ** 2, y: (point.y - c.y) / r.y ** 2, z: (point.z - c.z) / r.z ** 2 };
  const length = Math.hypot(n.x, n.y, n.z) || 1;
  return { t, point, normal: { x: n.x / length, y: n.y / length, z: n.z / length }, region };
}
export function hitAnatomy(animal, from, to) {
  const start = toLocal(animal, from), end = toLocal(animal, to);
  let nearest = null;
  for (const region of REGIONS) {
    const hit = ellipsoid(start, end, region);
    if (hit && (!nearest || hit.t < nearest.t)) nearest = hit;
  }
  if (!nearest) return null;
  const direction = { x: end.x - start.x, y: end.y - start.y, z: end.z - start.z };
  const length = Math.hypot(direction.x, direction.y, direction.z) || 1;
  nearest.directness = Math.max(0, -(direction.x * nearest.normal.x + direction.y * nearest.normal.y + direction.z * nearest.normal.z) / length);
  nearest.worldPoint = toWorld(animal, nearest.point);
  return nearest;
}
export function injuryFor(hit, speed, kind = 'throw') {
  const energy = (speed / (kind === 'throw' ? 26 : 9)) ** 2;
  const depth = Math.max(0, Math.min(1.5, energy * hit.directness ** 1.7 / hit.region.resistance));
  const severity = Math.max(0.025, Math.min(1.25, depth));
  const glancing = hit.directness < 0.4 || depth < 0.16;
  return { region: hit.region.name, depth, severity, glancing, embedded: kind !== 'thrust' && !glancing && depth > 0.24,
    trauma: hit.region.trauma * severity * (glancing ? 0.25 : 1),
    bleed: hit.region.bleed * severity * (glancing ? 0.18 : 1), local: hit.point, normal: hit.normal };
}
