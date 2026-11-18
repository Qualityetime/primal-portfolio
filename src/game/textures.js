import * as THREE from 'three';

// Small procedural textures for the ravine's restrained, PS1-like texture
// language: low resolution, crisp texels up close (nearest magnification),
// mipmapped in the distance so nothing shimmers. Built from typed arrays, so
// they need no DOM canvas and also load in Node tests.

export function hash2(x, y, seed = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
// Tileable value noise with period `period` cells.
export function valueNoise(x, y, period, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const wrap = v => ((v % period) + period) % period;
  const s = t => t * t * (3 - 2 * t);
  const a = hash2(wrap(xi), wrap(yi), seed), b = hash2(wrap(xi + 1), wrap(yi), seed);
  const c = hash2(wrap(xi), wrap(yi + 1), seed), d = hash2(wrap(xi + 1), wrap(yi + 1), seed);
  return a + (b - a) * s(xf) + (c - a) * s(yf) + (a - b - c + d) * s(xf) * s(yf);
}
export function fbm(x, y, period, seed = 0, octaves = 3) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, period, seed + o * 17) * amp; norm += amp;
    x *= 2; y *= 2; period *= 2; amp *= 0.5;
  }
  return sum / norm;
}

function finish(data, width, height, { color = true, repeat = true, alpha = false } = {}) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = texture.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  texture.userData.alpha = alpha;
  texture.needsUpdate = true;
  return texture;
}

function paint(width, height, painter) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a = 1] = painter(x, y);
    const o = (y * width + x) * 4;
    data[o] = Math.max(0, Math.min(255, r * 255)); data[o + 1] = Math.max(0, Math.min(255, g * 255));
    data[o + 2] = Math.max(0, Math.min(255, b * 255)); data[o + 3] = Math.max(0, Math.min(255, a * 255));
  }
  return data;
}

// Neutral, low-contrast earth detail multiplied over terrain vertex colours.
export function groundTexture(size = 64) {
  return finish(paint(size, size, (x, y) => {
    const n = fbm(x / 8, y / 8, size / 8, 3), grit = hash2(x, y, 9);
    const pebble = valueNoise(x / 3, y / 3, size / 3, 21) > 0.78 ? 0.08 : 0;
    const v = 0.93 + (n - 0.5) * 0.13 + (grit - 0.5) * 0.035 + pebble * 0.6;
    return [v, v * 0.98, v * 0.94];
  }), size, size);
}

// Cliff rock: broken horizontal strata and soft mottling, neutral grey so the
// vertex colours (moss, damp) stay in charge of the palette.
export function rockTexture(size = 64) {
  return finish(paint(size, size, (x, y) => {
    const strata = valueNoise(x / 16, y / 4, size / 16, 4);
    const cracks = Math.abs(valueNoise(x / 8, y / 8, size / 8, 8) - 0.5) < 0.025 ? -0.09 : 0;
    const n = fbm(x / 9, y / 9, size / 9, 11);
    const v = 0.86 + (n - 0.5) * 0.2 + (strata - 0.5) * 0.07 + cracks + (hash2(x, y, 2) - 0.5) * 0.03;
    return [v, v, v * 0.97];
  }), size, size);
}

export function barkTexture(width = 32, height = 64) {
  return finish(paint(width, height, (x, y) => {
    const ridge = valueNoise(x / 2.2, y / 14, width / 2.2, 5);
    const v = 0.7 + (ridge - 0.5) * 0.45 + (hash2(x, y, 6) - 0.5) * 0.06;
    return [v * 0.95, v * 0.86, v * 0.72];
  }), width, height);
}

export function hideTexture(size = 32) {
  return finish(paint(size, size, (x, y) => {
    const n = fbm(x / 5, y / 5, size / 5, 31);
    const v = 0.78 + (n - 0.5) * 0.3;
    return [v, v * 0.85, v * 0.66];
  }), size, size);
}

// Alpha-cut leaf cards. Each frond is drawn along +y (base at the bottom).
function leafCard(width, height, shape, seed) {
  return finish(paint(width, height, (x, y) => {
    const u = (x + 0.5) / width * 2 - 1, v = (y + 0.5) / height;
    const result = shape(u, v);
    if (!result) return [0, 0, 0, 0];
    const tone = 0.85 + (hash2(x, y, seed) - 0.5) * 0.18;
    return [result[0] * tone, result[1] * tone, result[2] * tone, 1];
  }), width, height, { repeat: false, alpha: true });
}

export function fernTexture() {
  // A rachis with paired, tapering pinnae.
  return leafCard(64, 128, (u, v) => {
    const taper = 1 - v * 0.85;
    if (Math.abs(u) < 0.045 && v < 0.98) return [0.32, 0.42, 0.2];
    const along = (v * 22) % 1, pinna = 0.9 * taper * (1 - Math.abs(u) * 0.15);
    const lobe = Math.abs(u) < pinna && Math.abs(along - 0.5 + Math.abs(u) * 0.35) < 0.36 * (1 - Math.abs(u) / (pinna + 0.001) * 0.6);
    if (!lobe || v < 0.06 || v > 0.97) return null;
    const light = 0.8 + Math.abs(u) * 0.3;
    return [0.33 * light, 0.5 * light, 0.2 * light];
  }, 41);
}

export function broadleafTexture() {
  // One large, glossy leaf with a midrib and lateral veins.
  return leafCard(64, 128, (u, v) => {
    const width = Math.sin(Math.min(1, v * 1.08) * Math.PI) ** 0.75 * 0.92;
    if (Math.abs(u) > width || v < 0.03) return null;
    if (Math.abs(u) < 0.035) return [0.42, 0.5, 0.26];
    const vein = Math.abs(((v * 9 + Math.abs(u) * 3) % 1) - 0.5) < 0.04;
    const shade = 0.72 + (1 - Math.abs(u) / width) * 0.22;
    return vein ? [0.3 * shade, 0.45 * shade, 0.2 * shade] : [0.22 * shade, 0.38 * shade, 0.16 * shade];
  }, 43);
}

export function palmTexture() {
  // Long frond: slender leaflets either side of a central stem.
  return leafCard(32, 128, (u, v) => {
    if (Math.abs(u) < 0.07) return [0.36, 0.38, 0.2];
    const along = (v * 30) % 1, reach = (1 - v * 0.7);
    if (Math.abs(u) > reach || Math.abs(along - 0.5 - Math.abs(u) * 0.3) > 0.32 || v < 0.05) return null;
    return [0.25, 0.36 + Math.abs(u) * 0.08, 0.17];
  }, 47);
}

export function grassTexture() {
  return leafCard(32, 32, (u, v) => {
    for (let blade = 0; blade < 7; blade++) {
      const base = -0.8 + blade * 0.27, lean = (hash2(blade, 1, 3) - 0.5) * 0.6, height = 0.55 + hash2(blade, 2, 3) * 0.45;
      if (v < height && Math.abs(u - base - lean * v) < 0.09 * (1 - v / height)) return [0.33, 0.42 + v * 0.1, 0.2];
    }
    return null;
  }, 49);
}

export function vineTexture() {
  // Hanging strands with small paired leaves.
  return leafCard(32, 128, (u, v) => {
    for (let s = 0; s < 3; s++) {
      const x = -0.55 + s * 0.55 + Math.sin(v * 9 + s) * 0.08, length = 0.55 + hash2(s, 4, 7) * 0.45;
      if (1 - v > length) continue;
      if (Math.abs(u - x) < 0.05) return [0.26, 0.34, 0.17];
      const leaf = (v * 18 + s * 0.3) % 1;
      if (leaf < 0.45 && Math.abs(u - x) < 0.24 * Math.sin(leaf / 0.45 * Math.PI)) return [0.25, 0.4, 0.18];
    }
    return null;
  }, 53);
}

// Bright vertical streaks for the falls (scrolled in the shader).
export function fallTexture(width = 32, height = 64) {
  return finish(paint(width, height, (x, y) => {
    const streak = valueNoise(x / 1.6, y / 10, width / 1.6, 61), fleck = valueNoise(x / 2, y / 3, width / 2, 63);
    const v = 0.65 + streak * 0.3 + (fleck > 0.7 ? 0.12 : 0);
    return [v * 0.92, v * 0.97, v, 0.55 + streak * 0.45];
  }), width, height, { alpha: true });
}

// Soft round puff for mist sprites (linear filtering; it is a blur, not a texel).
export function puffTexture(size = 32) {
  const texture = finish(paint(size, size, (x, y) => {
    const d = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    const a = Math.max(0, 1 - d) ** 1.6;
    return [1, 1, 1, a];
  }), size, size, { repeat: false, alpha: true });
  texture.magFilter = THREE.LinearFilter;
  return texture;
}
