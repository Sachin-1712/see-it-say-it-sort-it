import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { inventory } from "./inventory.mjs";
import { OBJECT_SLOTS } from "./inventory-store.mjs";
import { ModelLibrary, applyJoint } from "./model-assets.mjs";

const $ = id => document.getElementById(id);
const host = $("model-canvas"), library = new ModelLibrary(new GLTFLoader());
let renderer, scene, camera, controls, environment;
let selectedId = inventory.previewId(), current = null, version = 0;
const status = (text, error = false) => { $("model-load-status").textContent = text; $("model-load-status").dataset.error = String(error); };

function initRenderer() {
  if (renderer) return;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x15181D);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  renderer.domElement.setAttribute("aria-hidden", "true");
  host.append(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  environment = pmrem.fromScene(room, 0.04);
  room.dispose(); pmrem.dispose(); scene.environment = environment.texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x596373, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.7); key.position.set(-150, 250, 200); scene.add(key);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false; controls.enablePan = false;
  controls.addEventListener("change", draw);
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
  const record = inventory.list().find(record => record.id === selectedId), photo = inventory.getPhoto(selectedId);
  $("model-photo-row").hidden = !photo;
  if (photo) {
    $("model-captured-photo").src = photo.url;
    $("model-captured-photo").alt = `Captured photograph of ${record.name}`;
    $("model-photo-label").textContent = `${record.source === "camera" ? "Camera photo" : "Uploaded photo"} · ${record.type === "box" ? `${record.color} · ${record.destination ? record.destination + " bag" : "destination unassigned"}` : "manually identified sweeper"}`;
  } else $("model-captured-photo").removeAttribute("src");
  const slot = OBJECT_SLOTS.find(slot => slot.id === selectedId);
  host.setAttribute("aria-label", `Interactive saved 3D model of ${slot.name}. Drag to rotate; scroll or pinch to zoom.`);
  $("model-select").replaceChildren(...OBJECT_SLOTS.map(slot => {
    const option = document.createElement("option"); option.value = slot.id;
    option.textContent = `${slot.name}${inventory.getPhoto(slot.id) ? " · captured" : " · no photo yet"}`; return option;
  }));
  $("model-select").value = selectedId;
}
function setupJointControls() {
  $("sweeper-controls").hidden = !current?.joints.servo;
  for (const name of ["tilt", "servo"]) {
    const joint = current?.joints[name]; if (!joint) continue;
    const input = $(`model-${name}`);
    [input.min, input.max] = joint.limitsDeg;
    input.value = joint.restDeg;
    $(`model-${name}-value`).textContent = `${joint.restDeg}°`;
    input.oninput = () => { const value = applyJoint(joint, input.value); $(`model-${name}-value`).textContent = `${value}°`; frameModel(true); };
  }
}
async function showModel(id) {
  const slot = OBJECT_SLOTS.find(slot => slot.id === id); if (!slot) return;
  selectedId = id; const token = ++version;
  $("model-preview-title").textContent = slot.name;
  $("model-reset").disabled = true; $("model-retry").hidden = true; $("sweeper-controls").hidden = true;
  $("model-dimensions").textContent = "";
  status("Loading saved model…"); updatePhoto();
  try {
    initRenderer();
    // Remove the previous asset while loading, so it cannot be mistaken for this one.
    if (current) scene.remove(current.root);
    current = null; draw();
    const instance = await library.instantiate(slot.modelKey);
    if (token !== version) return;
    current = instance; scene.add(instance.root);
    setupJointControls(); resize(); frameModel();
    const dimensions = instance.metadata.dimensionsMm;
    $("model-dimensions").textContent = dimensions ? `${dimensions.width} × ${dimensions.depth} × ${dimensions.height} mm · bottom-centre origin` : "Can-base origin · independent tilt and servo pivots";
    status(`Saved ${slot.name} model loaded · ${slot.modelKey}.glb`);
    $("model-reset").disabled = false;
    host.dataset.loadedModel = slot.modelKey;
  } catch (error) {
    if (token !== version) return;
    host.removeAttribute("data-loaded-model");
    status(`Could not load the saved model. ${error.message} Your photograph is kept.`, true);
    $("model-retry").hidden = false;
  }
}
$("model-select").onchange = () => void showModel($("model-select").value);
$("model-reset").onclick = () => frameModel();
$("model-reset-pose").onclick = () => {
  for (const joint of Object.values(current?.joints ?? {})) applyJoint(joint, joint.restDeg);
  setupJointControls(); frameModel();
};
$("model-retry").onclick = () => void showModel(selectedId);
document.addEventListener("inventorypreview", event => void showModel(event.detail.id));
document.addEventListener("inventorychange", updatePhoto);
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
void showModel(selectedId);
