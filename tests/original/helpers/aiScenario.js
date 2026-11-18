import { createHash } from 'node:crypto';
import { GameState } from '../../../simulation/gameState.js';
import { neutralInput } from '../../../shared/movement.js';
import { createLegacyWorld } from './legacyWorld.js';

// Deterministic four-hunter / two-boar encounter for Professor Boar drift checks.
// Hunters approach, sprint, circle and back off under scripted input; at tick 200
// boar B receives one fixed chest wound built without any region geometry. No
// thrust, throw or brace occurs, so anatomy geometry cannot influence the run.
// Every tick records both brains' state, timing, position, heading, pressure,
// target and health, plus hunter health, into a SHA-256 digest.
// `world` defaults to the frozen v0.3.5 clearing (tests/helpers/legacyWorld.js)
// so the recorded digests keep proving the brain is unchanged; pass the
// production world to exercise the Hunt Slice ravine instead.
export function runAIScenario(seed, ticks = 1500, world = createLegacyWorld()) {
  const game = new GameState({ world });
  const hunters = ['a', 'b', 'c', 'd'].map(id => game.addPlayer(id, { room: 'BONES', name: `Hunter ${id}` }));
  const { hunt } = game.rooms.get('BONES');
  hunt.seed = seed; hunt.spawnAnimals();
  const [A, B] = hunt.animals;
  const plan = [
    { p: hunters[0], target: A, sprint: false, from: 0 },
    { p: hunters[1], target: A, sprint: true, from: 240 },
    { p: hunters[2], target: B, sprint: false, from: 120 },
    { p: hunters[3], target: B, sprint: true, from: 600 },
  ];
  const chest = { name: 'chest', resistance: 1.2, trauma: 35, bleed: 0.008 };
  const hash = createHash('sha256'), states = new Set();
  for (let i = 0; i < ticks; i++) {
    const tick = game.tick + 1;
    for (const [k, { p, target, sprint, from }] of plan.entries()) {
      const dx = target.x - p.state.x, dz = target.z - p.state.z, d = Math.hypot(dx, dz);
      const input = { ...neutralInput(Math.atan2(-dx, -dz), 0), seq: p.lastReceivedSequence + 1 };
      if (tick >= from && p.health > 0) {
        if (Math.floor((tick + k * 97) / 300) % 2 === 1 && d < 6) input.forward = -1;
        else if (d > 3) { input.forward = 1; input.sprint = sprint; }
        else input.strafe = k % 2 ? -1 : 1;
      }
      game.receiveInput(p.id, 'BONES', [input], tick * 1000 / 60);
    }
    if (tick === 200) hunt.impact(B, { region: chest, point: { x: 0.55, y: 0.92, z: -0.29 }, normal: { x: 1, y: 0, z: 0 },
      directness: 1, worldPoint: { x: B.x, y: 0.92, z: B.z }, t: 0.3 }, 24, 'throw', 'c', tick, null);
    game.step(tick * 1000 / 60);
    const row = [tick];
    for (const a of hunt.animals) {
      states.add(a.state);
      row.push(a.state, a.stateTick, +a.x.toFixed(6), +a.z.toFixed(6), +a.yaw.toFixed(6), +(a.pressure ?? 0).toFixed(6), a.targetId ?? null, +a.health.toFixed(6));
    }
    for (const p of hunters) row.push(+p.health.toFixed(6));
    hash.update(JSON.stringify(row));
  }
  return { digest: hash.digest('hex'), states: [...states].sort() };
}
