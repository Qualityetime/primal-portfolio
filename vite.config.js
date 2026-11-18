import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// GitHub Pages serves a project repository at https://<user>.github.io/<repo>/,
// so production assets must be requested under /<repo>/. The repository is
// named primal-portfolio; override with BASE_PATH (e.g. "/" for a custom
// domain or a user site) without touching code.
const REPO_BASE = '/primal-portfolio/';

export default defineConfig(({ command }) => ({
  base: command === 'build' ? (process.env.BASE_PATH || REPO_BASE) : '/',
  resolve: { alias: { '@shared': `${root}shared` } },
  // Vite 8 transforms JSX with Oxc; React's automatic runtime needs no plugin.
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // three.js is one large, rarely-changing chunk; keep it separate so a game
    // update does not invalidate the cached renderer.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
}));
