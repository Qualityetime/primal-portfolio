// Portfolio-facing content and links. Edit this file (or set the VITE_* build
// variables) — no component code needs to change.
const env = import.meta.env ?? {};

export const PORTFOLIO = Object.freeze({
  title: 'Project Primal',
  edition: 'Portfolio Edition',
  version: '1.0.0',
  derivedFrom: 'Primal Co-op v0.4.0 (Hunt Slice 0.1 · Hunting 1.2.2)',
  tagline: 'A single-player hunting demo built from a four-player, server-authoritative survival prototype.',

  // Source code of THIS repository. The GitHub Pages workflow fills it in
  // automatically from the repository it runs in (VITE_SOURCE_URL).
  sourceUrl: env.VITE_SOURCE_URL || '',
  // Optional: the original multiplayer project, if it is public.
  multiplayerSourceUrl: env.VITE_MULTIPLAYER_SOURCE_URL || '',
  // Optional: link back to your main portfolio site.
  portfolioUrl: env.VITE_PORTFOLIO_URL || '',

  // Multiplayer footage of the ORIGINAL Node.js build. Leave all empty until
  // you have a recording; the section then shows a neutral placeholder card
  // instead of a broken player. Provide ONE of:
  //   file:    put the video in public/media/ and give its name, e.g. 'primal-multiplayer.mp4'
  //   youtube: a YouTube video ID, e.g. 'dQw4w9WgXcQ'
  multiplayerVideo: Object.freeze({
    file: env.VITE_MULTIPLAYER_VIDEO_FILE || '',
    poster: env.VITE_MULTIPLAYER_VIDEO_POSTER || '', // optional image in public/media/
    youtube: env.VITE_MULTIPLAYER_VIDEO_YOUTUBE || '',
    caption: 'Original multiplayer build: hunters cooperating against two boars on a Node.js / Socket.IO server.',
  }),

  technologies: Object.freeze([
    ['React 19', 'Menus, HUD, live telemetry, settings and results'],
    ['Three.js r186', 'Terrain, lighting, rigged boar, first-person spear rig'],
    ['JavaScript (ES modules)', 'Fixed-step 60 Hz simulation, boar AI, anatomy and wounds'],
    ['Vite 8', 'Development server and static production build'],
    ['GitHub Actions + Pages', 'Automated build and static deployment'],
    ['Node test runner', 'Simulation, AI and client-module regression tests'],
  ]),
});
