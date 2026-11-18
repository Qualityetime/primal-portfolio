import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REGIONS, hitAnatomy, injuryFor } from '../../simulation/anatomy.js';
import { HuntState } from '../../simulation/huntState.js';
import { createWorld } from '../../shared/world.js';
import { toWorld, toLocal } from '../../shared/body.js';

// Integrity + expression hotfix: authoritative anatomy refitted to the approved
// 1.18x rigged boar. Fixture points are seeded samples of the actual skinned
// Ironhide surface (boar-local metres, outward normal), generated read-only
// from client/public/assets/ironhide-boar.glb. "rest" is the neutral stance;
// "walk" samples eight phases of the supplied walk clip (an approximation: the
// client's load-time pitch/bob bakes were not reproduced). Hoof soles and leg
// faces turned toward the other leg are excluded; spears reach legs from outside.
const SURFACE = JSON.parse(readFileSync(new URL('./fixtures/ironhide-surface-points.json', import.meta.url)));
const DEPTH = 0.15; // a visible strike must reach its region within 15 cm of the skin

// Pre-hotfix geometry, kept only to prove the improvement is measured, not assumed.
const OLD_REGIONS = [
  { name: 'head', center: { x: 0, y: 0.75, z: -1.08 }, radii: { x: 0.42, y: 0.40, z: 0.47 } },
  { name: 'neck', center: { x: 0, y: 1.08, z: -0.73 }, radii: { x: 0.44, y: 0.32, z: 0.30 } },
  { name: 'chest', center: { x: 0, y: 0.92, z: -0.29 }, radii: { x: 0.64, y: 0.57, z: 0.48 } },
  { name: 'belly', center: { x: 0, y: 0.69, z: 0.23 }, radii: { x: 0.60, y: 0.40, z: 0.46 } },
  { name: 'rump', center: { x: 0, y: 0.88, z: 0.72 }, radii: { x: 0.54, y: 0.47, z: 0.42 } },
  ...[-1, 1].flatMap(side => [-0.56, 0.67].map(z => ({ name: 'legs', center: { x: side * 0.41, y: 0.27, z }, radii: { x: 0.14, y: 0.28, z: 0.15 } }))),
];
// Same swept-ellipsoid test as server/anatomy.js, for the old table only.
function oldHit(from, to) {
  let best = null;
  for (const region of OLD_REGIONS) {
    const { center: c, radii: r } = region;
    const o = { x: (from.x - c.x) / r.x, y: (from.y - c.y) / r.y, z: (from.z - c.z) / r.z };
    const d = { x: (to.x - from.x) / r.x, y: (to.y - from.y) / r.y, z: (to.z - from.z) / r.z };
    const a = d.x ** 2 + d.y ** 2 + d.z ** 2, b = 2 * (o.x * d.x + o.y * d.y + o.z * d.z), cc = o.x ** 2 + o.y ** 2 + o.z ** 2 - 1;
    const disc = b * b - 4 * a * cc; if (disc < 0) continue;
    const t = cc <= 0 ? 0 : (-b - Math.sqrt(disc)) / (2 * a);
    if (t < 0 || t > 1) continue;
    if (!best || t < best.t) best = { t, region, point: { x: from.x + (to.x - from.x) * t } };
  }
  return best;
}
const still = { x: 0, z: 0, yaw: 0 };
// Fire a spear along the inward normal of a visible surface point.
function strike([x, y, z, nx, ny, nz], hit = (from, to) => hitAnatomy(still, from, to)) {
  const from = { x: x + nx * 0.6, y: y + ny * 0.6, z: z + nz * 0.6 }, to = { x: x - nx * 0.6, y: y - ny * 0.6, z: z - nz * 0.6 };
  const result = hit(from, to);
  return result && result.t * 1.2 <= 0.6 + DEPTH ? result : null;
}
const semantic = part => part.includes('leg') ? 'legs' : part;
const rate = (points, predicate) => points.filter(predicate).length / points.length;

test('integrity anatomy: semantic regions and every tissue property are unchanged', () => {
  const tissue = Object.fromEntries(REGIONS.map(r => [r.name, { resistance: r.resistance, trauma: r.trauma, bleed: r.bleed }]));
  assert.deepEqual(tissue, {
    head: { resistance: 2.8, trauma: 16, bleed: 0.0015 }, neck: { resistance: 0.9, trauma: 42, bleed: 0.014 },
    chest: { resistance: 1.2, trauma: 35, bleed: 0.008 }, belly: { resistance: 0.75, trauma: 25, bleed: 0.006 },
    rump: { resistance: 1.6, trauma: 18, bleed: 0.003 }, legs: { resistance: 1, trauma: 15, bleed: 0.0025 },
  });
  for (const name of ['head', 'neck', 'chest', 'belly', 'rump']) assert.equal(REGIONS.filter(r => r.name === name).length, 1);
  // Four individual legs, each an upper and a lower segment of the same tissue.
  const legs = REGIONS.filter(r => r.name === 'legs');
  assert.equal(legs.length, 8);
  assert.deepEqual(new Set(legs.map(r => r.id.replace(/-(upper|lower)$/, ''))),
    new Set(['left-front-leg', 'right-front-leg', 'left-hind-leg', 'right-hind-leg']));
  for (const r of legs) assert.equal(Math.sign(r.center.x), r.id.startsWith('left') ? -1 : 1, `${r.id} lies on its side (+X is the boar's right)`);
  assert.ok(Object.isFrozen(REGIONS) && REGIONS.every(r => Object.isFrozen(r) && Object.isFrozen(r.center) && Object.isFrozen(r.radii)));
});

test('integrity anatomy (1): visible torso strikes on the rigged boar map to their anatomical region', () => {
  for (const part of ['head', 'neck', 'chest', 'belly', 'rump']) {
    const points = SURFACE.rest[part];
    const registered = rate(points, p => strike(p)), correct = rate(points, p => strike(p)?.region.name === part);
    assert.ok(registered >= (part === 'head' ? 0.75 : 0.9), `${part}: ${(registered * 100).toFixed(0)}% of visible strikes register`);
    assert.ok(correct >= 0.7, `${part}: ${(correct * 100).toFixed(0)}% resolve to ${part}`);
  }
  const all = Object.entries(SURFACE.rest).flatMap(([part, points]) => points.map(p => [part, p]));
  const registered = rate(all, ([, p]) => strike(p)), before = rate(all, ([, p]) => strike(p, oldHit));
  assert.ok(registered >= 0.95, `all visible flesh: ${(registered * 100).toFixed(1)}%`);
  assert.ok(registered > before + 0.15, `refit ${(registered * 100).toFixed(1)}% vs previous ${(before * 100).toFixed(1)}%`);
});

test('integrity anatomy (2): visible hind-leg strikes now register on the hind legs instead of missing', () => {
  for (const part of ['left-hind-leg', 'right-hind-leg']) {
    const points = SURFACE.rest[part];
    const now = rate(points, p => strike(p)?.region.name === 'legs'), before = rate(points, p => strike(p, oldHit)?.region.name === 'legs');
    assert.ok(now >= 0.9, `${part} at rest: ${(now * 100).toFixed(0)}% now hit legs`);
    assert.ok(before <= 0.1, `${part} at rest previously: ${(before * 100).toFixed(0)}%`);
    const walking = SURFACE.walk[part];
    const walkNow = rate(walking, p => strike(p)), walkBefore = rate(walking, p => strike(p, oldHit));
    assert.ok(walkNow >= 0.5 && walkNow > walkBefore + 0.15, `${part} walking: ${(walkNow * 100).toFixed(0)}% vs ${(walkBefore * 100).toFixed(0)}%`);
  }
  // The pre-hotfix hind-leg zone was empty space under the belly of the visible rig.
  const oldZone = { x: 0.41, y: 0.27, z: 0.67 };
  assert.equal(hitAnatomy(still, { ...oldZone, x: 0.6 }, { ...oldZone, x: 0.3 }), null);
  // The visible hock and cannon now hold the authoritative leg.
  assert.equal(hitAnatomy(still, { x: 1, y: 0.25, z: 1.35 }, { x: 0, y: 0.25, z: 1.35 })?.region.id, 'right-hind-leg-lower');
});

test('integrity anatomy (3): left and right leg identity follows the visible leg, on a rotated animal too', () => {
  const animal = { x: 4, z: -7, yaw: 1.23 };
  for (const part of ['left-front-leg', 'right-front-leg', 'left-hind-leg', 'right-hind-leg']) {
    const side = part.startsWith('left') ? 'left' : 'right', sign = side === 'left' ? -1 : 1;
    let legs = 0;
    for (const [x, y, z, nx, ny, nz] of SURFACE.rest[part]) {
      const from = toWorld(animal, { x: x + nx * 0.6, y: y + ny * 0.6, z: z + nz * 0.6 });
      const to = toWorld(animal, { x: x - nx * 0.6, y: y - ny * 0.6, z: z - nz * 0.6 });
      const hit = hitAnatomy(animal, from, to);
      if (hit?.region.name !== 'legs') continue;
      legs++;
      assert.ok(hit.region.id.startsWith(side), `${part} resolved to ${hit.region.id}`);
      assert.equal(Math.sign(hit.point.x), sign, 'wound local position is on the struck side');
      assert.equal(Math.sign(toLocal(animal, hit.worldPoint).x), sign);
    }
    assert.ok(legs / SURFACE.rest[part].length >= 0.85, `${part}: ${legs} leg hits`);
  }
});

test('integrity anatomy (4): each boar keeps its own anatomy, wounds and earliest-hit identity', () => {
  const world = createWorld(); world.obstacles = [];
  const hunt = new HuntState(world, { seed: 7 });
  const [a, b] = hunt.animals;
  Object.assign(a, { x: 0, z: -6, yaw: 0.4 }); Object.assign(b, { x: 5, z: -6, yaw: -1.1 });
  for (const animal of hunt.animals) hunt.previousAnimals.set(animal.id, { ...animal });
  // A sweep that touches only B's visible right hind leg.
  const local = { x: 0.6, y: 0.25, z: 1.35 }, from = toWorld(b, local), to = toWorld(b, { ...local, x: 0.2 });
  const hit = hunt.firstAnimalHit(from, to);
  assert.equal(hit.animal, b); assert.equal(hit.hit.region.id, 'right-hind-leg-lower');
  const before = JSON.stringify(a.wounds);
  hunt.impact(b, hit.hit, 26, 'throw', 'a', 1);
  assert.equal(b.wounds.length, 1); assert.equal(b.wounds[0].region, 'legs'); assert.equal(JSON.stringify(a.wounds), before);
  hunt.stepWounds(b, 2); hunt.stepWounds(a, 2);
  assert.ok(b.limp > 0); assert.equal(a.limp, 0);
  // The same local strike on A resolves through A's own position and heading.
  const onA = hunt.firstAnimalHit(toWorld(a, { x: -0.8, y: 0.2, z: -0.6 }), toWorld(a, { x: -0.3, y: 0.2, z: -0.6 }));
  assert.equal(onA.animal, a); assert.equal(onA.hit.region.id, 'left-front-leg-lower');
  assert.equal(b.wounds.length, 1);
});

test('integrity anatomy (5): penetration, trauma and bleeding math is the pre-hotfix formula exactly', () => {
  // Verbatim reference of the unchanged injuryFor() formula.
  const reference = (region, directness, speed, kind) => {
    const energy = (speed / (kind === 'throw' ? 26 : 9)) ** 2;
    const depth = Math.max(0, Math.min(1.5, energy * directness ** 1.7 / region.resistance));
    const severity = Math.max(0.025, Math.min(1.25, depth));
    const glancing = directness < 0.4 || depth < 0.16;
    return { depth, severity, glancing, embedded: kind !== 'thrust' && !glancing && depth > 0.24,
      trauma: region.trauma * severity * (glancing ? 0.25 : 1), bleed: region.bleed * severity * (glancing ? 0.18 : 1) };
  };
  for (const region of REGIONS) for (const [speed, kind] of [[30, 'throw'], [12, 'throw'], [8.7, 'thrust'], [23.5, 'brace']]) {
    for (const directness of [1, 0.6, 0.39, 0.1]) {
      const point = { x: 0.1, y: 0.9, z: 0 }, normal = { x: 1, y: 0, z: 0 };
      const actual = injuryFor({ region, directness, point, normal }, speed, kind);
      const { region: name, local, normal: n, ...math } = actual;
      assert.equal(name, region.name); assert.equal(local, point); assert.equal(n, normal);
      assert.deepEqual(math, reference(region, directness, speed, kind));
    }
  }
});

test('integrity anatomy (6): previously valid anatomical hits still resolve to the same regions and depths', () => {
  const ray = (from, to, animal = still) => hitAnatomy(animal, toWorld(animal, from), toWorld(animal, to));
  const rotated = { x: 3, z: -5, yaw: 1.23 };
  // The canonical rays used across the Hunting 1.1-1.2.2 suites.
  assert.equal(ray({ x: 0, y: 0.75, z: -3 }, { x: 0, y: 0.75, z: 0 }, rotated).region.name, 'head');
  assert.equal(ray({ x: 0, y: 0.75, z: -3 }, { x: 0, y: 0.75, z: 3 }).region.name, 'head');
  assert.equal(ray({ x: 2, y: 1.2, z: -0.74 }, { x: 0, y: 1.2, z: -0.74 }, rotated).region.name, 'neck');
  assert.equal(ray({ x: 2, y: 1.1, z: -0.28 }, { x: 0, y: 1.1, z: -0.28 }, rotated).region.name, 'chest');
  assert.equal(ray({ x: 2, y: 0.65, z: 0.25 }, { x: 0, y: 0.65, z: 0.25 }, rotated).region.name, 'belly');
  assert.equal(ray({ x: 2, y: 0.95, z: 0.82 }, { x: 0, y: 0.95, z: 0.82 }, rotated).region.name, 'rump');
  assert.equal(ray({ x: 0, y: 0.88, z: 3 }, { x: 0, y: 0.88, z: -3 }).region.name, 'rump');
  const direct = ray({ x: 2, y: 0.92, z: -0.29 }, { x: -2, y: 0.92, z: -0.29 });
  const graze = ray({ x: 2, y: 1.482, z: -0.29 }, { x: -2, y: 1.482, z: -0.29 });
  assert.equal(direct.region.name, 'chest'); assert.equal(graze.region.name, 'chest');
  assert.ok(direct.directness > 0.98);
  const deep = injuryFor(direct, 26), shallow = injuryFor(graze, 26);
  assert.equal(deep.glancing, false); assert.equal(deep.embedded, true);
  assert.equal(shallow.glancing, true); assert.equal(shallow.embedded, false);
  // Visible-surface points that already worked before the refit keep their region.
  let kept = 0, total = 0;
  for (const [part, points] of Object.entries(SURFACE.rest)) for (const p of points) {
    const before = strike(p, oldHit);
    if (before?.region.name !== semantic(part)) continue;
    total++; if (strike(p)?.region.name === semantic(part)) kept++;
  }
  assert.ok(total > 100 && kept / total >= 0.9, `${kept}/${total} previously correct visible strikes unchanged in region`);
});
