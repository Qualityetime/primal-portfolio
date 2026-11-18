// Counts what happened during one hunt from the simulation's own event stream
// (HuntState.event). Used by the React results screen.
import { HUNT } from '../../shared/hunt.js';

export function createStats() {
  return {
    throws: 0, thrusts: 0, braces: 0, strongBraces: 0,
    hits: 0, glancing: 0, hitsByRegion: {},
    kills: 0, damageTaken: 0, timesHurt: 0, knockdowns: 0, respawns: 0,
    harvested: 0, cooked: 0, recovered: 0,
    firstBloodTick: null, firstKillTick: null, completeTick: null,
  };
}

export function applyEvent(stats, event, selfId) {
  const mine = event.player === selfId;
  switch (event.type) {
    case 'throw': if (mine) stats.throws++; break;
    case 'thrust': if (mine) stats.thrusts++; break;
    case 'braced': if (mine) { stats.braces++; if (event.strong) stats.strongBraces++; } break;
    case 'hit':
      if (!mine) break;
      stats.hits++;
      if (event.glancing) stats.glancing++;
      stats.hitsByRegion[event.region] = (stats.hitsByRegion[event.region] ?? 0) + 1;
      stats.firstBloodTick ??= event.tick;
      break;
    case 'kill': stats.kills++; stats.firstKillTick ??= event.tick; break;
    case 'hurt': if (mine) { stats.timesHurt++; stats.damageTaken += event.amount; if (event.knocked) stats.knockdowns++; } break;
    case 'respawn': if (mine) stats.respawns++; break;
    case 'harvest': if (mine) stats.harvested += event.amount; break;
    case 'cooked': if (mine) stats.cooked++; break;
    case 'recovered': if (mine) stats.recovered++; break;
    case 'complete': stats.completeTick ??= event.tick; break;
    default: break;
  }
  return stats;
}

const seconds = tick => (tick === null ? null : Math.round(tick / 6) / 10);

// Final summary, including each boar's fate read from the simulation.
export function summarise(stats, sim, outcome) {
  const attacks = stats.throws + stats.thrusts + stats.braces;
  const boars = sim.hunt.animals.map((a, i) => ({
    label: `Boar ${i + 1}`,
    fate: a.health <= 0 ? 'Killed' : a.wounds.length ? 'Escaped wounded' : 'Unharmed',
    wounds: a.wounds.length,
    regions: [...new Set(a.wounds.filter(w => !w.glancing).map(w => w.region))],
    blood: Math.round(a.blood * 100),
  }));
  return {
    outcome,
    duration: seconds(sim.tick),
    attacks,
    accuracy: attacks ? Math.round((stats.hits / attacks) * 100) : 0,
    ...stats,
    firstBlood: seconds(stats.firstBloodTick),
    firstKill: seconds(stats.firstKillTick),
    completedAt: seconds(stats.completeTick),
    mealGoal: HUNT.mealGoal,
    boars,
  };
}
