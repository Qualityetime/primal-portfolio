// Pure function from a simulation snapshot (+ the locally predicted hunter) to
// the values the React HUD shows. Ported from the original DOM HUD
// (client/src/huntUI.js and ui.js), adapted for one hunter. Values are rounded
// so that unchanged readings compare equal and React does not re-render.
import { HUNT, flatDistance, interactionHint } from '../../shared/hunt.js';

const round = (value, step) => Math.round(value / step) * step;

export const OBJECTIVES = Object.freeze([
  { step: 'HUNT', title: 'Hunt a wild boar', note: 'Read the animal. Watch the ground.' },
  { step: 'HARVEST', title: 'Harvest the boar', note: 'Walk up to the carcass and press E.' },
  { step: 'COOK', title: 'Cook at the campfire', note: `Return to camp. Cook ${HUNT.mealGoal} pieces of meat (E).` },
  { step: 'DONE', title: 'First meal cooked', note: 'The hunt is complete.' },
]);

export function objectiveStage(snapshot, self) {
  const hunt = snapshot.hunt;
  if (hunt.complete) return 3;
  if (hunt.meals > 0 || self?.rawMeat > 0 || self?.cooking > 0) return 2;
  if (hunt.animals.some(a => !a.alive && a.meat > 0)) return 1;
  return 0;
}

export function objectiveNote(stage, snapshot) {
  const alive = snapshot.hunt.animals.filter(a => a.alive).length;
  if (stage === 1 && alive) return 'E · Harvest meat. Another boar is still alive.';
  if (stage === 3 && alive) return 'Keep watch. Another boar is still alive.';
  return OBJECTIVES[stage].note;
}

/**
 * @param snapshot   authoritative snapshot from LocalSimulation
 * @param selfId     the local hunter id
 * @param local      { position, yaw, state, sprinting } — predicted, smoothed local hunter
 * @param active     pointer locked and playing
 * @param now        performance.now() for transient effects
 * @param hurtUntil  performance.now() until which the damage flash shows
 */
export function hudModel(snapshot, selfId, { position, yaw, state, sprinting = false }, active, now = 0, hurtUntil = 0) {
  const self = snapshot?.players.find(p => p.id === selfId);
  if (!self || !snapshot.hunt) return null;
  const hunt = snapshot.hunt;
  const stage = objectiveStage(snapshot, self);
  const charge = active && state?.winding ? Math.min(1, (state.windupTime ?? 0) / HUNT.windupSeconds) : 0;
  const bearing = Math.atan2(-(HUNT.camp.x - position.x), -(HUNT.camp.z - position.z));
  const turn = Math.atan2(Math.sin(bearing - yaw), Math.cos(bearing - yaw));
  const status = self.bracing ? 'BRACING' : self.winding ? 'DRAWN' : self.recovering ? 'PULLING FREE' : self.bleeding ? 'BLEEDING' : '';
  return {
    health: self.health,
    stamina: Math.round(self.stamina),
    spears: self.spears,
    spearCapacity: HUNT.spearCapacity,
    spearReady: round(self.spearReady, 0.05),
    spearStatus: status,
    bleeding: !!self.bleeding,
    rawMeat: self.rawMeat,
    cookedMeat: self.cookedMeat,
    cooking: self.cooking > 0 ? round(1 - self.cooking, 0.02) : 0,
    charge: round(charge, 0.02),
    round: hunt.round,
    stage,
    objective: OBJECTIVES[stage].title,
    note: objectiveNote(stage, snapshot),
    meals: Math.min(hunt.meals, HUNT.mealGoal),
    mealGoal: HUNT.mealGoal,
    complete: hunt.complete,
    boarsAlive: hunt.animals.filter(a => a.alive).length,
    boarsTotal: hunt.animals.length,
    hint: active ? interactionHint({ ...self, ...position }, hunt) : '',
    campDistance: Math.round(flatDistance(position, HUNT.camp)),
    campTurn: round(turn, 0.02),
    movement: !state?.grounded ? 'AIRBORNE' : sprinting ? 'SPRINTING' : 'ON FOOT',
    down: self.health <= 0 ? 'down' : self.knockTicks > 0 ? 'knocked' : null,
    lowHealth: active && self.health > 0 && self.health <= 25,
    hurt: active && now < hurtUntil,
  };
}
