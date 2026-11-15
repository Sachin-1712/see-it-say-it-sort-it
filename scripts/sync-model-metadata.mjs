// Requires npm ci --prefix tests. Refresh manifest from the same fitted assets
// used by the viewer, after Blender regeneration or configuration changes.
import { readFile, writeFile } from "node:fs/promises";
import * as THREE from "../tests/node_modules/three/build/three.module.js";
import { GLTFLoader } from "../tests/node_modules/three/examples/jsm/loaders/GLTFLoader.js";
import { ModelLibrary } from "../viewer/model-assets.mjs";
import { fitToConfig } from "../viewer/model-fit.mjs";
const read = async path => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const manifest = await read("../assets/models/manifest.json");
const config = {rig:await read("../config/rig.json"), models:await read("../config/models.json")};
const library = new ModelLibrary({loadAsync: async url => {
  const data = await readFile(new URL(`../assets/models/${url.split("/").at(-1)}`, import.meta.url));
  return new GLTFLoader().parseAsync(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), "");
}}, {manifestUrl:"http://localhost/assets/models/manifest.json", fetchImpl:async () => ({ok:true,json:async () => manifest})});
for (const key of ["box", "sweeper"]) manifest.models[key] = fitToConfig(THREE, await library.instantiate(key), key, config).metadata;
await writeFile(new URL("../assets/models/manifest.json", import.meta.url), JSON.stringify(manifest, null, 2) + "\n");
