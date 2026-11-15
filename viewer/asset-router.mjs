// Known objects only load GLBs. Only unknown objects use the approximate primitive path.
// Known GLBs are then resized to config by `fit` (viewer/model-fit.mjs), when one is given.
export class AssetRouter {
  #generic = new Map();
  constructor(library, generateApproximation, fit = null) { this.library = library; this.generateApproximation = generateApproximation; this.fit = fit; }
  async instantiate(record) {
    if (["box", "sweeper"].includes(record.type)) {
      const instance = await this.library.instantiate(record.type);
      return this.fit ? this.fit(instance, record.type) : instance;
    }
    if (record.type !== "unknown" || !record.definition?.approximation) throw new Error("Unrecognised object category.");
    const key = JSON.stringify([record.id, record.definition]);
    if (!this.#generic.has(key)) this.#generic.set(key, this.generateApproximation(record));
    const model = this.#generic.get(key), root = model.root.clone(true);
    root.updateMatrixWorld(true);
    return { root, metadata: structuredClone(model.metadata), joints: {} };
  }
}
