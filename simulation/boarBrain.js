import { FIXED_DT, TICK_RATE } from '../shared/config.js';
import { HUNT, flatDistance } from '../shared/hunt.js';
import { bodyContact } from '../shared/body.js';
import { BOAR_AI } from './boarTuning.js';
import { updateHuntMemory, rememberTrauma, updatePressure, preferredSeparation, blocksDirection } from './boarContext.js';

const ticks = seconds => Math.ceil(seconds * TICK_RATE);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const angleTo = (a, b) => Math.atan2(-(b.x - a.x), -(b.z - a.z));
const deltaAngle = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function temperament(seed) {
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  return { courage: 0.25 + random() * 0.65, caution: 0.25 + random() * 0.65,
    persistence: 0.3 + random() * 0.6, recovery: 0.35 + random() * 0.5, bluff: random() };
}

function visible(world, a, b, padding = 0.04) {
  const dx = b.x - a.x, dz = b.z - a.z, length = dx * dx + dz * dz;
  for (const o of world.obstacles) {
    const t = clamp(((o.x - a.x) * dx + (o.z - a.z) * dz) / (length || 1), 0, 1);
    if (Math.hypot(a.x + dx * t - o.x, a.z + dz * t - o.z) < o.radius + padding) return false;
  }
  return true;
}

function perceive(hunt, tick, players) {
  const a = hunt.animal;
  const near = [];
  const dt = Math.max(0, tick - (a.lastPerception ?? tick - 1)) / TICK_RATE;
  a.awareHunters = [];
  let best = null, bestScore = -1;
  for (const p of players.values()) {
    if (p.health <= 0 || flatDistance(p.state, HUNT.camp) <= HUNT.campSafeRange) continue;
    const distance = flatDistance(p.state, a), facing = Math.cos(deltaAngle(a.yaw, angleTo(a, p.state)));
    const noisy = Math.hypot(p.velocityX ?? 0, p.velocityZ ?? 0) > 5;
    const memory = a.threats.get(p.id) ?? { damage: 0, seen: -10000, x: p.state.x, z: p.state.z };
    // Close peripheral awareness and recently observed movement are independent
    // of body yaw. Trees still hide hunters; only the body has a turning limit.
    const moving = Math.hypot(p.velocityX ?? 0, p.velocityZ ?? 0) > 1;
    const sensed = distance < (noisy || (moving && facing > 0) ? BOAR_AI.disturbanceRange : BOAR_AI.sightRange)
      && visible(hunt.world, a, p.state)
      && (distance < BOAR_AI.peripheralRange || facing > -0.35 || noisy || tick - memory.seen < ticks(2));
    if (sensed) { memory.seen = tick; memory.x = p.state.x; memory.z = p.state.z; }
    memory.damage *= Math.exp(-0.14 * dt);
    a.threats.set(p.id, memory);
    if (tick - memory.seen > ticks(5 + a.traits.persistence * 7)) continue;
    // A remembered hunter is assessed at the last sensed position, not tracked
    // magically through cover. Recently wounded threat remains a strong influence.
    const position = sensed ? p.state : memory;
    const knownDistance = flatDistance(position, a);
    const aim = Math.cos(deltaAngle(p.state.yaw, angleTo(p.state, a)));
    const closing = -((p.state.x - a.x) * (p.velocityX ?? 0) + (p.state.z - a.z) * (p.velocityZ ?? 0)) / (distance || 1);
    const interest = distance < 14 ? 0.22 : 0.08;
    memory.suspicion = clamp((memory.suspicion ?? 0) + (sensed ? interest + Math.max(0, closing) * 0.15
      + (aim > 0.75 && p.spears ? 0.12 : 0) : -0.18) * dt, 0, 1);
    const stage = distance >= BOAR_AI.sightRange ? 'disturbance' : distance < BOAR_AI.closeRange ? 'close' : distance < 10 ? 'pressure'
      : memory.suspicion > 0.35 || (sensed && closing > 0.6 && aim > 0.5) ? 'suspicious'
        : distance < BOAR_AI.sightRange ? 'aware' : 'disturbance';
    const score = 14 / (knownDistance + 1.2) + memory.damage * 0.13 + (sensed && aim > 0.75 && p.spears ? 1.4 : 0)
      + (noisy && sensed ? 0.9 : 0) + (sensed && p.state.knockTicks > 0 && distance < 3 ? 2 : 0)
      + (sensed && distance < 3.5 ? 1.5 + clamp(closing, 0, 6) * 0.55 + (facing < -0.35 ? 0.8 : 0) : 0);
    memory.score = score;
    if (score > bestScore) { bestScore = score; best = { id: p.id, x: position.x, z: position.z, sensed, distance: knownDistance }; }
    if (sensed) a.awareHunters.push({ id: p.id, x: p.state.x, z: p.state.z, distance, facing, closing, aim, score, stage, suspicion: memory.suspicion });
    if (sensed && distance < 6) near.push(Math.atan2(p.state.z - a.z, p.state.x - a.x));
  }
  for (const id of a.threats.keys()) if (!players.has(id)) a.threats.delete(id);
  // Largest free arc is a route out of a ring of hunters, not a random flee vector.
  near.sort((x, y) => x - y);
  let gap = Math.PI * 2, escapeAngle = Math.atan2(a.z - HUNT.camp.z, a.x - HUNT.camp.x);
  if (near.length > 1) {
    gap = 0;
    for (let i = 0; i < near.length; i++) {
      const next = near[(i + 1) % near.length] + (i === near.length - 1 ? Math.PI * 2 : 0);
      const free = next - near[i];
      if (free > gap) { gap = free; escapeAngle = near[i] + free / 2; }
    }
  } else if (best) escapeAngle = Math.atan2(a.z - best.z, a.x - best.x);
  a.surrounded = near.length > 1 && gap < Math.PI * 1.25;
  const length = BOAR_AI.escapeDistance + a.huntAwareness * BOAR_AI.huntEscapeExtra;
  const angles = [0, 0.55, -0.55, 1.1, -1.1, Math.PI / 2, -Math.PI / 2, Math.PI].map(offset => escapeAngle + offset);
  const routes = angles.map(angle => ({ x: clamp(a.x + Math.cos(angle) * length, -hunt.world.halfSize + 2, hunt.world.halfSize - 2),
    z: clamp(a.z + Math.sin(angle) * length, -hunt.world.halfSize + 2, hunt.world.halfSize - 2) }));
  const open = routes.filter(point => routeOpen(hunt, point) && !a.awareHunters.some(p => blocksDirection(a, p, point)));
  // Longer-lived pursuit experience values routes that separate from remembered
  // pursuers. Live coordinates behind cover never participate in route choice.
  const routeScore = point => a.awareHunters.reduce((sum, p) => sum + flatDistance(point, p)
    * (1 + (a.huntMemory.get(p.id)?.awareness ?? 0)), 0) - Math.abs(deltaAngle(a.yaw, angleTo(a, point))) * 0.45;
  open.sort((x, y) => routeScore(y) - routeScore(x));
  a.escape = open[0] ?? routes.find(point => routeOpen(hunt, point)) ?? routes[0];
  a.escapeOpen = open.length > 0;
  if (best) {
    // Hysteresis keeps target switching deliberate while damage or a close flank
    // can pull attention immediately; it never remains locked on the first hunter.
    const current = a.threats.get(a.targetId), old = players.get(a.targetId);
    const currentScore = current?.score ?? -1;
    const valid = old?.health > 0 && current && tick - current.seen < ticks(5 + a.traits.persistence * 7)
      && flatDistance(old.state, HUNT.camp) > HUNT.campSafeRange;
    const executingClose = ['gore', 'sweep', 'kick', 'maul', 'pivot'].includes(a.state) && tick < a.commitUntil;
    const rushing = ['charge', 'bluff', 'breakaway'].includes(a.state) || executingClose;
    const urgent = !rushing && best.distance < 1.7 && (!current || flatDistance(current, a) > 3.5);
    const materialInjury = (a.threats.get(best.id)?.damage ?? 0) > (current?.damage ?? 0) + 18;
    const canSwitch = !rushing && tick >= (a.intentUntil ?? 0)
      && tick - a.targetChanged >= ticks(0.45) && bestScore > currentScore * 1.3;
    if ((!valid && !rushing) || best.id === a.targetId || (materialInjury && !rushing) || urgent || canSwitch) {
      if (best.id !== a.targetId) a.targetChanged = tick;
      a.targetId = best.id;
    }
    const chosen = a.threats.get(a.targetId);
    a.targetPosition = chosen ? { x: chosen.x, z: chosen.z } : best;
    a.lastThreat = tick;
  } else { a.targetId = null; a.targetPosition = null; }
  a.lastPerception = tick;
}

export function changeState(a, state, tick, seconds, reason = state) {
  a.previousIntent = { state: a.state, reason: a.intentReason, started: a.stateTick, ended: tick };
  a.state = state; a.stateTick = tick; a.until = tick + ticks(seconds);
  a.intentUntil = a.until; a.tacticGoal = null;
  // Deliberation stays fast. This separate deadline protects the physical part
  // of the selected action from fatigue/contact exits before it can execute.
  a.commitUntil = ['flee', 'reposition', 'breakaway', 'charge', 'bluff'].includes(state)
    ? tick + ticks(Math.min(seconds, BOAR_AI.moveCommitSeconds))
    : ['gore', 'sweep', 'kick', 'maul', 'pivot'].includes(state) ? a.until : tick;
  a.intentReason = reason; a.lastDecisionTick = tick;
  a.intentTrace ??= [];
  a.intentTrace.push({ tick, state, reason, target: a.targetId, until: a.until });
  if (a.intentTrace.length > BOAR_AI.traceLimit) a.intentTrace.shift();
}

function routeOpen(hunt, point) {
  const a = hunt.animal, dx = point.x - a.x, dz = point.z - a.z;
  const t = clamp(((HUNT.camp.x - a.x) * dx + (HUNT.camp.z - a.z) * dz) / (dx * dx + dz * dz || 1), 0, 1);
  return flatDistance({ x: a.x + dx * t, z: a.z + dz * t }, HUNT.camp) >= HUNT.campSafeRange - 0.05
    && flatDistance(a, point) > 1 && visible(hunt.world, a, point, 0.68);
}

function decision(a) {
  a.decisionSeed = (Math.imul(a.decisionSeed ?? 7, 1664525) + 1013904223) >>> 0;
  return a.decisionSeed / 4294967296;
}

function commitMove(a, state, tick, seconds, goal, reason = state) {
  changeState(a, state, tick, seconds, reason);
  a.tacticGoal = { x: goal.x, z: goal.z };
  a.blocked = 0; // previous-route collisions do not invalidate an untried route
  if (a.acute && tick < a.acute.commitUntil) a.acute.goal = { ...a.tacticGoal };
}

function chooseTarget(a, p, tick, position = p.state) {
  a.targetId = p.id; a.targetChanged = tick; a.targetPosition = { x: position.x, z: position.z };
  const memory = a.threats.get(p.id) ?? { damage: 0 };
  Object.assign(memory, { seen: tick, x: position.x, z: position.z }); a.threats.set(p.id, memory);
}

function startRush(a, tick, duration = 1.5, explosive = false, state = 'charge') {
  changeState(a, state, tick, duration); a.hitPlayers.clear(); a.rushSpeed = explosive ? 5 : 3.5;
  a.explosiveUntil = explosive ? tick + ticks(0.32) : 0; a.rushRetargeted = false;
}

function escape(hunt, tick, explosive = false) {
  const a = hunt.animal;
  commitMove(a, 'flee', tick, 2 + a.traits.persistence * 0.9 + a.huntAwareness * 0.6, a.escape, 'create separation through open space');
  a.explosiveUntil = explosive ? tick + ticks(0.32) : 0;
}

function breakAway(hunt, tick, goal = null) {
  const a = hunt.animal, side = decision(a) < 0.5 ? -1 : 1;
  const destination = goal ?? { x: a.x - Math.sin(a.yaw) * 4.3 + Math.cos(a.yaw) * side * 1.8,
    z: a.z - Math.cos(a.yaw) * 4.3 - Math.sin(a.yaw) * side * 1.8 };
  commitMove(a, 'breakaway', tick, BOAR_AI.moveCommitSeconds, destination, 'break positional pressure');
  a.explosiveUntil = tick + ticks(0.32); a.hitPlayers.clear(); a.lastBreakaway = tick; a.rearPressure = 0;
}

function rearResponse(hunt, p, tick) {
  const a = hunt.animal, roll = decision(a);
  a.lastBreakaway = tick; a.rearPressure = 0;
  chooseTarget(a, p, tick);
  if (a.traits.courage > 0.6 && roll < 0.42) {
    changeState(a, 'pivot', tick, 0.65);
    a.pivotSide = deltaAngle(a.yaw, angleTo(a, p.state)) < 0 ? -1 : 1;
    a.pivotRight = { x: Math.cos(a.yaw), z: -Math.sin(a.yaw) };
  } else if (a.traits.caution > a.traits.courage && a.escapeOpen && roll > 0.5) escape(hunt, tick, true);
  else if (roll > 0.72 && a.escapeOpen) commitMove(a, 'reposition', tick, 0.85, a.escape);
  else breakAway(hunt, tick);
}

function desperate(hunt, p, tick) {
  const a = hunt.animal;
  a.lastDesperate = tick; chooseTarget(a, p, tick);
  if (flatDistance(a, p.state) < 2.55 && Math.cos(deltaAngle(a.yaw, angleTo(a, p.state))) > 0.25) startClose(a, p, tick, true);
  else breakAway(hunt, tick);
}

function orientRush(a, p, tick, position = p.state, duration = 0.95) {
  chooseTarget(a, p, tick, position);
  changeState(a, 'orient', tick, 0.7); a.nextRushDuration = duration; a.nextRushState = 'charge'; a.nextRushExplosive = true;
}

function acuteResponse(hunt, reaction, tick, players, badlyHurt) {
  const a = hunt.animal, nearest = a.awareHunters.reduce((best, p) => !best || p.distance < best.distance ? p : best, null);
  const thrower = players.get(reaction.owner);
  const observed = a.awareHunters.find(p => p.id === reaction.owner);
  const eligible = thrower?.health > 0 && !!observed;
  if (reaction.kind === 'pull' && thrower?.health > 0 && flatDistance(thrower.state, HUNT.camp) > HUNT.campSafeRange
    && flatDistance(a, thrower.state) < 2.8) {
    chooseTarget(a, thrower, tick);
    if (badlyHurt) desperate(hunt, thrower, tick);
    else if (Math.cos(deltaAngle(a.yaw, angleTo(a, thrower.state))) < -0.35 && a.rearPressure > 0.4) rearResponse(hunt, thrower, tick);
    else startClose(a, thrower, tick, true);
    return;
  }
  // Pain supplies a side/direction, not magical knowledge of a projectile's
  // owner or launch position. Start moving before any attacker identification.
  const source = reaction.sourceDirection ?? { x: Math.sin(a.yaw), z: Math.cos(a.yaw) };
  const away = Math.atan2(-source.z, -source.x);
  const goals = [0, 0.65, -0.65, 1.2, -1.2].map(offset => ({
    x: clamp(a.x + Math.cos(away + offset) * 5, -hunt.world.halfSize + 2, hunt.world.halfSize - 2),
    z: clamp(a.z + Math.sin(away + offset) * 5, -hunt.world.halfSize + 2, hunt.world.halfSize - 2),
  }));
  const painGoal = goals.find(goal => routeOpen(hunt, goal) && !a.awareHunters.some(p => blocksDirection(a, p, goal)))
    ?? (a.escapeOpen ? a.escape : goals.find(goal => routeOpen(hunt, goal))) ?? a.escape;
  const openPainRoute = routeOpen(hunt, painGoal) && !a.awareHunters.some(p => blocksDirection(a, p, painGoal));
  const blocker = a.awareHunters.find(p => p.distance < 3.4 && blocksDirection(a, p, painGoal));
  const roll = decision(a);
  // A serious lodged throw first resolves the pain physically, including when
  // its owner is already visible. Identification/retaliation follows the burst.
  const movementFirst = reaction.kind === 'throw' && openPainRoute && !(badlyHurt && nearest?.distance < 3.3);
  if (movementFirst) {
    if (a.traits.caution > a.traits.courage || badlyHurt) {
      commitMove(a, 'flee', tick, 2 + a.traits.persistence * 0.9, painGoal, 'lodged trauma: create separation first');
    } else breakAway(hunt, tick, painGoal);
    a.explosiveUntil = tick + ticks(BOAR_AI.traumaBurstSeconds);
  } else if (badlyHurt && nearest?.distance < 3.3 && tick - a.lastDesperate > ticks(0.8)) {
    desperate(hunt, players.get(nearest.id), tick);
  } else if (blocker && (badlyHurt || a.traits.courage > 0.45)) {
    const p = players.get(blocker.id);
    if (blocker.distance < 2.55) { chooseTarget(a, p, tick); startClose(a, p, tick, true); }
    else orientRush(a, p, tick, p.state, 0.65);
  } else if (eligible && !badlyHurt && roll < (a.traits.courage > 0.65 ? 0.82 : 0.55)
    && a.traits.courage + a.stress * 0.25 > a.traits.caution) {
    if (observed.distance < 2.55) { chooseTarget(a, thrower, tick); startClose(a, thrower, tick, true); }
    else orientRush(a, thrower, tick, observed, 0.85 + a.traits.persistence * 0.35);
  } else if (!eligible || (a.escapeOpen && (badlyHurt || a.traits.caution > 0.55 || roll > 0.75))) {
    if (a.traits.caution > a.traits.courage || badlyHurt) {
      commitMove(a, 'flee', tick, 2 + a.traits.persistence * 0.9, painGoal, 'acute pain: escape before identification');
    } else breakAway(hunt, tick, painGoal);
    a.explosiveUntil = tick + ticks(BOAR_AI.traumaBurstSeconds);
  }
  else if (nearest?.distance < 2.55) { const p = players.get(nearest.id); chooseTarget(a, p, tick); startClose(a, p, tick, true); }
  else if (eligible && roll < 0.75) orientRush(a, thrower, tick, observed, 0.8);
  else breakAway(hunt, tick, painGoal);
  a.acute = { ...reaction, started: tick, until: tick + ticks(BOAR_AI.traumaContextSeconds),
    burstUntil: tick + ticks(BOAR_AI.traumaBurstSeconds), identifiedId: eligible ? thrower.id : null,
    commitUntil: tick + ticks(BOAR_AI.traumaCommitSeconds), movementFirst,
    goal: { ...painGoal }, speed: 1.8, followup: false };
  if (['flee', 'breakaway', 'reposition'].includes(a.state)) a.commitUntil = Math.max(a.commitUntil, a.acute.commitUntil);
  a.intentReason = `acute ${reaction.kind}: ${a.state}`;
  a.intentTrace.at(-1).reason = a.intentReason;
  if (!reaction.remembered) rememberTrauma(a, a.acute, tick);
}

function bodyCapacity(a) {
  return clamp(1 - a.limp * 0.55 - a.lung * 0.22 - (1 - a.blood) * 0.3, 0.18, 1);
}

function acuteMovement(hunt, tick) {
  const a = hunt.animal, acute = a.acute;
  if (!acute || tick >= acute.burstUntil || a.state === 'stagger') return;
  const dx = acute.goal.x - a.x, dz = acute.goal.z - a.z, length = Math.hypot(dx, dz);
  if (length < 0.15) return;
  acute.speed = Math.min(BOAR_AI.traumaSpeed, acute.speed + BOAR_AI.traumaAcceleration * FIXED_DT);
  const speed = acute.speed * bodyCapacity(a);
  // A short recoil/side-hop, not a teleport or indefinite sideways sprint. Body
  // yaw still follows its bounded physical turn; wounds still limit the effort.
  hunt.moveAnimal(dx / length * speed * FIXED_DT, dz / length * speed * FIXED_DT);
  a.traumaMoveTick = tick;
  a.breath = Math.max(0, a.breath - FIXED_DT * (0.45 + a.lung * 0.25));
}

function steer(hunt, target, speed, turnRate = 3.5) {
  const a = hunt.animal;
  let dx = target.x - a.x, dz = target.z - a.z, length = Math.hypot(dx, dz) || 1;
  dx /= length; dz /= length;
  if (a.state !== 'charge' && a.state !== 'bluff') {
    for (const o of hunt.world.obstacles) {
      const ox = a.x + dx * 1.5 - o.x, oz = a.z + dz * 1.5 - o.z, d = Math.hypot(ox, oz);
      if (d < o.radius + 1.6) { const force = (o.radius + 1.6 - d) * 1.3; dx += ox / (d || 1) * force; dz += oz / (d || 1) * force; }
    }
    const cx = a.x + dx * 1.5 - HUNT.camp.x, cz = a.z + dz * 1.5 - HUNT.camp.z, cd = Math.hypot(cx, cz);
    if (cd < HUNT.campSafeRange + 1.6) { dx += cx / (cd || 1) * 2; dz += cz / (cd || 1) * 2; }
    const edge = hunt.world.halfSize - 3;
    if (Math.abs(a.x) > edge) dx -= Math.sign(a.x) * 2;
    if (Math.abs(a.z) > edge) dz -= Math.sign(a.z) * 2;
  }
  const desired = Math.atan2(-dx, -dz);
  const turning = turnRate * (1 - a.limp * 0.25);
  a.yaw += clamp(deltaAngle(a.yaw, desired), -turning * FIXED_DT, turning * FIXED_DT);
  if (a.traumaMoveTick === a.simTick) return; // the recoil already spent this tick's movement
  const burst = a.simTick < (a.explosiveUntil ?? 0) ? 1.12 : 1;
  const locomotion = Math.min(1, bodyCapacity(a) * burst);
  const gait = a.limp > 0.1 ? 1 - a.limp * 0.2 * (0.5 + Math.sin(a.simTick * 0.27) * 0.5) : 1;
  const turnEffort = ['flee', 'reposition'].includes(a.state) ? Math.max(0.2, Math.cos(deltaAngle(a.yaw, desired))) : 1;
  hunt.moveAnimal(-Math.sin(a.yaw) * speed * locomotion * gait * turnEffort * FIXED_DT, -Math.cos(a.yaw) * speed * locomotion * gait * turnEffort * FIXED_DT);
}

function startClose(a, target, tick, urgent = false) {
  const relative = Math.cos(deltaAngle(a.yaw, angleTo(a, target.state)));
  const state = target.state.knockTicks > 0 && relative > 0.4 ? 'maul' : relative < -0.35 ? 'kick' : relative < 0.55 ? 'sweep' : 'gore';
  changeState(a, state, tick, urgent ? 0.42 : state === 'kick' ? 0.48 : 0.63);
  a.attackAt = tick + ticks(urgent ? 0.17 : state === 'kick' ? 0.22 : state === 'maul' ? 0.28 : 0.34);
  a.attackDone = false; a.hitPlayers.clear();
}

function assessMotion(hunt, position, distance) {
  if (!position) return;
  const a = hunt.animal;
  a.yaw += clamp(deltaAngle(a.yaw, angleTo(a, position)), -2.8 * FIXED_DT * (1 - a.limp * 0.3), 2.8 * FIXED_DT * (1 - a.limp * 0.3));
  const back = distance < preferredSeparation(a) ? 0.85 * bodyCapacity(a) : 0;
  const lateral = distance < 14 ? 0.55 * bodyCapacity(a) : 0;
  if (back || lateral) hunt.moveAnimal((Math.cos(a.yaw) * lateral + Math.sin(a.yaw) * back) * FIXED_DT,
    (-Math.sin(a.yaw) * lateral + Math.cos(a.yaw) * back) * FIXED_DT);
}

const warningSeconds = (a, base) => Math.max(BOAR_AI.warningMinSeconds, base * (1 - a.pressure * 0.8));

export function stepBoar(hunt, tick, players) {
  const a = hunt.animal;
  if (a.health <= 0) return;
  a.simTick = tick;
  if (tick % 3 === 0 || !a.targetPosition || a.acuteReaction) perceive(hunt, tick, players);
  let target = players.get(a.targetId), position = a.targetPosition;
  let distance = position ? flatDistance(a, position) : Infinity;
  let close = target && target.health > 0 && flatDistance(target.state, HUNT.camp) > HUNT.campSafeRange
    && flatDistance(a, target.state) < 2.55 && visible(hunt.world, a, target.state);
  const threatened = distance < BOAR_AI.disturbanceRange;
  const badlyHurt = a.blood < 0.63 || a.lung > 0.55 || a.limp > 0.7 || a.health < HUNT.boarHealth * 0.32;
  const nearest = a.awareHunters.filter(p => players.get(p.id)?.health > 0)
    .reduce((best, p) => !best || p.distance < best.distance ? p : best, null);
  const nearPlayer = nearest ? players.get(nearest.id) : null;
  const immediate = a.awareHunters.filter(p => players.get(p.id)?.health > 0
    && flatDistance(players.get(p.id).state, HUNT.camp) > HUNT.campSafeRange
    && flatDistance(a, players.get(p.id).state) < BOAR_AI.immediateMeleeRange
    && visible(hunt.world, a, players.get(p.id).state))
    .reduce((best, p) => !best || p.distance < best.distance ? p : best, null);
  a.immediateMelee = !!immediate; a.immediateHunter = immediate?.id ?? null;
  const rear = a.awareHunters.filter(p => p.distance < 4 && p.facing < -0.35 && players.get(p.id)?.health > 0)
    .reduce((best, p) => !best || p.distance < best.distance ? p : best, null);
  a.rearPressure = rear ? (a.rearPressure ?? 0) + FIXED_DT : Math.max(0, (a.rearPressure ?? 0) - FIXED_DT * 2);
  updateHuntMemory(a, tick, players, FIXED_DT);
  updatePressure(a, tick, FIXED_DT);
  // Shorten deliberation when pressure rises, never the travel commitment of a
  // chosen maneuver. Small score fluctuations cannot flicker an executing plan.
  if (['assess', 'warning'].includes(a.state) && a.pressure >= BOAR_AI.mediumPressure) {
    const latency = a.state === 'warning' ? warningSeconds(a, 0.6) : a.decisionSeconds;
    a.until = Math.min(a.until, a.stateTick + ticks(latency)); a.intentUntil = a.until;
  }
  const ready = tick >= a.until || (nearest?.distance < 2.1 && nearest.closing > 1);
  a.breath = clamp(a.breath + (['charge', 'flee', 'bluff', 'breakaway'].includes(a.state) ? -0.24 * (1 + a.lung)
    - (tick < (a.explosiveUntil ?? 0) ? 0.3 : 0) : 0.19 * (1 - a.lung * 0.7)) * FIXED_DT, 0, 1);

  // A serious new wound changes the current plan. A physical stagger finishes
  // first; ordinary warning/recovery/escape intent can be interrupted by trauma.
  if (a.acuteReaction && a.state !== 'stagger') {
    const reaction = a.acuteReaction; a.acuteReaction = null;
    if (tick - reaction.tick <= ticks(1.4)) {
      acuteResponse(hunt, reaction, tick, players, badlyHurt);
      updatePressure(a, tick, 0);
      target = players.get(a.targetId); position = a.targetPosition;
      distance = position ? flatDistance(a, position) : Infinity;
      close = target?.health > 0 && flatDistance(a, target.state) < 2.55 && visible(hunt.world, a, target.state);
    }
  }
  if (a.acute && tick >= a.acute.until) a.acute = null;
  if (a.acute && !a.acute.identifiedId && tick - a.acute.started >= ticks(BOAR_AI.traumaIdentifySeconds)) {
    const recognized = a.awareHunters.find(p => p.id === a.acute.owner);
    if (recognized) a.acute.identifiedId = recognized.id;
  }
  if (a.acute && tick >= a.acute.commitUntil && !a.acute.followup && !badlyHurt
    && a.traits.courage > 0.65 && a.traits.courage > a.traits.caution && ['flee', 'breakaway'].includes(a.state)) {
    const recognized = a.awareHunters.find(p => p.id === a.acute.identifiedId);
    // Knowing the attacker does not cancel the initial physical response.
    // Once that response has happened, bold individuals can return to fight.
    if (recognized) {
      a.acute.followup = true; orientRush(a, players.get(recognized.id), tick, recognized, 0.85);
      target = players.get(a.targetId); position = a.targetPosition;
      close = flatDistance(a, players.get(recognized.id).state) < BOAR_AI.immediateMeleeRange;
    }
  }
  acuteMovement(hunt, tick);

  if (['gore', 'sweep', 'kick', 'maul'].includes(a.state)) {
    if (position && a.state !== 'kick') a.yaw += clamp(deltaAngle(a.yaw, angleTo(a, position)), -0.035, 0.035);
    if (!a.attackDone && tick >= a.attackAt) {
      a.attackDone = true;
      for (const p of players.values()) {
        // Height above this boar's own ground (terrain-relative; 0 on the flat floor).
        if (p.health <= 0 || flatDistance(p.state, HUNT.camp) <= HUNT.campSafeRange || p.state.y - (a.y ?? 0) > 1.05) continue;
        const d = flatDistance(a, p.state), facing = Math.cos(deltaAngle(a.yaw, angleTo(a, p.state)));
        const inArc = a.state === 'kick' ? facing < -0.25 : a.state === 'sweep' ? facing > -0.35 : facing > 0.25;
        if (d < (a.state === 'sweep' ? 2.3 : 2.45) && inArc && visible(hunt.world, a, p.state)) {
          hunt.hurt(p, a.state === 'maul' ? 19 : a.state === 'kick' ? 18 : 24, tick, a.state, a.state !== 'kick');
        }
      }
    }
    if (tick >= a.until) changeState(a, 'recover', tick, (0.23 + a.traits.recovery * 0.35) * (1 - a.pressure * 0.4));
    return;
  }
  if (a.state === 'stagger') { if (tick >= a.until) changeState(a, 'recover', tick, 0.22); return; }
  if (a.state === 'recover') {
    if (position && tick < a.until) {
      a.tacticGoal ??= { x: a.x + (a.x - position.x), z: a.z + (a.z - position.z) };
      steer(hunt, a.tacticGoal, 1.1, 3.8);
    }
    if (tick >= a.until) changeState(a, 'assess', tick, 0.12);
    return;
  }
  if (a.state === 'pivot') {
    if (position) {
      const error = deltaAngle(a.yaw, angleTo(a, position));
      const sign = tick - a.stateTick < ticks(0.25) ? a.pivotSide : Math.sign(error);
      a.yaw += Math.min(Math.abs(error), 5.2 * (1 - a.limp * 0.35) * FIXED_DT) * sign;
      if (a.traumaMoveTick !== tick) hunt.moveAnimal(a.pivotRight.x * a.pivotSide * 0.8 * (1 - a.limp * 0.5) * FIXED_DT, a.pivotRight.z * a.pivotSide * 0.8 * (1 - a.limp * 0.5) * FIXED_DT);
    }
    if (tick >= a.until) changeState(a, 'assess', tick, 0.15);
    return;
  }
  // Target utility chooses attention at range. Immediate contact arbitration
  // must use the sensed close hunter, even when another hunter's damage score
  // dominates. Executing attacks, rushes and maneuvers keep their own exits.
  if (immediate && ['patrol', 'assess', 'warning', 'orient'].includes(a.state)) {
    const p = players.get(immediate.id);
    if (immediate.facing < -0.35 && a.rearPressure > BOAR_AI.rearPressureSeconds && tick - a.lastBreakaway > ticks(1.2)) {
      rearResponse(hunt, p, tick); return;
    }
    chooseTarget(a, p, tick);
    if ((immediate.closing > 0.8 || a.closePressureSeconds > 0.35 || a.breath < 0.2)
      && a.traits.caution > a.traits.courage && a.escapeOpen) {
      escape(hunt, tick, true); a.intentReason = 'immediate melee: break contact';
    } else {
      startClose(a, p, tick, true); a.intentReason = 'immediate melee: resolve contact';
    }
    a.intentTrace.at(-1).reason = a.intentReason;
    return;
  }
  if (a.state === 'orient') {
    if (position) a.yaw += clamp(deltaAngle(a.yaw, angleTo(a, position)), -5.4 * FIXED_DT * (1 - a.limp * 0.35), 5.4 * FIXED_DT * (1 - a.limp * 0.35));
    if (close && tick - a.stateTick > ticks(0.12)) { startClose(a, target, tick, true); return; }
    const aligned = position && Math.abs(deltaAngle(a.yaw, angleTo(a, position))) < 0.35;
    if ((aligned && tick - a.stateTick >= ticks(0.1)) || tick >= a.until) {
      if (!position) escape(hunt, tick);
      else startRush(a, tick, a.nextRushDuration, a.nextRushExplosive, a.nextRushState);
    }
    return;
  }
  if (a.state === 'warning') {
    if (position) a.yaw += clamp(deltaAngle(a.yaw, angleTo(a, position)), -0.038, 0.038);
    if (rear && a.rearPressure > BOAR_AI.rearPressureSeconds && tick - a.lastBreakaway > ticks(1.2)) { rearResponse(hunt, players.get(rear.id), tick); return; }
    if (close && tick - a.stateTick > ticks(0.22)) { startClose(a, target, tick); return; }
    if (!threatened || (distance > a.warningDistance + 1.5 && a.traits.courage < 0.65)) { commitMove(a, 'reposition', tick, 1.1, a.escape); return; }
    if (tick >= a.until) {
      const bluff = a.traits.bluff > 0.45 && a.stress < 0.45 && a.blood > 0.85 && !a.surrounded;
      if (position && Math.abs(deltaAngle(a.yaw, angleTo(a, position))) > 0.5) {
        changeState(a, 'orient', tick, 0.65); a.nextRushDuration = bluff ? 0.45 : 1.5;
        a.nextRushState = bluff ? 'bluff' : 'charge'; a.nextRushExplosive = false;
      } else startRush(a, tick, bluff ? 0.45 : 1.5, false, bluff ? 'bluff' : 'charge');
    }
    return;
  }
  if (a.state === 'charge' || a.state === 'bluff') {
    a.rushSpeed = Math.min(a.state === 'bluff' ? 6 : 9.6, (a.rushSpeed ?? 3.5) + 15 * FIXED_DT);
    let pursuit = position, pursued = target;
    const oldFacing = position ? Math.cos(deltaAngle(a.yaw, angleTo(a, position))) : -1;
    const opportunity = a.awareHunters.find(p => p.id !== a.targetId && p.distance < 4.5 && p.facing > 0.92 && players.get(p.id)?.health > 0);
    if (a.state === 'charge' && !a.rushRetargeted && opportunity && (!target || target.health <= 0 || oldFacing < 0.55)) {
      pursued = players.get(opportunity.id); chooseTarget(a, pursued, tick); pursuit = a.targetPosition; a.rushRetargeted = true;
    }
    const sensed = pursued && tick - (a.threats.get(pursued.id)?.seen ?? -1000) <= 3;
    const intercept = pursuit ? { x: pursuit.x + (sensed ? pursued?.velocityX ?? 0 : 0) * 0.16, z: pursuit.z + (sensed ? pursued?.velocityZ ?? 0 : 0) * 0.16 }
      : { x: a.x - Math.sin(a.yaw) * 4, z: a.z - Math.cos(a.yaw) * 4 };
    const age = (tick - a.stateTick) / TICK_RATE, range = pursuit ? flatDistance(a, pursuit) : Infinity;
    const turn = range < 3.3 || age > 1 ? 0.45 : age < 0.6 ? 1.9 : 1.25;
    steer(hunt, intercept, a.rushSpeed, a.state === 'bluff' ? 1.8 : turn * (1 - a.limp * 0.35));
    if (tick >= a.until || (a.breath < 0.15 && tick >= a.commitUntil && tick >= (a.explosiveUntil ?? 0)) || (pursuit && range > 15) || a.blocked > 8) changeState(a, 'recover', tick, 0.24 + a.traits.recovery * 0.42);
    return;
  }
  if (a.state === 'breakaway') {
    steer(hunt, a.tacticGoal ?? a.escape, 7.8, 4.4 * (1 - a.limp * 0.3));
    if (tick >= a.until || a.blocked > 6 || (a.breath < 0.08 && tick >= a.commitUntil && tick >= (a.explosiveUntil ?? 0))) changeState(a, 'recover', tick, 0.25);
    return;
  }
  if (a.state === 'flee' || a.state === 'reposition') {
    if (a.tacticGoal && flatDistance(a, a.tacticGoal) < 0.8) { changeState(a, 'assess', tick, a.decisionSeconds, 'gap reached: watch pursuers'); return; }
    if (tick - a.stateTick > ticks(0.12) && tick % 6 === 0 && (a.blocked > 6 || !routeOpen(hunt, a.tacticGoal ?? a.escape)
      || a.awareHunters.some(p => p.distance < 3.4 && blocksDirection(a, p, a.tacticGoal)))) {
      const blocker = a.awareHunters.find(p => p.distance < 2.55 && blocksDirection(a, p, a.tacticGoal));
      if (blocker) { chooseTarget(a, players.get(blocker.id), tick); startClose(a, players.get(blocker.id), tick, true); }
      else if (a.escapeOpen) commitMove(a, a.state, tick, Math.max(BOAR_AI.moveCommitSeconds, (a.until - tick) / TICK_RATE), a.escape, 'chosen route became blocked');
      else breakAway(hunt, tick);
      return;
    }
    if (badlyHurt && nearest?.distance < 3.2 && tick >= a.commitUntil && tick - a.lastDesperate > ticks(2)) {
      desperate(hunt, nearPlayer, tick); return;
    }
    if (close && tick >= a.commitUntil && bodyContact(target.state, a, 0.6)) { startClose(a, target, tick); return; }
    steer(hunt, a.tacticGoal ?? a.escape, a.state === 'flee' ? 6.8 : 4.2, 4.2);
    if (tick >= a.until || (a.breath < 0.12 && tick >= a.commitUntil && tick >= (a.explosiveUntil ?? 0))
      || (a.tacticGoal && flatDistance(a, a.tacticGoal) < 0.8)
      || (a.state === 'flee' && position && tick >= a.commitUntil && distance > 16 + a.huntAwareness * 5)) changeState(a, 'assess', tick, a.decisionSeconds);
    return;
  }

  // Complete assessment every tick instead of falling back to patrol while its
  // timer is active. A new point-blank approach is a material change in pressure.
  if (a.state === 'assess' && tick < a.until && !(nearest?.distance < 2.1 && nearest.closing > 1)) {
    assessMotion(hunt, position, distance);
    return;
  }

  if (rear && a.rearPressure > BOAR_AI.rearPressureSeconds && tick - a.lastBreakaway > ticks(1.2)) { rearResponse(hunt, players.get(rear.id), tick); return; }
  if (badlyHurt && nearest?.distance < 3.2 && tick - a.lastDesperate > ticks(2)) { desperate(hunt, nearPlayer, tick); return; }
  if (a.surrounded && ready) {
    const roll = decision(a);
    if (a.escapeOpen && (badlyHurt || a.breath < 0.25 || (a.traits.caution > a.traits.courage && roll < 0.82))) escape(hunt, tick, true);
    else if (a.traits.courage > 0.65 || a.stress > 0.5) {
      a.warningDistance = distance; changeState(a, 'warning', tick, warningSeconds(a, 0.3 + a.traits.caution * 0.3), 'resolve surrounding by defensive threat');
    } else if (roll < 0.5 && a.escapeOpen) commitMove(a, 'reposition', tick, 0.85 + a.traits.persistence * 0.3, a.escape);
    else breakAway(hunt, tick, a.escapeOpen ? a.escape : null);
    return;
  }

  if (close && ready) {
    if ((nearest?.closing > 0.8 || a.closePressureSeconds > 0.35) && a.traits.caution > a.traits.courage && a.escapeOpen) escape(hunt, tick, true);
    else startClose(a, target, tick, a.pressure >= BOAR_AI.highPressure);
    return;
  }
  if (threatened && ready) {
    if ((badlyHurt && !a.surrounded) || (a.surrounded && a.traits.caution > a.traits.courage && a.stress < 0.7) || a.breath < 0.2) {
      escape(hunt, tick); return;
    }
    const observer = a.awareHunters.find(p => p.id === a.targetId);
    if (a.escapeOpen && distance < preferredSeparation(a) && (a.traits.caution > a.traits.courage || a.huntAwareness > 0.35)
      && (observer?.closing > 0.3 || (observer?.suspicion ?? 0) > 0.35 || a.huntAwareness > 0.35)) {
      escape(hunt, tick, a.pressure >= BOAR_AI.highPressure); return;
    }
    if (distance < 6.5 || (a.stress > 0.35 && distance < 11) || a.surrounded) {
      a.warningDistance = distance;
      changeState(a, 'warning', tick, warningSeconds(a, 0.42 + a.traits.caution * 0.62), 'pressure demands a threat display'); return;
    }
    changeState(a, 'assess', tick, a.decisionSeconds, 'suspicious presence: focused watching');
    // Face the threat while edging sideways, making room to commit or escape.
    assessMotion(hunt, position, distance);
    return;
  }
  if (a.state !== 'patrol') changeState(a, 'patrol', tick, 0, 'no known immediate threat');
  const phase = tick / TICK_RATE * 0.13 + a.traits.bluff * 6;
  steer(hunt, { x: Math.cos(phase) * 4.3, z: -5 + Math.sin(phase) * 2.4 }, 1.05, 1.8);
}
