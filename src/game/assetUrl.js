// Portfolio Edition: resolve files in public/ against Vite's deployment base, so
// the same build works at "/" (dev) and "/primal-portfolio/" (GitHub Pages).
// Outside Vite (node --test) import.meta.env is undefined and "/" is used.
const BASE = import.meta.env?.BASE_URL ?? '/';
export function assetUrl(path) {
  return `${BASE.replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}
