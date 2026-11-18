// Portfolio Edition game engine: the original client entry point
// (client/src/main.js) restructured as a class that React can own.
//
//  * Three.js rendering, the first-person rig, boar visuals and the 60 Hz
//    fixed-step input/prediction loop are the original modules, called the same
//    way main.js called them.
//  * The Socket.IO connection is replaced by LocalSimulation, which runs the
//    original authoritative GameState in this page (see LocalSimulation.js).
//  * The original hand-written DOM HUD is replaced by React. The engine never
//    renders React; it publishes throttled plain-object snapshots to small
//    external stores (store.js) that React components subscribe to.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createWorld } from '@shared/world.js';
import { FIXED_DT, PLAYER } from '@shared/config.js';
import { HUNT } from '@shared/hunt.js';
import { groundHeight } from '@shared/terrain.js';
import { buildWorld } from '../game/world.js';
import { InputController } from '../game/input.js';
import { PredictedPlayer } from '../game/player.js';
import { HuntView } from '../game/huntView.js';
import { GameSound } from '../game/sound.js';
import { createBoarAssetCache } from '../game/boarAvatar.js';
import { LocalSimulation } from './LocalSimulation.js';
import { createStore, shallowEqual } from './store.js';
import { hudModel } from './hudModel.js';
import { TelemetrySampler, mapSample } from './telemetry.js';
import { createStats, applyEvent, summarise } from './huntStats.js';

export const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 1, // multiplier of the original 0.0022 rad/px
  fov: 75,
  quality: 'high',
  telemetry: true,
  boarCount: 2,
  muted: false,
});
const SETTINGS_KEY = 'primal-portfolio:settings:v1';
const BASE_SENSITIVITY = 0.0022;
const PIXEL_RATIO = { low: 0.75, medium: 1, high: 1.75 };
const BOAR_ASSET_BYTES = 6210052; // fallback when the server omits Content-Length
const HUD_INTERVAL = 50; // ms → 20 Hz
const TELEMETRY_INTERVAL = 200; // ms → 5 Hz
const MAP_INTERVAL = 100; // ms → 10 Hz
const RESULTS_DELAY = 3200; // ms after the hunt completes, so the moment lands
// Lobby vista: from behind the camp, over the fire, toward the falls (original).
const LOBBY_VIEW = { position: new THREE.Vector3(1.6, 2.5, 8.2), target: new THREE.Vector3(-6.5, 4.6, -30) };

export class WebGLUnavailableError extends Error {}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}
function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode etc. */ }
}

// One download and parse per page, shared across engine instances (React
// StrictMode mounts twice in development) and across restarts.
const assetProgress = createStore({ loaded: 0, total: BOAR_ASSET_BYTES });
let boarAssets;
function boarAssetCache() {
  boarAssets ??= createBoarAssetCache({
    loadAsync: url => new GLTFLoader().loadAsync(url, event => {
      assetProgress.set({ loaded: event.loaded, total: event.lengthComputable && event.total ? event.total : BOAR_ASSET_BYTES });
    }),
  });
  return boarAssets;
}

export class GameEngine {
  constructor(container, { debug = false } = {}) {
    this.container = container;
    this.settings = loadSettings();
    // ---- Stores React subscribes to --------------------------------------
    this.app = createStore({ phase: 'lobby', pauseReason: null, notice: null, fatal: null });
    this.assets = createStore({ progress: 0, ready: false, failed: false });
    this.settingsStore = createStore(this.settings);
    this.hud = createStore(null);
    this.telemetry = createStore(null);
    this.map = createStore(null);
    this.toasts = createStore(null);
    this.results = createStore(null);
    this.perf = createStore({ fps: 0 });

    // ---- Renderer (as in main.js) ----------------------------------------
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.canvas.setAttribute('aria-label', 'Primal 3D view');
    container.appendChild(this.canvas);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    } catch (error) {
      this.canvas.remove();
      throw new WebGLUnavailableError('This demo needs a desktop browser with WebGL 2 and hardware acceleration enabled.', { cause: error });
    }
    const renderer = this.renderer;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.autoClear = false; // world pass + first-person hands pass
    this.onContextLost = event => {
      event.preventDefault();
      this.app.patch({ fatal: 'The graphics context was lost (often after a driver reset or sleep). Reload the page to continue.' });
    };
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);

    this.scene = new THREE.Scene();
    this.world = createWorld();
    this.environment = buildWorld(this.scene, this.world);
    this.camera = new THREE.PerspectiveCamera(this.settings.fov, innerWidth / innerHeight, 0.06, 240);
    this.camera.rotation.order = 'YXZ';
    this.lobbyCamera(0);
    this.localPlayer = new PredictedPlayer(this.world);
    // Multiplayer-only presentation (other hunters' rigged bodies, remote
    // spear hand-offs) is not linked: HuntView works without remotes.
    this.huntView = new HuntView(this.scene, this.camera, { world: this.world, loadAsset: () => boarAssetCache().load() });
    this.sunDirection = this.environment.sunlight.position.clone().sub(this.environment.sunlight.target.position).normalize();
    this.sound = new GameSound();
    this.sound.muted = this.settings.muted;
    this.input = new InputController(this.canvas, locked => this.onLockChange(locked), () => {
      this.updateSettings({ muted: !this.settings.muted });
      this.toast(this.settings.muted ? 'Sound muted. Press M to turn it on.' : 'Sound on.');
    });

    this.unsubscribeProgress = assetProgress.subscribe(() => {
      const { loaded, total } = assetProgress.get();
      if (!this.assets.get().ready) this.assets.patch({ progress: Math.min(0.99, loaded / total) });
    });
    this.huntView.ready.then(asset => {
      if (this.disposed) return;
      this.assets.set({ progress: 1, ready: true, failed: !asset });
      if (!asset) this.app.patch({ notice: 'The boar model could not be downloaded, so a simple stand-in model is used. Gameplay is unaffected.' });
    });

    // ---- Session state ----------------------------------------------------
    this.sim = null;
    this.selfId = null;
    this.sampler = new TelemetrySampler();
    this.resetSession();
    this.debug = { enabled: debug, ignoreLock: false, input: null };
    if (debug) this.installDebugApi();

    this.applySettings();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.lastFrame = performance.now();
    this.fpsStarted = this.lastFrame;
    this.frames = 0;
    renderer.setAnimationLoop(now => this.frame(now));
  }

  // ---- Public API used by React ------------------------------------------
  get phase() { return this.app.get().phase; }

  /** Start a fresh hunt. Call from a click handler (pointer lock needs a user gesture). */
  startHunt() {
    this.sound.unlock();
    this.newSimulation();
    this.setPhase('playing');
    this.lockPointer();
  }
  restart() { this.startHunt(); }
  resume() {
    if (!this.sim) return;
    this.sound.unlock();
    this.lockPointer();
    if (this.debug.ignoreLock) this.setPhase('playing');
  }
  pause(reason = 'menu') {
    if (this.phase !== 'playing') return;
    this.setPhase('paused', reason);
    if (this.input.locked) document.exitPointerLock();
  }
  endHunt() { this.finish('ended'); }
  quitToLobby() {
    if (this.input.locked) document.exitPointerLock();
    this.sim = null;
    this.huntView.clear();
    this.input.clear();
    this.resetSession();
    this.hud.set(null); this.telemetry.set(null); this.map.set(null); this.results.set(null);
    this.setPhase('lobby');
  }
  updateSettings(partial) {
    this.settings = { ...this.settings, ...partial };
    this.settingsStore.set(this.settings);
    saveSettings(this.settings);
    this.applySettings();
  }
  resetSettings() { this.updateSettings({ ...DEFAULT_SETTINGS }); }

  // ---- Session -------------------------------------------------------------
  resetSession() {
    this.accumulator = 0;
    this.lastEventId = 0;
    this.lastAnimalStates = new Map();
    this.lastPredictedThrow = -Infinity;
    this.hurtUntil = 0;
    this.completeAt = null;
    this.stats = createStats();
    this.lastLocal = null;
    this.motion = { speed: 0, sprinting: false };
    this.latestInput = null;
    this.lastHud = this.lastTelemetry = this.lastMap = 0;
    this.lastSnapshot = null;
    this.sampler.reset();
  }

  newSimulation() {
    this.resetSession();
    this.huntView.clear();
    this.results.set(null);
    this.sim = new LocalSimulation({ world: this.world, boarCount: this.settings.boarCount });
    const welcome = this.sim.welcome();
    const self = welcome.snapshot.players.find(p => p.id === welcome.id);
    this.selfId = welcome.id;
    this.localPlayer.reset(self);
    this.localPlayer.bodies = welcome.snapshot.hunt?.animals ?? [];
    this.input.clear();
    this.input.yaw = self.yaw;
    this.input.pitch = self.pitch;
    this.huntView.receive(welcome.snapshot, true);
    this.lastEventId = welcome.snapshot.hunt?.events.at(-1)?.id ?? 0;
    this.lastAnimalStates = new Map((welcome.snapshot.hunt?.animals ?? []).map(a => [a.id, a.state]));
    this.lastSnapshot = welcome.snapshot;
    this.publish(performance.now(), true);
  }

  // Port of main.js onSnapshot: reconcile prediction, update visuals, react to
  // simulation events (sounds, first-person hurt, toasts) and count stats.
  receiveSnapshot(snapshot, now) {
    const self = snapshot.players.find(p => p.id === this.selfId);
    this.localPlayer.bodies = snapshot.hunt?.animals ?? [];
    if (self) this.localPlayer.reconcile(self);
    this.huntView.receive(snapshot);
    const events = snapshot.hunt.events.filter(event => event.id > this.lastEventId);
    this.lastEventId = Math.max(this.lastEventId, snapshot.hunt.events.at(-1)?.id ?? 0);
    for (const event of events) {
      const yours = event.player === this.selfId;
      applyEvent(this.stats, event, this.selfId);
      this.huntView.event(event);
      if (event.type === 'hit' || event.type === 'kill' || event.type === 'complete'
        || (yours && ['hurt', 'harvest', 'cooked', 'braced'].includes(event.type))) this.sound.play(event.type);
      if (event.type === 'hurt' && yours) { this.huntView.viewModel.hurt(now / 1000); this.hurtUntil = now + 450; }
      if (event.type === 'kill') this.toast('Boar down. Walk up to it and press E to harvest.');
      if (event.type === 'harvest' && yours) this.toast(`Collected ${event.amount} raw meat. Return to camp.`);
      if (event.type === 'cooked' && yours) this.toast('Meat cooked. Health restored.');
      if (event.type === 'complete') { this.toast('First meal cooked. The hunt is complete.'); this.completeAt ??= now + RESULTS_DELAY; }
      if (event.type === 'respawn' && yours) this.toast('Back at camp. Your meat is still with you.');
      if (event.type === 'cook-cancelled' && yours) this.toast('Cooking stopped. Your raw meat was returned.');
      if (event.type === 'reset') this.toast(`Hunt ${event.round}. Spears ready.`);
      if (event.type === 'recovered' && yours) this.toast('Spear recovered.');
      if (event.type === 'resupplied' && yours) this.toast('Spears taken from camp.');
      if (event.type === 'braced' && yours) this.toast(event.strong ? 'Braced spear held the charge.' : 'The charge drove through your brace.');
    }
    for (const animal of snapshot.hunt.animals) {
      if (animal.state === 'warning' && this.lastAnimalStates.get(animal.id) !== 'warning') this.sound.play('warning');
    }
    this.lastAnimalStates = new Map(snapshot.hunt.animals.map(a => [a.id, a.state]));
    this.lastSnapshot = snapshot;
  }

  finish(outcome) {
    if (!this.sim || this.phase === 'results' || this.phase === 'lobby') return;
    this.results.set(summarise(this.stats, this.sim, outcome));
    this.setPhase('results');
    if (this.input.locked) document.exitPointerLock();
    this.input.clear();
  }

  // ---- Pointer lock and phases -------------------------------------------
  async lockPointer() {
    if (this.debug.ignoreLock) return;
    try {
      await this.input.lock();
    } catch {
      // Browsers refuse a re-lock for about a second after Esc.
      if (this.sim && this.phase !== 'results') this.setPhase('paused', 'pointer');
    }
  }
  onLockChange(locked) {
    if (locked) {
      if (this.sim && (this.phase === 'paused' || this.phase === 'playing')) { this.accumulator = 0; this.setPhase('playing'); }
    } else if (this.phase === 'playing' && !this.debug.ignoreLock) this.setPhase('paused', 'menu');
  }
  setPhase(phase, pauseReason = null) {
    this.app.patch({ phase, pauseReason });
    if (phase !== 'playing') this.input.clear();
  }

  toast(message) { this.toasts.set({ id: (this.toasts.get()?.id ?? 0) + 1, message }); }

  // ---- Frame loop (structure follows main.js) --------------------------------
  readInput() {
    const input = this.input.read();
    if (!this.debug.input) return input;
    const scripted = { ...input, ...this.debug.input, yaw: this.debug.input.yaw ?? this.input.yaw, pitch: this.debug.input.pitch ?? this.input.pitch };
    // One-shot actions fire once, like a real key or button press.
    for (const key of ['attack', 'throw', 'throwStart', 'jump', 'interact', 'restart']) delete this.debug.input[key];
    this.input.yaw = scripted.yaw; this.input.pitch = scripted.pitch;
    return scripted;
  }

  frame(now) {
    if (this.disposed) return;
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.frames++;
    if (now - this.fpsStarted > 1000) {
      this.perf.set({ fps: Math.round(this.frames * 1000 / (now - this.fpsStarted)) });
      this.fpsStarted = now; this.frames = 0;
    }
    const camera = this.camera, sim = this.sim;
    const running = !!sim && this.phase === 'playing' && (this.input.locked || this.debug.ignoreLock);
    if (sim && this.phase !== 'lobby') {
      if (running) {
        this.accumulator += dt;
        while (this.accumulator >= FIXED_DT) {
          const input = this.readInput();
          this.latestInput = input;
          const state = this.localPlayer.state;
          const released = input.throw && (state.winding || input.throwStart);
          if ((released || input.attack) && state.spears > 0 && state.health > 0 && state.knockTicks <= 0
            && now - this.lastPredictedThrow >= (input.throw ? 800 : 640)) {
            this.lastPredictedThrow = now;
            if (released) { this.huntView.thrown(); this.sound.play('throw'); } else { this.huntView.thrust(); this.sound.play('thrust'); }
          }
          sim.step(this.localPlayer.step(input));
          // 20 Hz snapshots, exactly as the server broadcast them.
          if (sim.tick % 3 === 0) this.receiveSnapshot(sim.snapshot(), now);
          this.accumulator -= FIXED_DT;
        }
      }
      this.localPlayer.updateVisual(dt);
      const position = this.localPlayer.visualPosition;
      const state = this.localPlayer.state;
      const down = state.knockTicks > 0 || state.health <= 0;
      camera.position.set(position.x, position.y + (down ? 0.62 : PLAYER.eyeHeight), position.z);
      camera.rotation.set(this.input.pitch, this.input.yaw, down ? 0.22 : 0, 'YXZ');
      const li = this.latestInput;
      const sprinting = running && !!li && li.sprint && (li.forward !== 0 || li.strafe !== 0);
      this.motion.speed = running && this.lastLocal && dt > 0 ? Math.min(12, Math.hypot(position.x - this.lastLocal.x, position.z - this.lastLocal.z) / dt) : 0;
      this.motion.sprinting = sprinting;
      this.lastLocal = { x: position.x, z: position.z };
      this.sound.ambient(this.phase === 'playing' ? position : null, this.environment.sounds);
      this.publish(now, false, position, sprinting, running);
      if (this.completeAt !== null && now >= this.completeAt && this.phase === 'playing') this.finish('complete');
    } else {
      this.lobbyCamera(now / 1000);
      this.sound.ambient(null);
    }
    // Low quality refreshes the shadow map at 4 Hz instead of every frame.
    if (!this.renderer.shadowMap.autoUpdate && now - (this.lastShadow ?? 0) > 250) {
      this.lastShadow = now;
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.environment.update(now / 1000);
    this.huntView.update(now, dt, this.localPlayer.state, running, this.motion);
    this.huntView.viewModel.light(camera, this.sunDirection, HUNT.camp);
    this.renderer.clear();
    this.renderer.render(this.scene, camera);
    if (this.sim && this.phase !== 'lobby') this.huntView.viewModel.render(this.renderer);
  }

  // Throttled publication to React: HUD 20 Hz, map 10 Hz, telemetry 5 Hz.
  publish(now, force = false, position = this.localPlayer.visualPosition, sprinting = false, active = false) {
    if (!this.sim || !this.lastSnapshot) return;
    if (force || now - this.lastHud >= HUD_INTERVAL) {
      this.lastHud = now;
      const next = hudModel(this.lastSnapshot, this.selfId,
        { position, yaw: this.input.yaw, state: this.localPlayer.state, sprinting }, active || force, now, this.hurtUntil);
      if (!shallowEqual(next, this.hud.get())) this.hud.set(next);
    }
    const player = { x: position.x, z: position.z, yaw: this.input.yaw };
    if (this.settings.telemetry && (force || now - this.lastMap >= MAP_INTERVAL)) {
      this.lastMap = now;
      this.map.set(mapSample(this.sim, player));
    }
    if (this.settings.telemetry && (force || now - this.lastTelemetry >= TELEMETRY_INTERVAL) && (active || force || !this.telemetry.get())) {
      this.lastTelemetry = now;
      this.telemetry.set(this.sampler.sample(this.sim, player));
    }
  }

  lobbyCamera(seconds) {
    this.camera.position.copy(LOBBY_VIEW.position).add(new THREE.Vector3(Math.sin(seconds * 0.11) * 0.5, Math.sin(seconds * 0.07) * 0.12, 0));
    this.camera.lookAt(LOBBY_VIEW.target);
  }

  applySettings() {
    const s = this.settings;
    this.input.sensitivity = BASE_SENSITIVITY * Math.max(0.2, Math.min(3, Number(s.sensitivity) || 1));
    this.camera.fov = Math.max(60, Math.min(100, Number(s.fov) || 75));
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, PIXEL_RATIO[s.quality] ?? PIXEL_RATIO.high));
    this.renderer.shadowMap.autoUpdate = s.quality !== 'low';
    this.renderer.shadowMap.needsUpdate = true;
    this.lastShadow = 0;
    this.sound.muted = !!s.muted;
    if (s.muted) this.sound.ambient(null);
    if (!s.telemetry) { this.telemetry.set(null); this.map.set(null); }
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.huntView.viewModel.resize(innerWidth / innerHeight);
  }

  // ---- Scripted control for automated browser tests (?debug only) ----------
  installDebugApi() {
    const engine = this;
    window.__primal = {
      engine,
      ignorePointerLock(on = true) { engine.debug.ignoreLock = on; if (on && engine.phase === 'paused') engine.setPhase('playing'); },
      input(partial) { engine.debug.input = partial ? { ...(engine.debug.input ?? {}), ...partial } : null; },
      teleport(x, z, yaw = engine.input.yaw) {
        const state = engine.sim.player.state;
        Object.assign(state, { x, z, yaw, vy: 0 });
        state.y = groundHeight(engine.world, x, z);
        engine.localPlayer.reset(engine.sim.snapshot().players[0]);
        // Keep the input sequence: the simulation rejects replayed sequence numbers.
        engine.localPlayer.sequence = engine.sim.player.lastReceivedSequence;
        engine.input.yaw = yaw;
      },
      state() {
        const sim = engine.sim;
        return {
          phase: engine.phase, tick: sim?.tick ?? 0,
          player: sim && { ...sim.player.state, health: sim.player.health, spears: sim.player.spears, rawMeat: sim.player.rawMeat, cookedMeat: sim.player.cookedMeat },
          animals: sim?.hunt.animals.map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z, yaw: a.yaw, state: a.state, health: a.health, meat: a.meat, wounds: a.wounds.length })) ?? [],
          meals: sim?.hunt.meals, complete: sim?.hunt.complete, stats: { ...engine.stats },
        };
      },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.unsubscribeProgress();
    if (this.input.locked) document.exitPointerLock();
    this.input.destroy();
    this.huntView.clear();
    const textures = new Set();
    this.scene.traverse(object => {
      object.geometry?.dispose();
      for (const material of [object.material].flat().filter(Boolean)) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
        for (const uniform of Object.values(material.uniforms ?? {})) if (uniform?.value?.isTexture) textures.add(uniform.value);
        material.dispose();
      }
    });
    for (const texture of textures) texture.dispose();
    this.renderer.renderLists.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.sound.context?.close?.().catch?.(() => {});
    if (window.__primal?.engine === this) delete window.__primal;
  }
}

