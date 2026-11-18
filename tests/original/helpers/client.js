import { readFile } from 'node:fs/promises';

const modules = new Map();
// Load actual client modules in Node, replacing only Vite's import resolution.
// Scene-graph and prediction checks need neither WebGL nor a browser installation.
async function moduleURL(url) {
  if (!modules.has(url.href)) modules.set(url.href, (async () => {
    let source = await readFile(url, 'utf8');
    for (const match of [...source.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
      const specifier = match[2];
      const target = specifier.startsWith('@shared/') ? new URL(`../../../shared/${specifier.slice(8)}`, import.meta.url).href
        : specifier.startsWith('.') ? await moduleURL(new URL(specifier, url)) : import.meta.resolve(specifier);
      source = source.replace(match[0], `from ${JSON.stringify(target)}`);
    }
    return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  })());
  return modules.get(url.href);
}
export async function loadClient(name) { return import(await moduleURL(new URL(`../../../src/game/${name}`, import.meta.url))); }

export function mockDocument(t) {
  const previous = globalThis.document;
  const elements = new Map(), element = () => ({ textContent: '', hidden: false, style: {}, classList: { toggle() {} },
    querySelectorAll: () => [element(), element(), element()], getContext: () => ({ fillRect() {}, fillText() {} }) });
  globalThis.document = { createElement: element, getElementById(id) {
    if (!elements.has(id)) elements.set(id, element()); return elements.get(id);
  } };
  t.after(() => { globalThis.document = previous; });
  return elements;
}
