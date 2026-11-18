import * as THREE from 'three';
import { HUNT } from '@shared/hunt.js';
import { groundHeight, pathDistance, waterAt } from '@shared/terrain.js';
import { randomFromSeed, walkableGrid } from '@shared/world.js';
import * as TEX from './textures.js';

// Hunt Slice 0.1 renderer for the Jungle Ravine. Every shape that a hunter can
// touch is drawn from the same shared data the server simulates:
//  - the ground mesh samples groundHeight() (gameplay terrain), nothing else;
//  - each rock column and boulder covers its circular collider, with its face
//    between the collider edge and where a hunter stops (no gap, no clipping);
//  - water is a flat surface over the carved creek bed, never a floor.
// Everything else (falls, the overhead log, cliff-top palms, distant spires)
// sits on or beyond impassable rock and is clearly out of reach.

export const ENVIRONMENT = Object.freeze({
  fog: 0x8d9aa0,
  fogDensity: 0.0165,
  skyTop: 0x5d6d7d,
  skyHorizon: 0xa7b1b0,
  hemiSky: 0xbac7cc,
  hemiGround: 0x3d3a2b,
  sun: 0xffe2b8,
  terrainStep: 0.6,
  // Faces of touchable rock lie between the collider edge (+0) and this far
  // outside it, below head height. A hunter stops PLAYER.radius (0.35) out.
  rockFaceMargin: 0.2,
});

const color = hex => new THREE.Color(hex);
const PALETTE = {
  dirt: color(0x6c5b44), path: color(0x80705a), moss: color(0x4a5833), mossDark: color(0x3a4629),
  litter: color(0x5a4b36), pebble: color(0x7a766a), mud: color(0x4a3f31), bed: color(0x666a60), ash: color(0x463f37),
  rock: color(0x666a61), rockDark: color(0x4b4e45), rockLight: color(0x7e8178), rockMoss: color(0x5a6f3c),
  bark: color(0x6f604b), barkDark: color(0x4b4033), leaf: color(0x3f5a2c), leafDark: color(0x2e4421), leafLight: color(0x5a7239),
};

function smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }

// ---------------------------------------------------------------- terrain --
function groundColour(world, x, z, h, cliffDistance, target) {
  const n = TEX.fbm(x * 0.35 + 50, z * 0.35 + 50, 4096, 7), fine = TEX.fbm(x * 1.3, z * 1.3, 4096, 9);
  target.copy(PALETTE.dirt);
  // Moss creeps out from the cliff bases and over the raised pocket.
  const moss = Math.max(smooth(4.5, 0.4, cliffDistance) * 0.85, h > 0.05 ? 0.45 : 0) * (0.65 + n * 0.5);
  target.lerp(n > 0.55 ? PALETTE.moss : PALETTE.mossDark, Math.min(1, moss));
  // Leaf litter under the camp forest and the groves.
  if (z > 6.5 || (x > 15 && h > 0.2)) target.lerp(PALETTE.litter, 0.35 + fine * 0.2);
  // Trodden paths stay readable from the basin.
  let path = 0;
  for (const p of world.paths) path = Math.max(path, 1 - smooth(p.width * 0.45, p.width * 1.05, pathDistance(x, z, p.points)));
  target.lerp(PALETTE.path, path * 0.7);
  // Creek banks: pebbles, then a narrow band of wet mud at the waterline, then the bed.
  if (h < -0.015) {
    target.lerp(PALETTE.pebble, smooth(-0.015, -0.1, h) * (0.6 + fine * 0.3));
    const level = world.water[0]?.level ?? -0.2;
    target.lerp(PALETTE.mud, Math.max(0, 1 - Math.abs(h - level - 0.02) / 0.06) * 0.75);
    target.lerp(PALETTE.bed, smooth(level - 0.02, level - 0.15, h));
  }
  // Ash and trampled earth around the fire.
  const camp = Math.hypot(x - HUNT.camp.x, z - HUNT.camp.z);
  target.lerp(PALETTE.path, smooth(4.5, 2, camp) * 0.45);
  target.lerp(PALETTE.ash, smooth(1.5, 0.7, camp) * 0.8);
  target.multiplyScalar(0.94 + (n - 0.5) * 0.16);
  return target;
}

function buildTerrain(world, textures) {
  const step = ENVIRONMENT.terrainStep, x0 = -27, x1 = 35, z0 = -37, z1 = 23;
  const nx = Math.round((x1 - x0) / step), nz = Math.round((z1 - z0) / step);
  const positions = new Float32Array((nx + 1) * (nz + 1) * 3), colours = new Float32Array(positions.length), uvs = new Float32Array((nx + 1) * (nz + 1) * 2);
  const c = new THREE.Color();
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
    const x = x0 + i * step, z = z0 + j * step, h = groundHeight(world, x, z), k = j * (nx + 1) + i;
    let cliffDistance = Infinity;
    for (const rock of world.cliffs) cliffDistance = Math.min(cliffDistance, Math.hypot(x - rock.x, z - rock.z) - rock.radius);
    positions.set([x, h, z], k * 3);
    groundColour(world, x, z, h, cliffDistance, c);
    colours.set([c.r, c.g, c.b], k * 3);
    uvs.set([x / 2, z / 2], k * 2);
  }
  const index = [];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
    index.push(a, d, b, b, d, e);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ map: textures.ground, vertexColors: true }));
  mesh.receiveShadow = true; mesh.name = 'terrain';
  mesh.userData.bounds = { x0, x1, z0, z1, step };
  return mesh;
}

// ------------------------------------------------------------------ rock ---
// Non-indexed faceted geometry with per-face colour, so flat shading and moss
// on upward faces both come for free.
class FacetBuilder {
  constructor() { this.positions = []; this.colours = []; this.uvs = []; }
  tri(a, b, c, colour, uv = [[0, 0], [1, 0], [0, 1]]) {
    this.positions.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.colours.push(colour.r, colour.g, colour.b);
    this.uvs.push(...uv[0], ...uv[1], ...uv[2]);
  }
  geometry({ upNormals = false } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colours, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (upNormals) {
      // Leaf cards are lit like a canopy (from above) on both faces, so
      // double-sided fronds never turn black when seen from behind.
      const normals = new Float32Array(this.positions.length);
      for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
      g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    } else g.computeVertexNormals();
    return g;
  }
}
const faceNormalY = (a, b, c) => {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return ny / (Math.hypot(nx, ny, nz) || 1);
};

// A column of stacked, irregular rings. `touchable` keeps the lowest rings'
// faces inside [radius, radius + rockFaceMargin] so the drawn face is where
// the collider is. Returns the ring radii for vine placement.
function rockColumn(builder, { x, z, radius, height, base = -1.6, rng, sides = 9, touchable = true, tint = 0, twist = 0, calm = false }) {
  const minimum = radius / Math.cos(Math.PI / sides), margin = ENVIRONMENT.rockFaceMargin;
  const upper = [0.24, 0.38, 0.52, 0.64, 0.78, 0.9].map(f => height * f).filter(y => y > 3.4);
  const levels = [base, 0.6, 2.7, ...upper, height];
  let shiftX = 0, shiftZ = 0;
  const rings = levels.map((y, level) => {
    const low = y <= 2.7 && touchable;
    const last = level === levels.length - 1;
    // Above head height the column steps in and out in blocky ledges and
    // drifts sideways, so walls read as stacked, fractured strata.
    // `calm` columns (behind the falls) never step out past their footing.
    if (!low && !last && !calm) { shiftX += (rng() - 0.5) * 0.7; shiftZ += (rng() - 0.5) * 0.7; }
    const scale = low ? 1 : last ? 0.55 + rng() * 0.2 : calm ? 0.72 + rng() * 0.12 : 0.82 + rng() * 0.38;
    const ledge = !low && !last && !calm && rng() < 0.35 ? 0.3 : 0;
    const jitter = low ? 0.1 : 0.35;
    return Array.from({ length: sides }, (_, i) => {
      const angle = twist + (i + (rng() - 0.5) * jitter) / sides * Math.PI * 2;
      const r = low ? minimum + rng() * Math.max(0, radius + margin - minimum) : (minimum * scale + ledge) * (0.9 + rng() * 0.2);
      const sx = low ? 0 : shiftX, sz = low ? 0 : shiftZ;
      return [x + Math.cos(angle) * r + sx, y + (level > 0 && !last ? (rng() - 0.5) * 0.5 : 0), z + Math.sin(angle) * r + sz];
    });
  });
  const shade = new THREE.Color();
  for (let level = 0; level < rings.length - 1; level++) {
    const lower = rings[level], upper = rings[level + 1];
    for (let i = 0; i < sides; i++) {
      const a = lower[i], b = lower[(i + 1) % sides], c = upper[(i + 1) % sides], d = upper[i];
      for (const [p, q, r] of [[a, d, c], [a, c, b]]) {
        const up = faceNormalY(p, q, r), mid = (p[1] + q[1] + r[1]) / 3;
        shade.copy(mid < 1.5 ? PALETTE.rockDark : PALETTE.rock).lerp(PALETTE.rockLight, Math.min(0.5, mid / height * 0.5 + tint))
          .lerp(PALETTE.rockDark, ((level * 7) % 5) / 5 * 0.25);
        if (up > 0.35 || (rng() < 0.2 && mid > 2.5)) shade.lerp(PALETTE.rockMoss, up > 0.35 ? 0.85 : 0.45 + rng() * 0.25);
        shade.multiplyScalar(0.9 + rng() * 0.18);
        const u = i / sides * radius * 1.2, uv = [[u, p[1] / 4.5], [u + 0.4, q[1] / 4.5], [u + 0.2, r[1] / 4.5]];
        builder.tri(p, q, r, shade, uv);
      }
    }
  }
  const top = rings.at(-1), centre = [x, height + 0.4, z];
  for (let i = 0; i < sides; i++) builder.tri(top[i], centre, top[(i + 1) % sides], PALETTE.rockMoss.clone().multiplyScalar(0.85 + rng() * 0.2));
  return rings;
}

function buildRock(world, textures, grid, rng) {
  const wall = new FacetBuilder(), backdrop = new FacetBuilder();
  const log = world.setPieces?.fallenLog;
  const columns = [];
  const falls = world.setPieces?.waterfall;
  for (const rock of world.cliffs) {
    let height = rock.height;
    if (log) for (const [lx, lz, ly] of [log.from, log.to]) if (Math.hypot(rock.x - lx, rock.z - lz) < 6) height = Math.max(height, ly + 1.5 + rng());
    const behindFalls = falls && Math.hypot(rock.x - falls.x, rock.z - falls.z) < rock.radius + falls.width;
    if (behindFalls) height = Math.max(height, falls.top + 1.2);
    const rings = rockColumn(wall, { ...rock, height, rng, twist: rock.twist, tint: rock.lean, calm: behindFalls });
    columns.push({ rock, height, rings });
  }
  // Massive backing rock behind each wall so the walls read as ravine sides
  // rather than a row of pillars. A backing column must sit BEHIND its wall
  // (farther from walkable ground than the wall itself), never in a pocket
  // inside the ravine that merely happens to be unreachable.
  const nearestReachable = (x, z, limit = 12) => {
    let best = Infinity;
    for (let dz = -limit; dz <= limit; dz++) for (let dx = -limit; dx <= limit; dx++) {
      const d = Math.hypot(dx, dz);
      if (d < best && grid.reachable(x + dx, z + dz)) best = d;
    }
    return best;
  };
  for (const rock of world.cliffs) {
    const wallDistance = nearestReachable(rock.x, rock.z);
    for (let k = 0; k < 6; k++) {
      const angle = k / 6 * Math.PI * 2 + rock.twist, distance = rock.radius * (1.3 + rng() * 0.5);
      const x = rock.x + Math.cos(angle) * distance, z = rock.z + Math.sin(angle) * distance, radius = rock.radius * (1.1 + rng() * 0.6);
      const behind = nearestReachable(x, z);
      if (!(behind >= wallDistance + 1.5 && behind >= radius + 0.6)) continue;
      rockColumn(backdrop, { x, z, radius, height: rock.height + 3 + rng() * 9, rng, sides: 7, touchable: false, tint: 0.08 });
      break;
    }
  }
  // Distant spires fade into the mist beyond the ravine.
  for (let i = 0; i < 34; i++) {
    const angle = i / 34 * Math.PI * 2 + rng() * 0.15, distance = 52 + rng() * 60;
    const x = Math.cos(angle) * distance, z = -8 + Math.sin(angle) * distance;
    rockColumn(backdrop, { x, z, radius: 4 + rng() * 7, height: 26 + rng() * 44, base: -3, rng, sides: 7, touchable: false, tint: 0.12 });
  }
  const material = new THREE.MeshStandardMaterial({ map: textures.rock, vertexColors: true, flatShading: true, roughness: 1, metalness: 0 });
  const walls = new THREE.Mesh(wall.geometry(), material);
  walls.castShadow = true; walls.receiveShadow = true; walls.name = 'cliffs';
  const back = new THREE.Mesh(backdrop.geometry(), material);
  back.receiveShadow = true; back.castShadow = true; back.name = 'cliff-backdrop';
  return { walls, back, columns };
}

function buildBoulders(world, textures, rng, grid) {
  const builder = new FacetBuilder();
  const base = new THREE.IcosahedronGeometry(1, 1), p = base.attributes.position;
  const shade = new THREE.Color();
  for (const rock of world.rocks) {
    const y0 = groundHeight(world, rock.x, rock.z), squash = rock.height, warp = new Map();
    // Horizontal extent stays inside [radius, radius + margin] (icosphere faces
    // sit at ~0.92 of the vertex radius), so the face is the collider.
    const scale = rock.radius / 0.92, margin = ENVIRONMENT.rockFaceMargin / scale * 0.9;
    const point = i => {
      const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
      if (!warp.has(key)) warp.set(key, rng());
      const k = 1 + warp.get(key) * margin, cr = Math.cos(rock.rotation), sr = Math.sin(rock.rotation);
      const lx = p.getX(i) * k, lz = p.getZ(i) * k;
      return [rock.x + (lx * cr - lz * sr) * scale, y0 - squash * 0.18 + (p.getY(i) * 0.5 + 0.5) * squash * k, rock.z + (lx * sr + lz * cr) * scale];
    };
    for (let i = 0; i < p.count; i += 3) {
      const a = point(i), b = point(i + 1), c = point(i + 2), up = faceNormalY(a, b, c);
      shade.copy(PALETTE.rock).lerp(PALETTE.rockDark, 0.3).lerp(PALETTE.rockMoss, up > 0.55 ? 0.7 : 0).multiplyScalar(0.88 + rng() * 0.2);
      builder.tri(a, b, c, shade, [[a[0] / 2, a[1] / 2], [b[0] / 2, b[1] / 2], [c[0] / 2, c[1] / 2]]);
    }
  }
  // Small creek stones: ankle height, walkable, purely decorative.
  const creek = world.terrain.features.find(f => f.id === 'creek-channel');
  const stone = new THREE.IcosahedronGeometry(1, 0), sp = stone.attributes.position;
  for (let i = 0; creek && i < 170; i++) {
    const pts = creek.points, s = Math.floor(rng() * (pts.length - 1)), t = rng();
    const nx = -(pts[s + 1][1] - pts[s][1]), nz = pts[s + 1][0] - pts[s][0], length = Math.hypot(nx, nz), off = (rng() * 2 - 1) * 5.5;
    const x = pts[s][0] + (pts[s + 1][0] - pts[s][0]) * t + nx / length * off, z = pts[s][1] + (pts[s + 1][1] - pts[s][1]) * t + nz / length * off;
    if (world.obstacles.some(o => Math.hypot(x - o.x, z - o.z) < o.radius + 0.2)) continue;
    const size = 0.07 + rng() * 0.16, y = groundHeight(world, x, z), rot = rng() * Math.PI;
    for (let v = 0; v < sp.count; v += 3) {
      const tri = [0, 1, 2].map(k => {
        const lx = sp.getX(v + k) * size * 1.3, lz = sp.getZ(v + k) * size;
        return [x + lx * Math.cos(rot) - lz * Math.sin(rot), y + (sp.getY(v + k) * 0.55 + 0.1) * size, z + lx * Math.sin(rot) + lz * Math.cos(rot)];
      });
      shade.copy(PALETTE.pebble).lerp(PALETTE.rockDark, rng() * 0.5).multiplyScalar(0.85 + rng() * 0.25);
      builder.tri(...tri, shade);
    }
  }
  // Loose stones across the floor so the basin is not a bare plane. Ankle
  // height and walkable; kept off the paths and the camp terrace.
  for (let i = 0; i < 320; i++) {
    const x = -22 + rng() * 54, z = -31 + rng() * 47;
    if (!grid.reachable(x, z) || world.paths.some(p => pathDistance(x, z, p.points) < p.width * 0.8) || Math.hypot(x, z - 4) < 6.5) continue;
    if (world.obstacles.some(o => Math.hypot(x - o.x, z - o.z) < o.radius + 0.15) || waterAt(world, x, z)) continue;
    const cluster = 1 + Math.floor(rng() * 3);
    for (let c = 0; c < cluster; c++) {
      const sx = x + (rng() - 0.5) * 0.6, sz = z + (rng() - 0.5) * 0.6, size = 0.05 + rng() * 0.11, y = groundHeight(world, sx, sz), rot = rng() * Math.PI;
      for (let v = 0; v < sp.count; v += 3) {
        const tri = [0, 1, 2].map(k => {
          const lx = sp.getX(v + k) * size * 1.4, lz = sp.getZ(v + k) * size;
          return [sx + lx * Math.cos(rot) - lz * Math.sin(rot), y + (sp.getY(v + k) * 0.5 + 0.08) * size, sz + lx * Math.sin(rot) + lz * Math.cos(rot)];
        });
        shade.copy(PALETTE.pebble).lerp(PALETTE.dirt, rng() * 0.5).multiplyScalar(0.8 + rng() * 0.25);
        builder.tri(...tri, shade);
      }
    }
  }
  const mesh = new THREE.Mesh(builder.geometry(), new THREE.MeshStandardMaterial({ map: textures.rock, vertexColors: true, flatShading: true, roughness: 1 }));
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'boulders';
  return mesh;
}

// ------------------------------------------------------------- vegetation ---
function cardGroup(builder, cards) {
  for (const { corners, colour } of cards) {
    const [a, b, c, d] = corners;
    builder.tri(a, b, c, colour, [[0, 0], [1, 0], [1, 1]]);
    builder.tri(a, c, d, colour, [[0, 0], [1, 1], [0, 1]]);
  }
}
// One arching frond as a strip of quads, from `base` along `angle`.
function frond(builder, base, angle, { length, width, rise, droop, colour, segments = 3 }) {
  const dx = Math.cos(angle), dz = Math.sin(angle), px = -dz, pz = dx;
  let prev = null;
  for (let s = 0; s <= segments; s++) {
    const t = s / segments, along = t * length, y = base[1] + rise * t - droop * t * t;
    const cx = base[0] + dx * along, cz = base[2] + dz * along, w = width * 0.5;
    const left = [cx + px * w, y, cz + pz * w], right = [cx - px * w, y, cz - pz * w];
    if (prev) {
      const v0 = (s - 1) / segments, v1 = t;
      builder.tri(prev[0], prev[1], right, colour, [[0, v0], [1, v0], [1, v1]]);
      builder.tri(prev[0], right, left, colour, [[0, v0], [1, v1], [0, v1]]);
    }
    prev = [left, right];
  }
}

function foliageGeometry(kind) {
  const b = new FacetBuilder(), white = new THREE.Color(1, 1, 1);
  if (kind === 'fern') {
    for (let i = 0; i < 9; i++) frond(b, [0, 0.04, 0], i / 9 * Math.PI * 2 + (i % 2) * 0.2,
      { length: 0.85 + (i % 3) * 0.12, width: 0.34, rise: 0.55, droop: 0.42 + (i % 2) * 0.1, colour: white });
  } else if (kind === 'broadleaf') {
    for (let i = 0; i < 6; i++) frond(b, [0, 0.1, 0], i / 6 * Math.PI * 2 + 0.3,
      { length: 0.9 + (i % 2) * 0.2, width: 0.52, rise: 0.95, droop: 0.65, colour: white, segments: 3 });
  } else if (kind === 'grass') {
    for (let i = 0; i < 3; i++) {
      const a = i / 3 * Math.PI, dx = Math.cos(a) * 0.28, dz = Math.sin(a) * 0.28;
      cardGroup(b, [{ corners: [[-dx, 0, -dz], [dx, 0, dz], [dx, 0.42, dz], [-dx, 0.42, -dz]], colour: white }]);
    }
  }
  return b.geometry({ upNormals: true });
}

function swayMaterial(map, uniforms, strength) {
  const material = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: false });
  material.onBeforeCompile = shader => {
    shader.uniforms.windTime = uniforms.windTime;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nuniform float windTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        vec2 anchor = instanceMatrix[3].xz;
      #else
        vec2 anchor = vec2(0.0);
      #endif
      float sway = sin(windTime * 1.3 + anchor.x * 0.7 + anchor.y * 0.5) * 0.5 + sin(windTime * 2.1 + anchor.y) * 0.25;
      transformed.xz += vec2(0.8, 0.45) * sway * ${strength.toFixed(3)} * max(0.0, transformed.y);`);
    // Both faces of a leaf card use its canopy (upward) normal; the default
    // double-sided flip would light the underside as if it faced the ground.
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n  normal = normalize( vNormal );');
  };
  material.customProgramCacheKey = () => `sway-${strength}`;
  return material;
}

function buildFoliage(world, textures, uniforms) {
  const group = new THREE.Group(); group.name = 'foliage';
  const dummy = new THREE.Object3D(), c = new THREE.Color();
  const specs = { fern: { map: textures.fern, sway: 0.05, scale: 1 }, broadleaf: { map: textures.broadleaf, sway: 0.04, scale: 1.15 },
    grass: { map: textures.grass, sway: 0.08, scale: 1 } };
  for (const [kind, spec] of Object.entries(specs)) {
    const items = world.foliage.filter(f => f.kind === kind);
    if (!items.length) continue;
    const mesh = new THREE.InstancedMesh(foliageGeometry(kind), swayMaterial(spec.map, uniforms, spec.sway), items.length);
    items.forEach((f, i) => {
      dummy.position.set(f.x, f.y, f.z); dummy.rotation.set(0, f.rotation, 0); dummy.scale.setScalar(f.scale * spec.scale);
      dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      // The leaf texture carries the green; instances only vary its tone.
      c.setRGB(1, 1, 1).lerp(f.shade > 0.5 ? new THREE.Color(1.15, 1.2, 0.95) : new THREE.Color(0.72, 0.78, 0.7), Math.abs(f.shade - 0.5) * 2);
      mesh.setColorAt(i, c);
    });
    mesh.castShadow = kind !== 'grass'; mesh.receiveShadow = true; mesh.name = `foliage-${kind}`;
    group.add(mesh);
  }
  return group;
}

function buildTrees(world, textures, uniforms, rng) {
  const trunks = new FacetBuilder(), leaves = new FacetBuilder(), canopy = new FacetBuilder();
  const shade = new THREE.Color();
  const trunk = (x, y, z, radius, height, bend, sides = 6, flare = 0.15) => {
    const levels = 6, bendAngle = rng() * Math.PI * 2;
    const ring = l => {
      const t = l / levels, r = (radius + (l === 0 ? flare : 0)) * (1 - t * 0.45);
      const ox = Math.cos(bendAngle) * bend * t * t, oz = Math.sin(bendAngle) * bend * t * t;
      return Array.from({ length: sides }, (_, i) => [x + ox + Math.cos(i / sides * Math.PI * 2) * r, y - 0.3 + t * (height + 0.3), z + oz + Math.sin(i / sides * Math.PI * 2) * r]);
    };
    const rings = Array.from({ length: levels + 1 }, (_, l) => ring(l));
    for (let l = 0; l < levels; l++) for (let i = 0; i < sides; i++) {
      const a = rings[l][i], b = rings[l][(i + 1) % sides], cc = rings[l + 1][(i + 1) % sides], d = rings[l + 1][i];
      shade.copy(l === 0 ? PALETTE.barkDark : PALETTE.bark).lerp(PALETTE.rockMoss, l < 2 ? 0.25 : 0).multiplyScalar(0.85 + rng() * 0.25);
      const u0 = i / sides, u1 = (i + 1) / sides, v0 = l / levels * height / 2, v1 = (l + 1) / levels * height / 2;
      trunks.tri(a, d, cc, shade, [[u0, v0], [u0, v1], [u1, v1]]); trunks.tri(a, cc, b, shade, [[u0, v0], [u1, v1], [u1, v0]]);
    }
    const top = rings.at(-1);
    return [top.reduce((s, p) => s + p[0], 0) / sides, y + height, top.reduce((s, p) => s + p[2], 0) / sides];
  };
  // Jungle trees: the trunk is the collider (flare stays within 0.15 m).
  for (const tree of world.trees) {
    const y = groundHeight(world, tree.x, tree.z), crown = trunk(tree.x, y, tree.z, tree.radius, tree.height, 0.4 + rng() * 0.8);
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2 + rng(), r = 0.9 + rng() * 1.4, h = crown[1] - 1.6 + rng() * 2.2;
      const cx = crown[0] + Math.cos(a) * r * 0.75, cz = crown[2] + Math.sin(a) * r * 0.75;
      // An irregular low-poly mass for the canopy, and drooping leaf cards around it.
      const blob = new THREE.IcosahedronGeometry(1, 0), bp = blob.attributes.position;
      const sx = 1.3 + rng() * 0.9, sy = 0.95 + rng() * 0.6;
      shade.copy(PALETTE.leafDark).lerp(PALETTE.leafLight, rng() * 0.7);
      for (let v = 0; v < bp.count; v += 3) {
        const tri = [0, 1, 2].map(q => [cx + bp.getX(v + q) * sx, h + bp.getY(v + q) * sy, cz + bp.getZ(v + q) * sx]);
        canopy.tri(...tri, shade.clone().multiplyScalar(faceNormalY(...tri) > 0.3 ? 1.15 : 0.8));
      }
      for (let f = 0; f < 3; f++) frond(leaves, [cx, h, cz], a + (f - 1) * 0.7, { length: 1.5 + rng(), width: 0.7, rise: 0.25, droop: 1.1, colour: new THREE.Color(1, 1, 1) });
    }
  }
  // Palms crown the cliff tops (out of reach, on rock).
  for (const palm of world.foliage.filter(f => f.kind === 'palm')) {
    const height = 4 + palm.scale * 4, crown = trunk(palm.x, palm.y, palm.z, 0.16, height, 0.8 + rng(), 5, 0);
    for (let f = 0; f < 9; f++) frond(leaves, crown, f / 9 * Math.PI * 2 + palm.rotation, { length: 2.4 + rng() * 0.8, width: 0.55, rise: 0.5, droop: 1.6, colour: new THREE.Color(1, 1, 1), segments: 4 });
  }
  const trunkMesh = new THREE.Mesh(trunks.geometry(), new THREE.MeshLambertMaterial({ map: textures.bark, vertexColors: true }));
  trunkMesh.castShadow = true; trunkMesh.receiveShadow = true; trunkMesh.name = 'tree-trunks';
  const canopyMesh = new THREE.Mesh(canopy.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 }));
  canopyMesh.castShadow = true; canopyMesh.name = 'tree-canopy';
  const leafMaterial = swayMaterial(textures.palm, uniforms, 0.015);
  const leafMesh = new THREE.Mesh(leaves.geometry({ upNormals: true }), leafMaterial);
  leafMesh.castShadow = true; leafMesh.name = 'tree-leaves';
  return [trunkMesh, canopyMesh, leafMesh];
}

// Vines hang on the faces of the walls that look into the ravine.
function buildVines(world, columns, grid, textures, uniforms, rng) {
  const b = new FacetBuilder(), white = new THREE.Color(1, 1, 1);
  for (const { rock, height } of columns) {
    for (let k = 0; k < 4; k++) {
      if (rng() < 0.35) continue;
      const angle = rng() * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
      if (!grid.reachable(rock.x + dx * (rock.radius + 1.4), rock.z + dz * (rock.radius + 1.4))) continue;
      const top = height * (0.55 + rng() * 0.4), length = 3 + rng() * Math.min(9, top - 3.2), width = 1 + rng() * 1.2;
      const r = rock.radius + 0.45, cx = rock.x + dx * r, cz = rock.z + dz * r, px = -dz * width / 2, pz = dx * width / 2;
      const bottom = Math.max(3.1, top - length);
      cardGroup(b, [{ corners: [[cx - px, bottom, cz - pz], [cx + px, bottom, cz + pz], [cx + px, top, cz + pz], [cx - px, top, cz - pz]], colour: white }]);
    }
  }
  const log = world.setPieces?.fallenLog;
  if (log) for (let i = 1; i < 9; i++) {
    const t = i / 9 + (rng() - 0.5) * 0.05, x = log.from[0] + (log.to[0] - log.from[0]) * t, z = log.from[1] + (log.to[1] - log.from[1]) * t;
    const y = log.from[2] + (log.to[2] - log.from[2]) * t, length = 2.5 + rng() * 5;
    cardGroup(b, [{ corners: [[x - 0.6, y - length, z], [x + 0.6, y - length, z], [x + 0.6, y, z], [x - 0.6, y, z]], colour: white }]);
  }
  const material = swayMaterial(textures.vine, uniforms, 0.012);
  const mesh = new THREE.Mesh(b.geometry({ upNormals: true }), material);
  mesh.name = 'vines';
  return mesh;
}

function buildFallenLog(world, textures, rng) {
  const log = world.setPieces?.fallenLog;
  if (!log) return null;
  const from = new THREE.Vector3(log.from[0], log.from[2], log.from[1]), to = new THREE.Vector3(log.to[0], log.to[2], log.to[1]);
  const length = from.distanceTo(to), geometry = new THREE.CylinderGeometry(log.radius * 0.8, log.radius, length, 10, 8, false).toNonIndexed();
  const p = geometry.attributes.position, colours = [], shade = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const sag = Math.sin((p.getY(i) / length + 0.5) * Math.PI) * 0.5;
    p.setX(i, p.getX(i) * (0.95 + TEX.hash2(i, 3, 5) * 0.1) + sag);
    shade.copy(PALETTE.bark).lerp(PALETTE.rockMoss, p.getX(i) > 0.2 ? 0.7 : 0.15).multiplyScalar(0.8 + TEX.hash2(i >> 3, 1, 9) * 0.3);
    colours.push(shade.r, shade.g, shade.b);
  }
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: textures.bark, vertexColors: true, flatShading: true, roughness: 1 }));
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
  mesh.rotateY(Math.PI / 2);
  mesh.castShadow = true; mesh.receiveShadow = true; mesh.name = 'fallen-log';
  void rng;
  return mesh;
}

// ------------------------------------------------------------------ water ---
const waterVertex = /* glsl */`
  attribute float depth;
  attribute vec2 flow;
  varying vec3 vWorld;
  varying float vDepth;
  varying vec2 vFlow;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz; vDepth = depth; vFlow = flow;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const waterFragment = /* glsl */`
  uniform float time;
  uniform vec3 skyTop, skyHorizon, shallow, deep, foamColour, sunDirection, sunColour;
  uniform vec3 fallsPoint;
  varying vec3 vWorld;
  varying float vDepth;
  varying vec2 vFlow;
  #include <fog_pars_fragment>
  float wave(vec2 p, vec2 d, float f, float s) { return sin(dot(p, d) * f + time * s); }
  void main() {
    // Surface ripples travel downstream (vFlow.y) with a cross chop.
    vec2 p = vec2(vFlow.x, vFlow.y);
    float h = wave(p, vec2(0.25, 1.0), 2.3, -2.6) * 0.5 + wave(p, vec2(-0.6, 0.8), 3.7, -3.4) * 0.3
      + wave(vWorld.xz, vec2(0.9, 0.4), 5.1, 1.7) * 0.18 + wave(vWorld.xz, vec2(-0.3, 1.0), 7.3, -2.2) * 0.12;
    vec3 normal = normalize(vec3(
      cos(dot(p, vec2(0.25, 1.0)) * 2.3 - time * 2.6) * 0.09 + cos(dot(vWorld.xz, vec2(0.9, 0.4)) * 5.1 + time * 1.7) * 0.05,
      1.0,
      cos(dot(p, vec2(-0.6, 0.8)) * 3.7 - time * 3.4) * 0.08 + cos(dot(vWorld.xz, vec2(-0.3, 1.0)) * 7.3 - time * 2.2) * 0.04));
    vec3 view = normalize(cameraPosition - vWorld);
    float fresnel = 0.04 + 0.6 * pow(1.0 - max(dot(view, normal), 0.0), 5.0);
    vec3 reflected = reflect(-view, normal);
    // In a ravine the low reflections are the dark, mossy walls; only steep
    // reflections see the overcast sky.
    vec3 walls = vec3(0.11, 0.14, 0.12);
    vec3 sky = mix(walls, mix(skyHorizon, skyTop, clamp(reflected.y * 1.4 - 0.3, 0.0, 1.0)), smoothstep(0.18, 0.62, reflected.y));
    float depthMix = clamp(vDepth / 0.26, 0.0, 1.0);
    vec3 body = mix(shallow, deep, depthMix);
    vec3 colour = mix(body, sky, fresnel);
    float glint = pow(max(dot(reflected, normalize(sunDirection)), 0.0), 140.0);
    colour += sunColour * glint * 0.9;
    // Foam: a soft line at the shore, streaks in the current, white water at the falls.
    float shore = (1.0 - smoothstep(0.0, 0.022, vDepth)) * 0.35;
    float streak = smoothstep(0.75, 0.95, sin(vFlow.x * 3.1 + sin(vFlow.y * 0.7) * 2.0) * 0.5 + 0.5) * smoothstep(0.7, 0.98, h * 0.5 + 0.5) * 0.22;
    float falls = 1.0 - smoothstep(1.0, 4.2, distance(vWorld.xz, fallsPoint.xz));
    float foam = clamp(shore * 0.75 + streak + falls * (0.55 + 0.35 * sin(time * 6.0 + vWorld.x * 3.0)), 0.0, 1.0);
    colour = mix(colour, foamColour, foam);
    float alpha = clamp(mix(0.42, 0.84, depthMix) + fresnel * 0.35 + foam * 0.5, 0.0, 0.96);
    alpha *= smoothstep(-0.01, 0.015, vDepth);
    gl_FragColor = vec4(colour, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function buildWater(world) {
  const meshes = [];
  for (const body of world.water ?? []) {
    const features = body.features.map(id => world.terrain.features.find(f => f.id === id)).filter(Boolean);
    const xs = [], zs = [];
    for (const f of features) for (const [x, z] of f.points) { xs.push(x - f.outer, x + f.outer); zs.push(z - f.outer, z + f.outer); }
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs), step = 0.5;
    const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
    const flowLine = world.terrain.features.find(f => f.id === body.flow)?.points ?? features[0].points;
    const positions = [], depth = [], flow = [], index = [], map = new Map();
    // Along-stream coordinate for flow animation.
    const along = (x, z) => {
      let best = Infinity, result = 0, travelled = 0;
      for (let i = 1; i < flowLine.length; i++) {
        const [ax, az] = flowLine[i - 1], [bx, bz] = flowLine[i], dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (length * length)));
        const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
        if (d < best) { best = d; result = travelled + t * length; }
        travelled += length;
      }
      return result;
    };
    for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) {
      const x = x0 + i * step, z = z0 + j * step;
      const inside = features.some(f => pathDistance(x, z, f.points) < f.outer + 0.6);
      if (!inside) continue;
      map.set(j * (nx + 1) + i, positions.length / 3);
      positions.push(x, body.level, z);
      depth.push(body.level - groundHeight(world, x, z));
      const a = along(x, z);
      flow.push(x * 0.4, a);
    }
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const k = [j * (nx + 1) + i, j * (nx + 1) + i + 1, (j + 1) * (nx + 1) + i, (j + 1) * (nx + 1) + i + 1].map(v => map.get(v));
      if (k.some(v => v === undefined)) continue;
      // Skip triangles entirely above the bank so no surface floats over dry ground.
      for (const tri of [[k[0], k[2], k[1]], [k[1], k[2], k[3]]]) if (tri.some(v => depth[v] >= -0.02)) index.push(...tri);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
    geometry.setAttribute('flow', new THREE.Float32BufferAttribute(flow, 2));
    geometry.setIndex(index);
    const falls = world.setPieces?.waterfall;
    const material = new THREE.ShaderMaterial({
      vertexShader: waterVertex, fragmentShader: waterFragment, transparent: true, depthWrite: false, fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        time: { value: 0 }, skyTop: { value: color(0x7f909c) }, skyHorizon: { value: color(0xb3bdbb) },
        shallow: { value: color(0x5b6d64) }, deep: { value: color(0x22393b) }, foamColour: { value: color(0xd9e2de) },
        sunDirection: { value: new THREE.Vector3(-0.4, 0.75, 0.5) }, sunColour: { value: color(0xfff1d6) },
        fallsPoint: { value: new THREE.Vector3(falls?.x ?? 999, 0, (falls?.z ?? 999) + 1.2) },
      }]),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `water-${body.id}`; mesh.renderOrder = 2;
    meshes.push(mesh);
  }
  return meshes;
}

const fallVertex = /* glsl */`
  varying vec2 vUv;
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const fallFragment = /* glsl */`
  uniform sampler2D map;
  uniform float time, speed;
  varying vec2 vUv;
  #include <fog_pars_fragment>
  void main() {
    vec4 a = texture2D(map, vec2(vUv.x * 1.5, vUv.y * 1.2 + time * speed));
    vec4 b = texture2D(map, vec2(vUv.x * 2.3 + 0.37, vUv.y * 0.8 + time * speed * 1.37));
    float edge = smoothstep(0.0, 0.18, vUv.x) * smoothstep(1.0, 0.82, vUv.x);
    // Darker, glassier water at the lip; whiter, aerated water lower down.
    vec3 colour = mix(vec3(0.5, 0.58, 0.6), vec3(0.86, 0.9, 0.9), clamp((a.r + b.r) * 0.5 + (1.0 - vUv.y) * 0.3 - 0.15, 0.0, 1.0));
    gl_FragColor = vec4(colour, edge * clamp((a.a + b.a) * 0.5 - 0.05, 0.0, 0.9));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function buildWaterfall(world, textures, rng) {
  const falls = world.setPieces?.waterfall;
  if (!falls) return null;
  const group = new THREE.Group(); group.name = 'waterfall';
  const level = world.water?.[0]?.level ?? -0.2;
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null }, time: { value: 0 }, speed: { value: 1.6 } }]);
  uniforms.map.value = textures.fall;
  const material = new THREE.ShaderMaterial({ vertexShader: fallVertex, fragmentShader: fallFragment, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
  // The main fall and a thinner side strand, each a bowed sheet over the
  // headwall (whose columns behind it stay flush) into the plunge pool. The
  // splash boulders in the layout keep hunters a body-length from the sheet.
  for (const [dx, top, width, bow] of [[0, falls.top, falls.width, 1], [2.3, falls.top - 4.5, falls.width * 0.32, 0.6]]) {
    const height = top - level, geometry = new THREE.PlaneGeometry(1, 1, 6, 14), p = geometry.attributes.position;
    for (let v = 0; v < p.count; v++) {
      const t = p.getY(v) + 0.5, w = width * (1 + (1 - t) * 0.4);
      p.setX(v, p.getX(v) * w);
      p.setY(v, (t - 0.5) * height);
      p.setZ(v, (Math.cos(p.getX(v) / w * Math.PI) * 0.12 + 0.15 + (1 - t) * (1 - t) * 0.35) * bow);
    }
    geometry.computeVertexNormals();
    const sheet = new THREE.Mesh(geometry, material);
    sheet.position.set(falls.x + dx, level + height / 2, falls.z);
    sheet.renderOrder = 3; sheet.name = dx ? 'falls-strand' : 'falls-main';
    group.add(sheet);
  }
  // Drifting spray at the plunge pool.
  const count = 70, positions = new Float32Array(count * 3), seeds = [];
  for (let i = 0; i < count; i++) { seeds.push([rng(), rng(), rng()]); }
  const mist = new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)),
    new THREE.PointsMaterial({ map: textures.puff, size: 2.6, transparent: true, opacity: 0.3, depthWrite: false, color: 0xe8eeee, fog: true }));
  mist.frustumCulled = false; mist.renderOrder = 4; mist.name = 'falls-mist';
  group.add(mist);
  group.userData = { material, mist, seeds, falls, level };
  return group;
}

// ------------------------------------------------------------------- camp ---
function buildCampProps(world, textures, rng) {
  const group = new THREE.Group(); group.name = 'camp-props';
  const wood = new THREE.MeshLambertMaterial({ map: textures.bark, color: 0x8a7458 });
  const hide = new THREE.MeshLambertMaterial({ map: textures.hide, color: 0x7a6047, side: THREE.DoubleSide });
  const cut = new THREE.MeshLambertMaterial({ color: 0xa38b6a });
  for (const prop of world.props) {
    const y = groundHeight(world, prop.x, prop.z);
    if (prop.kind === 'lean-to') {
      // Fits inside its 1.6 m collider: frame 2.4 m wide, 1.8 m deep.
      const shelter = new THREE.Group(); shelter.position.set(prop.x, y, prop.z); shelter.rotation.y = prop.yaw;
      for (const side of [-1, 1]) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 1.85, 6), wood);
        pole.position.set(side * 1.1, 0.92, -0.75); pole.rotation.z = side * 0.06; shelter.add(pole);
        const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.0, 5), wood);
        brace.position.set(side * 1.1, 0.85, 0.05); brace.rotation.x = -1.1; shelter.add(brace);
      }
      const ridge = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.5, 6), wood);
      ridge.rotation.z = Math.PI / 2; ridge.position.set(0, 1.8, -0.75); shelter.add(ridge);
      const tarpGeometry = new THREE.PlaneGeometry(2.5, 2.05, 6, 4), tp = tarpGeometry.attributes.position;
      for (let v = 0; v < tp.count; v++) tp.setZ(v, -Math.sin((tp.getY(v) / 2.05 + 0.5) * Math.PI) * 0.16 * (0.6 + Math.sin((tp.getX(v) / 2.5 + 0.5) * Math.PI) * 0.4) + (TEX.hash2(v, 2, 4) - 0.5) * 0.03);
      tarpGeometry.computeVertexNormals();
      const tarp = new THREE.Mesh(tarpGeometry, hide);
      tarp.position.set(0, 0.95, 0.1); tarp.rotation.x = -Math.PI / 2 + 0.6; shelter.add(tarp);
      const bedding = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.08, 1.0), new THREE.MeshLambertMaterial({ map: textures.hide, color: 0x7d6650 }));
      bedding.position.set(0, 0.04, 0.2); shelter.add(bedding);
      shelter.traverse(o => { o.castShadow = true; o.receiveShadow = true; });
      group.add(shelter);
    } else if (prop.kind === 'seat') {
      const stump = new THREE.Mesh(new THREE.CylinderGeometry(prop.radius * 0.92, prop.radius, 0.46, 8), [wood, cut, cut]);
      stump.position.set(prop.x, y + 0.23, prop.z); stump.rotation.y = prop.yaw; stump.castShadow = true; stump.receiveShadow = true;
      group.add(stump);
    } else if (prop.kind === 'firewood') {
      for (let i = 0; i < 7; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.75, 6), wood);
        log.rotation.set(0, prop.yaw, Math.PI / 2);
        log.position.set(prop.x + Math.sin(prop.yaw) * ((i % 3) - 1) * 0.15, y + 0.08 + Math.floor(i / 3) * 0.13, prop.z + Math.cos(prop.yaw) * ((i % 3) - 1) * 0.15);
        log.castShadow = true; group.add(log);
      }
    }
  }
  void rng;
  return group;
}

// -------------------------------------------------------------- atmosphere ---
function buildSky() {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: color(ENVIRONMENT.skyTop) }, horizon: { value: color(ENVIRONMENT.skyHorizon) }, time: { value: 0 } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top, horizon; uniform float time; varying vec3 vDir;
      float n(vec2 p) { return sin(p.x) * sin(p.y * 1.3 + 1.7) * 0.5 + 0.5; }
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        vec2 p = vDir.xz / max(vDir.y, 0.08) * 1.8 + vec2(time * 0.01, 0.0);
        float clouds = n(p) * 0.6 + n(p * 2.3 + 3.1) * 0.4;
        c = mix(c, horizon * 1.08, smoothstep(0.55, 0.85, clouds) * 0.35 * smoothstep(0.02, 0.3, h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(200, 24, 12), material);
  sky.name = 'sky'; sky.frustumCulled = false; sky.renderOrder = -10;
  return sky;
}

export function buildWorld(scene, world) {
  const rng = randomFromSeed((world.seed ?? 1) ^ 0x5eed);
  const textures = {
    ground: TEX.groundTexture(), rock: TEX.rockTexture(), bark: TEX.barkTexture(), hide: TEX.hideTexture(),
    fern: TEX.fernTexture(), broadleaf: TEX.broadleafTexture(), palm: TEX.palmTexture(), grass: TEX.grassTexture(),
    vine: TEX.vineTexture(), fall: TEX.fallTexture(), puff: TEX.puffTexture(),
  };
  scene.background = new THREE.Color(ENVIRONMENT.fog);
  scene.fog = new THREE.FogExp2(ENVIRONMENT.fog, ENVIRONMENT.fogDensity);
  scene.add(new THREE.HemisphereLight(ENVIRONMENT.hemiSky, ENVIRONMENT.hemiGround, 2.6));
  const sunlight = new THREE.DirectionalLight(ENVIRONMENT.sun, 1.9);
  sunlight.position.set(-26, 44, 30);
  sunlight.target.position.set(2, 0, -8);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, { left: -42, right: 42, top: 42, bottom: -42, near: 4, far: 130 });
  sunlight.shadow.normalBias = 0.05; sunlight.shadow.bias = -0.0004; sunlight.shadow.radius = 3;
  scene.add(sunlight, sunlight.target);

  const uniforms = { windTime: { value: 0 } };
  const grid = walkableGrid(world, 1);
  const terrain = buildTerrain(world, textures);
  const outer = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshLambertMaterial({ color: 0x3e4733 }));
  outer.rotation.x = -Math.PI / 2; outer.position.y = -0.7; outer.name = 'outer-ground';
  const rock = buildRock(world, textures, grid, rng);
  const boulders = buildBoulders(world, textures, rng, grid);
  const foliage = buildFoliage(world, textures, uniforms);
  const trees = buildTrees(world, textures, uniforms, rng);
  const vines = buildVines(world, rock.columns, grid, textures, uniforms, rng);
  const log = buildFallenLog(world, textures, rng);
  const water = buildWater(world);
  const falls = buildWaterfall(world, textures, rng);
  const camp = buildCampProps(world, textures, rng);
  const sky = buildSky();
  const root = new THREE.Group(); root.name = 'environment';
  root.add(sky, terrain, outer, rock.walls, rock.back, boulders, foliage, ...trees, vines, ...water, camp);
  if (log) root.add(log);
  if (falls) root.add(falls);
  scene.add(root);

  const fallsPoint = falls ? new THREE.Vector3(falls.userData.falls.x, falls.userData.level, falls.userData.falls.z + 1.2) : null;
  return {
    root, terrain, water, falls, sunlight, textures, columns: rock.columns,
    sounds: { falls: fallsPoint, creek: world.terrain.features.find(f => f.id === 'creek-channel')?.points ?? [], camp: { x: HUNT.camp.x, z: HUNT.camp.z } },
    update(seconds) {
      uniforms.windTime.value = seconds;
      for (const mesh of water) mesh.material.uniforms.time.value = seconds;
      sky.material.uniforms.time.value = seconds;
      if (falls) {
        const { material, mist, seeds, falls: f, level } = falls.userData;
        material.uniforms.time.value = seconds;
        const p = mist.geometry.attributes.position;
        seeds.forEach(([a, b, c], i) => {
          const life = (seconds * (0.18 + a * 0.12) + b) % 1;
          p.setXYZ(i, f.x + (a - 0.4) * 5 + Math.sin(seconds * 0.4 + c * 9) * 0.6, level + 0.2 + life * 3.2, f.z + 0.8 + c * 2.2 + life * 1.2);
        });
        p.needsUpdate = true;
      }
    },
  };
}

