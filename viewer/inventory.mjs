import { InventoryStore, OBJECT_SLOTS, canonicalIdentity } from "./inventory-store.mjs";
import { selectTab } from "./tabs.mjs";
import { workbenchState } from "./workbench-state.mjs";

const $ = id => document.getElementById(id);
const cap = text => text[0].toUpperCase() + text.slice(1);
const dialog = $("capture-dialog"), video = $("camera-preview"), photo = $("capture-photo");
let store = new InventoryStore();
let colours = ["red", "blue", "green", "yellow", "orange", "purple", "white", "black"];
let stream = null, draft = null, draftURL = null, version = 0, opener = null;
let cameraId = "", mappingAvailable = false;
let previewId = null, editingId = null;

function requestPreview(id, materialize = false) {
  previewId = id;
  document.dispatchEvent(new CustomEvent("inventorypreview", { detail: { id, materialize } }));
  $("model-preview-panel").scrollIntoView({ block: "nearest" });
}

function message(text, error = false) {
  $("camera-message").textContent = text;
  $("camera-message").dataset.error = String(error);
}
function announce(text) { $("inventory-notice").textContent = text; }
function option(value, text) { const item = document.createElement("option"); item.value = value; item.textContent = text; return item; }
function fillColours(select, color = "red") {
  // Only colours with a bag in config/rig.json can be sorted. A record that already has
  // another colour keeps it, labelled so the operator sees why it cannot be sorted.
  const list = colours.includes(color) || !color ? colours : [...colours, color];
  select.replaceChildren(...list.map(item => option(item, colours.includes(item) ? cap(item) : `${cap(item)} · no bag`)));
  select.value = color && list.includes(color) ? color : list[0];
}
function stopCamera() {
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  video.srcObject = null;
  $("take-picture").disabled = true;
}
function clearDraft() {
  if (draftURL) URL.revokeObjectURL(draftURL);
  draftURL = null;
  draft = null;
  photo.removeAttribute("src");
  photo.hidden = true;
  $("add-inventory").disabled = true;
}
function updateIdentity() {
  const identity = $("capture-identity").value;
  const slot = OBJECT_SLOTS.find(slot => slot.id === identity) ?? { type: "unknown", name: "Other object" };
  const existing = store.get(identity === "other" ? editingId : identity);
  $("capture-color-field").hidden = slot.type !== "box";
  $("capture-other-fields").hidden = slot.type !== "unknown";
  for (const id of ["capture-object-name", "capture-width", "capture-depth", "capture-height"]) $(id).required = slot.type === "unknown";
  const destination = store.destination($("capture-color").value);
  $("capture-destination").textContent = destination ? `Destination: ${cap(destination)} Bag` :
    mappingAvailable ? "Destination: unassigned for this colour" : "Destination mapping unavailable. Reload to retry loading the rig.";
  $("capture-replacement").hidden = !existing;
  $("capture-replacement").textContent = existing ? `Confirming replaces ${existing.name}’s photo. Placed objects stay on the workbench.` : "";
  $("add-inventory").textContent = existing ? "Replace Photo in Inventory" : "Add to Inventory";
  $("capture-identity-note").textContent = draft ? `${draft.source === "camera" ? "Camera photo" : "Uploaded photo"} · ${slot.type === "unknown" ? "Shape approximation" : slot.name} · Ready to confirm` : "Take or upload a photo to continue.";
}
function selectIdentity(id) {
  id = canonicalIdentity(id);
  const record = store.get(id);
  $("capture-identity").value = record?.type === "unknown" || id === "other" ? "other" : id;
  $("capture-color").value = record?.color ?? "red";
  if (record?.type === "unknown") {
    $("capture-object-name").value = record.name;
    $("capture-shape").value = record.definition.shape;
    for (const dimension of ["width", "depth", "height"]) $(`capture-${dimension}`).value = record.definition.dimensionsMm[dimension];
  }
  updateIdentity();
}
function changed() {
  renderInventory();
  document.dispatchEvent(new CustomEvent("inventorychange", { detail: { records: store.list() } }));
}
function renderInventory() {
  const records = store.list(), count = records.length;
  $("inventory-progress").textContent = count ? `${count} object ${count === 1 ? "type" : "types"} captured · click to place` : "No objects captured yet";
  const slots = [...OBJECT_SLOTS, ...records.filter(record => record.type === "unknown")];
  $("inventory-grid").replaceChildren(...slots.map(slot => {
    const record = store.get(slot.id), image = store.getPhoto(slot.id), placed = workbenchState.count(slot.id);
    const card = document.createElement("article"); card.className = "inventory-card"; card.dataset.objectId = slot.id;
    const place = document.createElement("button"); place.type = "button"; place.className = "inventory-place";
    place.disabled = !!record && !workbenchState.ready;
    place.setAttribute("aria-label", record ? `Place ${slot.name} on workbench (${placed} placed)` : `Capture ${slot.name}`);
    place.onclick = () => record ? document.dispatchEvent(new CustomEvent("worldplace", { detail: { record: store.get(slot.id) } })) : openCapture(slot.id);
    if (image) {
      const thumb = document.createElement("img"); thumb.className = "inventory-thumb";
      thumb.src = image.url; thumb.alt = `Captured photograph of ${slot.name}`; place.append(thumb);
    } else {
      const empty = document.createElement("div"); empty.className = "inventory-empty";
      const icon = document.createElement("span"); icon.textContent = slot.type === "box" ? "□" : "◎"; icon.setAttribute("aria-hidden", "true");
      empty.append(icon, document.createTextNode("Capture to add")); place.append(empty);
    }
    const title = document.createElement("strong"); title.className = "inventory-card-title";
    title.textContent = record && placed ? `${slot.name} × ${placed}` : slot.name; place.append(title); card.append(place);
    const info = document.createElement("div"); info.className = "inventory-info";
    const line = (text, className = "") => { const p = document.createElement("p"); p.textContent = text; p.className = className; info.append(p); };
    if (record?.type === "box") {
      const label = document.createElement("label"); label.className = "inventory-color"; label.textContent = "Routing colour";
      const color = document.createElement("select"); color.setAttribute("aria-label", "Box routing colour"); fillColours(color, record.color);
      color.onchange = () => { store.setColor(slot.id, color.value); changed(); announce("Box routing colour updated."); $("inventory-grid").querySelector(`[data-object-id="${slot.id}"] select`).focus(); };
      label.append(color); info.append(label);
      line(record.destination ? `Destination: ${cap(record.destination)} Bag` : "Destination: unassigned");
    }
    if (record) {
      line(record.type === "unknown" ? `${cap(record.definition.shape)} approximation` : "Ready to place", "capture-ready");
      line(record.source === "camera" ? "Camera photo" : "Uploaded photograph");
      const actions = document.createElement("div"); actions.className = "inventory-card-actions";
      for (const [text, action, className] of [
        ["Preview", () => requestPreview(slot.id), ""],
        ["Recapture", () => openCapture(slot.id), ""],
        ["Remove", () => { store.remove(slot.id); changed(); announce(`${slot.name} removed from inventory. Placed objects are unchanged.`); $("capture-object").focus(); }, "remove-photo"],
      ]) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = text; button.className = className;
        button.setAttribute("aria-label", `${text} ${slot.name}`); button.onclick = action; actions.append(button);
      }
      info.append(actions);
    } else line("Waiting for a photograph");
    card.append(info); return card;
  }));
}
let previousCounts = "";
workbenchState.subscribe(() => {
  const signature = JSON.stringify([workbenchState.ready, workbenchState.list().map(item => item.inventoryId)]);
  if (signature !== previousCounts) { previousCounts = signature; renderInventory(); }
});

function cameraError(error) {
  const errors = {
    NotAllowedError: "Camera access was denied. Allow camera access in your browser’s site settings and retry, or upload a photo.",
    SecurityError: "Camera access is blocked by this browser. Open the viewer on localhost or upload a photo.",
    NotFoundError: "No camera was found. Connect a webcam and retry, or upload a photo.",
    NotReadableError: "The camera is unavailable. It may be in use by another app. Close that app and retry, or upload a photo.",
    OverconstrainedError: "The selected camera is unavailable. Try another camera or upload a photo.",
  };
  return errors[error.name] ?? "Could not start the camera. Try again or upload a JPG, PNG or WebP photo.";
}
function previewReady() {
  if (!dialog.open || draft || !stream || !video.videoWidth || video.readyState < 2) return;
  $("take-picture").disabled = false;
  $("camera-placeholder").hidden = true;
  video.hidden = false;
  $("capture-source").hidden = false;
  $("capture-source").textContent = "LIVE CAMERA";
  message("Camera is live. Centre your object, then take a picture.");
}
video.addEventListener("loadeddata", previewReady);
video.addEventListener("canplay", previewReady);
video.addEventListener("error", () => {
  if (!dialog.open || draft) return;
  version++; stopCamera(); video.hidden = true; $("capture-source").hidden = true;
  message("The camera preview could not play. Retry the camera or upload a photo.", true);
  $("camera-retry").hidden = false;
});

async function listCameras(token) {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === "videoinput");
    if (token !== version || !dialog.open) return;
    $("camera-device").replaceChildren(...devices.map((device, index) => option(device.deviceId, device.label || `Camera ${index + 1}`)));
    $("camera-device").value = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? "";
    $("camera-device-label").hidden = devices.length < 2;
  } catch { /* Capture still works if camera enumeration is unavailable. */ }
}
async function startCamera() {
  const token = ++version;
  stopCamera(); clearDraft(); updateIdentity();
  video.hidden = true; $("camera-placeholder").hidden = false;
  $("camera-placeholder").querySelector("p").textContent = "Starting your camera…";
  $("capture-source").hidden = true; $("camera-controls").hidden = false;
  $("photo-controls").hidden = true; $("camera-retry").hidden = true;
  $("camera-device-label").hidden = true;
  message("Allow camera access when your browser asks. You can also upload a photo below.");
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    message("Camera access needs a supported browser on HTTPS or localhost. Upload a photo to continue.", true);
    $("camera-placeholder").querySelector("p").textContent = "Camera unavailable";
    $("camera-retry").hidden = false;
    return;
  }
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: false, video: cameraId ? { deviceId: { exact: cameraId } } : { width: { ideal: 1280 }, height: { ideal: 960 } } });
    // Permission may resolve after close, upload, retake, or another camera request.
    if (token !== version || !dialog.open) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    stream.getVideoTracks().forEach(track => track.addEventListener("ended", () => {
      if (token !== version || !dialog.open || draft) return;
      version++; stopCamera(); video.hidden = true; $("capture-source").hidden = true;
      $("camera-placeholder").hidden = false;
      $("camera-placeholder").querySelector("p").textContent = "Camera disconnected";
      $("camera-retry").hidden = false;
      message("The camera disconnected. Reconnect it and retry, or upload a photo.", true);
    }));
    video.srcObject = stream; video.hidden = false;
    message("Starting the live preview…");
    await video.play();
    if (token !== version || !dialog.open) return;
    previewReady();
    void listCameras(token);
  } catch (error) {
    if (token !== version || !dialog.open) return;
    stopCamera(); video.hidden = true;
    $("camera-placeholder").hidden = false;
    $("camera-placeholder").querySelector("p").textContent = "Camera unavailable";
    $("camera-retry").hidden = false;
    if (error.name === "OverconstrainedError") cameraId = "";
    message(cameraError(error), true);
  }
}

// Capture a bounded, decoded photograph. No base64 data or localStorage needed.
function photograph(source, width, height) {
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Image capture is unavailable in this browser."));
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("The photograph could not be saved. Please try again.")), "image/jpeg", 0.88));
}
function showPhotograph(blob, source, capturedAt) {
  stopCamera(); clearDraft();
  draft = { blob, source, capturedAt }; draftURL = URL.createObjectURL(blob);
  photo.src = draftURL; photo.hidden = false; video.hidden = true;
  $("camera-placeholder").hidden = true; $("camera-controls").hidden = true;
  $("photo-controls").hidden = false; $("capture-source").hidden = false;
  $("capture-source").textContent = source === "camera" ? "CAMERA PHOTO" : "UPLOADED PHOTO";
  $("add-inventory").disabled = false;
  message("Check your photograph, then choose its identity and add it to the inventory.");
  updateIdentity();
  $("capture-identity").focus();
}
async function takePicture() {
  if (!stream || video.readyState < 2 || !video.videoWidth || $("take-picture").disabled) return;
  const token = ++version, capturedAt = new Date().toISOString();
  $("take-picture").disabled = true;
  try {
    const blob = await photograph(video, video.videoWidth, video.videoHeight);
    if (token !== version || !dialog.open) return;
    showPhotograph(blob, "camera", capturedAt);
  } catch (error) {
    if (token !== version || !dialog.open) return;
    $("take-picture").disabled = !stream;
    message(error.message, true);
  }
}
async function uploadPicture(file) {
  if (!file || !dialog.open) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 20 * 1024 * 1024 || !file.size) {
    message("Choose a JPG, PNG or WebP photograph up to 20 MB.", true); return;
  }
  const token = ++version, capturedAt = new Date().toISOString();
  stopCamera(); clearDraft(); updateIdentity();
  video.hidden = true; $("capture-source").hidden = true;
  $("photo-controls").hidden = true; $("camera-controls").hidden = false;
  $("camera-placeholder").hidden = false;
  $("camera-placeholder").querySelector("p").textContent = "Reading your photo…";
  $("add-inventory").disabled = true;
  message("Reading your uploaded photograph…");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (token !== version || !dialog.open) return;
    const blob = await photograph(image, image.naturalWidth, image.naturalHeight);
    if (token !== version || !dialog.open) return;
    showPhotograph(blob, "upload", capturedAt);
  } catch {
    if (token !== version || !dialog.open) return;
    $("camera-placeholder").querySelector("p").textContent = "Could not read this photo";
    $("camera-retry").hidden = false;
    $("camera-controls").hidden = false;
    $("add-inventory").disabled = !draft;
    message("This file could not be read as a photograph. Try another JPG, PNG or WebP, or retry the camera.", true);
  } finally { URL.revokeObjectURL(url); }
}

function openCapture(id) {
  if (dialog.open) return;
  opener = document.activeElement;
  clearDraft();
  editingId = id ? canonicalIdentity(id) : null;
  $("capture-object-name").value = "Other object";
  selectIdentity(id ?? OBJECT_SLOTS.find(slot => !store.get(slot.id))?.id ?? "other");
  dialog.showModal();
  void startCamera();
}
function cleanup() {
  version++; stopCamera(); clearDraft();
  $("photo-file").value = "";
  if (opener?.isConnected) opener.focus(); else $("capture-object").focus();
}
function closeCapture() {
  version++; stopCamera(); clearDraft();
  dialog.close();
}
$("capture-object").onclick = () => openCapture();
$("capture-close").onclick = closeCapture;
dialog.addEventListener("close", () => { if (!dialog.open) cleanup(); });
// Escape must release the camera immediately, before the close event is queued.
dialog.addEventListener("cancel", () => { version++; stopCamera(); });
$("camera-retry").onclick = startCamera;
$("retake-picture").onclick = startCamera;
$("take-picture").onclick = takePicture;
$("camera-device").onchange = () => { cameraId = $("camera-device").value; void startCamera(); };
$("upload-picture").onclick = () => $("photo-file").click();
$("photo-file").onchange = () => { const file = $("photo-file").files[0]; $("photo-file").value = ""; void uploadPicture(file); };
$("capture-identity").onchange = () => selectIdentity($("capture-identity").value);
$("capture-color").onchange = updateIdentity;
$("capture-form").onsubmit = event => {
  event.preventDefault();
  if (!draft || $("add-inventory").disabled) return;
  try {
    const identity = $("capture-identity").value;
    const targetId = identity === "other" && store.get(editingId)?.type === "unknown" ? editingId : identity;
    const definition = identity === "other" ? { shape: $("capture-shape").value, dimensionsMm: Object.fromEntries(["width", "depth", "height"].map(key => [key, Number($(`capture-${key}`).value)])) } : undefined;
    const record = store.save(targetId, { ...draft, color: $("capture-color").value, name: $("capture-object-name").value, definition });
    changed(); selectTab("inventory");
    announce(`${record.name} added to inventory. Click its card to place it.`);
    closeCapture(); requestPreview(record.id, true);
  } catch (error) { message(error.message, true); }
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" || !dialog.open || draft) return;
  version++; stopCamera(); video.hidden = true; $("capture-source").hidden = true;
  $("camera-placeholder").hidden = false;
  $("camera-placeholder").querySelector("p").textContent = "Camera paused";
  $("camera-retry").hidden = false;
  message("Camera paused while this tab was hidden. Retry the camera to continue.");
});
window.addEventListener("pagehide", () => { version++; stopCamera(); clearDraft(); });

$("capture-identity").replaceChildren(...OBJECT_SLOTS.map(slot => option(slot.id, slot.name)), option("other", "Other object · approximation"));
fillColours($("capture-color"));
renderInventory(); updateIdentity();
// Independent fetch: inventory remains usable if Three.js or the observer is offline.
try {
  const response = await fetch("../config/rig.json");
  if (!response.ok) throw new Error("Rig unavailable");
  const rig = await response.json();
  store.colourToBag = { ...rig.colour_to_bag };
  mappingAvailable = true;
  colours = Object.keys(store.colourToBag).length ? Object.keys(store.colourToBag) : colours;
  const selected = $("capture-color").value;
  fillColours($("capture-color"), selected);
  for (const record of store.list()) if (record.type === "box") store.setColor(record.id, record.color);
  changed(); updateIdentity();
} catch { /* Missing mapping is shown as unassigned; never invent a destination. */ }

// Small, read-only integration surface for the next phase. Blob URLs are tab-scoped.
export const inventory = Object.freeze({
  list: () => store.list(),
  get: id => store.get(id),
  getPhoto: id => store.getPhoto(id),
  previewId: () => previewId,
});
