// Post-build check for GitHub Pages: every file index.html references exists,
// URLs use the deployment base path, game assets are present, and the site
// stays well inside Pages limits (1 GB site, 100 MB per file).
// Usage: node scripts/check-dist.mjs [distDir] [basePath]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dist = process.argv[2] ?? 'dist';
const base = process.argv[3] ?? process.env.BASE_PATH ?? '/primal-portfolio/';
const problems = [];
const fail = message => problems.push(message);

if (!existsSync(join(dist, 'index.html'))) {
  console.error(`No ${dist}/index.html. Run npm run build first.`);
  process.exit(1);
}
const html = readFileSync(join(dist, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => !/^(https?:|data:|#|mailto:)/.test(u));
if (!refs.length) fail('index.html references no local files.');
for (const ref of refs) {
  if (!ref.startsWith(base)) fail(`${ref} does not start with the base path ${base}`);
  else if (!existsSync(join(dist, ref.slice(base.length)))) fail(`${ref} is referenced but missing from ${dist}/`);
}
for (const required of ['game/ironhide-boar.glb', 'game/fp-skin.png', 'game/fp-wrap.png', 'favicon.svg']) {
  if (!existsSync(join(dist, required))) fail(`missing ${required}`);
}

let total = 0, largest = { file: '', size: 0 };
const walk = dir => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else {
      total += stat.size;
      if (stat.size > largest.size) largest = { file: path, size: stat.size };
      if (stat.size > 95 * 1024 * 1024) fail(`${path} is ${(stat.size / 1048576).toFixed(1)} MB (GitHub blocks files over 100 MB)`);
    }
  }
};
walk(dist);
if (total > 500 * 1024 * 1024) fail(`site is ${(total / 1048576).toFixed(0)} MB; keep it well under the 1 GB Pages limit`);

console.log(`dist: ${(total / 1048576).toFixed(2)} MB total · largest ${largest.file} (${(largest.size / 1048576).toFixed(2)} MB) · ${refs.length} entry references under ${base}`);
if (problems.length) {
  for (const p of problems) console.error(`✗ ${p}`);
  process.exit(1);
}
console.log('✓ build output is ready for GitHub Pages');
