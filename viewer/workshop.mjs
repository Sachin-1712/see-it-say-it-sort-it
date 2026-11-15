import { selectTab } from "./tabs.mjs";
import { Workbench } from "./workbench.mjs";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

const WS_URL = "ws://localhost:8765";
const DEG = Math.PI / 180;
const EXECUTE_MIN = 0.8;
const C = { accent: 0xF5C518, success: 0x3DDC84, bg: 0xE9EAEC };

// ---------------------------------------------------------------------------
// The ONLY place the simulation's z-up table frame becomes three.js y-up.
// Table frame: x right, y away from the front edge, z up (mm, degrees CCW from above).
// three.js:    X = x, Y = z, Z = -y. A CCW rotation about z is the same rotation about Y.
function toThree({ x = 0, y = 0, z = 0, theta = 0 }) {
  return { pos: new THREE.Vector3(x, z, -y), yaw: theta * DEG };
}
// ---------------------------------------------------------------------------

const rig = await (await fetch("../config/rig.json")).json();
const { table } = rig;
const modelConfig = await (await fetch("../config/models.json")).json();
let workbench = null;
const zones = rig.zones ?? {};
const bags = rig.bags ?? {};
const parcelSize = id => rig.parcels?.find(p => p.id === id) ?? rig.parcels?.[0] ?? { width: 50, depth: 35, height: 20 };
await Promise.race([document.fonts.load("700 48px Inter"), new Promise(r => setTimeout(r, 1500))]).catch(() => {});

const TAG = { red: "#D9473A", blue: "#3D74D9", green: "#2FAE66", yellow: "#E8C547", orange: "#E8862F",
              purple: "#8A55D8", white: "#F2F2F2", black: "#2A2A2A", pink: "#E86AA6" };
const tagColour = name => TAG[name] ?? name ?? "#999999";
const bagColour = Object.fromEntries(Object.entries(rig.colour_to_bag ?? {}).map(([c, b]) => [b, c]));

// ---- renderer: the main scene, then parcels in their own pass so nothing hides them ----
const host = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(C.bg);
const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
const environment = pmrem.fromScene(room, .04); scene.environment = environment.texture; scene.environmentIntensity = 0.3;
room.dispose(); pmrem.dispose();

// ---- helpers ---------------------------------------------------------------
const matte = color => new THREE.MeshStandardMaterial({ color, roughness: 0.95, metalness: 0 });
function block(w, d, h, material) {      // w along table x, d along table y, h along z
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.castShadow = m.receiveShadow = true;
  return m;
}
function place(obj, pose) {
  const t = toThree(pose);
  obj.position.copy(t.pos);
  obj.rotation.y = t.yaw;
}
const onTable = (x, y) => x >= 0 && x <= table.width && y >= 0 && y <= table.depth;
const parcelZ = (pose, h) => (onTable(pose.x, pose.y) ? table.height : 0) + h / 2;   // bags sit on the floor

function floorText(text, heightMM, color = "#5E636C") {
  const px = 96, c = document.createElement("canvas"), ctx = c.getContext("2d");
  const font = `700 ${px}px Inter, ui-sans-serif, system-ui, sans-serif`;
  ctx.font = font;
  c.width = Math.ceil(ctx.measureText(text).width + px * 0.5); c.height = Math.ceil(px * 1.3);
  ctx.font = font; ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const w = heightMM * c.width / c.height;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, heightMM),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.userData.width = w;
  return m;
}

// ---- lights (soft key + ambient), mirrored into the parcel pass ---------------
const centre = toThree({ x: table.width / 2, y: table.depth / 2, z: table.height }).pos;
const span = Math.max(table.width, table.depth);
function addLights(target, withShadow) {
  target.add(new THREE.HemisphereLight(0xffffff, 0xd4d6da, 1.2));
  const key = new THREE.DirectionalLight(0xffffff, 1.5);
  key.position.copy(centre).add(new THREE.Vector3(-span * 0.9, span * 2.4, span * 1.2));
  key.target.position.copy(centre);
  if (withShadow) {
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0004;
    const s = key.shadow.camera;
    s.left = s.bottom = -span * 1.6; s.right = s.top = span * 1.6; s.near = 1; s.far = span * 8;
  }
  target.add(key, key.target);
}
addLights(scene, true);


// ---- workshop room: floor plus back and right walls, white gridlines at 60% ----
const ROOM = { left: -800, right: table.width + 120, front: -700, back: table.depth + 70, height: 520, step: 40 };
function grid(w, h, step) {               // in the local XY plane from (0,0) to (w,h)
  const pts = [];
  for (let x = 0; x <= w + 1e-6; x += step) pts.push(x, 0, 0, x, h, 0);
  for (let y = 0; y <= h + 1e-6; y += step) pts.push(0, y, 0, w, y, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
}
{
  const fw = ROOM.right - ROOM.left, fd = ROOM.back - ROOM.front;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), matte(0xD9DBDF));
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(toThree({ x: ROOM.left + fw / 2, y: ROOM.front + fd / 2 }).pos);
  floor.receiveShadow = true;
  scene.add(floor);
  const fg = grid(fw, fd, ROOM.step);
  fg.rotation.x = -Math.PI / 2;                          // local +Y -> table +y
  fg.position.copy(toThree({ x: ROOM.left, y: ROOM.front, z: 0.3 }).pos);
  scene.add(fg);

  const back = new THREE.Mesh(new THREE.PlaneGeometry(fw, ROOM.height), matte(0xE3E5E8));
  back.position.copy(toThree({ x: ROOM.left + fw / 2, y: ROOM.back, z: ROOM.height / 2 }).pos);
  back.receiveShadow = true;
  scene.add(back);
  const bg = grid(fw, ROOM.height, ROOM.step);
  bg.position.copy(toThree({ x: ROOM.left, y: ROOM.back - 0.3 }).pos);
  scene.add(bg);

  const right = new THREE.Mesh(new THREE.PlaneGeometry(fd, ROOM.height), matte(0xDDDFE3));
  right.rotation.y = -Math.PI / 2;                       // faces left (towards the camera)
  right.position.copy(toThree({ x: ROOM.right, y: ROOM.front + fd / 2, z: ROOM.height / 2 }).pos);
  right.receiveShadow = true;
  scene.add(right);
  const rg = grid(fd, ROOM.height, ROOM.step);
  rg.rotation.y = -Math.PI / 2;                          // local +X -> table -y
  rg.position.copy(toThree({ x: ROOM.right - 0.3, y: ROOM.back }).pos);
  scene.add(rg);
}

// ---- table -----------------------------------------------------------------
const tableMesh = block(table.width, table.depth, table.height, matte(0xAEAEAE));
place(tableMesh, { x: table.width / 2, y: table.depth / 2, z: table.height / 2 });
scene.add(tableMesh);

// ---- zones: thin outlines flat on the table, small labels, no fill ---------
const TOP = table.height + 0.25;
for (const [name, z] of Object.entries(zones)) {
  const t = 1.2, ink = new THREE.MeshBasicMaterial({ color: 0x4A4E56 });
  for (const [w, d, dx, dy] of [[z.width, t, 0, z.depth / 2], [z.width, t, 0, -z.depth / 2],
                                [t, z.depth, z.width / 2, 0], [t, z.depth, -z.width / 2, 0]]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ink);
    s.rotation.x = -Math.PI / 2;
    s.position.copy(toThree({ x: z.x + dx, y: z.y + dy, z: TOP }).pos);
    scene.add(s);
  }
  const label = floorText(name.toUpperCase(), 7, "#4A4E56");        // left of the zone, clear of parcels
  label.position.copy(toThree({ x: z.x - z.width / 2 - 16 - label.userData.width / 2, y: z.y, z: TOP }).pos);
  scene.add(label);
}

// ---- bags: open-top bins, rim tinted with the parcel colour each accepts -----
const bagLabelPoints = [];
for (const [side, b] of Object.entries(bags)) {
  const body = matte(0x5E636C), t = 2.5, rimH = 3;
  const rim = matte(0x898989);
  const parts = [
    [b.width, b.depth, t, 0, 0, t / 2, body],
    [b.width, t, b.height, 0, b.depth / 2 - t / 2, b.height / 2, body],
    [b.width, t, b.height, 0, -b.depth / 2 + t / 2, b.height / 2, body],
    [t, b.depth, b.height, b.width / 2 - t / 2, 0, b.height / 2, body],
    [t, b.depth, b.height, -b.width / 2 + t / 2, 0, b.height / 2, body],
    [b.width + 1, t + 1, rimH, 0, b.depth / 2 - t / 2, b.height + rimH / 2, rim],
    [b.width + 1, t + 1, rimH, 0, -b.depth / 2 + t / 2, b.height + rimH / 2, rim],
    [t + 1, b.depth + 1, rimH, b.width / 2 - t / 2, 0, b.height + rimH / 2, rim],
    [t + 1, b.depth + 1, rimH, -b.width / 2 + t / 2, 0, b.height + rimH / 2, rim],
  ];
  for (const [w, d, h, dx, dy, dz, m] of parts) {
    const p = block(w, d, h, m);
    place(p, { x: b.x + dx, y: b.y + dy, z: dz });
    scene.add(p);
  }
  const label = floorText(`${side.toUpperCase()} BAG`, 9);
  // The camera looks from the front-left, so the table hides the floor in front of the
  // right bag: that label moves forward past the table's front edge.
  const ly = b.x > table.width ? Math.min(b.y - b.depth / 2 - 14, -14) : b.y - b.depth / 2 - 14;
  label.position.copy(toThree({ x: b.x, y: ly, z: 0.5 }).pos);
  scene.add(label);
  bagLabelPoints.push([b.x - label.userData.width / 2, ly - 6], [b.x + label.userData.width / 2, ly + 6]);
}

// Inventory instances are introduced only by explicit placement, never observer items.

// ---- ghosts: one thin line per attempt -------------------------------------
// Agent colours avoid yellow (accent), green (success) and red (danger).
const PALETTE = ["#3B7DDD", "#8E5CF0", "#13A3C2", "#E0559F", "#6B7280", "#B0703A", "#4F5BD5", "#9C6B98"];
function agentColour(id) {
  const n = parseInt(String(id).replace(/\D/g, ""), 10);
  if (!Number.isNaN(n)) return PALETTE[(n - 1 + PALETTE.length) % PALETTE.length];
  let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const GHOST_CAP = 40;
const GHOST_DRAW = 0.5;       // s for the line to draw out to its end point
const FAIL_FADE = 1.5;        // s for a failed attempt to fade
const SUCCESS_HOLD = 3.0;     // s a success stays green
const SUCCESS_FADE = 0.4;
const GHOST_OPACITY = 0.35;
const lineMaterials = new Set();          // need the canvas size for pixel line widths
function lineMat(opts) {
  const m = new LineMaterial({ transparent: true, depthWrite: false, ...opts });
  m.resolution.set(host.clientWidth, host.clientHeight);
  lineMaterials.add(m);
  return m;
}
const ghostGroup = new THREE.Group();
scene.add(ghostGroup);
const dotGeom = new THREE.SphereGeometry(2.4, 12, 8);
let ghosts = [];
let seenKeys = new Set();
let successCount = 0;

const ghostKey = g => `${g.agent}|${g.parcel}|${g.path.length}|${g.path[1]}|${g.path.at(-1)}`;
const pathPositions = path => path.flatMap(p => toThree({ x: p[0], y: p[1], z: p[2] }).pos.toArray());

function spawnGhost(g) {
  if (!g.path || g.path.length < 2) return;
  while (ghosts.length >= GHOST_CAP) removeGhost(ghosts[0]);
  const geom = new LineGeometry();
  geom.setPositions(pathPositions(g.path));
  geom.instanceCount = 1;
  const colour = agentColour(g.agent);
  const line = new Line2(geom, lineMat({ color: colour, linewidth: 1.5, opacity: GHOST_OPACITY }));
  const dot = new THREE.Mesh(dotGeom, new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.8, depthWrite: false }));
  ghostGroup.add(line, dot);
  const gh = { line, dot, path: g.path, success: !!g.success, born: performance.now() / 1000, green: false };
  ghosts.push(gh);
  setGhostProgress(gh, 0);
}
function removeGhost(g) {
  ghostGroup.remove(g.line, g.dot);
  g.line.geometry.dispose(); lineMaterials.delete(g.line.material); g.line.material.dispose(); g.dot.material.dispose();
  ghosts = ghosts.filter(x => x !== g);
}
function clearGhosts() { [...ghosts].forEach(removeGhost); }

function pointAlong(path, s) {            // table-frame point at fraction s of the path's points
  const f = s * (path.length - 1), i = Math.min(Math.floor(f), path.length - 2), t = f - i;
  const a = path[i], b = path[i + 1], l = (u, v) => u + (v - u) * t;
  return { x: l(a[0], b[0]), y: l(a[1], b[1]), z: l(a[2], b[2]), theta: l(a[3], b[3]) };
}
function setGhostProgress(g, s) {
  const segs = g.path.length - 1;
  g.line.geometry.instanceCount = Math.max(1, Math.ceil(s * segs));
  g.dot.position.copy(toThree(pointAlong(g.path, s)).pos);
}
function setGhostOpacity(g, k) {
  g.line.material.opacity = GHOST_OPACITY * k * (g.green ? 2 : 1);
  g.dot.material.opacity = 0.8 * k;
}

function updateGhosts(now) {
  for (const g of [...ghosts]) {
    const age = now - g.born;
    setGhostProgress(g, Math.min(1, age / GHOST_DRAW));
    if (age < GHOST_DRAW) continue;
    const after = age - GHOST_DRAW;
    if (g.success) {
      if (!g.green) {
        g.green = true;
        g.line.material.color.set(C.success); g.dot.material.color.set(C.success);
      }
      const fade = after - SUCCESS_HOLD;
      setGhostOpacity(g, fade > 0 ? 1 - fade / SUCCESS_FADE : 1);
      if (fade >= SUCCESS_FADE) removeGhost(g);
    } else {
      setGhostOpacity(g, 1 - after / FAIL_FADE);
      if (after >= FAIL_FADE) removeGhost(g);
    }
  }
}
function ingestGhosts(list = [], live) {
  const keys = new Set();
  for (const g of list) {
    const k = ghostKey(g);
    keys.add(k);
    if (live && !seenKeys.has(k)) {        // don't replay old attempts after a reconnect
      spawnGhost(g);
      if (g.success) successCount++;
    }
  }
  seenKeys = keys;
}

// ---- the current best: thick yellow line, outlined box sliding along it on a loop ----
// The frame's "best" has no path, so the viewer takes the path of the newest successful
// ghost from the best agent for that parcel, seen when the best changed.
const bestLine = new Line2(new LineGeometry(), lineMat({ color: C.accent, linewidth: 4, opacity: 1, transparent: false }));
bestLine.visible = false;
bestLine.renderOrder = 2;
scene.add(bestLine);
let bestBox = null, bestPath = null, bestSig = null, bestBoxFor = null;
const BEST_LOOP = 2.4;        // s per slide along the best path
function setBestPath(path, parcelId) {
  bestPath = path;
  if (!path) { bestLine.visible = false; if (bestBox) bestBox.visible = false; return; }
  const pos = pathPositions(path).map((v, i) => (i % 3 === 1 ? v + 0.6 : v));   // lift off the surface a touch
  bestLine.geometry.dispose();
  bestLine.geometry = new LineGeometry();
  bestLine.geometry.setPositions(pos);
  bestLine.visible = true;
  if (bestBoxFor !== parcelId) {
    if (bestBox) { scene.remove(bestBox); bestBox.geometry.dispose(); }
    const s = parcelSize(parcelId);
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(s.width, s.height, s.depth));
    bestBox = new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(edges),
                                lineMat({ color: C.accent, linewidth: 2, opacity: 1, transparent: false }));
    bestBox.renderOrder = 2;
    scene.add(bestBox);
    bestBoxFor = parcelId;
  }
}
function trackBest(f) {
  const b = f.best;
  const sig = b ? `${b.agent}|${b.robust}|${b.goal?.parcel}` : null;
  if (!b) { bestSig = null; setBestPath(null); return; }
  if (sig === bestSig && bestPath) return;
  const parcel = b.goal?.parcel;
  const cand = (f.ghosts ?? []).filter(g => g.success && g.agent === b.agent && (!parcel || g.parcel === parcel));
  if (cand.length) { setBestPath(cand.at(-1).path, parcel ?? cand.at(-1).parcel); bestSig = sig; }
}
function updateBest(now, phase) {
  if (!bestBox) return;
  const slide = bestPath && (phase === "searching" || phase === "ready");
  bestBox.visible = !!slide && document.getElementById("observer-overlay").checked;
  if (!slide) return;
  const p = pointAlong(bestPath, (now % BEST_LOOP) / BEST_LOOP);
  place(bestBox, p);
}

// ---- camera: fixed three-quarter view from the front-left ---------------------
const camera = new THREE.PerspectiveCamera(30, 1, 5, 20000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.enabled = true;                      // "O" toggles orbit for debugging

const AZIMUTH = -28 * DEG;                     // negative = from the left
const ELEVATION = 34 * DEG;
const VIEW_DIR = new THREE.Vector3(Math.cos(ELEVATION) * Math.sin(AZIMUTH), Math.sin(ELEVATION),
                                   Math.cos(ELEVATION) * Math.cos(AZIMUTH));
const TABLE_SHARE = 0.6;                       // table width as a share of the scene width
const EDGE = 0.06;                             // keep everything this far inside each edge

const tablePoints = [], environmentPoints = [];
{
  const add = (list, x, y, z) => list.push(toThree({ x, y, z }).pos);
  for (const x of [0, table.width]) for (const y of [0, table.depth]) for (const z of [0, table.height]) {
    add(tablePoints, x, y, z); add(environmentPoints, x, y, z);
  }
  for (const b of Object.values(bags))
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, b.height + 3])
      add(environmentPoints, b.x + sx * b.width / 2, b.y + sy * b.depth / 2, z);
  for (const [x, y] of bagLabelPoints) add(environmentPoints, x, y, 0);

}

function fitCamera() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  const allPoints = [...environmentPoints];
  const bounds = workbench?.bounds();
  if (bounds && !bounds.isEmpty()) for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) allPoints.push(new THREE.Vector3(x,y,z));
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  const fwd = VIEW_DIR.clone().negate();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd);
  const fy = (h / 2) / Math.tan(camera.fov * DEG / 2);           // focal length in px
  const target = new THREE.Box3().setFromPoints(allPoints).getCenter(new THREE.Vector3());

  const extent = (pts, d) => {
    const eye = target.clone().addScaledVector(VIEW_DIR, d);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      const v = p.clone().sub(eye), depth = v.dot(fwd);
      const sx = fy * v.dot(right) / depth, sy = fy * v.dot(up) / depth;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    return { x0, x1, y0, y1 };
  };
  const ok = d => {
    const t = extent(tablePoints, d), a = extent(allPoints, d);
    return t.x1 - t.x0 <= TABLE_SHARE * w &&
           a.x1 - a.x0 <= (1 - 2 * EDGE) * w && a.y1 - a.y0 <= (1 - 2 * EDGE) * h;
  };
  let d = 0;
  for (let pass = 0; pass < 3; pass++) {
    let lo = 50, hi = 60000;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; ok(mid) ? (hi = mid) : (lo = mid); }
    d = hi;
    const a = extent(allPoints, d);                                  // centre the content
    target.addScaledVector(right, ((a.x0 + a.x1) / 2) * d / fy).addScaledVector(up, ((a.y0 + a.y1) / 2) * d / fy);
  }
  camera.position.copy(target).addScaledVector(VIEW_DIR, d);
  camera.lookAt(target);
  controls.target.copy(target);
}

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  for (const m of lineMaterials) m.resolution.set(w, h);
  if (controls.enabled) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
  else fitCamera();
}
new ResizeObserver(resize).observe(host);
addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key !== "o" && e.key !== "O") return;
  controls.enabled = !controls.enabled;
  if (!controls.enabled) fitCamera();
});

// ---- UI ----------------------------------------------------------------------
const $ = id => document.getElementById(id);
const pct = r => (typeof r === "number" ? `${Math.round(r * 100)}%` : "–");
const mm = v => (typeof v === "number" ? v.toFixed(1) : "–");
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : "");
let ws = null, lastFrame = null, prevPhase = null, prevHadBest = false;
const connected = () => ws?.readyState === WebSocket.OPEN;
function send(msg) { if (connected()) ws.send(JSON.stringify(msg)); }

const MUTE_SVG = `<svg class="mute" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"
  stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="silenced"><path d="M2 6h3l4-3v10l-4-3H2z"/>
  <path d="M11 6l4 4M15 6l-4 4"/></svg>`;

const agentRows = new Map();   // id -> {el, role}
function renderAgents(agents = []) {
  const ids = new Set(agents.map(a => a.id));
  for (const [id, r] of agentRows) if (!ids.has(id)) { r.el.remove(); agentRows.delete(id); }
  for (const a of agents) {
    let r = agentRows.get(a.id);
    if (!r) {
      const el = document.createElement("div");
      el.className = "agent";
      el.innerHTML = `<span class="dot"></span><span class="id"></span>
        <span class="rolecell"><span class="chip role"></span><span class="deadlabel" hidden>dead</span></span>
        <span class="tries mono"></span><span class="bar"><i></i></span><button class="kill">Kill</button>`;
      el.querySelector(".dot").style.background = agentColour(a.id);
      el.querySelector(".id").textContent = a.id;
      el.querySelector(".kill").onclick = () => send({ cmd: "die", id: a.id });
      $("rows").appendChild(el);
      r = { el, role: null };
      agentRows.set(a.id, r);
    }
    const { el } = r;
    el.classList.toggle("dead", !a.alive);
    const chip = el.querySelector(".role");
    chip.hidden = !a.alive;
    el.querySelector(".deadlabel").hidden = a.alive;
    if (a.alive) {
      if (r.role !== null && r.role !== a.role) {       // role changed: flash the chip
        chip.classList.remove("flash"); void chip.offsetWidth; chip.classList.add("flash");
      }
      chip.textContent = cap(a.role);
    }
    r.role = a.role;
    const mute = el.querySelector(".mute");
    if (a.alive && a.silenced && !mute) el.querySelector(".rolecell").insertAdjacentHTML("beforeend", MUTE_SVG);
    if (!(a.alive && a.silenced) && mute) mute.remove();
    el.querySelector(".tries").textContent = (a.tries ?? 0).toLocaleString();
    const robust = Math.max(0, Math.min(1, a.robust ?? 0));
    const bar = el.querySelector(".bar");
    bar.title = `robust ${pct(robust)}`;
    bar.firstElementChild.style.width = `${robust * 100}%`;
    bar.firstElementChild.style.background = robust >= EXECUTE_MIN ? "var(--success)" : agentColour(a.id);
    const kill = el.querySelector(".kill");
    kill.hidden = !a.alive;
    kill.disabled = !connected();
  }
}

function renderOutcomes(f) {
  $("m-attempts").textContent = (f.agents ?? []).reduce((s, a) => s + (a.tries ?? 0), 0).toLocaleString();
  $("m-success").textContent = successCount.toLocaleString();
  $("m-best").textContent = pct(f.best?.robust);
  const r = f.phase === "done" ? f.result : null;
  const box = $("result");
  if (!r) {
    if (!box.querySelector(".placeholder"))
      box.innerHTML = `<div class="placeholder">After a real push, predicted against actual appears here.</div>`;
    return;
  }
  const p = r.predicted, a = r.actual;
  box.innerHTML = `<div class="result">
      <div class="verdict ${r.landed ? "hit" : "miss"}"></div>
      <table>
        <tr><th></th><th>x mm</th><th>y mm</th><th>θ°</th></tr>
        <tr><td>Predicted</td><td class="mono">${mm(p.x)}</td><td class="mono">${mm(p.y)}</td><td class="mono">${mm(p.theta)}</td></tr>
        <tr><td>Actual</td><td class="mono">${mm(a.x)}</td><td class="mono">${mm(a.y)}</td><td class="mono">${mm(a.theta)}</td></tr>
      </table>
      <div class="err"><span class="heading">Error</span><span><span class="v mono">${mm(Math.hypot(a.x - p.x, a.y - p.y))}</span> mm</span></div>
    </div>`;
  box.querySelector(".verdict").textContent = `${r.landed ? "Hit" : "Missed"} ${r.bin ?? "the"} bag`;
}

const itemRows = new Map();
function renderItems(items = []) {
  const ids = new Set(items.map(i => i.id));
  for (const [id, el] of itemRows) if (!ids.has(id)) { el.remove(); itemRows.delete(id); }
  for (const it of items) {
    let el = itemRows.get(it.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<span class="sw"></span><span class="id"></span><span class="route"></span><span class="chip status"></span>`;
      el.querySelector(".id").textContent = it.id;
      $("items").appendChild(el);
      itemRows.set(it.id, el);
    }
    el.querySelector(".sw").style.background = tagColour(it.color);
    el.querySelector(".sw").title = it.color ?? "";
    const route = el.querySelector(".route");
    route.textContent = `${cap(it.zone ?? "?")} → `;
    const bag = document.createElement("b");
    bag.textContent = it.bin ? `${it.bin} bag` : "no bag yet";
    route.appendChild(bag);
    const st = el.querySelector(".status");
    st.textContent = it.status ?? "";
    st.className = `chip status ${it.status ?? ""}`;
  }
}

function renderTop(f) {
  const ph = $("phase");
  ph.textContent = f ? f.phase : "offline";
  ph.className = f?.phase ?? "";
  $("best").textContent = pct(f?.best?.robust);
  const goal = $("goal");
  goal.replaceChildren();
  const target = f?.best?.goal?.parcel ?? (f?.items ?? []).find(i => i.zone === "pick")?.id;
  const item = (f?.items ?? []).find(i => i.id === target);
  const bin = f?.best?.goal?.bin ?? item?.bin;
  if (!f) goal.innerHTML = `<span class="muted">Waiting for the observer</span>`;
  else if (!item) goal.innerHTML = `<span class="muted">No parcel in the pick zone</span>`;
  else {
    const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = tagColour(item.color);
    const txt = document.createElement("span");
    txt.textContent = `${item.id} (${item.color}) → ${bin ?? "?"} bag`;
    goal.append(sw, txt);
  }
  const silenced = (f?.agents ?? []).some(a => a.alive && a.silenced);
  $("silence").classList.toggle("on", silenced);
  $("silence").textContent = silenced ? "Unsilence" : "Silence all";
  $("silence").disabled = $("replan").disabled = !connected();
}

function renderSend(f) {
  const b = $("send");
  const robust = f?.best?.robust ?? 0;
  const armed = connected() && robust >= EXECUTE_MIN && ["searching", "ready"].includes(f?.phase);
  b.disabled = !armed;
  b.classList.toggle("armed", armed);
  b.textContent = f?.phase === "executing" ? "Pushing..." : armed ? "Send to Arduino" :
                  f?.phase === "done" ? "Pushed · Replan for the next parcel" : "Waiting for a plan above 80%";
}

function renderFrame(f) {
  const hasBest = !!f.best;
  if ((f.phase === "searching" && prevPhase && !["searching", "ready"].includes(prevPhase)) || (prevHadBest && !hasBest)) {
    clearGhosts(); seenKeys = new Set(); successCount = 0; bestSig = null; setBestPath(null);
  }
  if (f.phase === "done" && prevPhase && prevPhase !== "done") selectTab("outcomes");
  prevPhase = f.phase; prevHadBest = hasBest;

  ingestGhosts(f.ghosts, f.phase === "searching" || f.phase === "ready");
  trackBest(f);
  bestLine.visible = !!bestPath && document.getElementById("observer-overlay").checked;

  renderTop(f);
  renderAgents(f.agents);
  renderOutcomes(f);
  renderItems(f.items);
  renderSend(f);
  lastFrame = f;
}

$("silence").onclick = () => {
  const silenced = (lastFrame?.agents ?? []).some(a => a.alive && a.silenced);
  send({ cmd: silenced ? "unsilence" : "silence" });
};
$("replan").onclick = () => send({ cmd: "replan" });
$("send").onclick = () => send({ cmd: "execute" });

function setConnected(on) {
  $("conn").classList.toggle("on", on);
  $("conn").title = on ? "observer connected" : "observer offline, retrying";
  renderTop(on ? lastFrame : null);
  renderSend(on ? lastFrame : null);
  if (lastFrame) renderAgents(lastFrame.agents);
}

// ---- WebSocket -------------------------------------------------------------
function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => setConnected(true);
  ws.onclose = () => { setConnected(false); setTimeout(connect, 1000); };
  ws.onmessage = ev => renderFrame(JSON.parse(ev.data));
}
connect();

// ---- placement: independent of all observer items and arm poses ----------------
workbench = new Workbench({ scene, camera, canvas: renderer.domElement, toThree, onBoundsChanged: fitCamera, table, setup: modelConfig.workbench ?? {} });
ghostGroup.visible = false;
$("observer-overlay").onchange = () => { ghostGroup.visible = $("observer-overlay").checked; bestLine.visible = ghostGroup.visible && !!bestPath; if (bestBox) bestBox.visible = false; };
document.addEventListener("workbenchclear", () => { $("observer-overlay").checked = false; ghostGroup.visible = false; clearGhosts(); bestLine.visible = false; if (bestBox) bestBox.visible = false; });
// ---- loop ------------------------------------------------------------------
let previousTime = performance.now() / 1000;
fitCamera(); resize();
renderer.setAnimationLoop(() => {
  const now = performance.now() / 1000;
  workbench.update(now - previousTime); previousTime = now;
  updateGhosts(now);
  updateBest(now, lastFrame?.phase);
  if (controls.enabled) controls.update();
  renderer.clear();
  renderer.render(scene, camera);

});
