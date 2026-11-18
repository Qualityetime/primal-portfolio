import { TICK_RATE } from '../shared/config.js';
import { BOAR_AI } from './boarTuning.js';

const clamp = n => Math.max(0, Math.min(1, n));
const fleeing = state => ['flee', 'breakaway', 'reposition'].includes(state);

// This memory records observations, not live hunter coordinates. It is separate
// from the short threat table so disengagement ends targeting without erasing
// the experience of pursuit. Only active room hunters are retained.
export function updateHuntMemory(a, tick, players, dt) {
  const sensed = new Map(a.awareHunters.map(p => [p.id, p]));
  for (const [id, memory] of a.huntMemory) {
    if (!players.has(id)) { a.huntMemory.delete(id); continue; }
    if (!sensed.has(id) && tick - memory.lastSeen > BOAR_AI.huntGraceSeconds * TICK_RATE) {
      memory.awareness *= Math.exp(-Math.LN2 * dt / BOAR_AI.huntHalfLifeSeconds);
      if (memory.awareness < 0.005) a.huntMemory.delete(id);
    }
  }
  for (const p of a.awareHunters) {
    const old = a.huntMemory.get(p.id);
    const m = old ?? { awareness: 0, lastSeen: tick, reapproaches: 0, pursuitSeconds: 0, cutoffs: 0, wounds: 0 };
    if (old && tick - m.lastSeen > TICK_RATE && m.awareness > 0.03) {
      m.reapproaches++; m.reappeared = tick; m.awareness = clamp(m.awareness + BOAR_AI.huntReapproachGain);
    }
    const chasing = fleeing(a.state) && p.closing > 0.6 && p.distance < BOAR_AI.sightRange;
    const cuttingOff = fleeing(a.state) && p.distance < 4 && blocksDirection(a, p, a.tacticGoal);
    let gain = p.distance < 6 ? BOAR_AI.huntCloseGain : 0;
    if (chasing) { gain += BOAR_AI.huntChaseGain; m.pursuitSeconds += dt; }
    if (a.surrounded) gain += BOAR_AI.huntSurroundGain;
    if (cuttingOff) { gain += BOAR_AI.huntCutoffGain; m.cutoffs += dt; }
    // Distant, peaceful watching is not evidence of a never-ending hunt.
    m.awareness = clamp(m.awareness + gain * dt - (gain === 0 ? 0.008 * dt : 0));
    m.lastSeen = tick; a.huntMemory.set(p.id, m);
  }
  if (tick - (a.lastTraumaTick ?? -10000) > BOAR_AI.huntGraceSeconds * TICK_RATE) {
    a.huntAlarm *= Math.exp(-Math.LN2 * dt / BOAR_AI.huntHalfLifeSeconds);
    if (a.huntAlarm < 0.005) a.huntAlarm = 0;
  }
  a.huntAwareness = Math.max(a.huntAlarm, ...[...a.huntMemory.values()].map(m => m.awareness));
}

export function rememberTrauma(a, reaction, tick) {
  a.lastTraumaTick = tick;
  a.huntAlarm = clamp(a.huntAlarm + BOAR_AI.huntTraumaGain + reaction.severity * 0.12);
  // Ownership is authoritative combat bookkeeping. Attribution in the brain
  // still requires a sensed or recently recognized hunter, never a client ID.
  if (reaction.identifiedId) {
    const m = a.huntMemory.get(reaction.identifiedId) ?? { awareness: 0, lastSeen: tick, reapproaches: 0, pursuitSeconds: 0, cutoffs: 0, wounds: 0 };
    m.awareness = clamp(m.awareness + BOAR_AI.huntTraumaGain + reaction.severity * 0.12); m.wounds++;
    a.huntMemory.set(reaction.identifiedId, m);
  }
  a.huntAwareness = Math.max(a.huntAwareness, a.huntAlarm);
}

export function blocksDirection(a, p, goal) {
  if (!goal) return false;
  const dx = goal.x - a.x, dz = goal.z - a.z, length = Math.hypot(dx, dz);
  if (length < 0.1) return false;
  const along = ((p.x - a.x) * dx + (p.z - a.z) * dz) / length;
  const across = Math.abs((p.x - a.x) * dz - (p.z - a.z) * dx) / length;
  return along > 0.3 && along < Math.min(length + 0.6, 4) && across < 1.5;
}

export function updatePressure(a, tick, dt) {
  const near = a.awareHunters.filter(p => p.distance < BOAR_AI.pressureRange);
  const nearest = Math.min(Infinity, ...near.map(p => p.distance));
  a.closePressureSeconds = nearest < BOAR_AI.closeRange
    ? Math.min(3, a.closePressureSeconds + dt) : Math.max(0, a.closePressureSeconds - dt * 2);
  const parts = {
    proximity: clamp((BOAR_AI.pressureRange - nearest) / (BOAR_AI.pressureRange - 1.5)),
    closing: clamp(Math.max(0, ...near.map(p => p.closing)) / 5),
    hunters: clamp((near.length - 1) / 2),
    geometry: a.surrounded ? 1 : near.some(p => p.facing < -0.35) ? 0.65 : 0,
    blocked: near.length && (!a.escapeOpen || a.blocked > 3 || near.some(p => blocksDirection(a, p, a.tacticGoal))) ? 1 : 0,
    injury: near.length ? Math.max(a.limp, a.lung, 1 - a.blood) : 0,
    pursuit: a.awareHunters.length ? a.huntAwareness : 0,
    reapproach: a.awareHunters.some(p => tick - (a.huntMemory.get(p.id)?.reappeared ?? -10000) < TICK_RATE * 1.5) ? 1 : 0,
    sustained: clamp(a.closePressureSeconds / 1.5),
    trauma: clamp(1 - (tick - (a.lastTraumaTick ?? -10000)) / (BOAR_AI.traumaContextSeconds * TICK_RATE)),
  };
  const total = Object.entries(parts).reduce((sum, [key, value]) => sum + value * BOAR_AI.pressureWeights[key], 0);
  a.pressure = clamp(Math.max(total, nearest < BOAR_AI.closeRange ? BOAR_AI.highPressure : 0,
    a.surrounded ? BOAR_AI.surroundPressure : 0));
  a.pressureParts = parts;
  a.decisionSeconds = decisionSeconds(a);
}

export function decisionSeconds(a) {
  return BOAR_AI.urgentDecisionSeconds + (BOAR_AI.calmDecisionSeconds + a.traits.persistence * 0.2 - BOAR_AI.urgentDecisionSeconds)
    * (1 - a.pressure) ** 2;
}

export function preferredSeparation(a) {
  return 5.5 + a.traits.caution * 3 + a.huntAwareness * BOAR_AI.huntSeparationExtra;
}
