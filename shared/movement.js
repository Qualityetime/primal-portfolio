import { FIXED_DT, PLAYER } from './config.js';
import { resolveBodies } from './body.js';
import { HUNT } from './hunt.js';
import { TERRAIN, groundHeight } from './terrain.js';

export function createPlayerState(spawn) {
  return { x: spawn.x, y: spawn.y, z: spawn.z, vy: 0, yaw: spawn.yaw, pitch: 0, grounded: true,
    stamina: 100, injurySlow: 0, knockTicks: 0, impulseX: 0, impulseZ: 0, braceTime: 0, bracing: false,
    winding: false, windupTime: 0 };
}

export function neutralInput(yaw = 0, pitch = 0) {
  return { forward: 0, strafe: 0, yaw, pitch, sprint: false, jump: false };
}

export function resolveObstacles(state, world, bodies = null) {
  const limit = world.halfSize - PLAYER.radius;
  for (let iteration = 0; iteration < 3; iteration++) {
    state.x = Math.max(-limit, Math.min(limit, state.x));
    state.z = Math.max(-limit, Math.min(limit, state.z));
    for (const obstacle of world.obstacles) {
      const dx = state.x - obstacle.x;
      const dz = state.z - obstacle.z;
      const distance = Math.hypot(dx, dz);
      const minimum = PLAYER.radius + obstacle.radius;
      if (distance >= minimum) continue;
      if (distance < 0.00001) {
        state.x = obstacle.x + minimum;
      } else {
        const overlap = minimum - distance;
        state.x += (dx / distance) * overlap;
        state.z += (dz / distance) * overlap;
      }
    }
    resolveBodies(state, bodies);
  }
  state.x = Math.max(-limit, Math.min(limit, state.x));
  state.z = Math.max(-limit, Math.min(limit, state.z));
}

// A grounded hunter's feet follow the shared terrain. On a world without terrain
// data this is the original y = 0 floor and changes nothing.
export function followGround(state, world) {
  if (!state.grounded) return;
  const ground = groundHeight(world, state.x, state.z);
  if (state.y - ground > TERRAIN.stepDown) { state.grounded = false; state.vy = Math.min(state.vy ?? 0, 0); }
  else state.y = ground;
}

// Fixed timestep; a packet cannot supply its own duration or position.
// y is the player's feet. Static obstacles block horizontally at all heights.
export function stepPlayer(state, input, world, dt = FIXED_DT, bodies = null) {
  const oldYaw = state.yaw;
  state.yaw = input.yaw;
  state.pitch = input.pitch;
  const magnitude = Math.hypot(input.forward, input.strafe);
  const forward = input.forward / Math.max(1, magnitude);
  const strafe = input.strafe / Math.max(1, magnitude);
  state.stamina ??= 100; state.injurySlow ??= 0; state.knockTicks ??= 0;
  state.impulseX ??= 0; state.impulseZ ??= 0; state.braceTime ??= 0;
  const down = state.knockTicks > 0 || state.health === 0;
  state.winding = !!(input.throwHeld || input.throwStart) && !input.throw && !input.attack && !input.interact
    && !down && state.spears !== 0 && state.stamina >= 12;
  state.windupTime = state.winding ? Math.min(HUNT.windupSeconds, (input.throwStart ? 0 : state.windupTime ?? 0) + dt) : 0;
  const sprint = input.sprint && magnitude > 0 && state.stamina > 4 && !down;
  const turned = Math.abs(Math.atan2(Math.sin(input.yaw - oldYaw), Math.cos(input.yaw - oldYaw)));
  state.bracing = !!input.brace && !state.winding && !input.throw && !input.attack && !down && magnitude === 0 && !input.jump && !input.sprint
    && state.grounded && state.stamina > 12 && state.spears !== 0 && turned < 0.12 && Math.hypot(state.impulseX, state.impulseZ) < 0.65;
  state.braceTime = state.bracing ? Math.min(1, state.braceTime + dt) : 0;
  state.stamina = Math.max(0, Math.min(100, state.stamina + (sprint ? -15 : state.bracing ? -3 : 12) * dt));
  const speed = (sprint ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (1 - state.injurySlow * 0.45) * (down ? 0 : 1);
  const dx = ((-Math.sin(input.yaw) * forward + Math.cos(input.yaw) * strafe) * speed + state.impulseX) * dt;
  const dz = ((-Math.cos(input.yaw) * forward - Math.sin(input.yaw) * strafe) * speed + state.impulseZ) * dt;

  // Substeps prevent fast movement from tunnelling through thin tree trunks.
  const substeps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / (PLAYER.radius * 0.5)));
  for (let i = 0; i < substeps; i++) {
    state.x += dx / substeps;
    state.z += dz / substeps;
    resolveObstacles(state, world, bodies);
  }
  followGround(state, world);
  state.impulseX *= Math.exp(-7 * dt); state.impulseZ *= Math.exp(-7 * dt);
  if (state.knockTicks > 0) state.knockTicks--;
  if (input.jump && state.grounded && !down && state.stamina > 10) {
    state.stamina -= 10;
    state.vy = PLAYER.jumpSpeed;
    state.grounded = false;
  }
  if (!state.grounded) {
    state.vy -= PLAYER.gravity * dt;
    state.y += state.vy * dt;
    const floor = groundHeight(world, state.x, state.z);
    if (state.y <= floor) {
      state.y = floor;
      state.vy = 0;
      state.grounded = true;
    }
  }
  // Resolve again after falling/landing. A hunter crossing the top of the body
  // cannot issue a thrust from inside it on the landing tick.
  resolveObstacles(state, world, bodies);
  followGround(state, world);
  return state;
}
