// No Blender / image-generation path exists here. Only static GLB loading + cloning.
export const ASSET_TO_VIEWER_SCALE = 1000; // glTF metres -> existing viewer millimetres

export class ModelLibrary {
  #cache = new Map();
  #manifest;
  constructor(loader, { manifestUrl = "../assets/models/manifest.json", fetchImpl = (...args) => globalThis.fetch(...args) } = {}) {
    this.loader = loader;
    this.manifestUrl = new URL(manifestUrl, globalThis.location?.href ?? "http://localhost/viewer/");
    this.fetchImpl = fetchImpl;
  }
  async manifest() {
    if (!this.#manifest) this.#manifest = this.fetchImpl(this.manifestUrl).then(async response => {
      if (!response.ok) throw new Error("Saved model catalogue is unavailable.");
      const manifest = await response.json();
      if (manifest.schemaVersion !== 1 || manifest.assetUnits !== "metres" || !manifest.models) throw new Error("Unsupported model catalogue.");
      return manifest;
    }).catch(error => { this.#manifest = null; throw error; });
    return this.#manifest;
  }
  async load(key) {
    if (!this.#cache.has(key)) this.#cache.set(key, (async () => {
      const manifest = await this.manifest();
      const metadata = manifest.models[key];
      if (!metadata) throw new Error(`Unknown saved model: ${key}`);
      const asset = await this.loader.loadAsync(new URL(metadata.url, this.manifestUrl).href);
      return { scene: asset.scene, metadata };
    })().catch(error => { this.#cache.delete(key); throw error; }));
    return this.#cache.get(key);
  }
  async instantiate(key) {
    const { scene, metadata } = await this.load(key);
    // Exported Y-up already matches Three.js and the existing toThree(x,z,-y).
    // Do NOT apply a second Z-up rotation. Only the metre/mm scale changes.
    const root = scene.clone(true);
    root.scale.multiplyScalar(ASSET_TO_VIEWER_SCALE);
    root.userData.modelKey = key;
    const joints = {};
    for (const [name, spec] of Object.entries(metadata.joints ?? {})) {
      const node = root.getObjectByName(spec.node);
      if (!node) throw new Error(`Missing transform node: ${spec.node}`);
      joints[name] = { ...spec, node, base: node.quaternion.clone(), axis: node.position.clone().fromArray(spec.axisGltfLocal).normalize() };
    }
    root.updateMatrixWorld(true);
    return { root, metadata, joints };
  }
}

export function applyJoint(joint, degrees) {
  if (!Number.isFinite(Number(degrees))) throw new Error("Joint angle must be finite.");
  const [min, max] = joint.limitsDeg;
  const value = Math.max(min, Math.min(max, Number(degrees)));
  if (!Number.isFinite(value)) throw new Error("Joint angle must be finite.");
  const angle = (value - joint.restDeg) * joint.direction * Math.PI / 180;
  joint.node.quaternion.copy(joint.base).multiply(joint.base.clone().setFromAxisAngle(joint.axis, angle));
  return value;
}
