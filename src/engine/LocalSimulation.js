// Portfolio Edition: the in-browser replacement for the multiplayer server.
//
// The original game ran GameState (simulation/gameState.js) inside a Node.js
// process and talked to it over Socket.IO: clients sent input batches, the
// server stepped a 60 Hz authoritative simulation and broadcast 20 Hz
// snapshots. The simulation modules never depended on Node or the network, so
// this class runs the *same, unmodified* GameState/HuntState/boar brain in the
// page and keeps the protocol shape (welcome → input commands → snapshots).
//
// Differences from the server, all deliberate:
//  * Lockstep: the engine hands over each predicted input command and steps the
//    simulation immediately, so there is no latency or packet loss to hide.
//  * The clock is simulation time, not wall time. When the game is paused the
//    simulation is simply not stepped, so no input-timeout or AI timer fires.
//  * One hunter, and a configurable number of boars (1 or 2).
import { GameState } from '../../simulation/gameState.js';
import { HuntState } from '../../simulation/huntState.js';
import { FIXED_DT, GAME_VERSION, MAX_PLAYERS } from '../../shared/config.js';
import { HUNT } from '../../shared/hunt.js';

export const SOLO_ROOM = 'SOLO';
export const SOLO_PLAYER_ID = 'hunter';

// HuntState spawns one boar per HUNT.boarSpawns entry from inside its
// constructor and again on every new round. A subclass trims that list without
// touching the original module, so the AI, IDs and seeds stay identical.
function huntStateFor(boarCount) {
  const count = Math.max(1, Math.min(HUNT.boarSpawns.length, Math.round(boarCount) || 1));
  return class PortfolioHuntState extends HuntState {
    spawnAnimals() {
      super.spawnAnimals();
      if (this.animals.length <= count) return;
      this.animals = this.animals.slice(0, count);
      const keep = new Set(this.animals.map(a => a.id));
      for (const map of [this.previousAnimals, this.brains]) {
        for (const id of [...map.keys()]) if (!keep.has(id)) map.delete(id);
      }
    }
  };
}

export class LocalSimulation {
  constructor({ world, boarCount = 2, seed } = {}) {
    this.game = new GameState(world ? { world } : undefined);
    const Hunt = huntStateFor(boarCount);
    const hunt = new Hunt(this.game.world, seed === undefined ? undefined : { seed });
    // Pre-create the room so GameState.addPlayer joins it instead of making
    // its own (two-boar) HuntState.
    this.game.rooms.set(SOLO_ROOM, { players: new Map(), hunt });
    this.player = this.game.addPlayer(SOLO_PLAYER_ID, { room: SOLO_ROOM, name: 'Hunter' });
    this.clockMs = 0;
    this.boarCount = hunt.animals.length;
  }

  get session() { return this.game.rooms.get(SOLO_ROOM); }
  get hunt() { return this.session.hunt; }
  get tick() { return this.game.tick; }
  get world() { return this.game.world; }

  // Same payload the Socket.IO server sent on connection.
  welcome() {
    return { id: SOLO_PLAYER_ID, room: SOLO_ROOM, seed: this.game.world.seed, maxPlayers: MAX_PLAYERS,
      version: GAME_VERSION, snapshot: this.snapshot() };
  }

  // Feed one predicted command and advance one authoritative tick. The command
  // goes through the server's own validation (sanitizeBatch in receiveInput).
  step(command) {
    this.clockMs += FIXED_DT * 1000;
    if (command) this.game.receiveInput(SOLO_PLAYER_ID, SOLO_ROOM, [command], this.clockMs);
    this.game.step(this.clockMs);
  }

  snapshot() { return this.game.snapshot(SOLO_ROOM); }
}
