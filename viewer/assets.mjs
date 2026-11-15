import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { ModelLibrary } from "./model-assets.mjs";
import { AssetRouter } from "./asset-router.mjs";
import { createPrimitiveModel } from "./primitive-models.mjs";
// One cache shared by workbench and preview. Capturing never invokes Blender.
export const modelLibrary = new ModelLibrary(new GLTFLoader());
export const assetRouter = new AssetRouter(modelLibrary, record => createPrimitiveModel(THREE, record));
