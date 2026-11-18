// Hunt Slice 0.1 test biome: "Jungle Ravine".
//
// Pure layout DATA, separate from expansion (shared/world.js), gameplay
// (shared/movement.js, server/*) and rendering (client/src/world.js). Move,
// add or delete entries here to rearrange the biome; nothing else hard-codes
// these positions. Coordinates are metres: +x east, -z north (hunters spawn
// facing north). The camp, the four spawns and both boar spawns are the
// existing gameplay anchors (shared/hunt.js, shared/world.js) and the layout is
// built around them.
//
// Concept-sheet mapping (references/01_APPROVED_VISUAL_TARGET):
//   04 Camp edge -> wilderness : camp terrace under tall trees, south end
//   02 Hunt basin              : broad flat floor north of camp, boulders, fern margins
//   01 Creek ravine approach   : shallow creek along the west cliff from the falls
//   03 Narrow pass             : 3.4 m gap in the east rock fin into a raised pocket
//   overhead fallen log        : decorative span between the cliff tops, unreachable

const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

export const RAVINE_LAYOUT = freeze({
  id: 'jungle-ravine-0.1',
  seed: 71931,
  halfSize: 36,

  // Walkable elevation. Everything here is authoritative ground (see
  // shared/terrain.js). The basin floor and camp terrace are exactly y = 0.
  terrain: {
    base: 0,
    features: [
      // Creek bed: 0.45 m below the floor; banks ease over 4.8 m (8 degrees at most).
      { id: 'creek-channel', mode: 'carve', height: -0.45, inner: 1.8, outer: 6.6,
        points: [[-13.2, -27], [-14.6, -20], [-13.8, -12], [-15.2, -4], [-14.8, 4], [-16, 11], [-17.5, 19]] },
      // Plunge pool under the falls; the same shallow depth as the creek.
      { id: 'falls-pool', mode: 'carve', height: -0.45, inner: 3.2, outer: 7.8, points: [[-13, -27.4]] },
      // East pocket: a 0.6 m raised floor reached by ramps through the narrow
      // pass and the north opening.
      { id: 'east-pocket', mode: 'raise', height: 0.6, inner: 5, outer: 13, points: [[21.5, -9], [22, -23]] },
    ],
  },

  // Flat water surfaces over the carved features. 0.25 m deep at most.
  water: [{ id: 'creek', level: -0.2, features: ['creek-channel', 'falls-pool'], flow: 'creek-channel' }],

  // Impassable rock. Each chain becomes overlapping circular colliders (the
  // existing obstacle primitive used by movement, boar steering/sight and
  // spears) and the renderer draws a rock column over every collider.
  cliffs: [
    { id: 'west-wall', radius: 2.4, spacing: 2.6, height: [15, 23],
      points: [[-21, 18], [-22.2, 8], [-21.8, -2], [-21.6, -12], [-20.6, -22], [-19.6, -29]] },
    { id: 'headwall', radius: 2.4, spacing: 2.6, height: [18, 26],
      points: [[-19.6, -29], [-16.5, -32.2], [-12.5, -33], [-8.5, -32.2], [-4, -30.8], [1, -30.4], [6, -30.6],
        [10.5, -30.2], [14.5, -30.2], [19, -30.8], [24, -30], [28.5, -27.5], [31, -23]] },
    { id: 'pocket-east', radius: 2.4, spacing: 2.6, height: [14, 21],
      points: [[31, -23], [31.6, -15], [30.2, -8], [26.5, -4.2], [21, -3.2], [16, -2.6]] },
    // The rock fin between the basin and the east pocket. The 3.4 m gap
    // between its two parts is the narrow pass.
    { id: 'east-fin-south', radius: 2.4, spacing: 2.6, height: [11, 17],
      points: [[12.6, 13], [12.6, 4], [12.5, -3], [12.5, -9]] },
    { id: 'east-fin-north', radius: 2.4, spacing: 2.6, height: [10, 15],
      points: [[13.2, -17.2], [14.2, -19.8]] },
    { id: 'south-wall', radius: 2.4, spacing: 2.6, height: [13, 19],
      points: [[12.6, 13], [10.5, 16], [5, 18], [-2, 18.6], [-9, 17.8], [-15, 18.6], [-21, 18]] },
  ],

  // Hand-placed boulders: cover in the basin, stepping stones in the creek,
  // a ring round the pool and the creek's exit under the south wall.
  boulders: [
    [-5.5, -15.5, 1.3], [-4.2, -16.9, 0.7], [6.8, -17.5, 1.5], [5.3, -19.2, 0.75], [-2.2, -22.5, 1.1],
    [3, -25.2, 1.4], [8.2, -14.8, 0.8],
    [-13.2, -16, 0.8], [-15.6, -9, 0.7], [-13.4, -1, 0.9], [-16.2, 6, 0.8], [-14, 13.5, 1.0], [-12.4, -22.5, 0.7],
    [-9.4, -28, 1.2], [-16.8, -25.8, 1.3], [-11, -24.1, 0.6],
    // Splash rocks where the falls land: they keep hunters clear of the sheet.
    [-12.8, -29.4, 1.0], [-14.7, -29.1, 0.75], [-10.7, -29.4, 0.8],
    [-17.2, 15.4, 1.4], [-14.5, 16.1, 1.0],
    [24.5, -11, 1.2], [19.5, -19.5, 1.0], [27, -20, 1.6], [17.6, -6.6, 0.8],
    [-7, 6, 0.9], [7.5, 5.5, 1.0],
  ],

  // Camp set piece around the existing fire at HUNT.camp (0, 3). Props that a
  // hunter could bump into are solid; the fire ring itself stays walkable so
  // cooking range is unchanged. The lean-to sits east of the camp, clear of
  // the open lanes (x = -4 .. 4) that run from behind the fire into the basin.
  camp: {
    leanTo: { x: 6.8, z: 10.4, radius: 1.6, yaw: 0.74 },
    seats: [[-2.4, 3.5, 0.32], [2.45, 3.1, 0.32]],
    firewood: { x: 3.4, z: 7, radius: 0.45 },
  },

  // Seeded scatter. Trees are solid trunks; foliage is soft and never collides.
  trees: [
    { id: 'camp-forest', count: 22, spacing: 1.7, rect: [-11.5, 7, 10.5, 15.4] },
    { id: 'creek-margin', count: 8, spacing: 2.6, band: { width: 1.1, points: [[-9.2, 4], [-9.6, -10], [-10.4, -22]] } },
    { id: 'basin-east-margin', count: 6, spacing: 2.8, band: { width: 0.9, points: [[8.7, 4], [9.1, -7], [8.4, -24]] } },
    { id: 'pocket-grove', count: 12, spacing: 2.4, band: { width: 2.6, points: [[20, -7], [25.5, -14], [22, -25]] } },
    { id: 'basin-north', count: 4, spacing: 3.5, band: { width: 1.5, points: [[-6, -26.5], [7, -27]] } },
  ],
  foliage: [
    { kind: 'fern', count: 150, zone: 'cliff-base' },
    { kind: 'fern', count: 70, zone: 'creek-bank' },
    { kind: 'fern', count: 60, zone: 'forest-floor' },
    { kind: 'broadleaf', count: 34, zone: 'creek-bank' },
    { kind: 'broadleaf', count: 26, zone: 'forest-floor' },
    { kind: 'grass', count: 140, zone: 'margins' },
    { kind: 'palm', count: 46, zone: 'cliff-top' },
  ],

  // Kept clear of scatter (paths stay readable) and coloured as trodden earth.
  paths: [
    { width: 1.6, points: [[0, 6], [0, 0], [0.5, -10], [2.5, -21], [1.5, -27]] },
    { width: 1.3, points: [[1, -8], [7, -11.5], [11, -13.2], [16, -13.4], [21, -16], [23, -23], [16, -25]] },
    { width: 1.2, points: [[-2, 2], [-8.2, -1], [-9.6, -12], [-10.4, -24]] },
  ],
  clearings: [
    { x: 0, z: 4, radius: 6.4 },   // camp: spawns and fire
    { x: 0, z: -4, radius: 9 },    // boar spawns at the basin's south edge
  ],

  // Visual-only set pieces. Nothing here is walkable or collides; each sits on
  // or above impassable rock.
  setPieces: {
    waterfall: { x: -12.6, z: -30.4, top: 18, width: 4.4 },
    fallenLog: { from: [-22, -19, 19.5], to: [14.5, -23.5, 20.5], radius: 0.9 },
  },
});
