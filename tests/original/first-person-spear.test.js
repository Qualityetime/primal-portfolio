import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { HUNT } from '../../shared/hunt.js';
import { TICK_RATE } from '../../shared/config.js';
import { GameState } from '../../simulation/gameState.js';
import { loadClient, mockDocument } from './helpers/client.js';

// First-Person Spear Live Integration: the approved first-person spear runs in
// the live client (HuntView.viewModel = FirstPersonRig) on the local action
// clocks main.js starts, and the server's combat timing stays the truth.
const { FirstPersonRig } = await loadClient('firstPerson.js');
const fp = await loadClient('fpSpearMotion.js');
const { FP_ATTACK, FP_TIMING, FP_IDLE } = fp;
const ready = { health: 100, spears: 3, knockTicks: 0 };

function newRig() { const rig = new FirstPersonRig(); rig.resize(16 / 9); return rig; }
// Run a rig over [from, to] seconds at `hz` with clocks(t), returning per-step samples.
function run(rig, from, to, clocks, { state = ready, hz = 120, sample = () => null } = {}) {
  const out = [];
  for (let i = 0; from + i / hz <= to + 1e-9; i++) {
    const t = from + i / hz;
    rig.update(1 / hz, t, typeof state === 'function' ? state(t) : state, clocks(t), { active: true });
    out.push({ t, phase: rig.phase, pose: rig.pose, ...(sample(rig, t) ?? {}) });
  }
  return out;
}
const near = (a, b, eps = 1e-6) => a.grip.distanceTo(b.grip) < eps && a.leftPos.distanceTo(b.leftPos) < eps && Math.abs(a.att - b.att) < eps && 1 - Math.abs(a.q.dot(b.q)) < eps;

test('first-person spear: one production path — the live rig draws the approved keys, timing and hands', async () => {
  const source = await readFile(new URL('../../src/game/firstPerson.js', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/fpSpearMotion\.js'/); assert.match(source, /from '\.\/gripHand\.js'/);
  assert.doesNotMatch(source, /HeldSpearRig|CharacterArm|BlockArm|FP_STANCES/, 'no second (legacy) first-person implementation');
  // The approved keys and timing, unchanged.
  assert.deepEqual(FP_ATTACK.map(k => k.t), [0, 0.17, 0.3, 0.38, 0.56, 0.7, 0.82]);
  assert.deepEqual({ ...FP_TIMING }, { wind: 0.17, strike: 0.3, hold: 0.38, retract: 0.56, settle: 0.82 });
  assert.deepEqual(FP_ATTACK[2].spear, { yaw: -16, pitch: 6, roll: 30, screen: [0.32, -0.47], depth: 0.56 }, 'locked full-thrust key');
  assert.deepEqual(FP_ATTACK[0].left, { attach: 1, slide: 0.46, lroll: -86 }, 'approved left-hand idle');
  assert.deepEqual(FP_ATTACK.at(-1).spear, FP_IDLE.spear, 'the cycle ends on the idle');
});

test('first-person spear: an attack begins from the live runtime state — HuntView\'s local thrust clock drives the view model', async t => {
  mockDocument(t);
  const { HuntView } = await loadClient('huntView.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const view = new HuntView(scene, camera, { boarMode: 'placeholder' });
  let now = 10000;
  const step = ms => { for (let i = 0; i < ms / (1000 / 60); i++) { now += 1000 / 60; view.update(now, 1 / 60, ready, true, {}); } };
  step(500);
  assert.equal(view.viewModel.phase, 'hold'); assert.equal(view.viewModel.stance, 'ready');
  const realNow = performance.now; performance.now = () => now;
  try { view.thrust(); } finally { performance.now = realNow; }
  step(300);
  assert.equal(view.viewModel.phase, 'attack', 'main.js\' thrust input starts the approved attack');
  assert.ok(view.viewModel.pose.att < 0.05, 'the left hand has cleared');
  step(700);
  assert.equal(view.viewModel.phase, 'hold', 'and it settles back into the idle');
  view.clear();
});

test('first-person spear: the visual cycle is the approved ~0.82 s — wind-up, strike, hold, retract, settle — and lands back on the exact idle', () => {
  const rig = newRig();
  run(rig, 0, 0.5, () => ({}));
  const rows = run(rig, 0.5, 2, t => ({ thrustAge: t >= 1 ? t - 1 : Infinity }));
  const at = s => rows.reduce((b, r) => Math.abs(r.t - (1 + s)) < Math.abs(b.t - (1 + s)) ? r : b);
  const P = rig.poser, idle = P.holdState(FP_IDLE), strike = P.segState(FP_ATTACK, FP_TIMING.strike);
  assert.equal(at(0.01).phase, 'attack');
  assert.ok(near(at(FP_TIMING.strike).pose, strike, 1e-3) && near(at(FP_TIMING.hold - 0.01).pose, strike, 1e-3), 'full extension held 0.30-0.38 s');
  assert.ok(at(0.33).pose.att < 1e-6, 'left hand cleared through the strike');
  assert.ok(at(0.62).pose.att > 0.3, 'left hand coming back under the shaft in the settle');
  assert.equal(at(FP_TIMING.settle - 0.02).phase, 'attack');
  assert.equal(at(FP_TIMING.settle + 0.02).phase, 'hold');
  assert.ok(near(at(0.95).pose, idle, 1e-4), 'recovery restores the approved left-hand idle exactly');
  // Full extension covers the server's full-reach time (0.35 s) inside its hit window (0.12-0.40 s).
  assert.ok(FP_TIMING.strike <= 0.35 && 0.35 <= FP_TIMING.hold && FP_TIMING.hold <= 0.4);
});

test('first-person spear: server combat timing is unchanged (39-tick thrust, reach window), the view only reads it', () => {
  assert.equal(HUNT.thrustCooldown, 0.64); assert.equal(HUNT.windupSeconds, 0.9); assert.equal(HUNT.throwCooldown, 0.8);
  const game = new GameState();
  const p = game.addPlayer('a', { room: 'FP', name: 'Hunter' });
  const starts = new Set();
  for (let i = 0; i < 2 * TICK_RATE; i++) {
    const tick = game.tick + 1;
    game.receiveInput('a', 'FP', [{ forward: 0, strafe: 0, yaw: 0, pitch: 0, sprint: false, jump: false, attack: true, seq: i + 1 }], tick * 1000 / TICK_RATE);
    game.step(tick * 1000 / TICK_RATE);
    for (const e of game.snapshot('FP').hunt.events) if (e.type === 'thrust') starts.add(e.tick);
  }
  const ticks = [...starts].sort((a, b) => a - b);
  assert.ok(ticks.length >= 3);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i] - ticks[i - 1] >= Math.ceil(HUNT.thrustCooldown * TICK_RATE), 'next thrust no sooner than the server allows');
  assert.ok(p.state.spears === 3, 'thrusting never spends a spear');
});

test('first-person spear: a chained attack blends from the recovery pose — no idle frame, no pop, no spear jump', () => {
  const rig = newRig();
  run(rig, 0, 0.5, () => ({}));
  const starts = [1, 1 + 0.65];
  const clocks = t => { const s = starts.filter(x => x <= t + 1e-9).at(-1); return { thrustAge: s === undefined ? Infinity : t - s }; };
  const rows = run(rig, 0.5, 3.2, clocks, { hz: 240, sample: r => ({ tip: r.spear.localToWorld(new THREE.Vector3(0, 0, -1.1)), left: r.leftHand.position.clone() }) });
  const idle = rig.poser.holdState(FP_IDLE);
  const between = rows.filter(r => r.t > 1.4 && r.t < 2.2);
  assert.ok(between.every(r => r.phase === 'attack'), 'one attack runs straight into the next');
  assert.ok(!between.some(r => near(r.pose, idle, 1e-3)), 'no fake idle frame between the attacks');
  // Never faster than the approved single attack itself moves (its strike is
  // the fastest motion), and smooth right across the interruption.
  const steps = rs => {
    const m = { grip: 0, tip: 0, left: 0 };
    for (let i = 1; i < rs.length; i++) {
      m.grip = Math.max(m.grip, rs[i].pose.grip.distanceTo(rs[i - 1].pose.grip));
      m.tip = Math.max(m.tip, rs[i].tip.distanceTo(rs[i - 1].tip));
      m.left = Math.max(m.left, rs[i].left.distanceTo(rs[i - 1].left));
    }
    return m;
  };
  const single = newRig(); run(single, 0, 0.5, () => ({}));
  const ref = steps(run(single, 0.5, 2.2, t => ({ thrustAge: t >= 1 ? t - 1 : Infinity }), { hz: 240, sample: r => ({ tip: r.spear.localToWorld(new THREE.Vector3(0, 0, -1.1)), left: r.leftHand.position.clone() }) }));
  const chained = steps(rows);
  for (const key of ['grip', 'tip', 'left']) assert.ok(chained[key] <= ref[key] * 1.02 + 1e-6, `${key}: chained ${chained[key].toFixed(4)} m/step vs single ${ref[key].toFixed(4)}`);
  // Across the interruption nothing moves faster than it already was (the left
  // hand was rising back to the shaft; it eases out of that rise).
  const before = steps(rows.filter(r => r.t > starts[1] - 0.06 && r.t <= starts[1]));
  const across = steps(rows.filter(r => r.t > starts[1] - 0.01 && r.t < starts[1] + 0.05));
  assert.ok(across.grip <= Math.max(before.grip, 0.006) * 1.05 && across.left <= before.left * 1.05,
    `no pop at the interruption (grip ${across.grip.toFixed(4)} vs ${before.grip.toFixed(4)}, left ${across.left.toFixed(4)} vs ${before.left.toFixed(4)})`);
  // From the second wind-up key on, it is the single attack exactly.
  const after = rows.find(r => r.t >= starts[1] + FP_TIMING.wind + 0.05);
  assert.ok(near(after.pose, rig.poser.segState(FP_ATTACK, after.t - starts[1]), 1e-4));
  assert.ok(near(rows.at(-1).pose, idle, 1e-4), 'and it settles back into the idle');
});

test('first-person spear: the held spear is never shown alongside its thrown world spear, and is local-only', async t => {
  mockDocument(t);
  const { HuntView } = await loadClient('huntView.js');
  const { RemotePlayers } = await loadClient('avatars.js');
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const view = new HuntView(scene, camera, { boarMode: 'placeholder' });
  const remotes = new RemotePlayers(scene, { mode: 'bean' }); view.linkRemotes(remotes);
  assert.ok(!scene.getObjectById(view.viewModel.spear.id), 'the first-person spear lives in its own view scene, never in the world');
  let now = 10000;
  const step = (ms, state) => { for (let i = 0; i < ms / (1000 / 60); i++) { now += 1000 / 60; view.update(now, 1 / 60, state, true, {}); } };
  step(300, ready);
  const realNow = performance.now; performance.now = () => now;
  try { view.thrown(); } finally { performance.now = realNow; }
  step(40, { ...ready, spears: 2 });
  assert.equal(view.viewModel.spear.visible, true, 'held through the drive');
  step(120, { ...ready, spears: 2 });
  assert.equal(view.viewModel.spear.visible, false, 'once released the held spear is gone — the world spear is the only one');
  step(600, { ...ready, spears: 2 });
  assert.equal(view.viewModel.spear.visible, true, 're-armed from the spears left');
  view.clear();
});

// ---- First-person throw left-hand finger hotfix ----------------------------
// The let-go left hand in the throw prep must stay a believable hand: its
// fingers follow a relaxed curl (not a spear shaft it no longer holds), so no
// joint bends backward and no fingers cross. Idle and thrust hands are untouched.
function fingerReport(rig, axisSign) {
  const mesh = rig.leftShown, g = mesh.userData.grip, fingers = g.fingerJoints;
  const axis = fingers[3][0].clone().sub(fingers[0][0]).normalize().multiplyScalar(axisSign);  // knuckle line
  const flex = fingers.flatMap(js => {
    const segs = js.slice(1).map((p, k) => p.clone().sub(js[k]).normalize());
    return segs.slice(1).map((b, k) => Math.atan2(segs[k].clone().cross(b).dot(axis), segs[k].dot(b)) * 180 / Math.PI);
  });
  let clearance = Infinity;
  const pts = js => js.slice(1).flatMap((p, k, a) => k ? Array.from({ length: 9 }, (_, s) => a[k - 1].clone().lerp(p, s / 8)) : []);
  for (let i = 0; i < 3; i++) for (const p of pts(fingers[i])) for (const q of pts(fingers[i + 1])) clearance = Math.min(clearance, p.distanceTo(q));
  return { flex, clearance, key: [...rig.leftMeshes].find(([, m]) => m === mesh)[0] };
}
test('first-person throw: the left hand stays anatomical through the throw prep and at full draw (no crumpled fingers)', () => {
  const rig = newRig();
  run(rig, 0, 1, () => ({}));
  // Flexion sign from the approved closed support grip (its knuckles flex forward).
  const idle = fingerReport(rig, 1), axisSign = idle.flex[0] > 0 ? 1 : -1;
  assert.equal(typeof idle.key, 'number', 'idle uses the original support hand');
  const charge = t => ({ ...ready, winding: true, windupTime: Math.min(1.05, t - 1) });
  const samples = run(rig, 1 + 1 / 120, 2.3, () => ({}), { state: charge, sample: r => fingerReport(r, axisSign) });
  for (const s of samples) {
    assert.ok(Math.max(...s.flex) < 60, `no extreme curl (${Math.max(...s.flex).toFixed(1)} deg)`);
    assert.ok(Math.min(...s.flex) > -5, `no finger joint bends backward while the hand opens (${Math.min(...s.flex).toFixed(1)} deg at ${s.t.toFixed(3)} s)`);
    assert.ok(s.clearance >= idle.clearance - 1e-4, `fingers never closer than in the approved support grip (${(s.clearance * 1000).toFixed(1)} mm)`);
  }
  const full = samples.at(-1);
  assert.ok(full.pose.relax > 0.99 && full.pose.att < 0.01, 'full draw: the left hand has let go and rests in the relaxed hand');
  assert.ok(full.flex.every(a => a > 5), 'full draw: every finger joint gently flexed (a relaxed curl, not straight or bent back)');
  assert.ok(full.clearance > 0.017, `full draw: fingers separated and readable (${(full.clearance * 1000).toFixed(1)} mm between neighbours)`);
});
test('first-person throw: the finger hotfix leaves idle and every thrust hand exactly as approved; the throw still releases and re-arms', () => {
  const rig = newRig();
  const attack = run(rig, 0, 2.2, t => ({ thrustAge: t >= 0.5 ? t - 0.5 : Infinity }), { sample: r => ({ key: [...r.leftMeshes].find(([, m]) => m === r.leftShown)[0] }) });
  assert.ok(attack.some(s => s.phase === 'attack'));
  assert.ok(attack.every(s => (s.pose.relax ?? 0) === 0 && typeof s.key === 'number'), 'idle and thrust frames use only the original (shaft-solved) left-hand meshes');
  const rig2 = newRig();
  run(rig2, 0, 1, () => ({}));
  run(rig2, 1 + 1 / 120, 2.2, () => ({}), { state: t => ({ ...ready, winding: true, windupTime: Math.min(1.05, t - 1) }) });
  const thrown = run(rig2, 2.2 + 1 / 120, 3.4, t => ({ throwAge: t - 2.25 }), { state: { ...ready, spears: 2 }, sample: r => ({ held: r.spear.visible }) });
  const at = t => thrown.find(s => s.t >= t - 1e-9);
  assert.equal(at(2.25 + 0.05).held, true, 'held through the drive');
  assert.equal(at(2.25 + 0.1).held, false, 'released at the release point');
  assert.equal(at(2.25 + 0.4).held, true, 're-armed from the remaining spears');
  assert.ok((thrown.at(-1).pose.relax ?? 0) < 0.02 && thrown.at(-1).pose.att > 0.98, 'back to the approved underhand support after the throw');
});
