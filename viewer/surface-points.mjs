// Surface targets are sampled once per transition, not on every animation frame.
export function sampleModelSurface(THREE, MeshSurfaceSampler, root, count = 1800, random = Math.random) {
  root.updateMatrixWorld(true);
  const surfaces = [], a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  let total = 0;
  root.traverse(mesh => {
    if (!mesh.isMesh || !mesh.geometry.attributes.position) return;
    const geometry = mesh.geometry, positions = geometry.attributes.position, index = geometry.index;
    let area = 0;
    for (let i = 0, n = index?.count ?? positions.count; i < n; i += 3) {
      a.fromBufferAttribute(positions, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
      b.fromBufferAttribute(positions, index ? index.getX(i + 1) : i + 1).applyMatrix4(mesh.matrixWorld);
      c.fromBufferAttribute(positions, index ? index.getX(i + 2) : i + 2).applyMatrix4(mesh.matrixWorld);
      area += b.sub(a).cross(c.sub(a)).length() / 2;
    }
    if (area > 0) { total += area; surfaces.push({ mesh, sampler: new MeshSurfaceSampler(mesh).setRandomGenerator(random).build(), end: total }); }
  });
  if (!surfaces.length) throw new Error("No model surface to sample.");
  const result = new Float32Array(count * 3), point = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const choice = random() * total, surface = surfaces.find(surface => surface.end >= choice) ?? surfaces.at(-1);
    surface.sampler.sample(point); point.applyMatrix4(surface.mesh.matrixWorld); point.toArray(result, i * 3);
  }
  return result;
}
