# Architecture: Primal Portfolio Edition

## 1. Starting point (audit of Primal Co-op v0.4.0)

| Area | Original location | Depends on network/Node? |
|---|---|---|
| HTTP + Socket.IO server, 60 Hz tick timer, 20 Hz snapshot broadcast | `server/app.js`, `server/index.js` | **Yes**: Express, Socket.IO, `node:*` |
| Authoritative rooms, input queue, per-tick step, snapshots | `server/gameState.js` | No |
| Hunt rules: spears, thrust/throw/brace, swept collision, wounds, bleeding, blood tracks, harvest, cooking, rounds | `server/huntState.js` | No |
| Professor Boar brain: perception, threat memory, pressure, temperament, 15+ behaviour states | `server/boarBrain.js`, `boarContext.js`, `boarTuning.js` | No |
| Ellipsoid anatomy (head, neck, chest, belly, rump, 8 leg segments) and injury model | `server/anatomy.js` | No |
| Movement, terrain, world generation, input validation | `shared/*` | No |
| Client entry: renderer, prediction/reconciliation loop, event handling | `client/src/main.js` | Uses `networking.js` |
| Socket.IO client | `client/src/networking.js` | **Yes** |
| DOM HUD and lobby | `client/index.html`, `client/src/ui.js`, `huntUI.js` | No (multiplayer UI: rooms, roster, copy link) |
| Rendering, boar rig, first-person spear rig, sound | `client/src/*` (17 more modules) | No |

The key finding was that **every gameplay system except transport was already free of Node and network dependencies.** The server logic is plain ES modules driven by `GameState.step()`. That made it possible to move the server into the browser instead of rewriting it.

## 2. Architecture

```
┌──────────────────────────── React (src/ui, src/App.jsx) ───────────────────────────────┐
│ MainMenu · Briefing · About(video slot) · Hud · TelemetryPanel(+TacticalMap) · Pause · Results │
│        useSyncExternalStore ← small stores (app, hud, telemetry, map, toasts, results)   │
└─────────────────────────────────────────▲──────────────────────────────────────────────┘
                     throttled snapshots  │  commands: startHunt, pause, resume, restart,
                     HUD 20 Hz, map 10 Hz,│  endHunt, quitToLobby, updateSettings
                     telemetry 5 Hz       │
┌──────────────────── GameEngine (src/engine/GameEngine.js, adapted main.js) ─────────────┐
│ Three.js renderer · world · HuntView (boars, spears, blood) · FirstPersonRig · sound      │
│ InputController (pointer lock) → PredictedPlayer (client prediction, unchanged)           │
│ fixed 60 Hz loop:  input → predict → LocalSimulation.step(command) → every 3rd tick:      │
│                    snapshot → reconcile + HuntView.receive + events (stats, toasts, sfx) │
└─────────────────────────────────────────┬──────────────────────────────────────────────┘
                                          │ same protocol shape as the socket:
                                          │ welcome → input commands → snapshots
┌──────────────────── LocalSimulation (src/engine/LocalSimulation.js) ────────────────────┐
│ owns the ORIGINAL GameState → HuntState → stepBoar / anatomy (simulation/, verbatim)     │
│ one room, one hunter, 1–2 boars, simulation clock that only advances while unpaused      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why this split.** Three.js and the simulation run in a `requestAnimationFrame` loop that React never sees. React renders only when an engine store publishes a *changed* value, and the HUD model rounds its readings so that unchanged values compare equal. The telemetry map is painted imperatively on a canvas from a store subscription, without React re-rendering. Nothing in the 60 Hz loop waits on React.

### LocalSimulation: replacing the server

- It constructs the original `GameState` (sharing the client's already-built world) and pre-creates a single room, so `GameState.addPlayer` joins it.
- Commands go through `GameState.receiveInput`, which applies the server's own `sanitizeBatch` validation, and then `GameState.step` runs. That is the same code path the Socket.IO handler used.
- **Lockstep.** Each predicted command is stepped immediately, so there is no latency to hide. The original prediction and reconciliation code is kept and still runs on every snapshot.
- **Simulation clock.** The input-timeout clock advances with simulation ticks, not wall time. Pause simply stops stepping: AI timers, bleeding and cooking all freeze.
- **Boar count.** A three-line subclass of `HuntState` trims `spawnAnimals()` to one boar. It applies again on every in-game round reset, without editing the original module.

### What changed, file by file

| Original | Portfolio Edition | Change |
|---|---|---|
| `server/gameState.js`, `huntState.js`, `boarBrain.js`, `boarContext.js`, `boarTuning.js`, `anatomy.js` | `simulation/` | **Byte-identical** |
| `shared/*` (8 files) | `shared/` | **Byte-identical** |
| 17 client modules (`world.js`, `huntView.js`, `firstPerson.js`, `player.js`, `sound.js`, …) | `src/game/` | **Byte-identical** |
| `boarAvatar.js`, `gripHand.js`, `humanAvatar.js` | `src/game/` | Asset URLs go through `assetUrl()` so they respect the deployment base path (3 lines each) |
| `input.js` | `src/game/` | Mouse sensitivity is a property instead of a constant (6 lines) |
| `main.js` | `src/engine/GameEngine.js` | Restructured as a class with pause, restart, dispose, settings and throttled publishing. Socket calls are replaced by `LocalSimulation`. |
| `networking.js`, `server/app.js`, `server/index.js` | removed | Replaced by `LocalSimulation` |
| `index.html`, `ui.js`, `huntUI.js`, `styles.css` | `src/ui/*`, `src/styles/app.css` | Rebuilt in React with the same visual identity. Objective logic is ported to `engine/hudModel.js`. |
| `RemotePlayers` (other hunters' rigged bodies, spear hand-offs) | not linked | Multiplayer-only presentation. `HuntView` already works without it. |
| `stonehide-human.glb` (21 MB) | not shipped | Only used to draw other hunters |

## 3. React features

- **Main menu** over the live 3D lobby vista: title, tagline, Play, About/footage, source link, asset download progress, and a touch-device notice.
- **Briefing**: objective steps, behaviour tips and a full controls list. "Enter the ravine" waits until the boar model is ready, then captures the pointer as part of the click.
- **About**: a truthful project description, a "playable here vs shown in video only" distinction, a technology list, and a **multiplayer video integration point** (local file or YouTube, set by config or CI variable; otherwise a neutral placeholder card).
- **HUD**: objective and hunt steps, camp bearing, health/stamina/bleeding, inventory, spear pips and readiness, throw-charge ring, interaction prompts, cooking progress, damage and low-health overlays, knockdown state, FPS, and event toasts.
- **Telemetry**: one card per boar with behaviour state (colour plus text label), stated intent, perception (sees you / remembers / unaware, suspicion), health and blood bars, a pressure sparkline (about 14 s, with a hover read-out), wound regions, limp/lung, and lodged spears. Expandable detail shows pressure drivers, temperament and a recent-decision trace. A **tactical map** shows terrain obstacles, the creek, the camp's safe radius, the blood trail, loose spears, projectiles, boar headings and the hunter.
- **Pause / settings**: resume, restart, end hunt, main menu; mouse sensitivity, field of view, render quality, boar count (applies on restart), telemetry, sound, and reset to defaults. Settings persist in `localStorage`.
- **Results**: outcome, hunt time, attacks by type, hits and accuracy, meals, damage taken, hits per body region (bar table), each boar's fate, and a timeline (first blood, first kill, meal). Hunt again, menu, or about.
- **Robustness**: an error boundary, a WebGL-unavailable message, WebGL context-loss handling, a model-download failure fallback (a geometric stand-in boar), and a pointer-lock refusal shown as a resumable pause.

Behaviour colours (alert `#c98500`, aggressive `#d55181`, evasive `#3987e5`) were validated for colour-vision-deficiency separation and contrast on the panel surface. Calm, recovering and dead states are neutral, and every state is also labelled in text.

## 4. Retained gameplay and AI systems

- 60 Hz fixed-step movement with sprint, jump, stamina, injury slowdown and knockback, plus client prediction with reconciliation and visual error smoothing.
- Spear thrust (a swept tip with reach ramp and aim drift), wind-up throw (a charge curve controls speed and spread), braced spear against charges, ballistic projectiles with swept collision against terrain, obstacles and moving animals, glancing deflection, embedded spears, and spear recovery (pull time scales with depth).
- Anatomy: 13 ellipsoid regions fitted to the rigged boar. Injury depth comes from energy, directness and tissue resistance, which feed trauma, bleeding, limp, lung damage and blood tracks.
- The Professor Boar brain: line-of-sight perception, peripheral and noise awareness, threat memory and suspicion, a multi-factor pressure model, temperament (courage, caution, persistence, recovery, bluff), escape-gap search, acute trauma reactions, and the behaviour states patrol, assess, orient, pivot, warning, charge, bluff, gore, sweep, maul, kick, flee, breakaway, reposition, recover and stagger.
- Hunter wounds, bleeding, knockdown, and respawn at camp; the safe camp radius; harvesting, cooking with interruption, the two-meal goal, and in-game round reset (R at camp).
- Rendering: the jungle ravine terrain, cliffs, trees, foliage, water and falls; the rigged boar with expressions, walk-cycle fitting and bound wound decals; the first-person hands and spear rig; camp fire light; synthesized sound and ambience.

## 5. Verification (what was actually run)

| Check | Result |
|---|---|
| Original test suite on the untouched original, as a baseline | 230 / 230 pass |
| Original tests carried into the fork (paths adapted). Removed: the Socket.IO integration test file, the remote-human-avatar files, the DOM-HUD test and one remote-presentation test, because those systems are not in this build. | 194 / 194 pass |
| New portfolio tests: local simulation, one-boar setting across round resets, the **complete hunt loop (kill → harvest → cook ×2 → complete)**, HUD model, telemetry and store | 6 / 6 pass |
| Production bundle served under `/primal-portfolio/`, driven in headless Chrome (WebGL via SwiftShader) | 26 / 26 checks pass: menu, model download from the sub-path, about/video placeholder, pointer lock, HUD, telemetry, movement, pause truly stops the simulation, settings, throw, kill, harvest, cook, results, **restart without page reload**, boar-count setting, end hunt, back to menu, **no failed requests, no console errors** |
| Original project fingerprint (SHA-256 of all 290 files) before and after | Unchanged |

**Not run in the build environment:** `npm install` and `vite build`. The npm registry was unreachable, and the bundled Vite only had its Windows native binary. The browser checks above used an esbuild bundle with the same entry point, aliases, base path and `import.meta.env` values. The first real `vite build` happens on your machine or in the GitHub Actions workflow, which also runs the tests and `check:dist`.

## 6. Known limitations

- Desktop only: keyboard, mouse and pointer lock. Touch devices see a notice; there are no touch controls.
- Single player. The multiplayer-specific presentation (other hunters' rigged bodies, remote spear hand-off animation) is intentionally not included.
- As in the original, each rendered frame advances the simulation by at most 0.1 s. Below about 10 FPS the game slows down rather than skipping ahead.
- Each hunt uses a random seed, so there is no replay or seed selection.
- No React Fast Refresh plugin. Editing a component in `npm run dev` triggers a full reload, which is harmless.
- The telemetry panel deliberately reveals AI state. It is a demonstration aid and can be hidden with T.
- `package-lock.json` is not included because it could not be generated without registry access. Generate it with the first `npm install` and commit it; CI then uses `npm ci`.
