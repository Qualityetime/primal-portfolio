import * as THREE from 'three';

// The physical spear's presentation. Extents are unchanged from earlier
// versions (head tip at local z = -1.135, butt at +0.9, shaft along Z) because
// projectile, resting and embedded-spear placement offsets depend on them.
// Hunt Slice 0.1 refines the silhouette toward the concept sheet: a knapped,
// leaf-shaped stone head lashed with cord, and a hide grip wrap.
export const SPEAR = Object.freeze({ tip: -1.135, butt: 0.9, rightGrip: 0.3, shaftRadius: 0.03 });

// Each spear owns its geometry/materials, matching the existing disposal code
// (HuntView.dispose, avatars disposeOwnedObjects) that frees them per object.
const cached = (_key, build) => build();

function knappedHead() {
  // Leaf blade: an elongated, flattened bipyramid whose ridges are jittered so
  // it reads as flaked stone rather than a cone.
  const ring = 7, points = [];
  const geometry = new THREE.BufferGeometry(), positions = [];
  for (let i = 0; i < ring; i++) {
    const a = i / ring * Math.PI * 2, wobble = 0.86 + ((i * 37) % 11) / 11 * 0.28;
    points.push([Math.cos(a) * 0.088 * wobble, Math.sin(a) * 0.028 * wobble]);
  }
  const tip = [0, 0, -0.26], base = [0, 0, 0.13], mid = -0.04;
  for (let i = 0; i < ring; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % ring];
    positions.push(ax, ay, mid, bx, by, mid, ...tip);
    positions.push(bx, by, mid, ax, ay, mid, ...base);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

function material(_key, colour) {
  return new THREE.MeshLambertMaterial({ color: colour, flatShading: true });
}

export function createSpear(firstPerson = false) {
  const group = new THREE.Group();
  group.name = 'spear';
  const wood = material('wood', 0x60452f), stone = material('stone', 0x5d5b57), cord = material('cord', 0x9d865f), wrap = material('wrap', 0x4f3a2a);
  const shaft = new THREE.Mesh(cached('shaft', () => new THREE.CylinderGeometry(0.026, 0.032, 1.8, 6)), wood);
  shaft.rotation.x = Math.PI / 2;
  const head = new THREE.Mesh(cached('head', knappedHead), stone);
  head.position.z = -0.875;
  const lashing = new THREE.Mesh(cached('lash', () => new THREE.CylinderGeometry(0.039, 0.043, 0.13, 6)), cord);
  lashing.rotation.x = Math.PI / 2; lashing.position.z = -0.76;
  const lashing2 = new THREE.Mesh(cached('lash2', () => new THREE.CylinderGeometry(0.035, 0.037, 0.05, 6)), cord);
  lashing2.rotation.x = Math.PI / 2; lashing2.position.z = -0.66;
  const grip = new THREE.Mesh(cached('grip', () => new THREE.CylinderGeometry(0.035, 0.036, 0.3, 6)), wrap);
  grip.rotation.x = Math.PI / 2; grip.position.z = SPEAR.rightGrip;
  group.add(shaft, head, lashing, lashing2, grip);
  group.traverse(object => {
    if (!object.isMesh) return;
    object.castShadow = !firstPerson; object.receiveShadow = !firstPerson;
  });
  return group;
}
