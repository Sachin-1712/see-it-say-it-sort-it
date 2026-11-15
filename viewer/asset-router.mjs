// Known objects only load GLBs. Only unknown objects use the approximate primitive path.
export class AssetRouter {
  #generic = new Map();
  constructor(library, generateApproximation) { this.library = library; this.generateApproximation = generateApproximation; }
  async instantiate(record) {
    if (["box", "sweeper"].includes(record.type)) return this.library.instantiate(record.type);
    if (record.type !== "unknown" || !record.definition?.approximation) throw new Error("Unrecognised object category.");
    const key = JSON.stringify([record.id, record.definition]);
    if (!this.#generic.has(key)) this.#generic.set(key, this.generateApproximation(record));
    const model = this.#generic.get(key), root = model.root.clone(true);
    root.updateMatrixWorld(true);
    return { root, metadata: structuredClone(model.metadata), joints: {} };
  }
}
