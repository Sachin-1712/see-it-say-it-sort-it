import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { inventory } from "./inventory.mjs";
import { assetRouter } from "./assets.mjs";
import { Materializer } from "./materialization.mjs";

const $ = id => document.getElementById(id);
const host = $("model-canvas");
let renderer, scene, camera, controls, environment, materializer;
let selectedId = inventory.previewId(), current = null, version = 0;
const status = (text, error = false) => { $("model-load-status").textContent = text; $("model-load-status").dataset.error = String(error); };

function initRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x15181D);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.append(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  environment = pmrem.fromScene(room, 0.04);
  room.dispose(); pmrem.dispose(); scene.environment = environment.texture; scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-150, 250, 200); scene.add(key);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; controls.enablePan = false;
  controls.addEventListener("change", draw);
  materializer = new Materializer(scene, camera, draw);
  new ResizeObserver(resize).observe(host);
  renderer.domElement.addEventListener("webglcontextlost", event => {
    event.preventDefault(); status("3D preview paused. Reload the page to restore WebGL; capture still works.", true);
  });
}
function draw() { if (renderer && host.clientWidth && host.clientHeight) renderer.render(scene, camera); }
function resize() {
  if (!renderer || !host.clientWidth || !host.clientHeight) return;
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); draw();
}
function frameModel(preserveDirection = false) {
  if (!current) return;
  current.root.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(current.root).getBoundingSphere(new THREE.Sphere());
  const direction = preserveDirection ? camera.position.clone().sub(controls.target).normalize() : new THREE.Vector3(1.3, 0.9, 1.5).normalize();
  const limitingFov = Math.min(camera.fov * Math.PI / 180, 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * (host.clientWidth / (host.clientHeight || 1) || 1)));
  const distance = sphere.radius / Math.sin(limitingFov / 2) * 1.2;
  controls.target.copy(sphere.center);
  camera.position.copy(sphere.center).addScaledVector(direction, distance);
  camera.near = Math.max(0.05, sphere.radius / 100); camera.far = distance + sphere.radius * 30;
  controls.minDistance = sphere.radius * 1.2; controls.maxDistance = distance * 6;
  camera.updateProjectionMatrix(); controls.update(); resize();
}
function updatePhoto() {
  const records = inventory.list(), record = inventory.get(selectedId), photo = inventory.getPhoto(selectedId);
  $("model-photo-row").hidden = !photo;
  if (photo && record) {
    $("model-captured-photo").src = photo.url;
    $("model-captured-photo").alt = `Captured photograph of ${record.name}`;
    $("model-photo-label").textContent = `${record.source === "camera" ? "Camera photo" : "Uploaded photo"}${record.type === "box" ? ` · ${record.color} · ${record.destination ? record.destination + " bag" : "unassigned"}` : record.type === "unknown" ? " · shape approximation" : " · manually identified"}`;
  } else $("model-captured-photo").removeAttribute("src");
  $("model-select").replaceChildren(...records.map(record => Object.assign(document.createElement("option"), { value: record.id, textContent: record.name })));
  $("model-select").value = selectedId ?? "";
}
async function showModel(id, materialize = false) {
  const record = inventory.get(id); if (!record) return;
  selectedId = id; const token = ++version;
  materializer?.cancel();
  $("model-preview-panel").hidden = false;
  $("model-preview-title").textContent = record.name;
  $("model-reset").disabled = true; $("model-retry").hidden = true;
  $("model-dimensions").textContent = "";
  host.setAttribute("aria-label", `Interactive 3D preview of ${record.name}. Drag to rotate; scroll or pinch to zoom.`);
  status("Preparing object preview…"); updatePhoto();
  // Honest provenance: known objects are pre-built GLBs sized from config; others are typed-in shapes.
  $("model-load-caption").textContent = record.type === "unknown" ? "Approximate shape, dimensions you entered" : "Pre-built model, dimensions from config";
  $("model-load-caption").hidden = false;
  try {
    initRenderer();
    if (current) scene.remove(current.root);
    current = null; draw();
    const instance = await assetRouter.instantiate(record);
    if (token !== version) return;
    current = instance; scene.add(instance.root);
    resize(); frameModel();
    const dimensions = instance.metadata.dimensionsMm;
    $("model-dimensions").textContent = dimensions ? `${dimensions.width} × ${dimensions.depth} × ${dimensions.height} mm${record.type === "unknown" ? " · Approximate geometry" : ""}` : "Can-base origin · independent tilt and servo pivots";
    host.dataset.loadedModel = record.modelKey;
    if (materialize) {
      controls.enabled = false; host.dataset.transition = "materializing";
      status(record.type === "unknown" ? `Loading the ${record.name} approximation` : `Loading the ${record.name} model`);
      try { await materializer.play(instance.root, inventory.getPhoto(id)?.url); }
      catch { instance.root.visible = true; draw(); }
      if (token !== version) return;
    }
    controls.enabled = true; host.dataset.transition = "complete";
    status(record.type === "unknown" ? `${record.name} · ${record.definition.shape} approximation ready` : `${record.name} ready · click its card to place it`);
    $("model-reset").disabled = false;
  } catch (error) {
    if (token !== version) return;
    host.removeAttribute("data-loaded-model");
    status(`Could not display this object. ${error.message} Your photograph is kept.`, true);
    $("model-retry").hidden = false;
  }
}
$("model-select").onchange = () => void showModel($("model-select").value);
$("model-reset").onclick = () => frameModel();
$("model-replay").onclick = () => void showModel(selectedId, true);
$("model-retry").onclick = () => { if (selectedId) void showModel(selectedId, true); };
document.addEventListener("inventorypreview", event => void showModel(event.detail.id, event.detail.materialize));
document.addEventListener("inventorychange", () => {
  if (selectedId && !inventory.get(selectedId)) {
    version++; materializer?.cancel();
    if (current) scene?.remove(current.root);
    current = null; selectedId = null; $("model-preview-panel").hidden = true;
  }
  updatePhoto();
});
// Keyboard alternative to pointer orbit/zoom, only while the preview is focused.
host.addEventListener("keydown", event => {
  if (!current || !controls) return;
  const vector = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(vector);
  if (event.key === "ArrowLeft") spherical.theta -= 0.15;
  else if (event.key === "ArrowRight") spherical.theta += 0.15;
  else if (event.key === "ArrowUp") spherical.phi -= 0.15;
  else if (event.key === "ArrowDown") spherical.phi += 0.15;
  else if (event.key === "+" || event.key === "=") spherical.radius *= 0.9;
  else if (event.key === "-") spherical.radius *= 1.1;
  else if (event.key === "Home") { event.preventDefault(); frameModel(); return; }
  else return;
  event.preventDefault(); spherical.makeSafe(); spherical.radius = THREE.MathUtils.clamp(spherical.radius, controls.minDistance, controls.maxDistance);
  camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical)); controls.update(); draw();
});
if (selectedId) void showModel(selectedId, true);
