// Honest user-selected shape approximations. No photo geometry inference or AI.
export function createPrimitiveModel(THREE, record) {
  const { shape, dimensionsMm } = record.definition;
  const root = new THREE.Group(); root.name = record.id;
  const material = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.8, metalness: 0.05 });
  const mesh = geometry => { const object = new THREE.Mesh(geometry, material); root.add(object); return object; };
  if (shape === "cuboid") mesh(new THREE.BoxGeometry(1, 1, 1));
  else if (shape === "cylinder") mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 32));
  else if (shape === "bottle") {
    const points = [[0, 0], [.36, 0], [.4, .03], [.4, .65], [.19, .8], [.16, .83], [.16, .98], [.18, .98], [.18, 1], [0, 1]];
    mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), 32));
  } else if (shape === "mug") {
    const points = [[0, 0], [.35, 0], [.4, .06], [.42, 1], [.35, 1], [.33, .12], [0, .12]];
    mesh(new THREE.LatheGeometry(points.map(([x, y]) => new THREE.Vector2(x, y)), 32));
    const handle = mesh(new THREE.TorusGeometry(.28, .065, 8, 24)); handle.position.set(.42, .53, 0); handle.scale.y = 1.15;
  } else throw new Error("Unsupported approximate shape.");
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  root.children.forEach(child => {
    child.updateMatrix(); child.geometry.applyMatrix4(child.matrix);
    child.geometry.translate(-center.x, -bounds.min.y, -center.z);
    child.geometry.scale(dimensionsMm.width / size.x, dimensionsMm.height / size.y, dimensionsMm.depth / size.z);
    child.position.set(0, 0, 0); child.scale.set(1, 1, 1); child.rotation.set(0, 0, 0);
    child.castShadow = child.receiveShadow = true;
  });
  root.updateMatrixWorld(true);
  return { root, metadata: { type: "unknown", name: record.name, approximation: true, dimensionsMm,
    collision: { shape: "box", sizeMm: [dimensionsMm.width, dimensionsMm.depth, dimensionsMm.height], centerMm: [0, 0, dimensionsMm.height / 2], approximation: true },
    massG: null, friction: null }, joints: {} };
}
