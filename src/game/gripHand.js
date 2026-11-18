import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { assetUrl } from './assetUrl.js';

// Spear Ownership 0.1: purpose-built first-person hands and forearms.
//
// The Neanderthal's skinned hands cannot close cleanly around the hide grip
// wrap, so first person uses its own low-poly arms. They are built for the
// player camera, textured with swatches cut from the character's own baked
// texture (assets/fp-skin.png and assets/fp-wrap.png), and flat-shaded like
// the rest of the game.
//
// Each hand is modelled in a natural HAND frame (+Y toward the fingers, +Z the
// back of the hand, wrist at the origin), with the shaft crossing the palm
// diagonally as in a real power grip. Each finger is three phalanges that
// bend at their joints around the shaft. The finished hand is fixed in
// spear-local space: a grip never rotates to meet an arm. Each forearm runs
// straight out of its wrist, so the wrist is always continuous with the
// forearm.
//
//  RIGHT = dominant rear hand, locked from the approved full-thrust pose:
//          the thumb wraps over the top of the shaft and presses down; all
//          four fingers sit under the shaft and curl up the far side; the
//          palm is below and outside the shaft; index and thumb point toward
//          the head. The forearm runs straight out of the wrist (neutral), so
//          at full thrust forearm, wrist, hand and spear read as one line.
//  LEFT  = forward underhand support: palm up under the shaft, fingers curled
//          only part way up the far side, thumb lying along the near side
//          toward the head. Lighter and more open than the right.

// First person draws the spear slimmer across (FP_SHAFT_SCALE). The 0.072 m
// hide grip wrap reads as a log in a hand at arm's length from the camera.
// Presentation only: world spears are unchanged.
export const FP_SHAFT_SCALE = 0.74;
// Radius each hand closes on, as drawn in first person. The spear is six-sided,
// so this sits between the flats and the corners: the right hand holds the
// hide grip wrap (0.035-0.036 m), the left the bare shaft just ahead of it
// (about 0.029 m there).
export const GRIP_RADIUS = Object.freeze({ right: 0.0331 * FP_SHAFT_SCALE, left: 0.0268 * FP_SHAFT_SCALE });
const deg = Math.PI / 180;

// Hand-frame measurements (metres): a broad Neanderthal palm with short,
// thick fingers and a strong thumb. Fingers index first; len = proximal,
// middle and distal phalanx.
const HAND = Object.freeze({
  wrist: Object.freeze([0.0215, 0.0155]),
  fingers: Object.freeze([
    Object.freeze({ x: -0.0235, y: 0.083, r: 0.0084, len: Object.freeze([0.039, 0.024, 0.019]) }),
    Object.freeze({ x: -0.0075, y: 0.086, r: 0.0087, len: Object.freeze([0.043, 0.027, 0.020]) }),
    Object.freeze({ x: 0.0085, y: 0.083, r: 0.0082, len: Object.freeze([0.040, 0.025, 0.019]) }),
    Object.freeze({ x: 0.0230, y: 0.077, r: 0.0073, len: Object.freeze([0.032, 0.019, 0.016]) }),
  ]),
  thumb: Object.freeze({ base: Object.freeze([-0.033, 0.036, -0.007]), r: 0.0102, len: Object.freeze([0.033, 0.027]) }),
  palmFace: -0.009,
  back: 0.0105,
});
// obliquity: angle (deg) between the knuckle line and the shaft as it crosses
// the palm; centre: where the shaft crosses the palm (hand-frame y);
// indexToward: -1 when the index-finger end of the grip faces the spear's
// head (both hands here: thumbs forward, as in a real two-handed spear hold),
// +1 when it faces the butt. closure: how far each phalanx
// bends round the shaft (1 = closed on it, less = a looser, more open curl);
// thumb: 'wrap' closes it under the shaft, 'along' lays it on the near side.
// wristExtension: wrist bent back (deg), so a palm-up hand can meet a forearm
// rising from below. drift: how far the fingers travel along the shaft as
// they wrap (0 = straight round it).
export const GRIP_DESIGN = Object.freeze({
  right: Object.freeze({ obliquity: 80, centre: 0.056, indexToward: -1, closure: Object.freeze([1, 1, 1]), thumb: 'wrap', thumbWrap: 72, wristExtension: 0, drift: 0.3 }),
  left: Object.freeze({ obliquity: 55, centre: 0.058, indexToward: -1, closure: Object.freeze([1, 1, 1]), lift: Object.freeze([0.0005, 0.002, 0.004]), thumb: 'along', thumbWrap: 0, wristExtension: 45, drift: 0.15 }),
});
// Forearm cross-sections from the wrist (distance, half-width, half-depth).
const FOREARM = Object.freeze([[0, 0.0215, 0.0155], [0.03, 0.0245, 0.0175], [0.09, 0.031, 0.023], [0.16, 0.037, 0.028], [0.25, 0.041, 0.032], [0.36, 0.043, 0.034]]);
const WRAP = Object.freeze({ from: 0.022, to: 0.1, lift: 0.0035 });
const WRIST_CENTRE = Object.freeze(new THREE.Vector3(0, 0.003, 0.001));

// ---- textures/materials ----------------------------------------------------
// The swatches already carry the character's skin and bracer colours, so the
// material colours stay close to neutral: a warm tint multiplies into a red
// that does not match the third-person body.
export const SKIN_TONE = Object.freeze({ skin: 0xefefef, shade: 0xd2d2d2, nail: 0xf8f0ea, wrap: 0xe6e6e6 });
// Textures need a browser document (images); Node checks use the flat colours.
const loader = typeof document === 'undefined' || typeof document.createElementNS !== 'function' ? null : new THREE.TextureLoader();
function swatch(path) {
  if (!loader) return null;
  const texture = loader.load(path);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
let shared = null;
export function armMaterials() {
  shared ??= (() => {
    const skinMap = swatch(assetUrl('game/fp-skin.png')), wrapMap = swatch(assetUrl('game/fp-wrap.png'));
    const m = {
      skin: new THREE.MeshLambertMaterial({ color: SKIN_TONE.skin, map: skinMap, flatShading: true }),
      skinShade: new THREE.MeshLambertMaterial({ color: SKIN_TONE.shade, map: skinMap, flatShading: true }),
      wrap: new THREE.MeshLambertMaterial({ color: SKIN_TONE.wrap, map: wrapMap, flatShading: true }),
      nail: new THREE.MeshLambertMaterial({ color: SKIN_TONE.nail, map: skinMap, flatShading: true }),
    };
    // Without textures (tests, failed loads) the swatches' average colours.
    if (!skinMap) { m.skin.color.setHex(0xa3725a); m.skinShade.color.setHex(0x8d634e); m.wrap.color.setHex(0x5a4330); }
    return m;
  })();
  return shared;
}

// ---- geometry helpers ------------------------------------------------------
function tube(points, sections, up, sides = 7, uvScale = 9, caps = [true, true]) {
  const positions = [], uvs = [], rings = [];
  let length = 0;
  for (let i = 0; i < points.length; i++) {
    const t = new THREE.Vector3().subVectors(points[Math.min(i + 1, points.length - 1)], points[Math.max(i - 1, 0)]).normalize();
    const d = up.clone().addScaledVector(t, -up.dot(t)).normalize(), w = new THREE.Vector3().crossVectors(t, d);
    if (i > 0) length += points[i].distanceTo(points[i - 1]);
    const [hw, hd] = sections[i];
    rings.push({ v: length * uvScale, ring: Array.from({ length: sides }, (_, s) => {
      const a = s / sides * Math.PI * 2;
      return points[i].clone().addScaledVector(w, Math.cos(a) * hw).addScaledVector(d, Math.sin(a) * hd);
    }) });
  }
  const push = (p, u, v) => { positions.push(p.x, p.y, p.z); uvs.push(u, v); };
  for (let i = 0; i < rings.length - 1; i++) for (let s = 0; s < sides; s++) {
    const a = rings[i].ring[s], b = rings[i].ring[(s + 1) % sides], c = rings[i + 1].ring[(s + 1) % sides], e = rings[i + 1].ring[s];
    const u0 = s / sides * 0.35, u1 = (s + 1) / sides * 0.35, v0 = rings[i].v, v1 = rings[i + 1].v;
    push(a, u0, v0); push(c, u1, v1); push(b, u1, v0);
    push(a, u0, v0); push(e, u0, v1); push(c, u1, v1);
  }
  for (const [k, flip, on] of [[0, true, caps[0]], [rings.length - 1, false, caps[1]]]) {
    if (!on) continue;
    const ring = rings[k].ring, centre = ring.reduce((m, p) => m.add(p), new THREE.Vector3()).divideScalar(sides);
    for (let s = 0; s < sides; s++) {
      const a = ring[s], b = ring[(s + 1) % sides];
      if (flip) { push(centre, 0.5, 0.5); push(a, 0.4, 0.4); push(b, 0.6, 0.4); } else { push(centre, 0.5, 0.5); push(b, 0.6, 0.4); push(a, 0.4, 0.4); }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
}
function hull(points, uvScale = 9) {
  const geometry = new ConvexGeometry(points);
  const pos = geometry.attributes.position, uv = [];
  for (let i = 0; i < pos.count; i++) uv.push(pos.getX(i) * uvScale + pos.getZ(i) * uvScale * 0.7, pos.getY(i) * uvScale - pos.getZ(i) * uvScale * 0.4);
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return geometry;
}
function ellipse(centre, xAxis, zAxis, hw, hd, sides = 8) {
  return Array.from({ length: sides }, (_, s) => {
    const a = s / sides * Math.PI * 2;
    return centre.clone().addScaledVector(xAxis, Math.cos(a) * hw).addScaledVector(zAxis, Math.sin(a) * hd);
  });
}
function addMesh(group, geometry, material, name) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name; mesh.castShadow = false; mesh.receiveShadow = false;
  group.add(mesh);
  return mesh;
}
const polarG = (theta, radius, z) => new THREE.Vector3(Math.cos(theta) * radius, Math.sin(theta) * radius, z);

// A digit as a chain of phalanges closing round the shaft (the grip Z axis)
// from its base joint, turning `dir` about the axis. Each joint lands on the
// circle that keeps the digit on the shaft's surface, raised by lift[j] for
// a looser curl (the support hand's fingers rest round the shaft rather than
// clamping it); closure < 1 bends a joint less. Returns the joints.
function digitChain(base, lengths, radius, dir, closure, drift, R, lift = [0, 0, 0]) {
  const joints = [base.clone()];
  let rho = Math.hypot(base.x, base.y), theta = Math.atan2(base.y, base.x), z = base.z;
  lengths.forEach((length, j) => {
    const contact = R + radius + 0.0009 + lift[j];
    const c = THREE.MathUtils.clamp((rho * rho + contact * contact - length * length) / (2 * rho * contact), -1, 1);
    const turn = Math.acos(c) * closure[j];
    const next = rho * Math.cos(turn) + Math.sqrt(Math.max(0, length * length - rho * rho * Math.sin(turn) ** 2));
    theta += dir * turn; rho = next; z += drift * length;
    joints.push(polarG(theta, rho, z));
  });
  return joints;
}

// A relaxed, open hand (fingers free of any shaft), in the hand frame: each
// finger fans slightly from the middle and curls gently toward the palm (-Z),
// more toward the little finger, as a hand at rest does. Flexion per joint
// (deg: knuckle, middle, end) and fan (deg, + toward the little finger).
export const RELAXED_HAND = Object.freeze({
  curl: Object.freeze([Object.freeze([22, 28, 14]), Object.freeze([26, 32, 16]), Object.freeze([30, 36, 18]), Object.freeze([34, 40, 20])]),
  fan: Object.freeze([-6, -2, 2, 7]),
});
function relaxedDir(i, phi, out = new THREE.Vector3()) {
  const fan = RELAXED_HAND.fan[i] * deg;
  return out.set(Math.sin(fan) * Math.cos(phi), Math.cos(fan) * Math.cos(phi), -Math.sin(phi));
}
// Knuckle and the three joints of finger i (hand frame; V mirrors x for the left hand).
function relaxedFinger(V, x, y, len, i) {
  const points = [V(x, y, 0.003)];
  let phi = 0;
  len.forEach((length, j) => {
    phi += RELAXED_HAND.curl[i][j] * deg;
    const d = relaxedDir(i, phi);
    points.push(points.at(-1).clone().add(V(d.x, d.y, d.z).multiplyScalar(length)));
  });
  return points;
}
// The back of finger i's last phalanx (where its nail faces), hand frame.
function relaxedNailOut(V, i) {
  const phi = RELAXED_HAND.curl[i].reduce((a, b) => a + b, 0) * deg, fan = RELAXED_HAND.fan[i] * deg;
  return V(Math.sin(fan) * Math.sin(phi), Math.cos(fan) * Math.sin(phi), Math.cos(phi));
}

// The shaft in the hand frame: a cylinder of radius R under the palm, crossing
// it at `obliquity` from the knuckle line, its index end toward the butt or
// the head (design.indexToward). A proper rotation plus a translation, never
// a mirror: a right hand stays a right hand. Returns hand -> grip.
export function handToGrip(side, design = GRIP_DESIGN[side]) {
  const s = side === 'right' ? 1 : -1, R = GRIP_RADIUS[side]; // right thumb at -X, left at +X
  const a = design.obliquity * deg;
  const c = new THREE.Vector3(-s * Math.cos(a), Math.sin(a), 0);   // pinky side -> index side
  const origin = new THREE.Vector3(0, design.centre, HAND.palmFace - R - 0.0012);
  const zs = c.clone().multiplyScalar(design.indexToward);         // grip +Z = the butt
  const xs = new THREE.Vector3(0, 0, 1);                           // back of the hand -> grip +X
  const ys = new THREE.Vector3().crossVectors(zs, xs);
  const basis = new THREE.Matrix4().makeBasis(xs, ys, zs);
  return new THREE.Matrix4().copy(basis).transpose().multiply(new THREE.Matrix4().makeTranslation(-origin.x, -origin.y, -origin.z));
}

// A hand and its forearm in grip-local space.
function buildHand(side, { forearmLength = 0.36, design = GRIP_DESIGN[side], forearm = true } = {}) {
  const m = armMaterials(), group = new THREE.Group();
  const s = side === 'right' ? 1 : -1, toGrip = handToGrip(side, design), R = GRIP_RADIUS[side];
  const V = (x, y, z) => new THREE.Vector3(s * x, y, z);
  const G = v => v.clone().applyMatrix4(toGrip), D = v => v.clone().transformDirection(toGrip);
  const X = new THREE.Vector3(1, 0, 0), Z = new THREE.Vector3(0, 0, 1);

  // Hand body (hand frame): wrist ring, an arched mid-hand ring, the knuckle
  // row, and the thenar and heel pads; mirrored in x for the left hand. The
  // knuckles themselves are the finger bases, which stand slightly proud.
  const pts = [...ellipse(WRIST_CENTRE, X, Z, HAND.wrist[0], HAND.wrist[1])];
  for (const [x, zb] of [[-0.032, 0.0065], [-0.016, 0.0105], [0, 0.0115], [0.016, 0.0105], [0.029, 0.006]]) pts.push(V(x, 0.045, zb), V(x, 0.045, HAND.palmFace));
  HAND.fingers.forEach(({ x, y }, i) => {
    pts.push(V(x, y - 0.006, HAND.back - (i === 0 || i === 3 ? 0.004 : 0.0025)));    // back of the hand just behind the knuckle
    pts.push(V(x, y - 0.008, HAND.palmFace + 0.001));                                 // palm under the knuckle
  });
  pts.push(V(-0.0335, 0.072, 0.0), V(0.0305, 0.068, -0.001));                         // edges at the knuckle line
  pts.push(V(-0.028, 0.024, -0.0135), V(-0.035, 0.046, -0.0055), V(-0.021, 0.05, -0.0125)); // thenar
  pts.push(V(0.025, 0.022, -0.012), V(0.027, 0.05, -0.0105));                            // heel
  addMesh(group, hull(pts.map(G)), m.skin, 'palm');

  // Fingers: three phalanges each, closing over the shaft from the knuckles.
  // One curl direction for the whole hand (from the middle finger), so no
  // finger can curl the wrong way round the shaft.
  const forward = D(new THREE.Vector3(0, 1, 0));
  const curlDir = k => { const th = Math.atan2(k.y, k.x); return Math.sign(new THREE.Vector3(-Math.sin(th), Math.cos(th), 0).dot(forward)) || 1; };
  const dir = curlDir(G(V(HAND.fingers[1].x, HAND.fingers[1].y, 0.001)));
  const tips = [], fingerJoints = [];
  const relax = design.relax ?? 0;
  HAND.fingers.forEach(({ x, y, r, len }, i) => {
    const knuckle = G(V(x, y, 0.003));
    const joints = digitChain(knuckle, len, r, dir, design.closure, forward.z * (design.drift ?? 0.45), R, design.lift);
    if (relax > 0) {
      // A hand that has let go of the spear (first-person throw prep): the
      // fingers follow a natural relaxed curl in the hand's own frame instead
      // of a shaft that is no longer there (an open hand solved against the
      // shaft bends its outer joints backward and crosses the fingers).
      // Eased in quickly, so no joint passes through a backward bend while
      // the hand opens.
      const relaxed = relaxedFinger(V, x, y, len, i).map(G), w = 1 - (1 - relax) ** 3;
      joints.forEach((p, k) => p.lerp(relaxed[k], w));
    }
    const tip = joints.at(-1), last = joints.at(-2), along = tip.clone().sub(last).normalize();
    tips.push(tip.clone()); fingerJoints.push(joints.map(p => p.clone()));
    // The tube starts inside the hand so the knuckle reads as a bump.
    const points = [knuckle.clone().addScaledVector(forward, -0.012), ...joints.slice(0, 3), last.clone().lerp(tip, 0.72), tip.clone().addScaledVector(along, 0.002)];
    // Slightly narrower than the knuckle spacing, so the fingers read apart.
    const sections = [[r * 0.95, r * 0.92], [r * 1.22, r * 1.0], [r * 0.98, r * 0.93], [r * 0.88, r * 0.87], [r * 0.78, r * 0.79], [r * 0.36, r * 0.4]];
    addMesh(group, tube(points, sections, Z, 6, 30), i === 3 ? m.skinShade : m.skin, `finger${i}`);
    // Nail: a thin plate on the back of the last phalanx, low contrast.
    const out = new THREE.Vector3(tip.x + last.x, tip.y + last.y, 0).normalize();
    if (relax > 0) out.lerp(relaxedNailOut(V, i).transformDirection(toGrip), 1 - (1 - relax) ** 3).addScaledVector(along, -out.dot(along)).normalize();
    const nail = new THREE.Mesh(new THREE.BoxGeometry(0.0012, r * 0.85, r * 0.9), m.nail);
    nail.position.copy(last).lerp(tip, 0.62).addScaledVector(out, r * 0.7);
    nail.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(out, along, new THREE.Vector3().crossVectors(out, along)));
    nail.name = `nail${i}`;
    group.add(nail);
  });

  // Thumb from the thenar: the right thumb closes round under the shaft
  // toward the fingertips; the left (support) thumb lies along the near side
  // pointing toward the head.
  const t0 = G(V(...HAND.thumb.base)), tr = HAND.thumb.r;
  let thumb;
  if (design.thumb === 'wrap') {
    const turnTo = design.thumbWrap * deg, rho0 = Math.hypot(t0.x, t0.y), th0 = Math.atan2(t0.y, t0.x);
    const contact = R + tr + 0.0008;
    thumb = [t0, polarG(th0 - dir * turnTo * 0.5, (rho0 + contact) / 2, t0.z - 0.012), polarG(th0 - dir * turnTo, contact, t0.z - 0.024)];
  } else {
    const th0 = Math.atan2(t0.y, t0.x);
    thumb = [t0, polarG(th0 + dir * 0.14, R + tr + 0.0014, t0.z - 0.027), polarG(th0 + dir * 0.34, R + tr + 0.0010, t0.z - 0.047)];
  }
  const tAlong = thumb[2].clone().sub(thumb[1]).normalize();
  // The tube starts well inside the thenar so its end never shows.
  const thumbPts = [G(V(-0.017, 0.03, -0.003)), ...thumb, thumb[2].clone().addScaledVector(tAlong, 0.004)];
  addMesh(group, tube(thumbPts, [[tr * 1.1, tr * 1.15], [tr * 1.12, tr * 1.15], [tr * 0.98, tr], [tr * 0.82, tr * 0.86], [tr * 0.4, tr * 0.45]], Z, 6, 30), m.skinShade, 'thumb');

  // Forearm out of the wrist with its leather bracer: straight on (hand -Y)
  // for the right hand; the left support wrist is extended (bent back) so the
  // palm can face up while the forearm rises to it from below.
  const wrist = G(WRIST_CENTRE), backUp = D(new THREE.Vector3(0, 0, 1));
  const axis = D(forearmAxis(design)), first = D(new THREE.Vector3(0, -1, 0)).add(axis).normalize();
  const BEND = 0.016;
  const path = d => design.wristExtension ? (d <= BEND ? wrist.clone().addScaledVector(first, d) : wrist.clone().addScaledVector(first, BEND).addScaledVector(axis, d - BEND)) : wrist.clone().addScaledVector(axis, d);
  const sectionAt = d => {
    for (let i = 1; i < FOREARM.length; i++) if (d <= FOREARM[i][0]) {
      const [d0, w0, h0] = FOREARM[i - 1], [d1, w1, h1] = FOREARM[i], t = (d - d0) / (d1 - d0);
      return [w0 + (w1 - w0) * t, h0 + (h1 - h0) * t];
    }
    return FOREARM.at(-1).slice(1);
  };
  if (forearm) {
    const ds = [...new Set([...FOREARM.map(([d]) => d), ...(design.wristExtension ? [BEND] : [])])].sort((a, b) => a - b).filter(d => d < forearmLength).concat(forearmLength);
    addMesh(group, tube(ds.map(path), ds.map(sectionAt), backUp, 8, 7, [false, true]), m.skin, 'forearm');
    const wd = [WRAP.from, (WRAP.from + WRAP.to) / 2, WRAP.to];
    addMesh(group, tube(wd.map(path), wd.map(d => sectionAt(d).map(v => v + WRAP.lift)), backUp, 8, 5, [false, false]), m.wrap, 'wrap');
  }
  // Key points in grip-local space, for checks and debug views.
  group.userData.grip = {
    fingertips: tips, fingerJoints, thumbTip: thumbPts.at(-1).clone(), wrist: wrist.clone(), shaftRadius: R,
    forearm: axis.clone(), back: D(new THREE.Vector3(0, 0, 1)), palmNormal: D(new THREE.Vector3(0, 0, -1)),
  };
  return group;
}

export function buildRightGrip(options) { const g = buildHand('right', options); g.name = 'right-grip'; return g; }

// A forearm on its own, for arms that bend at the wrist: wrist centre at the
// origin, the forearm running down -Y to the elbow, +Z the back of the arm.
// It starts a little inside the hand so the wrist joint never opens a gap.
export function buildForearm({ length = 0.27 } = {}) {
  const m = armMaterials(), group = new THREE.Group(), Y = new THREE.Vector3(0, -1, 0), up = new THREE.Vector3(0, 0, 1);
  const sectionAt = d => {
    if (d <= 0) return FOREARM[0].slice(1).map(v => v * 0.96);
    for (let i = 1; i < FOREARM.length; i++) if (d <= FOREARM[i][0]) {
      const [d0, w0, h0] = FOREARM[i - 1], [d1, w1, h1] = FOREARM[i], t = (d - d0) / (d1 - d0);
      return [w0 + (w1 - w0) * t, h0 + (h1 - h0) * t];
    }
    return FOREARM.at(-1).slice(1);
  };
  const ds = [-0.012, ...FOREARM.map(([d]) => d).filter(d => d < length), length];
  addMesh(group, tube(ds.map(d => Y.clone().multiplyScalar(d)), ds.map(sectionAt), up, 8, 7, [false, true]), m.skin, 'forearm');
  const wd = [WRAP.from, (WRAP.from + WRAP.to) / 2, WRAP.to];
  addMesh(group, tube(wd.map(d => Y.clone().multiplyScalar(d)), wd.map(d => sectionAt(d).map(v => v + WRAP.lift)), up, 8, 5, [false, false]), m.wrap, 'wrap');
  group.name = 'forearm';
  return group;
}

// Upper arm from the elbow (origin) up -Y by `length` to the shoulder.
export function buildUpperArm({ length = 0.29 } = {}) {
  const m = armMaterials(), group = new THREE.Group(), Y = new THREE.Vector3(0, -1, 0);
  const ds = [-0.02, 0.06, length * 0.6, length + 0.04];
  addMesh(group, tube(ds.map(d => Y.clone().multiplyScalar(d)), [[0.042, 0.034], [0.046, 0.038], [0.052, 0.045], [0.056, 0.05]], new THREE.Vector3(0, 0, 1), 8, 7, [true, true]), m.skin, 'upperarm');
  group.name = 'upper-arm';
  return group;
}
export function buildLeftSupport(options) { const g = buildHand('left', options); g.name = 'left-support'; return g; }

// Forearm direction in the hand frame (away from the wrist): straight down
// the hand's -Y, tilted toward the back of the hand by any wrist extension.
function forearmAxis(design) {
  const e = (design.wristExtension ?? 0) * deg;
  return new THREE.Vector3(0, -Math.cos(e), Math.sin(e));
}

// Wrist socket in grip-local space (where the forearm meets its hand).
export function gripWrist(side, design = GRIP_DESIGN[side]) {
  const toGrip = handToGrip(side, design);
  return {
    point: WRIST_CENTRE.clone().applyMatrix4(toGrip),
    forearm: forearmAxis(design).transformDirection(toGrip),
    back: new THREE.Vector3(0, 0, 1).transformDirection(toGrip),
  };
}
export const GRIP_WRISTS = Object.freeze(Object.fromEntries(['right', 'left'].map(side => {
  const w = gripWrist(side);
  return [side, Object.freeze({ point: Object.freeze(w.point), forearm: Object.freeze(w.forearm), back: Object.freeze(w.back) })];
})));
