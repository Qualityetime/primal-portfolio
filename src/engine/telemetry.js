// Read-only telemetry from the live boar brains for the React telemetry panel.
// Everything here is sampled from the running simulation (HuntState.animals and
// its existing developer view, HuntState.animalDebug) — nothing is synthesised
// for display. Sampled at a few hertz, never per frame.
import { HUNT, flatDistance } from '../../shared/hunt.js';

// Behaviour states the Professor Boar brain actually uses, grouped for colour.
export const BEHAVIOUR = Object.freeze({
  patrol: { group: 'calm', label: 'Patrolling' },
  assess: { group: 'alert', label: 'Assessing threat' },
  orient: { group: 'alert', label: 'Orienting' },
  pivot: { group: 'alert', label: 'Pivoting' },
  warning: { group: 'alert', label: 'Warning display' },
  recover: { group: 'hurt', label: 'Recovering' },
  stagger: { group: 'hurt', label: 'Staggered' },
  charge: { group: 'aggressive', label: 'Charging' },
  bluff: { group: 'aggressive', label: 'Bluff charge' },
  gore: { group: 'aggressive', label: 'Goring' },
  sweep: { group: 'aggressive', label: 'Tusk sweep' },
  maul: { group: 'aggressive', label: 'Mauling' },
  kick: { group: 'aggressive', label: 'Rear kick' },
  flee: { group: 'evasive', label: 'Fleeing' },
  breakaway: { group: 'evasive', label: 'Breaking away' },
  reposition: { group: 'evasive', label: 'Repositioning' },
  dead: { group: 'dead', label: 'Down' },
});
export const behaviour = state => BEHAVIOUR[state] ?? { group: 'alert', label: state };

const r2 = value => Math.round((value ?? 0) * 100) / 100;
export const HISTORY_LENGTH = 72; // samples (≈ 14 s at 5 Hz)

export class TelemetrySampler {
  constructor() { this.history = new Map(); }
  reset() { this.history.clear(); }

  sample(sim, playerPosition) {
    const hunt = sim.hunt, tick = sim.tick;
    const animals = hunt.animals.map((a, index) => {
      const debug = hunt.animalDebug(a, tick);
      const sees = a.awareHunters.find(p => p.id === sim.player.id);
      const memory = a.threats.get(sim.player.id);
      const history = this.history.get(a.id) ?? { pressure: [], health: [], blood: [] };
      history.pressure.push(r2(a.pressure));
      history.health.push(r2(a.health / HUNT.boarHealth));
      history.blood.push(r2(a.blood));
      for (const series of Object.values(history)) if (series.length > HISTORY_LENGTH) series.shift();
      this.history.set(a.id, history);
      const wounds = a.wounds.map(w => ({ id: w.id, region: w.region, severity: r2(w.severity), glancing: !!w.glancing, bleed: w.bleed }));
      return {
        id: a.id,
        label: `Boar ${index + 1}`,
        alive: a.health > 0,
        state: a.state,
        behaviour: behaviour(a.state),
        reason: a.health > 0 ? debug.intent.reason : 'killed',
        intentSeconds: r2(debug.intent.commitmentSeconds),
        health: r2(a.health / HUNT.boarHealth),
        blood: r2(a.blood),
        limp: r2(a.limp),
        lung: r2(a.lung),
        breath: r2(a.breath),
        stress: r2(a.stress),
        pressure: r2(a.pressure),
        pressureParts: Object.fromEntries(Object.entries(a.pressureParts ?? {}).map(([k, v]) => [k, r2(v)])),
        decisionSeconds: r2(a.decisionSeconds),
        awareness: r2(a.huntAwareness),
        perceivesHunter: !!sees,
        suspicion: r2(sees?.suspicion ?? memory?.suspicion ?? 0),
        stage: sees?.stage ?? (memory && tick - memory.seen < 120 ? 'remembered' : 'unaware'),
        temperament: { courage: r2(a.traits.courage), caution: r2(a.traits.caution), persistence: r2(a.traits.persistence), bluff: r2(a.traits.bluff) },
        distance: Math.round(flatDistance(playerPosition, a) * 10) / 10,
        speed: r2(Math.hypot(a.vx, a.vz)),
        wounds,
        bleedRate: r2(a.wounds.reduce((s, w) => s + w.bleed, 0) * 100),
        embeddedSpears: hunt.spears.filter(s => s.status === 'embedded' && s.animalId === a.id).length,
        trace: a.intentTrace.slice(-6).reverse().map(t => ({ tick: t.tick, state: t.state, reason: t.reason, ago: r2((tick - t.tick) / 60) })),
        history: { pressure: [...history.pressure], health: [...history.health], blood: [...history.blood] },
      };
    });
    return { tick, seconds: Math.round(tick / 6) / 10, animals };
  }
}

// Positions for the tactical map (drawn imperatively on a canvas).
export function mapSample(sim, player) {
  const hunt = sim.hunt;
  return {
    player: { x: player.x, z: player.z, yaw: player.yaw },
    animals: hunt.animals.map(a => ({ id: a.id, x: a.x, z: a.z, yaw: a.yaw, alive: a.health > 0, group: behaviour(a.state).group,
      sees: a.awareHunters.some(p => p.id === sim.player.id) })),
    spears: hunt.spears.filter(s => s.status === 'ground').map(s => ({ x: s.x, z: s.z })),
    projectiles: hunt.projectiles.map(p => ({ x: p.x, z: p.z })),
    tracks: hunt.tracks.map(t => ({ x: t.x, z: t.z })),
  };
}
