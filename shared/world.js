// Deterministic world expansion: identical cliffs, rocks, trees, foliage, terrain
// and collision data on the server and every client. Layout data lives in
// shared/layouts/; this module only expands it, so the biome can be rearranged
// without touching gameplay or rendering code.
import { PLAYER } from './config.js';
import { RAVINE_LAYOUT } from './layouts/ravine.js';
import { groundHeight, pathDistance, waterAt } from './terrain.js';

export const WORLD_SIZE = RAVINE_LAYOUT.halfSize * 2;
export const WORLD_SEED = RAVINE_LAYOUT.seed;
// Existing spawn anchors around the camp fire (HUNT.camp = 0, 3). The camp
// terrace is exactly y = 0, which createWorld verifies.
export const SPAWNS = [
  { x: -2, y: 0, z: 5, yaw: 0 },
  { x: 2, y: 0, z: 5, yaw: 0 },
  { x: 0, y: 0, z: 6, yaw: 0 },
  { x: 0, y: 0, z: 5, yaw: 0 },
];

export function randomFromSeed(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = value => Math.round(value * 1000) / 1000;

function chainCircles(chain, random) {
  // Even arc-length sampling along the whole polyline, ending exactly on its
  // last point, so neighbouring colliders always overlap (spacing < 2 radius).
  const points = chain.points, lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  const total = lengths.at(-1), steps = Math.max(1, Math.ceil(total / chain.spacing - 1e-9));
  const circles = [];
  for (let s = 0; s <= steps; s++) {
    const d = total * s / steps;
    let i = 1;
    while (i < points.length - 1 && lengths[i] < d) i++;
    const span = lengths[i] - lengths[i - 1], t = span > 0 ? (d - lengths[i - 1]) / span : 0;
    circles.push({ x: points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, z: points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t });
  }
  return circles.map((c, index) => ({
    id: `${chain.id}-${index}`, chain: chain.id, x: round(c.x), z: round(c.z), radius: chain.radius,
    height: round(chain.height[0] + (chain.height[1] - chain.height[0]) * random()),
    twist: round(random() * Math.PI * 2), lean: round((random() - 0.5) * 0.12),
  }));
}

// Coarse reachability over the walkable floor, flooded from the first spawn.
// Used to keep scatter on the reachable side of the cliffs and by tests that
// prove the biome has no trapped spawns or reachable gaps in its walls.
export function walkableGrid(world, cell = 1) {
  const size = Math.ceil((world.halfSize * 2) / cell), clearance = PLAYER.radius;
  const blocked = new Uint8Array(size * size), reached = new Uint8Array(size * size);
  const center = i => -world.halfSize + (i + 0.5) * cell;
  for (let gz = 0; gz < size; gz++) for (let gx = 0; gx < size; gx++) {
    const x = center(gx), z = center(gz);
    if (Math.abs(x) > world.halfSize - clearance || Math.abs(z) > world.halfSize - clearance) { blocked[gz * size + gx] = 1; continue; }
    for (const o of world.obstacles) {
      const dx = x - o.x, dz = z - o.z, r = o.radius + clearance;
      if (dx * dx + dz * dz < r * r) { blocked[gz * size + gx] = 1; break; }
    }
  }
  const start = world.spawns[0];
  const index = (x, z) => Math.floor((z + world.halfSize) / cell) * size + Math.floor((x + world.halfSize) / cell);
  const queue = [index(start.x, start.z)];
  reached[queue[0]] = 1;
  while (queue.length) {
    const i = queue.pop(), gx = i % size, gz = (i - gx) / size;
    for (const [nx, nz] of [[gx + 1, gz], [gx - 1, gz], [gx, gz + 1], [gx, gz - 1]]) {
      if (nx < 0 || nz < 0 || nx >= size || nz >= size) continue;
      const n = nz * size + nx;
      if (!reached[n] && !blocked[n]) { reached[n] = 1; queue.push(n); }
    }
  }
  return {
    cell, size, blocked, reached, center,
    reachable(x, z) {
      if (Math.abs(x) >= world.halfSize || Math.abs(z) >= world.halfSize) return false;
      return reached[index(x, z)] === 1;
    },
  };
}

// Expansion is deterministic, so a room, a test fixture or a client page each
// receive an independent copy of one cached expansion per (seed, layout).
const expanded = new Map();
export function createWorld(seed = WORLD_SEED, layout = RAVINE_LAYOUT) {
  const key = `${seed}:${layout.id}`;
  if (!expanded.has(key)) expanded.set(key, expandWorld(seed, layout));
  const world = structuredClone(expanded.get(key));
  world.terrain = layout.terrain; world.water = layout.water; world.paths = layout.paths; world.setPieces = layout.setPieces;
  return world;
}

function expandWorld(seed, layout) {
  const random = randomFromSeed(seed);
  const halfSize = layout.halfSize;
  const world = { seed, layoutId: layout.id, halfSize, terrain: layout.terrain, water: layout.water,
    cliffs: [], rocks: [], trees: [], props: [], foliage: [], obstacles: [], spawns: SPAWNS,
    paths: layout.paths, setPieces: layout.setPieces };

  for (const chain of layout.cliffs) world.cliffs.push(...chainCircles(chain, random));
  for (const [x, z, radius] of layout.boulders) {
    world.rocks.push({ x, z, radius, height: round(radius * (0.9 + random() * 0.6)), rotation: round(random() * Math.PI) });
  }
  const camp = layout.camp;
  world.props.push({ kind: 'lean-to', x: camp.leanTo.x, z: camp.leanTo.z, radius: camp.leanTo.radius, yaw: camp.leanTo.yaw });
  for (const [x, z, radius] of camp.seats) world.props.push({ kind: 'seat', x, z, radius, yaw: round(random() * Math.PI) });
  world.props.push({ kind: 'firewood', x: camp.firewood.x, z: camp.firewood.z, radius: camp.firewood.radius, yaw: 0.6 });

  const solid = () => [...world.cliffs, ...world.rocks, ...world.trees, ...world.props];
  const onPath = (x, z, margin = 0) => layout.paths.some(p => pathDistance(x, z, p.points) < p.width + margin);
  const inClearing = (x, z, margin = 0) => layout.clearings.some(c => Math.hypot(x - c.x, z - c.z) < c.radius + margin);
  const spawnSafe = (x, z, radius) => world.spawns.every(s => Math.hypot(x - s.x, z - s.z) > radius + PLAYER.radius + 0.6);

  for (const zone of layout.trees) {
    let placed = 0;
    for (let attempt = 0; attempt < zone.count * 60 && placed < zone.count; attempt++) {
      let x, z;
      if (zone.rect) {
        const [x0, z0, x1, z1] = zone.rect;
        x = x0 + (x1 - x0) * random(); z = z0 + (z1 - z0) * random();
      } else {
        const pts = zone.band.points, i = Math.min(pts.length - 2, Math.floor(random() * (pts.length - 1)));
        const t = random(), [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const nx = -(bz - az), nz = bx - ax, length = Math.hypot(nx, nz) || 1, offset = (random() * 2 - 1) * zone.band.width;
        x = ax + (bx - ax) * t + nx / length * offset; z = az + (bz - az) * t + nz / length * offset;
      }
      const radius = 0.28 + random() * 0.17, height = 7 + random() * 6, shade = random();
      if (inClearing(x, z, 0.4) || onPath(x, z, 0.6) || !spawnSafe(x, z, radius) || waterAt(world, x, z)) continue;
      if (solid().some(o => Math.hypot(x - o.x, z - o.z) < o.radius + radius + (world.trees.includes(o) ? zone.spacing : 1.4))) continue;
      world.trees.push({ x: round(x), z: round(z), radius: round(radius), height: round(height), shade: round(shade), zone: zone.id });
      placed++;
    }
  }
  world.obstacles = solid().map(({ x, z, radius }) => ({ x, z, radius }));

  // Foliage is soft presentation only. It is still placed deterministically so
  // every hunter sees the same cover.
  const grid = walkableGrid(world);
  const freeOf = (x, z, margin) => world.obstacles.every(o => Math.hypot(x - o.x, z - o.z) > o.radius + margin);
  const creek = layout.terrain.features.find(f => f.id === 'creek-channel');
  const zoneAvailable = zone => zone !== 'creek-bank' || creek;
  for (const spec of layout.foliage) {
    if (!zoneAvailable(spec.zone)) continue;
    let placed = 0;
    for (let attempt = 0; attempt < spec.count * 40 && placed < spec.count; attempt++) {
      let x, z, y = null;
      if (spec.zone === 'cliff-base' || spec.zone === 'cliff-top') {
        const rock = world.cliffs[Math.floor(random() * world.cliffs.length)], angle = random() * Math.PI * 2;
        const distance = rock.radius + (spec.zone === 'cliff-base' ? 0.5 + random() * 2.2 : 1.5 + random() * 5);
        x = rock.x + Math.cos(angle) * distance; z = rock.z + Math.sin(angle) * distance;
        if (spec.zone === 'cliff-top') {
          if (grid.reachable(x, z) || Math.abs(x) > halfSize + 14 || Math.abs(z) > halfSize + 14) continue;
          // Top of the tallest column under the canopy; never on reachable ground.
          const under = world.cliffs.filter(c => Math.hypot(x - c.x, z - c.z) < c.radius + 5.5);
          if (!under.length) continue;
          y = Math.max(...under.map(c => c.height)) - 0.4;
        }
      } else if (spec.zone === 'creek-bank') {
        const pts = creek.points, i = Math.floor(random() * (pts.length - 1)), t = random();
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const nx = -(bz - az), nz = bx - ax, length = Math.hypot(nx, nz) || 1, side = random() < 0.5 ? -1 : 1;
        const offset = side * (4.2 + random() * 3.2);
        x = ax + (bx - ax) * t + nx / length * offset; z = az + (bz - az) * t + nz / length * offset;
      } else if (spec.zone === 'forest-floor') {
        const zones = layout.trees.filter(zone => zone.id !== 'basin-north');
        const zone = zones[Math.floor(random() * zones.length)];
        if (zone.rect) { const [x0, z0, x1, z1] = zone.rect; x = x0 + (x1 - x0) * random(); z = z0 + (z1 - z0) * random(); }
        else {
          const pts = zone.band.points, i = Math.min(pts.length - 2, Math.floor(random() * (pts.length - 1))), t = random();
          x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t + (random() * 2 - 1) * (zone.band.width + 1.5);
          z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t + (random() * 2 - 1) * (zone.band.width + 1.5);
        }
      } else {
        x = (random() * 2 - 1) * (halfSize - 4); z = (random() * 2 - 1) * (halfSize - 4);
        // Keep the open hunting floor readable: grass gathers at its margins.
        if (Math.hypot(x / 8, (z + 12) / 13) < 1) continue;
      }
      if (spec.zone !== 'cliff-top') {
        if (!grid.reachable(x, z) || !freeOf(x, z, spec.kind === 'grass' ? 0.1 : 0.25)) continue;
        if (onPath(x, z, spec.kind === 'grass' ? -0.3 : 0.2) || inClearing(x, z, spec.kind === 'grass' ? -1.5 : 0)) continue;
        if (waterAt(world, x, z) || groundHeight(world, x, z) < -0.17) continue;
        y = groundHeight(world, x, z);
      }
      world.foliage.push({ kind: spec.kind, x: round(x), y: round(y), z: round(z),
        scale: round(0.75 + random() * 0.6), rotation: round(random() * Math.PI * 2), shade: round(random()) });
      placed++;
    }
  }
  for (const spawn of world.spawns) {
    if (groundHeight(world, spawn.x, spawn.z) !== spawn.y) throw new Error('Layout must keep every spawn on its recorded ground height.');
  }
  return world;
}
