// Hunt Slice 0.1: deterministic walkable terrain shared by server authority,
// client prediction, boar grounding, physical spears and the renderer.
//
// Only +, -, *, /, Math.sqrt, Math.min and Math.max are used. Those are exactly
// specified by IEEE-754, so Node and every browser compute bit-identical ground
// heights from the same layout data (no engine-specific trig or exp).
//
// A world without `terrain` data (older fixtures, legacy layouts) is the original
// flat floor at y = 0, so every pre-0.4 behaviour is reproduced exactly there.

export const TERRAIN = Object.freeze({
  // Height (m) above the ground at which a resting spear lies, and the skin a
  // flying spear stops at. 0.05 / 0.06 are the original flat-floor constants.
  spearSkin: 0.05,
  spearRest: 0.06,
  // A grounded hunter follows the ground. A drop larger than this in one tick
  // would leave the hunter airborne; the authored terrain never contains one.
  stepDown: 0.3,
  // Authored walkable ground stays under this rise per metre (~8.5 degrees).
  maxWalkableGrade: 0.15,
  // All slice water is shallow. Hunters and boars wade; nobody swims.
  maxWaterDepth: 0.3,
});

const clamp01 = value => value < 0 ? 0 : value > 1 ? 1 : value;
export function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function segmentDistance(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, length = dx * dx + dz * dz;
  let t = length > 0 ? ((px - ax) * dx + (pz - az) * dz) / length : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t - px, z = az + dz * t - pz;
  return Math.sqrt(x * x + z * z);
}

export function pathDistance(px, pz, points) {
  if (points.length === 1) {
    const x = points[0][0] - px, z = points[0][1] - pz;
    return Math.sqrt(x * x + z * z);
  }
  let best = Infinity;
  for (let i = 1; i < points.length; i++) {
    const d = segmentDistance(px, pz, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    if (d < best) best = d;
  }
  return best;
}

// Each feature is a soft band around a point or polyline: full `height` within
// `inner` metres, easing to nothing at `outer`. Carved features (creek bed,
// pool) combine by their deepest value and raised features (the east pocket) by
// their highest, so overlapping features never stack into an unintended pit.
export function featureInfluence(feature, x, z) {
  return 1 - smoothstep(feature.inner, feature.outer, pathDistance(x, z, feature.points));
}

export function groundHeight(world, x, z) {
  const terrain = world?.terrain;
  if (!terrain) return 0;
  let carve = 0, raise = 0;
  for (const feature of terrain.features) {
    const value = feature.height * featureInfluence(feature, x, z);
    if (feature.mode === 'carve') { if (value < carve) carve = value; }
    else if (value > raise) raise = value;
  }
  return (terrain.base ?? 0) + raise + carve;
}

// Central differences; used by tests (slope limits) and the renderer (lighting
// and decal orientation), never by an authoritative decision.
export function groundGradient(world, x, z, step = 0.05) {
  return {
    x: (groundHeight(world, x + step, z) - groundHeight(world, x - step, z)) / (2 * step),
    z: (groundHeight(world, x, z + step) - groundHeight(world, x, z - step)) / (2 * step),
  };
}
export function groundNormal(world, x, z) {
  const g = groundGradient(world, x, z), length = Math.sqrt(g.x * g.x + 1 + g.z * g.z);
  return { x: -g.x / length, y: 1 / length, z: -g.z / length };
}

// Water is presentation plus documentation: it never changes speed, never blocks
// sight and never stops a spear. A point is wet when it lies inside one of a
// body's carved features and below that body's flat surface level.
export function waterAt(world, x, z) {
  for (const body of world?.water ?? []) {
    const ground = groundHeight(world, x, z);
    if (ground >= body.level) continue;
    const inside = body.features.some(id => {
      const feature = world.terrain.features.find(f => f.id === id);
      return feature && pathDistance(x, z, feature.points) < feature.outer;
    });
    if (inside) return { id: body.id, level: body.level, depth: body.level - ground };
  }
  return null;
}

// First point at which a moving segment meets the ground skin. On the flat
// floor this is exactly the original `(from.y - 0.05) / (from.y - to.y)`.
export function groundContact(world, from, to, skin = TERRAIN.spearSkin) {
  if (!world?.terrain) {
    // Legacy flat floor: the original expression, bit for bit.
    if (!(to.y <= skin && from.y > skin)) return null;
    const t = (from.y - skin) / (from.y - to.y);
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const g0 = from.y - (groundHeight(world, from.x, from.z) + skin);
  if (g0 <= 0) return null;
  const g1 = to.y - (groundHeight(world, to.x, to.z) + skin);
  if (g1 > 0) return null;
  const t = g0 / (g0 - g1);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
