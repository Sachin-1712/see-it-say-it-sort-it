import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ModelLibrary } from "./model-assets.mjs";
import { AssetRouter } from "./asset-router.mjs";
import { createPrimitiveModel } from "./primitive-models.mjs";
import { fitToConfig } from "./model-fit.mjs";
// One cache shared by workbench and preview. Capturing never invokes Blender.
// Sizes come from config: each loaded GLB is fitted to rig.json / models.json.
const json = url => fetch(url).then(response => { if (!response.ok) throw new Error(`${url} is unavailable.`); return response.json(); });
const config = Promise.all([json("../config/rig.json"), json("../config/models.json")]).then(([rig, models]) => ({ rig, models }));
export const modelLibrary = new ModelLibrary(new GLTFLoader());
export const assetRouter = new AssetRouter(modelLibrary, record => createPrimitiveModel(THREE, record),
  async (instance, key) => fitToConfig(THREE, instance, key, await config));
