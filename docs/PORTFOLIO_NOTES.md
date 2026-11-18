# Portfolio notes

## One-line description

Single-player browser demo of a multiplayer survival prototype: a React 19 interface over a Three.js renderer and an unmodified, formerly server-side 60 Hz simulation with tactical boar AI. Deployed as a static site through GitHub Actions.

## Suggested resume bullets

Each bullet describes something that exists in this repository. Adjust the wording to your own role in the original project.

- Ported a server-authoritative Node.js/Socket.IO multiplayer game to a fully client-side single-player build. The 60 Hz simulation and AI run unchanged in the browser through a local adapter that keeps the original protocol, input validation and client-side prediction.
- Reused 100% of the simulation, AI and shared modules byte-for-byte, plus 17 of 21 rendering modules unchanged. The remaining four needed edits of six lines or fewer. All 194 carried-over regression tests pass on the fork.
- Built a React 19 interface (menus, HUD, settings, results) that subscribes to throttled engine snapshots through `useSyncExternalStore`, keeping React renders out of the real-time render and simulation loop.
- Built a real-time AI telemetry view: each boar's behaviour state, decision intent, a multi-factor pressure trend, wounds and blood loss, and a canvas tactical map with line-of-sight and threat indicators, sampled live from the decision-making code.
- Implemented true pause (simulation-clock based), in-place restart without a page reload, persistent settings, and full Three.js resource disposal on teardown.
- Set up automated GitHub Pages deployment with GitHub Actions (tests → build → output verification → deploy). Kept the static site to about 7 MB by dropping multiplayer-only assets.
- Wrote headless-browser end-to-end checks that play a full hunt (move, throw, kill, harvest, cook, results, restart) against the production bundle served under its deployment sub-path.

## Talking points for interviews

- **Why not rewrite for React?** The simulation was already transport-agnostic, so the risk-minimising move was to change the transport, not the logic. React owns application state; the engine owns real-time state; a narrow store interface connects them.
- **Authority without a server.** The original server validated and replayed every input. The local adapter feeds commands through that same validation path, so solo play exercises the multiplayer rules.
- **Data visualisation under real-time constraints.** Telemetry is sampled at 5 Hz and the map at 10 Hz, and values are rounded so React skips unchanged renders. The canvas map draws imperatively.
- **Shipping.** The build has a base-path-aware asset loader, a CI check that fails the deploy if `index.html` references a missing file or the wrong base, and graceful fallbacks for missing WebGL, a failed model download and lost GPU context.
