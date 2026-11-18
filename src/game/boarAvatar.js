import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { BoarExpression } from './boarExpression.js';
import { assetUrl } from './assetUrl.js';

// Measured from the supplied GLB, not used by collision or server anatomy.
// Its scene faces +Z and is about 0.006684 x 0.012732 x 0.019167 units.
export const BOAR_AVATAR = Object.freeze({
  assetPath: assetUrl('game/ironhide-boar.glb'),
  // Keep the existing native-unit/proportion fit; enlarge the complete visual
  // with a separate uniform transform, never the authoritative animal root.
  scale: Object.freeze([170, 110, 150]),
  visualScale: 1.18,
  yOffset: -0.034499664,
  facingOffset: Math.PI,
  walkClip: 'Armature|Unreal Take|baselayer',
  crossfadeSeconds: 0.14,
  referenceSpeed: 3,
});

function fittingMatrix() {
  const fit = new THREE.Matrix4().compose(
    new THREE.Vector3(0, BOAR_AVATAR.yOffset, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), BOAR_AVATAR.facingOffset),
    new THREE.Vector3(...BOAR_AVATAR.scale),
  );
  const scale = BOAR_AVATAR.visualScale;
  return new THREE.Matrix4().makeScale(scale, scale, scale).multiply(fit);
}

function balanceWalkPitch(scene, meshName, walk, supports) {
  const track = walk.tracks.find(track => track.name === 'Hips.quaternion');
  if (!track || !supports.front.length || !supports.rear.length) return;
  // Bake a small pelvis-pitch correction into this one prepared walk. Its
  // authored pelvis/leg relationship is the starting pose, not the idle hips
  // rotation. Sample a private rig so the shared neutral template stays intact.
  const model = cloneSkeleton(scene), fitted = new THREE.Group();
  fitted.matrix.copy(fittingMatrix()); fitted.matrixAutoUpdate = false; fitted.add(model);
  const mesh = model.getObjectByName(meshName), hips = model.getObjectByName('Hips');
  const mixer = new THREE.AnimationMixer(model), action = mixer.clipAction(walk);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  // A foot can switch support between the export's 30 Hz keys. Densify only
  // this corrected pitch track so interpolation does not reopen that gap.
  const steps = Math.ceil(walk.duration * 120);
  const times = Float32Array.from({ length: steps + 1 }, (_, i) => i * walk.duration / steps);
  const values = new Float32Array(times.length * 4);
  const base = new THREE.Quaternion(), rotation = new THREE.Quaternion();
  const axis = new THREE.Vector3(1, 0, 0), point = new THREE.Vector3();
  const lowest = indices => {
    let bottom = Infinity;
    for (const index of indices) {
      mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
      bottom = Math.min(bottom, point.y);
    }
    return bottom;
  };
  const difference = angle => {
    hips.quaternion.copy(base).premultiply(rotation.setFromAxisAngle(axis, angle));
    fitted.updateMatrixWorld(true);
    return lowest(supports.rear) - lowest(supports.front);
  };
  for (let i = 0; i < times.length; i++) {
    mixer.setTime(times[i]); base.copy(hips.quaternion).normalize();
    // At most 6.9 degrees relative to the authored walking pose. This balances
    // one supporting front/rear hoof; swing legs retain their supplied motion.
    let low = -0.12, high = 0.12, lowError = difference(low), highError = difference(high);
    if (lowError * highError <= 0) {
      for (let step = 0; step < 10; step++) {
        const mid = (low + high) / 2, error = difference(mid);
        if (lowError * error <= 0) { high = mid; highError = error; }
        else { low = mid; lowError = error; }
      }
    }
    difference(Math.abs(lowError) < Math.abs(highError) ? low : high);
    hips.quaternion.toArray(values, i * 4);
  }
  action.stop(); mixer.uncacheRoot(model); mesh.skeleton.dispose();
  track.times = times; track.values = values;
}

function dampWalkBodyMotion(scene, meshName, walk, supports) {
  // Grounding cancels a simple hip-height amplitude change. The visible bob
  // is the supported pelvis rise plus its pitch through the long torso. Bake
  // quieter body motion while preserving the accepted leg/hoof trajectories.
  const model = cloneSkeleton(scene), fitted = new THREE.Group();
  fitted.matrix.copy(fittingMatrix()); fitted.matrixAutoUpdate = false; fitted.add(model);
  const mesh = model.getObjectByName(meshName), hips = model.getObjectByName('Hips');
  const limbs = ['frontleg', 'R_frontleg', 'backleg', 'R_backleg'].map(name => model.getObjectByName(name));
  const mixer = new THREE.AnimationMixer(model), action = mixer.clipAction(walk);
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
  const steps = Math.ceil(walk.duration * 120);
  const times = Float32Array.from({ length: steps + 1 }, (_, i) => i * walk.duration / steps);
  const frames = [], point = new THREE.Vector3(), first = new THREE.Quaternion();
  const mean = new THREE.Quaternion(0, 0, 0, 0); let meanHeight = 0;
  for (let i = 0; i < times.length; i++) {
    mixer.setTime(times[i]); fitted.updateMatrixWorld(true);
    let floor = Infinity;
    for (const index of supports) {
      mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
      floor = Math.min(floor, point.y);
    }
    const height = hips.getWorldPosition(point).y - floor, quaternion = hips.quaternion.clone().normalize();
    meanHeight += height;
    if (i === 0) first.copy(quaternion);
    const sign = first.dot(quaternion) < 0 ? -1 : 1;
    mean.x += quaternion.x * sign; mean.y += quaternion.y * sign;
    mean.z += quaternion.z * sign; mean.w += quaternion.w * sign;
    frames.push({ height, quaternion, position: hips.position.clone(),
      limbs: limbs.map(bone => bone.matrixWorld.clone()), verticalAxis: hips.parent.matrixWorld.elements[9] });
  }
  mean.normalize(); meanHeight /= frames.length;
  const values = new Map(['Hips', ...limbs.map(bone => bone.name)].flatMap(name => [
    [`${name}.position`, new Float32Array(times.length * 3)],
    [`${name}.quaternion`, new Float32Array(times.length * 4)],
  ]));
  const delta = new THREE.Quaternion(), pitch = new THREE.Quaternion(), swing = new THREE.Quaternion();
  const inversePitch = new THREE.Quaternion(), softPitch = new THREE.Quaternion();
  const inverse = new THREE.Matrix4(), local = new THREE.Matrix4(), unusedScale = new THREE.Vector3();
  const retention = 0.25; // Keep a quarter of supported rise/fall and pelvis pitch.
  action.reset().play();
  for (let i = 0; i < times.length; i++) {
    mixer.setTime(times[i]); const frame = frames[i];
    // Swing/twist decomposition reduces only the pelvis's local-X pitch.
    // Preserve its other rotation components and the average walking pose.
    delta.copy(mean).invert().multiply(frame.quaternion);
    pitch.set(delta.x, 0, 0, delta.w).normalize();
    swing.copy(delta).multiply(inversePitch.copy(pitch).invert());
    softPitch.identity().slerp(pitch, retention);
    hips.quaternion.copy(mean).multiply(swing).multiply(softPitch).normalize();
    hips.position.copy(frame.position);
    // The armature maps hip-local Z to world Y; change neither horizontal axis.
    hips.position.z += (meanHeight - frame.height) * (1 - retention) / frame.verticalAxis;
    fitted.updateMatrixWorld(true);
    hips.position.toArray(values.get('Hips.position'), i * 3);
    hips.quaternion.toArray(values.get('Hips.quaternion'), i * 4);
    for (let j = 0; j < limbs.length; j++) {
      const bone = limbs[j];
      // Compensate at the four limb attachments, keeping the existing stance
      // and swing paths as the body settles. No leg-chain solver or scaling.
      local.multiplyMatrices(inverse.copy(bone.parent.matrixWorld).invert(), frame.limbs[j]);
      local.decompose(bone.position, bone.quaternion, unusedScale);
      bone.position.toArray(values.get(`${bone.name}.position`), i * 3);
      bone.quaternion.normalize().toArray(values.get(`${bone.name}.quaternion`), i * 4);
    }
  }
  action.stop(); mixer.uncacheRoot(model); mesh.skeleton.dispose();
  for (const track of walk.tracks) {
    if (!values.has(track.name)) continue;
    track.times = times; track.values = values.get(track.name);
  }
}

export function prepareBoarAsset(gltf) {
  const hips = gltf.scene.getObjectByName('Hips');
  let mesh;
  gltf.scene.traverse(object => { if (object.isSkinnedMesh) mesh = object; });
  const source = gltf.animations.find(clip => clip.name === BOAR_AVATAR.walkClip);
  if (!hips || !mesh || !source) throw new Error('Boar asset is missing its rig or supplied walking clip.');
  const walk = source.clone();
  // Hips.scale is 0.94718 throughout the export: fading it in shrinks the
  // entire inherited rig. Other scale tracks contain only export noise.
  // Leave every bone at its bind scale instead of animating body volume.
  walk.tracks = walk.tracks.filter(track => !track.name.endsWith('.scale'));
  for (const track of walk.tracks) {
    if (track.name !== 'Hips.position') continue;
    // The Armature is rotated +90 degrees around X: hip-local X/Y are world
    // horizontal X/Z. Lock both to bind values, including the clip's initial
    // horizontal offset. Rebase hip-local Z from its walking-start offset
    // (~22 cm lower than rest after fitting), keeping the full vertical bob.
    const verticalOffset = hips.position.z - track.values[2];
    for (let i = 0; i < track.values.length; i += 3) {
      track.values[i] = hips.position.x;
      track.values[i + 1] = hips.position.y;
      track.values[i + 2] += verticalOffset;
    }
  }
  // One shared hide material. The export marks the hide fully metallic and
  // self-lit; let the existing world lighting shade its supplied color texture.
  mesh.material = mesh.material.clone();
  mesh.material.metalness = 0;
  mesh.material.roughness = 0.9;
  mesh.material.emissiveIntensity = 0;
  gltf.scene.updateMatrixWorld(true);
  mesh.skeleton.update();
  const fit = fittingMatrix(), point = new THREE.Vector3();
  const surface = [], box = new THREE.Box3();
  const indices = mesh.geometry.index.array;
  const joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
  for (let i = 0; i < mesh.geometry.attributes.position.count; i++) {
    mesh.getVertexPosition(i, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(fit);
    let influence = 0;
    for (let j = 1; j < 4; j++) if (weights.getComponent(i, j) > weights.getComponent(i, influence)) influence = j;
    surface.push({ point: point.clone(), normal: new THREE.Vector3(), bone: joints.getComponent(i, influence) });
    box.expandByPoint(point);
  }
  const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), normal = new THREE.Vector3();
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [surface[indices[i]], surface[indices[i + 1]], surface[indices[i + 2]]];
    normal.crossVectors(edge1.subVectors(b.point, a.point), edge2.subVectors(c.point, a.point));
    a.normal.add(normal); b.normal.add(normal); c.normal.add(normal);
  }
  for (const sample of surface) sample.normal.normalize();
  const supportVertices = [], supportGroups = { front: [], rear: [] };
  for (const name of ['frontleg2', 'backleg2', 'R_frontleg2', 'R_backleg2']) {
    const bone = mesh.skeleton.bones.findIndex(b => b.name === name);
    const ankle = mesh.skeleton.bones.findIndex(b => b.name === name.replace(/2$/, '1'));
    const candidates = [];
    // Some toe/heel vertices are weighted more to the ankle than the terminal
    // foot bone. Include either influence, not just the dominant foot bone.
    for (let i = 0; i < surface.length; i++) {
      for (let j = 0; j < 4; j++) {
        const joint = joints.getComponent(i, j);
        if (weights.getComponent(i, j) > 0 && (joint === bone || joint === ankle)) { candidates.push(i); break; }
      }
    }
    candidates.sort((a, b) => surface[a].point.y - surface[b].point.y);
    if (!candidates.length) continue;
    const lowest = surface[candidates[0]].point.y, soles = new Map();
    for (const i of candidates) {
      // Include the full toe/heel contact band, not just the idle pose's lowest
      // strip: walking pitch can make another hoof edge the supporting point.
      if (surface[i].point.y > lowest + 0.12 * BOAR_AVATAR.visualScale) break;
      // Flat-shaded duplicates can have different skin weights. Deduplicate
      // only points with the same influences, which really deform together.
      const skin = Array.from({ length: 4 }, (_, j) => `${joints.getComponent(i, j)}:${weights.getComponent(i, j).toFixed(6)}`);
      const key = surface[i].point.toArray().map(v => v.toFixed(5)).join(',') + ':' + skin.join(',');
      soles.set(key, i);
    }
    supportVertices.push(...soles.values());
    supportGroups[name.includes('backleg') ? 'rear' : 'front'].push(...soles.values());
  }
  balanceWalkPitch(gltf.scene, mesh.name, walk, supportGroups);
  dampWalkBodyMotion(gltf.scene, mesh.name, walk, supportVertices);
  const restBones = mesh.skeleton.bones.map(bone => new THREE.Matrix4().multiplyMatrices(fit, bone.matrixWorld));
  return { scene: gltf.scene, clips: new Map([[walk.name, walk]]), surface, box, supportVertices, supportGroups,
    boneNames: mesh.skeleton.bones.map(b => b.name), restBones,
    inverseRestBones: restBones.map(matrix => matrix.clone().invert()) };
}

// One fetch and parse per page; concurrent animals and later rounds share it.
// A failed load is cached too, leaving the geometric developer fallback usable.
export function createBoarAssetCache(loader = new GLTFLoader()) {
  let promise;
  return { load() {
    promise ??= Promise.resolve().then(() => loader.loadAsync(BOAR_AVATAR.assetPath)).then(prepareBoarAsset);
    return promise;
  } };
}
const boarAssetCache = createBoarAssetCache();
export function loadBoarAsset() { return boarAssetCache.load(); }

function fitsRegion(name, region) {
  if (!region) return true;
  if (region === 'legs') return /leg/.test(name);
  if (region === 'head') return /head|ear/.test(name);
  if (region === 'neck') return /head|chest/.test(name);
  // The supplied skin puts the hams on the upper hind-leg bones and the
  // shoulders on the head bone; let drawn rump/chest/belly wounds use them.
  if (region === 'rump') return name === 'Hips' || /^(R_)?backleg0?$/.test(name);
  return name === 'Hips' || name === 'chest' || name === 'head';
}

// Procedural body language on the rig (see boarExpression.js). Each entry maps
// one channel to boar-local rotation axes on named bones. Angles are radians per
// unit channel; chest rotations counter-rotate both front legs so hooves stay put.
export const BOAR_BODY_LANGUAGE = Object.freeze({
  chest: 'chest',
  frontLegs: Object.freeze(['frontleg', 'R_frontleg']),
  paw: Object.freeze({
    pawLeft: Object.freeze([['frontleg0', 0.5], ['frontleg1', -1.0]]),
    pawRight: Object.freeze([['R_frontleg0', 0.5], ['R_frontleg1', -1.0]]),
  }),
  kick: Object.freeze([['backleg', -0.25], ['backleg0', -0.25], ['R_backleg', -0.25], ['R_backleg0', -0.25]]),
  tail: Object.freeze([['tail', -0.5]]),
});
const AXIS = Object.freeze({ x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) });

export class BoarAvatar {
  constructor(asset, { seed = 0 } = {}) {
    this.asset = asset;
    this.visual = new THREE.Group();
    this.sized = new THREE.Group();
    this.sized.scale.setScalar(BOAR_AVATAR.visualScale);
    this.fitted = new THREE.Group();
    this.fitted.rotation.y = BOAR_AVATAR.facingOffset;
    this.fitted.position.y = BOAR_AVATAR.yOffset;
    this.fitted.scale.set(...BOAR_AVATAR.scale);
    this.model = cloneSkeleton(asset.scene);
    this.visual.add(this.sized); this.sized.add(this.fitted); this.fitted.add(this.model);
    this.skeletons = [];
    this.model.traverse(object => {
      if (!object.isSkinnedMesh) return;
      object.castShadow = object.receiveShadow = true;
      object.frustumCulled = false;
      this.skeletons.push(object.skeleton);
      this.bones = object.skeleton.bones;
      this.mesh = object;
    });
    this.mixer = new THREE.AnimationMixer(this.model);
    this.walk = this.mixer.clipAction(asset.clips.get(BOAR_AVATAR.walkClip));
    this.state = 'rest'; this.fadeRemaining = 0; this.disposed = false;
    this.attachments = new Map();
    this.inverseRoot = new THREE.Matrix4(); this.delta = new THREE.Matrix4();
    this.normalMatrix = new THREE.Matrix3();
    this.point = new THREE.Vector3(); this.direction = new THREE.Vector3();
    this.forward = new THREE.Vector3(0, 0, -1); this.out = new THREE.Vector3(0, 0, 1);
    this.expression = new BoarExpression(seed);
    this.createBodyLanguage();
  }

  // Cache this rig's bones and the parent-frame directions of the boar-local
  // axes, from the shared fitted rest pose. Nothing here is shared between boars.
  createBodyLanguage() {
    const byName = new Map(this.bones.map((bone, index) => [bone.name, index]));
    const entry = name => {
      const index = byName.get(name), bone = this.bones[index];
      const parent = this.bones.indexOf(bone.parent);
      const inverse = new THREE.Matrix3().setFromMatrix4(this.asset.restBones[parent]).invert();
      const axis = vector => vector.clone().applyMatrix3(inverse).normalize();
      return { bone, x: axis(AXIS.x), y: axis(AXIS.y), z: axis(AXIS.z), position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    };
    const map = BOAR_BODY_LANGUAGE, names = new Set([map.chest, ...map.frontLegs, ...map.kick.map(([name]) => name),
      ...map.tail.map(([name]) => name), ...Object.values(map.paw).flatMap(list => list.map(([name]) => name))]);
    const entries = new Map([...names].map(name => [name, entry(name)]));
    this.bodyLanguage = { entries, chest: entries.get(map.chest), frontLegs: map.frontLegs.map(name => entries.get(name).bone) };
    this.offsetsApplied = false;
    this.offsetTemp = { q: new THREE.Quaternion(), r: new THREE.Quaternion(), k: new THREE.Quaternion(), c: new THREE.Quaternion() };
  }

  // Return every procedurally offset bone to the exact animated/rest value it
  // had before the offset. Runs before any mixer call, so the mixer never saves
  // or blends an offset pose and offsets can never accumulate across frames.
  restoreBodyLanguage() {
    if (!this.offsetsApplied) return;
    for (const item of this.bodyLanguage.entries.values()) {
      item.bone.position.copy(item.position); item.bone.quaternion.copy(item.quaternion);
    }
    this.offsetsApplied = false;
  }

  applyBodyLanguage(channels) {
    if (!Object.values(channels).some(value => value !== 0)) return;
    const { entries, chest, frontLegs } = this.bodyLanguage, t = this.offsetTemp;
    for (const item of entries.values()) { item.position.copy(item.bone.position); item.quaternion.copy(item.bone.quaternion); }
    this.offsetsApplied = true;
    const rotate = (item, axis, angle) => { if (angle) item.bone.quaternion.premultiply(t.r.setFromAxisAngle(item[axis], angle)); };
    if (channels.pitch || channels.yaw || channels.roll) {
      // Neck/head attitude about the chest joint. Counter-rotate the front-leg
      // roots by the exact inverse so the forelegs and hooves keep their pose.
      t.q.setFromAxisAngle(chest.y, channels.yaw)
        .multiply(t.r.setFromAxisAngle(chest.x, channels.pitch))
        .multiply(t.k.setFromAxisAngle(chest.z, channels.roll));
      t.c.copy(chest.bone.quaternion);
      chest.bone.quaternion.premultiply(t.q);
      t.k.copy(t.c).invert().multiply(t.q.invert()).multiply(t.c);
      for (const leg of frontLegs) { leg.position.applyQuaternion(t.k); leg.quaternion.premultiply(t.k); }
    }
    for (const [channel, list] of Object.entries(BOAR_BODY_LANGUAGE.paw)) {
      for (const [name, scale] of list) rotate(entries.get(name), 'x', channels[channel] * scale);
    }
    for (const [name, scale] of BOAR_BODY_LANGUAGE.kick) rotate(entries.get(name), 'x', channels.kick * scale);
    for (const [name, scale] of BOAR_BODY_LANGUAGE.tail) rotate(entries.get(name), 'x', channels.tail * scale);
  }

  // cue: { tick, turn } from HuntView — the displayed snapshot's server tick
  // estimate and the current heading correction. Visual only; optional.
  update(dt, animal, speed = 0, roll = 0, rootY = 0, cue = {}) {
    if (this.disposed) return;
    this.restoreBodyLanguage();
    const next = !animal.alive ? 'dead' : speed > (this.state === 'walk' ? 0.2 : 0.3) ? 'walk' : 'rest';
    if (next !== this.state) {
      if (next === 'dead' || this.state === 'dead') {
        this.mixer.stopAllAction(); this.fadeRemaining = 0;
      }
      if (next === 'walk') {
        this.fadeRemaining = 0;
        this.walk.stopFading().reset().setEffectiveWeight(1).fadeIn(BOAR_AVATAR.crossfadeSeconds).play();
      } else if (this.state === 'walk' && next !== 'dead') {
        this.walk.fadeOut(BOAR_AVATAR.crossfadeSeconds);
        this.fadeRemaining = BOAR_AVATAR.crossfadeSeconds;
      }
      this.state = next;
    }
    if (next === 'walk') this.walk.setEffectiveTimeScale(THREE.MathUtils.clamp(speed / BOAR_AVATAR.referenceSpeed, 0.65, 1.8));
    this.mixer.update(dt);
    if (this.fadeRemaining > 0) {
      this.fadeRemaining -= dt;
      if (this.fadeRemaining <= 0) this.walk.stop();
    }
    // Layer authoritative-state body language over the finished mixer pose,
    // before moving-support grounding samples the hooves.
    if (next === 'dead') this.expression.reset();
    else {
      const walking = next === 'walk';
      this.applyBodyLanguage(this.expression.update(dt, animal, { tick: cue.tick, turn: cue.turn,
        walkPhase: walking ? this.walk.time / this.walk.getClip().duration : null, moving: walking }));
    }
    // There is no death clip. Keep the existing root's fall, with a local-only
    // lift so the fitted, resting corpse does not sink beneath the terrain.
    this.visual.position.set(0, 0, 0);
    if (next === 'walk' || this.fadeRemaining > 0) {
      // Align the active gait's support with terrain in either direction. The
      // rebased walking hip height can otherwise leave every hoof above it.
      // Sample cached sole vertices, lifting the presentation, never the entity.
      this.visual.updateWorldMatrix(true, false);
      // SkinnedMesh.updateMatrixWorld also refreshes its attached bind inverse;
      // updateWorldMatrix alone does not, so use the proper skinning path here.
      this.visual.updateMatrixWorld(true);
      if (this.visual.parent) this.inverseRoot.copy(this.visual.parent.matrixWorld).invert();
      else this.inverseRoot.identity();
      let bottom = Infinity;
      for (const index of this.asset.supportVertices) {
        this.mesh.getVertexPosition(index, this.point).applyMatrix4(this.mesh.matrixWorld).applyMatrix4(this.inverseRoot);
        bottom = Math.min(bottom, this.point.y);
      }
      if (Number.isFinite(bottom)) this.visual.position.y = -bottom;
    }
    if (next === 'dead') {
      const sin = Math.sin(roll), cos = Math.cos(roll), box = this.asset.box;
      const bottom = rootY + Math.min(box.min.x * sin, box.max.x * sin) + Math.min(box.min.y * cos, box.max.y * cos);
      const lift = 0.02 - bottom;
      this.visual.position.set(lift * sin, lift * cos, 0);
    }
  }

  bind(object, binding) {
    if (this.disposed || this.attachments.has(object)) return;
    const point = new THREE.Vector3(binding.local.x, binding.local.y, binding.local.z);
    const hint = binding.kind === 'spear'
      ? new THREE.Vector3(binding.direction.x, binding.direction.y, binding.direction.z).negate().normalize()
      : new THREE.Vector3(binding.normal.x, binding.normal.y, binding.normal.z).normalize();
    let nearest, score = Infinity;
    // Project once onto the fitted rest surface, within the existing named
    // region. This changes only the drawing, never snapshot penetration data.
    for (const sample of this.asset.surface) {
      if (!fitsRegion(this.asset.boneNames[sample.bone], binding.region)) continue;
      const distance = sample.point.distanceToSquared(point) + (1 - sample.normal.dot(hint)) * 0.035;
      if (distance < score) { score = distance; nearest = sample; }
    }
    if (!nearest) return;
    this.attachments.set(object, { binding, point: nearest.point, normal: nearest.normal, bone: nearest.bone });
  }

  unbind(object) { this.attachments.delete(object); }

  updateAttachments() {
    if (this.disposed || !this.attachments.size || !this.visual.parent) return;
    // Cache names, bones and surface samples at load/bind time. Update transform
    // matrices once only when there are attachments, not a per-frame rig search.
    this.visual.updateWorldMatrix(true, true);
    this.inverseRoot.copy(this.visual.parent.matrixWorld).invert();
    for (const [object, anchor] of this.attachments) {
      this.delta.multiplyMatrices(this.inverseRoot, this.bones[anchor.bone].matrixWorld)
        .multiply(this.asset.inverseRestBones[anchor.bone]);
      this.point.copy(anchor.point).applyMatrix4(this.delta);
      if (anchor.binding.kind === 'spear') {
        const d = anchor.binding.direction;
        this.direction.set(d.x, d.y, d.z).transformDirection(this.delta);
        object.quaternion.setFromUnitVectors(this.forward, this.direction);
        object.position.copy(this.point).addScaledVector(this.direction, -1.02);
      } else {
        this.normalMatrix.getNormalMatrix(this.delta);
        this.direction.copy(anchor.normal).applyMatrix3(this.normalMatrix).normalize();
        object.quaternion.setFromUnitVectors(this.out, this.direction);
        object.position.copy(this.point).addScaledVector(this.direction, 0.005);
      }
    }
  }

  dispose() {
    if (this.disposed) return;
    this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model);
    this.attachments.clear();
    for (const skeleton of this.skeletons) skeleton.dispose();
    this.visual.removeFromParent();
    // Geometry, textures and material belong to the cached source, not a boar.
    this.disposed = true;
  }
}
