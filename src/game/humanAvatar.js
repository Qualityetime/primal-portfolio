import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER } from '@shared/config.js';
import { createSpear } from './spearModel.js';
import { CharacterArm, HAND_GRIP, gripQuaternion, handOnShaft } from './armRig.js';
import { HeldSpearRig } from './spearRig.js';
import { TP_STANCES } from './handSlots.js';
import { UpperBodyLayer, rigPose } from './remoteSpear.js';
import { assetUrl } from './assetUrl.js';

// Spear Ownership 0.1: how far a hunter's spear stances follow their aim.
const AIM_STANCES = new Set(['thrust', 'windup', 'release', 'brace']);
const _chest = new THREE.Vector3(), _shoulder = new THREE.Vector3(), _hy = new THREE.Vector3(), _gp = new THREE.Vector3(), _hq = new THREE.Quaternion(), _fa = new THREE.Vector3(), _wp = new THREE.Vector3(), _pole = new THREE.Vector3(), _poleQ = new THREE.Quaternion(), _idQ = new THREE.Quaternion();
// Remote thrust arm at full extension (visual only): wrist-to-shoulder
// distance as a share of the arm's length (0.975 = about 25 deg of elbow
// bend), how far the arm line leans from the fist's natural forearm axis toward
// the exact shaft line, the fist's natural ulnar set (radians, - = ulnar),
// how far a thrust's elbow pole leans toward a neutral wrist (times pose wn)
// and the most it may turn away from the pose's own elbow pole (radians).
export const REMOTE_ARM = Object.freeze({ reach: 0.98, line: 0.45, ulnar: -0.3, pole: 1, cone: 0.45 });

// Visual-only settings. The supplied model is already 1.8 m tall with feet at y=0,
// but faces +Z. Game headings and the existing spear face -Z.
export const HUMAN_AVATAR = Object.freeze({
  assetPath: assetUrl('game/stonehide-human.glb'),
  scale: 1,
  yOffset: 0,
  facingOffset: Math.PI,
  sprintClip: 'Running', // Run_03 is the alternate; neither changes player speed.
  crossfadeSeconds: 0.16,
  slowSpeed: 3,
});
export const HUMAN_CLIPS = Object.freeze(['Casual_Walk', 'Walking', 'Running', 'Run_03', 'Dead']);

export function prepareHumanAsset(gltf) {
  const hips = gltf.scene.getObjectByName('mixamorigHips');
  let skinned = false;
  gltf.scene.traverse(object => { skinned ||= object.isSkinnedMesh === true; });
  if (!skinned || !hips) throw new Error('Human asset is missing its skinned mesh or hips.');
  const clips = new Map();
  for (const name of HUMAN_CLIPS) {
    const source = gltf.animations.find(clip => clip.name === name);
    if (!source) throw new Error(`Human asset is missing ${name}.`);
    const clip = source.clone();
    // Bake the allowed clips in place once, before sharing them. Preserve vertical
    // gait bob and the death fall, but anchor horizontal hips to the rest pose.
    for (const track of clip.tracks) {
      if (track.name !== `${hips.name}.position`) continue;
      for (let i = 0; i < track.values.length; i += 3) {
        track.values[i] = hips.position.x;
        track.values[i + 2] = hips.position.z;
      }
    }
    clips.set(name, clip);
  }
  return { scene: gltf.scene, clips };
}

// One request/parse per page, including concurrent joins and subsequent reconnects.
// Cache failures too: callers retain their Bean fallback rather than retrying per hunter.
export function createHumanAssetCache(loader = new GLTFLoader()) {
  let promise;
  return { load() {
    promise ??= Promise.resolve().then(() => loader.loadAsync(HUMAN_AVATAR.assetPath)).then(prepareHumanAsset);
    return promise;
  } };
}
const humanAssetCache = createHumanAssetCache();
export function loadHumanAsset() { return humanAssetCache.load(); }

export function locomotionState(state, speed, previous = 'rest') {
  if (state.health <= 0) return 'dead';
  if (state.knockTicks > 0) return 'rest';
  if (speed < (previous === 'rest' ? 0.18 : 0.12)) return 'rest';
  // Injury slows both existing gaits. Compare against that hunter's current
  // walk/sprint speeds so an injured sprint is still recognized as a sprint.
  const injuryScale = 1 - (state.injurySlow ?? 0) * 0.45;
  const runThreshold = (PLAYER.walkSpeed + PLAYER.sprintSpeed) * 0.5 * injuryScale;
  if (speed > runThreshold + (previous === 'run' ? -0.25 : 0.25)) return 'run';
  if (speed < HUMAN_AVATAR.slowSpeed + (previous === 'slow' ? 0.15 : -0.15)) return 'slow';
  return 'walk';
}

export class HumanAvatar {
  constructor(asset, sprintClip = HUMAN_AVATAR.sprintClip) {
    if (!['Running', 'Run_03'].includes(sprintClip)) throw new Error('Unsupported human sprint clip.');
    this.visual = new THREE.Group();
    this.visual.rotation.y = HUMAN_AVATAR.facingOffset;
    this.visual.position.y = HUMAN_AVATAR.yOffset;
    this.visual.scale.setScalar(HUMAN_AVATAR.scale);
    this.model = cloneSkeleton(asset.scene);
    this.visual.add(this.model);
    this.skeletons = [];
    this.model.traverse(object => {
      if (!object.isSkinnedMesh) return;
      object.castShadow = object.receiveShadow = true;
      // Four small rigs: avoid a stale bind-pose culling sphere cutting off limbs
      // or the death fall. Geometry/material/texture resources stay shared.
      object.frustumCulled = false;
      this.skeletons.push(object.skeleton);
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.clips = asset.clips;
    this.mapping = { slow: 'Casual_Walk', walk: 'Walking', run: sprintClip, dead: 'Dead' };
    this.actions = new Map();
    this.fading = new Map();
    this.state = 'rest';
    this.action = null;
    this.disposed = false;
  }

  update(dt, state, speed = 0) {
    if (this.disposed) return;
    this.layer?.restore(); // the spear layer is re-applied after the mixer each frame
    const next = locomotionState(state, speed, this.state);
    // Respawn/reset restores the original rig immediately, without carrying the
    // corpse pose to camp. This only touches this instance's animation bindings.
    if (this.state === 'dead' && next !== 'dead') this.reset();
    if (next !== this.state) {
      if (this.action) {
        this.action.fadeOut(HUMAN_AVATAR.crossfadeSeconds);
        this.fading.set(this.action, HUMAN_AVATAR.crossfadeSeconds);
      }
      this.action = null;
      const name = this.mapping[next];
      if (name) {
        let action = this.actions.get(name);
        if (!action) {
          action = this.mixer.clipAction(this.clips.get(name));
          this.actions.set(name, action);
        }
        this.fading.delete(action);
        action.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
        action.setLoop(next === 'dead' ? THREE.LoopOnce : THREE.LoopRepeat, next === 'dead' ? 1 : Infinity);
        action.clampWhenFinished = next === 'dead';
        action.fadeIn(HUMAN_AVATAR.crossfadeSeconds).play();
        this.action = action;
      }
      this.state = next;
    }
    if (this.action && next !== 'dead') {
      const referenceSpeed = next === 'run' ? PLAYER.sprintSpeed : next === 'walk' ? PLAYER.walkSpeed : 2.3;
      this.action.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / referenceSpeed, 0.55, 1.6));
    }
    this.mixer.update(dt);
    for (const [action, remaining] of this.fading) {
      if (remaining <= dt) { action.stop(); this.fading.delete(action); }
      else this.fading.set(action, remaining - dt);
    }
    // Standing still no clip writes the arms; give the spear rig the rest arms
    // (not whatever it solved last frame) to hand back to when a hand is free.
    if (this.arms && !this.action && !this.fading.size) {
      for (const arm of Object.values(this.arms)) {
        arm.upper.quaternion.copy(arm.rest.upper); arm.fore.quaternion.copy(arm.rest.fore); arm.hand.quaternion.copy(arm.rest.hand);
      }
    }
  }

  // ---- Spear Ownership 0.1: the held spear and the upper-body carry ----
  // RIGHT HAND BONE -> primaryGrip socket -> spear. Legs, hips and spine keep
  // the locomotion clip; after the mixer runs, both arm chains are solved onto
  // the spear (handSlots.TP_STANCES, written in a frame riding the chest bone).
  enableSpear() {
    if (this.carry) return this.carry;
    this.stanceFrame = new THREE.Object3D();
    this.stanceFrame.name = 'spear-stance-frame';
    this.visual.add(this.stanceFrame);
    this.chest = this.model.getObjectByName('mixamorigSpine2');
    this.heldSpear = createSpear();
    this.heldSpear.name = 'held-spear';
    this.arms = { right: new CharacterArm(this.model, 'right'), left: new CharacterArm(this.model, 'left') };
    this.carry = new HeldSpearRig({ arms: this.arms, spear: this.heldSpear, frame: this.stanceFrame, table: TP_STANCES });
    this.layer = new UpperBodyLayer(this.model);
    return this.carry;
  }

  // resolved: handSlots.resolveStance() for this hunter; holding: the spear
  // has not been handed to a thrown world spear; pitch: their aim.
  carrySpear(dt, resolved, { holding = true, pitch = 0 } = {}) {
    if (!this.carry || this.disposed) return;
    if (this.state === 'dead') { this.heldSpear.visible = false; return; } // the death clip owns the body
    if (resolved.motion) return this.carryMotion(dt, resolved, holding, pitch);
    this.visual.updateWorldMatrix(true, true);
    this.chest.getWorldPosition(_chest);
    this.stanceFrame.position.copy(this.visual.worldToLocal(_chest));
    const aim = THREE.MathUtils.clamp(pitch, -0.9, 0.9) * (AIM_STANCES.has(resolved.stance) ? 0.65 : 0.2);
    this.stanceFrame.rotation.set(aim, Math.PI, 0, 'YXZ');
    this.carry.update(dt, resolved, { holding, fast: AIM_STANCES.has(resolved.stance) });
    // Mixer-only ticks (rest) leave bones as last written; the carry rewrote
    // the arms, so nothing stale survives into the next frame.
  }

  // Remote Spear Pass: a continuous pose from remoteSpear.RemoteSpearMotion.
  // Order: locomotion (mixer, already run) -> upper-body layer (donor drive,
  // stoop) -> stance frame on the chest -> straight-arm strike line -> arms
  // solved onto the spear (HeldSpearRig, exact).
  carryMotion(dt, resolved, holding, pitch) {
    const p = resolved.motion;
    this.layer.apply(p.drive, p.lean, this.visual, p.crouch);
    this.visual.updateWorldMatrix(true, true);
    this.chest.getWorldPosition(_chest);
    this.stanceFrame.position.copy(this.visual.worldToLocal(_chest));
    this.stanceFrame.rotation.set(THREE.MathUtils.clamp(pitch, -0.9, 0.9) * p.aim, Math.PI, 0, 'YXZ');
    this.stanceFrame.updateWorldMatrix(true, false);
    const pose = rigPose(p);
    if (p.reach > 1e-3) {
      // Full extension (Remote Thrust Arm hotfix): a natural arm first, the
      // geometric line second. The wrist goes on a line from the shoulder that
      // follows the fist's own forearm axis (a slight ulnar set, REMOTE_ARM.ulnar)
      // blended only REMOTE_ARM.line of the way toward the shaft line, at
      // REMOTE_ARM.reach of the arm's length (a small elbow bend, never locked
      // or hyperextended). The spear keeps its direction; the shaft now runs a
      // few degrees off the arm instead of forcing the wrist ~50 deg sideways.
      const arm = this.arms.right;
      const shoulder = this.stanceFrame.worldToLocal(arm.shoulderPosition(_shoulder));
      const d = _hy.fromArray(p.d).normalize();
      gripQuaternion('right', d, _gp.fromArray(p.b), _hq, p.dg);
      const off = _gp.copy(HAND_GRIP.right.point).applyQuaternion(_hq);   // wrist -> grip point
      const axis = _fa.set(Math.sin(REMOTE_ARM.ulnar), Math.cos(REMOTE_ARM.ulnar), 0).applyQuaternion(_hq); // neutral forearm direction
      const line = axis.lerp(d, REMOTE_ARM.line).normalize();
      const grip = shoulder.addScaledVector(line, (arm.upperLength + arm.foreLength) * REMOTE_ARM.reach).add(off);
      pose.spear.grip = p.g.map((v, i) => v + (grip.getComponent(i) - v) * p.reach);
    }
    if (p.wn > 1e-3 && p.on > 0.5) {
      // Thrust only: lean the right elbow pole toward where the elbow would be
      // with the wrist near neutral (the forearm continuing the fist's own
      // axis), so the arm never folds the wrist sideways between keys. The
      // elbow always stays down and out from the body (never up or inward),
      // so the upper arm cannot roll through the shoulder.
      const arm = this.arms.right;
      const shoulder = this.stanceFrame.worldToLocal(arm.shoulderPosition(_shoulder));
      const hand = handOnShaft('right', _gp.fromArray(pose.spear.grip), _hy.fromArray(p.d).normalize(), _fa.fromArray(p.b), _wp, _hq, p.dg);
      const axis = _fa.set(Math.sin(REMOTE_ARM.ulnar), Math.cos(REMOTE_ARM.ulnar), 0).applyQuaternion(hand.quaternion);
      const line = _hy.copy(hand.position).sub(shoulder).normalize();
      const natural = hand.position.addScaledVector(axis, -arm.foreLength).sub(shoulder);
      natural.addScaledVector(line, -natural.dot(line));
      const given = _pole.fromArray(p.pr).normalize();
      if (natural.lengthSq() > 1e-8) {
        // Lean toward the natural elbow, but never more than REMOTE_ARM.cone
        // away from the pose's own (down and back) elbow direction.
        _poleQ.setFromUnitVectors(given, natural.normalize());
        const angle = 2 * Math.acos(Math.min(1, Math.abs(_poleQ.w))) * p.wn * REMOTE_ARM.pole;
        if (angle > 1e-4) given.applyQuaternion(_poleQ.slerp(_idQ, 1 - Math.min(angle, REMOTE_ARM.cone) / (2 * Math.acos(Math.min(1, Math.abs(_poleQ.w)))) ));
      }
      pose.right.pole = given.toArray();
    }
    // A free left hand never reaches past the arm's length from its shoulder
    // (reaching for a spear on the ground or in a boar).
    const free = pose.left.free;
    if (free) {
      const shoulder = this.stanceFrame.worldToLocal(this.arms.left.shoulderPosition(_shoulder));
      const reach = _gp.fromArray(free.pos).sub(shoulder), max = 0.62;
      if (reach.length() > max) free.pos = reach.setLength(max).add(shoulder).toArray();
    }
    this.carry.update(dt, { stance: resolved.stance, pose }, { holding, exact: true });
    this.motionPose = p;
  }

  reset() {
    this.layer?.restore();
    this.mixer.stopAllAction();
    this.fading.clear();
    this.state = 'rest';
    this.action = null;
  }

  dispose() {
    if (this.disposed) return;
    this.reset();
    this.mixer.uncacheRoot(this.model);
    for (const skeleton of this.skeletons) skeleton.dispose();
    if (this.heldSpear) {
      // The held spear owns its geometry/materials (createSpear makes fresh ones).
      this.heldSpear.removeFromParent();
      this.heldSpear.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    }
    this.visual.removeFromParent();
    // Do not dispose shared asset geometry, materials or textures here.
    this.disposed = true;
  }
}
