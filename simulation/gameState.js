import { MAX_PLAYERS, INPUT_TIMEOUT_MS, PLAYER_COLORS, FIXED_DT } from '../shared/config.js';
import { createWorld } from '../shared/world.js';
import { createPlayerState, neutralInput, stepPlayer } from '../shared/movement.js';
import { sanitizeBatch } from '../shared/protocol.js';
import { HuntState } from './huntState.js';

export class GameState {
  // A world may be injected (tests replay the frozen pre-0.4 clearing layout to
  // prove the boar brain is unchanged); production rooms use the shared biome.
  constructor({ world = createWorld() } = {}) {
    this.world = world;
    this.rooms = new Map();
    this.tick = 0;
  }

  addPlayer(id, { room, name }) {
    let session = this.rooms.get(room);
    if (session && session.players.size >= MAX_PLAYERS) throw new Error('That room is full. Try a different room code.');
    if (!session) {
      if (this.rooms.size >= 64) throw new Error('The server is full. Try again shortly.');
      session = { players: new Map(), hunt: new HuntState(this.world) };
      this.rooms.set(room, session);
    }
    const usedSlots = new Set([...session.players.values()].map(player => player.slot));
    const slot = this.world.spawns.findIndex((_, index) => !usedSlots.has(index));
    const player = {
      id, name, slot, color: PLAYER_COLORS[slot],
      state: createPlayerState(this.world.spawns[slot]),
      ack: 0, lastReceivedSequence: 0, queue: [], lastInputAt: 0,
    };
    session.hunt.addPlayer(player);
    session.players.set(id, player);
    return player;
  }

  removePlayer(id, room) {
    const session = this.rooms.get(room);
    if (!session) return;
    session.players.delete(id);
    if (!session.players.size) this.rooms.delete(room);
  }

  receiveInput(id, room, batch, now) {
    const player = this.rooms.get(room)?.players.get(id);
    if (!player) return false;
    const commands = sanitizeBatch(batch, player.lastReceivedSequence);
    if (!commands) return false;
    player.lastReceivedSequence = commands.at(-1).seq;
    player.lastInputAt = now;
    player.queue.push(...commands);
    // Keep stalled/flooded connections bounded. Still simulate at most one command per tick.
    if (player.queue.length > 30) player.queue.splice(0, player.queue.length - 4);
    return true;
  }

  step(now) {
    this.tick++;
    for (const session of this.rooms.values()) {
      for (const player of session.players.values()) {
        if (now - player.lastInputAt > INPUT_TIMEOUT_MS) player.queue.length = 0;
        const command = player.queue.shift();
        const previous = { x: player.state.x, z: player.state.z };
        stepPlayer(player.state, player.health > 0 && command ? command : neutralInput(player.state.yaw, player.state.pitch), this.world, FIXED_DT, session.hunt.animals);
        player.velocityX = (player.state.x - previous.x) / FIXED_DT;
        player.velocityZ = (player.state.z - previous.z) / FIXED_DT;
        if (command) session.hunt.action(player, command, this.tick, session.players);
        if (command) player.ack = command.seq;
      }
      session.hunt.step(this.tick, session.players);
    }
  }

  snapshot(room) {
    const session = this.rooms.get(room);
    const players = [...(session?.players.values() ?? [])].map(player => ({
      id: player.id, name: player.name, slot: player.slot, color: player.color,
      ack: player.ack, ...player.state, ...session.hunt.playerSnapshot(player, this.tick),
    }));
    return { tick: this.tick, players, hunt: session?.hunt.snapshot() ?? null };
  }
}
