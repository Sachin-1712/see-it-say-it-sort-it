import {resultLabel, recoveryText} from "./demo-state.mjs";
import { SwarmFrames } from "./swarm-state.mjs";
import { SwarmOverlay } from "./swarm-overlay.mjs";
import { workbenchState } from "./workbench-state.mjs";
import { selectTab } from "./tabs.mjs";
import { toThree, fromThree } from "./frame.mjs";
import { Workbench } from "./workbench.mjs";
import { sweeperPositionFromConfig } from "./workbench-state.mjs";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { OBB } from "three/addons/math/OBB.js";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";

// Observer address: ?observer=ws://host:port overrides the default (a busy port is not fatal on stage).
const WS_URL = new URLSearchParams(location.search).get("observer") ?? "ws://localhost:8765";
const DEG = Math.PI / 180;
const EXECUTE_MIN = 0.8;
const C = { accent: 0xF5C518, success: 0x3DDC84, bg: 0x10131A };
// Dark, minimal room with a little colour: blue-slate walls, a warm key light and a cool
// rim light. The bench stays light so the boxes and sweeper read clearly against it.
const ROOM_COLOURS = { floor: 0x161A22, floorGrid: 0x3A4253, back: 0x1E2330, side: 0x1B202B, wallGrid: 0x525C72 };

// Pose in the z-up table frame -> three.js Vector3 and yaw. The axis swap itself is
// toThree in frame.mjs, the one conversion function.
function scenePose({ x = 0, y = 0, z = 0, theta = 0 }) {
  return { pos: new THREE.Vector3(...toThree({ x, y, z })), yaw: theta * DEG };
}

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
const swarmFrames=new SwarmFrames(), swarmOverlay=new SwarmOverlay(scene);
let loadedSwarmTask=null, selectedAgent=null, loadingSwarmScene=false, lastWorldSignature=null;
const worldSignature=snapshot=>JSON.stringify(snapshot.objects.map(({instanceId,type,position,baseZ,roll,pitch,yaw,massG,friction,dimensionsMm,tiltDeg,servoDeg})=>({instanceId,type,position,baseZ,roll,pitch,yaw,massG,friction,dimensionsMm,tiltDeg,servoDeg})));
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
  const t = scenePose(pose);
  obj.position.copy(t.pos);
  obj.rotation.y = t.yaw;
}
const onTable = (x, y) => x >= 0 && x <= table.width && y >= 0 && y <= table.depth;
const parcelZ = (pose, h) => (onTable(pose.x, pose.y) ? table.height : 0) + h / 2;   // bags sit on the floor

function floorText(text, heightMM, color = "#616161") {
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
const centre = scenePose({ x: table.width / 2, y: table.depth / 2, z: table.height }).pos;
const span = Math.max(table.width, table.depth);
function addLights(target, withShadow) {
  target.add(new THREE.HemisphereLight(0xC9D6FF, 0x1A1E27, 1.0));
  const rim = new THREE.DirectionalLight(0x6FA8FF, 0.55);            // cool light from behind the bench
  rim.position.copy(centre).add(new THREE.Vector3(span * 1.2, span * 1.1, -span * 1.6));
  rim.target.position.copy(centre);
  target.add(rim, rim.target);
  const key = new THREE.DirectionalLight(0xFFF1DD, 1.6);
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
const sceneMaxX = Math.max(table.width, ...Object.values(bags).map(b => b.x + b.width / 2));
const sceneMaxY = Math.max(table.depth, ...Object.values(bags).map(b => b.y + b.depth / 2));
const ROOM = { left: -800, right: sceneMaxX + 80, front: -700, back: sceneMaxY + 70, height: 520, step: 40 };
function grid(w, h, step, color, opacity = 0.9) {   // in the local XY plane from (0,0) to (w,h)
  const pts = [];
  for (let x = 0; x <= w + 1e-6; x += step) pts.push(x, 0, 0, x, h, 0);
  for (let y = 0; y <= h + 1e-6; y += step) pts.push(0, y, 0, w, y, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}
{
  const fw = ROOM.right - ROOM.left, fd = ROOM.back - ROOM.front;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), matte(ROOM_COLOURS.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.copy(scenePose({ x: ROOM.left + fw / 2, y: ROOM.front + fd / 2 }).pos);
  floor.receiveShadow = true;
  scene.add(floor);
  const fg = grid(fw, fd, ROOM.step, ROOM_COLOURS.floorGrid);   // same grid as the walls, darker grey
  fg.rotation.x = -Math.PI / 2;                          // local +Y -> table +y
  fg.position.copy(scenePose({ x: ROOM.left, y: ROOM.front, z: 0.3 }).pos);
  scene.add(fg);

  const back = new THREE.Mesh(new THREE.PlaneGeometry(fw, ROOM.height), matte(ROOM_COLOURS.back));
  back.position.copy(scenePose({ x: ROOM.left + fw / 2, y: ROOM.back, z: ROOM.height / 2 }).pos);
  back.receiveShadow = true;
  scene.add(back);
  const bg = grid(fw, ROOM.height, ROOM.step, ROOM_COLOURS.wallGrid);
  bg.position.copy(scenePose({ x: ROOM.left, y: ROOM.back - 0.3 }).pos);
  scene.add(bg);

  const right = new THREE.Mesh(new THREE.PlaneGeometry(fd, ROOM.height), matte(ROOM_COLOURS.side));
  right.rotation.y = -Math.PI / 2;                       // faces left (towards the camera)
  right.position.copy(scenePose({ x: ROOM.right, y: ROOM.front + fd / 2, z: ROOM.height / 2 }).pos);
  right.receiveShadow = true;
  scene.add(right);
  const rg = grid(fd, ROOM.height, ROOM.step, ROOM_COLOURS.wallGrid);
  rg.rotation.y = -Math.PI / 2;                          // local +X -> table -y
  rg.position.copy(scenePose({ x: ROOM.right - 0.3, y: ROOM.back }).pos);
  scene.add(rg);
}

// ---- bench: a slab (table.thickness) on a support, top at table.height ---------
const slabT = table.thickness ?? table.height;
const tableMesh = block(table.width, table.depth, slabT, matte(0xAEAEAE));
place(tableMesh, { x: table.width / 2, y: table.depth / 2, z: table.height - slabT / 2 });
scene.add(tableMesh);
let supportMesh = null;
if (table.height - slabT > 0) {
  const inset = 30, supportH = table.height - slabT;
  supportMesh = block(table.width - 2 * inset, table.depth - 2 * inset, supportH, matte(0x3A404D));
  place(supportMesh, { x: table.width / 2, y: table.depth / 2, z: supportH / 2 });
  scene.add(supportMesh);
}

// ---- zones: thin outlines flat on the table, no labels, no fill --------------
const TOP = table.height + 0.25;
const zoneGroups = {};
for (const [name, z] of Object.entries(zones)) {
  const t = 1.2, ink = new THREE.MeshBasicMaterial({ color: 0x4C4C4C });
  const group = new THREE.Group(); zoneGroups[name] = group; scene.add(group);
  // Lines sit just inside the zone edge, so the outline's outer size is exactly the zone size.
  for (const [w, d, dx, dy] of [[z.width, t, 0, z.depth / 2 - t / 2], [z.width, t, 0, -z.depth / 2 + t / 2],
                                [t, z.depth, z.width / 2 - t / 2, 0], [t, z.depth, -z.width / 2 + t / 2, 0]]) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ink);
    s.rotation.x = -Math.PI / 2;
    s.position.copy(scenePose({ x: z.x + dx, y: z.y + dy, z: TOP }).pos);
    group.add(s);
  }
}

// ---- bags: open-top bins; the rim is the colour of the parcels each accepts,
// and its top (b.height) is level with the bench top -------------------------
const bagGroups = {};
for (const [side, b] of Object.entries(bags)) {
  const body = matte(0x353B47), t = 2.5, rimH = 3, wallH = b.height - rimH;
  const rim = matte(bagColour[side] ? tagColour(bagColour[side]) : 0x898989);
  const parts = [
    [b.width, b.depth, t, 0, 0, t / 2, body],
    [b.width, t, wallH, 0, b.depth / 2 - t / 2, wallH / 2, body],
    [b.width, t, wallH, 0, -b.depth / 2 + t / 2, wallH / 2, body],
    [t, b.depth, wallH, b.width / 2 - t / 2, 0, wallH / 2, body],
    [t, b.depth, wallH, -b.width / 2 + t / 2, 0, wallH / 2, body],
    [b.width, t, rimH, 0, b.depth / 2 - t / 2, wallH + rimH / 2, rim],
    [b.width, t, rimH, 0, -b.depth / 2 + t / 2, wallH + rimH / 2, rim],
    [t, b.depth, rimH, b.width / 2 - t / 2, 0, wallH + rimH / 2, rim],
    [t, b.depth, rimH, -b.width / 2 + t / 2, 0, wallH + rimH / 2, rim],
  ];
  const group = new THREE.Group(); bagGroups[side] = group; scene.add(group);
  for (const [w, d, h, dx, dy, dz, m] of parts) {
    const p = block(w, d, h, m);
    place(p, { x: b.x + dx, y: b.y + dy, z: dz });
    group.add(p);
  }
  // Same rule for both bags: upright on the inside of the bin's back wall, facing the front.
  // (On the floor in front of the bins, the bench hides the right bag's label from the camera.)
  const label = floorText(`${side.toUpperCase()} BAG`, 12, "#D6D6D6");
  label.rotation.x = 0;
  label.position.copy(scenePose({ x: b.x, y: b.y + b.depth / 2 - t - 0.6, z: b.height - rimH - 16 }).pos);
  group.add(label);
}

// Inventory instances are introduced only by explicit placement, never observer items.

// ---- ghosts: one thin line per attempt -------------------------------------
// Agent colours avoid yellow (accent), green (success) and red (danger).
const PALETTE = ["#F5C518", "#888888", "#DDC558", "#AAAAAA", "#BFA746", "#707070", "#E2CA74", "#C0C0C0"];
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
const pathPositions = path => path.flatMap(p => scenePose({ x: p[0], y: p[1], z: p[2] }).pos.toArray());

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
  g.dot.position.copy(scenePose(pointAlong(g.path, s)).pos);
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
controls.enabled = false;                      // "O" toggles orbit for debugging

const AZIMUTH = -28 * DEG;                     // negative = from the left
const ELEVATION = 34 * DEG;
const VIEW_DIR = new THREE.Vector3(Math.cos(ELEVATION) * Math.sin(AZIMUTH), Math.sin(ELEVATION),
                                   Math.cos(ELEVATION) * Math.cos(AZIMUTH));
const TABLE_SHARE = 0.6;                       // table width as a share of the scene width
const EDGE = 0.06;                             // keep everything this far inside each edge

const tablePoints = [], environmentPoints = [];
{
  const add = (list, x, y, z) => list.push(scenePose({ x, y, z }).pos);
  for (const x of [0, table.width]) for (const y of [0, table.depth]) for (const z of [0, table.height]) {
    add(tablePoints, x, y, z); add(environmentPoints, x, y, z);
  }
  for (const b of Object.values(bags))
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const z of [0, b.height])
      add(environmentPoints, b.x + sx * b.width / 2, b.y + sy * b.depth / 2, z);

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
      el.querySelector(".kill").onclick = event => {event.stopPropagation();send({cmd:"die",id:a.id});};
      el.onclick=()=>{selectedAgent=selectedAgent===a.id?null:a.id;swarmOverlay.selected=selectedAgent;$("swarm-isolate").value=selectedAgent??"";};
      el.appendChild(Object.assign(document.createElement("div"),{className:"agent-detail"}));
      $("rows").appendChild(el);
      r = { el, role: null };
      agentRows.set(a.id, r);
    }
    const { el } = r;
    el.classList.toggle("selected",selectedAgent===a.id);el.classList.toggle("taking-over",a.status==="Taking Over");
    if(a.pid) {
      const job=a.latest?.action;
      el.querySelector(".agent-detail").textContent=`PID ${a.pid} · ${a.status} · ${job?`${job.target} · tilt ${job.tilt_deg}° · ${job.direction ?? "sweep"}`:"No completed simulation"} · ${a.latest?.trial_id??""} · ${a.latest?`outcome ${a.latest.success?"success":"failure"} (${a.latest.score})`:""} · ${a.task?.validated_trials?`${a.task.successful_trials}/${a.task.validated_trials} validation successes · `:""}${a.checkpoint_id??"No checkpoint"}`;
    }
    el.classList.toggle("dead", !a.alive);
    const chip = el.querySelector(".role");
    chip.hidden = false;
    el.querySelector(".deadlabel").hidden = a.alive;
    el.querySelector(".deadlabel").textContent = a.status === "Stopped" ? "Stopped" : "DEAD";
    if (a.alive) {
      if (r.role !== null && r.role !== a.role) {       // role changed: flash the chip
        chip.classList.remove("flash"); void chip.offsetWidth; chip.classList.add("flash");
      }
      chip.textContent = cap(a.role);
    }
    if(!a.alive)chip.textContent=`was ${a.role}`;
    r.role = a.role;
    const mute = el.querySelector(".mute");
    if (a.alive && a.silenced && !mute) el.querySelector(".rolecell").insertAdjacentHTML("beforeend", MUTE_SVG);
    if (!(a.alive && a.silenced) && mute) mute.remove();
    el.querySelector(".tries").textContent = (a.tries ?? 0).toLocaleString();
    const robust = Math.max(0, Math.min(1, a.robust ?? 0));
    const bar = el.querySelector(".bar");
    bar.title = `robust ${pct(robust)}`;
    bar.firstElementChild.style.width = `${robust * 100}%`;
    bar.firstElementChild.style.background = robust >= EXECUTE_MIN ? "var(--accent)" : agentColour(a.id);
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
// A readable name for a planned object. Hand-placed boxes all share the name "Box", so
// repeated names get their stack position (Box 1 is the bottom), matching the workbench list.
function objectLabel(id, frame = lastFrame) {
  const objects = frame?.task?.snapshot?.objects ?? [], o = objects.find(x => x.instanceId === id);
  if (!o?.name) return id;
  const repeated = objects.filter(x => x.name === o.name).length > 1;
  return repeated && Number.isFinite(o.stackIndex) ? `${o.name} ${o.stackIndex + 1}` : o.name;
}
function renderItems(items = [], frame = lastFrame) {
  const ids = new Set(items.map(i => i.id));
  for (const [id, el] of itemRows) if (!ids.has(id)) { el.remove(); itemRows.delete(id); }
  for (const it of items) {
    let el = itemRows.get(it.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "item";
      el.innerHTML = `<span class="sw"></span><span class="id"></span><span class="route"></span><span class="chip status"></span>`;
      $("items").appendChild(el);
      itemRows.set(it.id, el);
    }
    // Swarm IDs are long (world_box_0001); show the object's name and keep the ID as a tooltip.
    const label = el.querySelector(".id");
    label.textContent = objectLabel(it.id, frame); label.title = it.id;
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
  const silenced = (f?.agents ?? []).some(a => a.alive && a.silenced);
  $("silence").classList.toggle("on", silenced);
  $("silence").textContent = silenced ? "Unsilence" : "Silence all";
  $("silence").disabled = $("replan").disabled = !connected();
}

function renderSend(f) {
  const b = $("send");
  const robust = f?.best?.robust ?? 0;
  const armed = connected() && robust >= EXECUTE_MIN && ["searching", "ready"].includes(f?.phase);
  if (f?.protocol === "gekko-swarm-v1") {
    // Human-confirmed Send, dry run: the server logs the servo commands; nothing reaches hardware.
    const ex = f.execution ?? {}, next = ex.next_step;
    const ready = connected() && !!f.best && robust >= EXECUTE_MIN && ex.dry_run && next != null;
    b.disabled = !ready; b.classList.toggle("armed", ready);
    b.textContent = ready ? `Log simulated G/P step ${next} of ${ex.steps} · no hardware` :
                    f.best && ex.steps && next == null ? "All simulated steps logged" : "Waiting for a validated plan";
    return;
  }
  b.disabled = !armed;
  b.classList.toggle("armed", armed);
  b.textContent = f?.phase === "executing" ? "Pushing..." : armed ? "Send to Arduino" :
                  f?.phase === "done" ? "Pushed · Replan for the next parcel" : "Waiting for a plan above 80%";
}

// The "Show agent" list. Frames arrive 4 times a second; replacing a native <select>'s
// options while its popup is open leaves the dropdown stuck over the page. So: never touch
// it while it is focused/open, update labels in place, and only add or remove options when
// the set of agents changes.
function syncAgentSelect(agents) {
  const select = $("swarm-isolate");
  if (document.activeElement === select) return;
  const wanted = ["", ...agents.map(a => a.id)];
  const have = [...select.options].map(o => o.value);
  if (wanted.join("|") !== have.join("|")) {
    const prior = select.value;
    select.replaceChildren(...wanted.map(id => Object.assign(document.createElement("option"), { value: id })));
    select.value = wanted.includes(prior) ? prior : "";
  }
  select.options[0].textContent = "All agents";
  agents.forEach((a, i) => {
    const text = `${a.id.toUpperCase()} · ${a.role} · ${a.status}`;
    if (select.options[i + 1].textContent !== text) select.options[i + 1].textContent = text;
  });
}

function renderSwarmFrame(f) {
  if(!swarmFrames.accept(f))return;
  renderTop(f);renderAgents(f.agents);renderItems(f.items, f);renderSend(f);lastFrame=f;
  $("swarm-demo").disabled=!connected(); updateStartAgents(f);
  const metrics=f.metrics??{};
  const recovery=f.recovery?.at(-1);
  const banner=$("recovery-banner");banner.hidden=!recovery;
  banner.textContent=recoveryText(recovery,f.live_search_stopped);
  const timeline=$("recovery-timeline");
  timeline.replaceChildren(...(recovery?.timeline??[]).map(e=>Object.assign(document.createElement("span"),{textContent:`${e.stage} · ${new Date(e.timestamp*1000).toLocaleTimeString()}`})));
  const link=recovery?.successor?`${recovery.dead}:${recovery.successor}:${recovery.checkpoint_id}`:null;
  if(link){const changed=timeline.dataset.link!==link;timeline.dataset.link=link;
    const arrow=Object.assign(document.createElement("strong"),{className:"takeover-link",textContent:`${recovery.dead.toUpperCase()} → ${recovery.successor.toUpperCase()}`});timeline.append(arrow);
    if(changed && !matchMedia('(prefers-reduced-motion: reduce)').matches)arrow.animate([{opacity:.3,transform:'translateX(-12px)'},{opacity:1,transform:'translateX(0)'}],{duration:250,easing:'cubic-bezier(0.23, 1, 0.32, 1)'});
  }
  for(const a of f.agents??[])agentRows.get(a.id)?.el.classList.toggle('taking-over',a.id===recovery?.successor && a.alive);
  const saved=f.best?.attribution==='previously_validated';
  $("saved-attribution").hidden=!saved;$("saved-attribution").textContent=saved?`${resultLabel(f.best)} · saved ${f.best.saved_at} · simulated replay only`:'';
  $("swarm-stop").disabled=!connected()||!f.task||f.live_search_stopped;
  $("swarm-saved").disabled=!connected()||!f.task||!f.live_search_stopped;
  $("swarm-replay").disabled=!connected()||!f.best;
  $("physical-dry").disabled=!connected()||!saved||f.execution?.awaiting_outcome||!f.execution?.physical_next_step;
  $("physical-outcome").disabled=!connected()||!f.execution?.awaiting_outcome;
  $("physical-failed").disabled=!connected()||!f.execution?.awaiting_outcome;

  $("swarm-status").textContent=f.task?`${metrics.active??0} real processes · ${metrics.trials??0} MuJoCo trials · ${metrics.plan_trials??0} plan trials · scene ${f.task.scene_version} · ${f.task.task_id} · ${metrics.elapsed_s}s${f.agents.some(a=>a.silenced)?" · PEER NETWORK OFF: local checkpoints":""}${f.failure?` · ${f.failure}`:""}`:"No simulation running · place the sweeper and boxes, then press ▶ Start agents (or Load Three-Box Demo).";
  syncAgentSelect(f.agents??[]);
  $("m-attempts").textContent=(metrics.trials??0).toLocaleString();$("m-success").textContent=(metrics.successes??0).toLocaleString();$("m-best").textContent=pct(f.best?.robust);
  const feed=$("swarm-activity"),activity=(f.agents??[]).filter(a=>a.alive&&a.latest).map(a=>({agent:a.id,timestamp:a.latest.timestamp,type:a.latest.role,detail:`${a.latest.action.target} · tilt ${a.latest.action.tilt_deg}° · trial #${a.latest.trial_id.split(":").at(-1)} · score ${a.latest.score}`}));
  feed.replaceChildren(...[...(f.events??[]),...activity].sort((a,b)=>b.timestamp-a.timestamp).slice(0,20).map(event=>Object.assign(document.createElement("div"),{textContent:`${new Date(event.timestamp*1000).toLocaleTimeString()} · ${(event.agent??"swarm").toUpperCase()} · ${event.type.replaceAll("_"," ")}${event.detail?` · ${event.detail}`:""}${event.role?` → ${event.role}`:""}${event.failed_agent?` ${event.failed_agent.toUpperCase()}`:""}${event.checkpoint_id?` · ${event.checkpoint_id} (${event.recovered_trials??"shared"} trials)`:""}`})));
  const panel=$("swarm-plan-details"),planKey=f.best?`${f.best.plan.id}:${f.best.robust}:${f.best.attribution}`:`none:${f.failure??""}`;
  if(panel.dataset.planKey!==planKey){panel.dataset.planKey=planKey;panel.replaceChildren();
  if(f.best?.plan){
    panel.appendChild(Object.assign(document.createElement("strong"),{textContent:`${resultLabel(f.best)} · ${pct(f.best.robust)} (${Object.keys(f.best.plan.evidence).length} independent trials)`}));
    const list=document.createElement("ol");
    for(const step of f.best.plan.actions)list.appendChild(Object.assign(document.createElement("li"),{textContent:`${objectLabel(step.target,f)}: manual tilt ${step.tilt_deg}° → ${step.direction.toUpperCase()} · predicted ${f.task.goals[step.target]} bag. Simulation angles/timing are uncalibrated.`}));
    const replay=Object.assign(document.createElement("button"),{type:"button",textContent:"Replay Three-Box Solution"});replay.onclick=()=>send({cmd:"replay_plan"});
    const back=Object.assign(document.createElement("button"),{type:"button",textContent:"Back to agent trials"});back.onclick=()=>swarmOverlay.stopSequence();
    panel.append(replay,back);
    panel.append(list,Object.assign(document.createElement("p"),{textContent:"Simulation prediction only. UNO Q execution is disabled."}));
  }else panel.textContent=f.failure??"No complete validated plan yet.";
  }
  swarmOverlay.visible=$("observer-overlay").checked;
  swarmOverlay.ingest(f);
  if(f.source === "golden" && f.task && loadedSwarmTask!==`${f.task.task_id}:${f.task.scene_version}` && workbench){
    loadedSwarmTask=`${f.task.task_id}:${f.task.scene_version}`;
    loadingSwarmScene=true;
    workbench.loadSnapshot(f.task.snapshot).catch(error=>{$("world-message").textContent=error.message;}).finally(()=>{loadingSwarmScene=false;lastWorldSignature=worldSignature(workbenchState.snapshot());});
    $("observer-overlay").checked=true;swarmOverlay.visible=true;selectTab("agents");
  }
}
function renderFrame(f) {
  if(f.type === "plan_replay"){
    if(lastFrame?.task?.task_id===f.task_id && lastFrame.task.scene_version===f.scene_version){swarmOverlay.playSequence(f.results,lastFrame.task);$("world-message").textContent=`${f.label} · yellow outlines: stored MuJoCo simulation. Solid objects: workbench setup, not physical state.`;}
    return;
  }
  if(f.type==='confirmed_step'){
    $("physical-status").textContent=`DRY RUN step ${f.step}: ${f.target} → ${f.bin}; tilt ${f.tilt_deg}°. ${f.command??'No calibrated L/R mapping'}. NOT SENT · NOT ACKNOWLEDGED. ${f.reason}`;
    $("physical-outcome").disabled=false;return;
  }
  if(f.type==='outcome_confirmed'){$("physical-status").textContent=`Human reported outcome recorded. Next step ${f.next_step}. No physical command was sent.`;$("physical-outcome").disabled=true;return;}
  if(f.type === "error"){$("swarm-status").textContent=f.reason;return;}
  if(f.type === "dry_run_command"){
    const text=`Dry run step ${f.step} of ${f.steps}: ${f.target} → ${f.bin} bag. Set tilt ${f.tilt_deg}° by hand, then ${f.commands.join(" · ")} (logged, not sent to hardware).`;
    $("swarm-status").textContent=text; $("world-message").textContent=text; return;
  }
  if(f.protocol === "gekko-swarm-v1"){renderSwarmFrame(f);return;}
  if(!new URLSearchParams(location.search).has("legacyObserver")){$("swarm-status").textContent="No simulation data · legacy fake observer ignored. Start python -m swarm.server.";return;}
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
$("send").onclick = () => {
  const f = lastFrame;
  if (f?.protocol !== "gekko-swarm-v1") { send({ cmd: "execute" }); return; }
  const step = f.best?.plan?.actions?.[(f.execution?.next_step ?? 1) - 1];
  if (!step) return;
  const name = objectLabel(step.target, f);
  const ok = confirm(`Send step ${f.execution.next_step} of ${f.execution.steps}: ${name} → ${f.task?.goals?.[step.target] ?? "?"} bag?\n\n` +
    `Set the tilt to ${step.tilt_deg}° by hand first.\nDRY RUN: the servo commands are logged on the server, not sent to the Arduino.`);
  if (ok) send({ cmd: "execute" });
};
$("swarm-demo").onclick=()=>send({cmd:"load_demo"});
$("swarm-stop").onclick=()=>send({cmd:'stop_live'});
$("swarm-saved").onclick=()=>send({cmd:'load_saved'});
$("swarm-replay").onclick=()=>send({cmd:'replay_plan'});
$("physical-stop").onclick=()=>{send({cmd:'hardware_stop'});$("physical-status").textContent='STOP: disconnect servo power physically. No serial transport is active.';};
$("physical-dry").onclick=()=>{
 const step=lastFrame?.best?.plan?.actions?.[(lastFrame.execution?.physical_next_step??1)-1];if(!step)return;
 const confirmed=confirm(`DRY RUN ONLY — no command will be transmitted.\nSet tilt manually to ${step.tilt_deg}°. Confirm the actual box scene matches this plan, and the previous boxes have the expected outcomes.\nPrepare ${step.target} → ${lastFrame.task.goals[step.target]}?`);
 if(confirmed)send({cmd:'prepare_step',plan_id:lastFrame.best.plan.id,tilt_confirmed:true,scene_confirmed:true});
};
$("physical-failed").onclick=()=>send({cmd:"confirm_outcome",success:false});
$("physical-outcome").onclick=()=>{if(confirm('Confirm you have observed the actual box in its expected bin. This is a human report, not hardware acknowledgement.'))send({cmd:'confirm_outcome',success:true});};
// "Start agents": plan whatever is placed on the bench (the sweeper plus at least one box).
function benchReady() {
  const objects = workbenchState.snapshot().objects;
  return objects.some(o => o.type === "sweeper") && objects.some(o => o.type === "box");
}
function updateStartAgents(f = lastFrame) {
  const ready = connected() && benchReady();
  const why = !connected() ? "Start the agents server: .venv312/bin/python -m swarm.server" :
              !benchReady() ? "Place the sweeper and at least one box first" : "Plan the placed objects with independent MuJoCo agents";
  for (const id of ["swarm-plan", "swarm-start-tab"]) { $(id).disabled = !ready; $(id).title = why; }
  // In the Agents tab, offer it while nothing is running for this workbench.
  $("swarm-start-tab").hidden = !!(f?.task && !f.live_search_stopped && f.phase !== "failed");
}
$("swarm-start-tab").onclick = () => $("swarm-plan").click();
$("swarm-plan").onclick=()=>{
  if(lastFrame?.source==="golden" && lastFrame.live_search_stopped){send({cmd:"start_agents"});selectTab("agents");return;}
  const unassigned=workbenchState.snapshot().objects.filter(o=>o.type==="box"&&!o.destination);
  if(unassigned.length){$("world-message").textContent=`${unassigned.length} placed box${unassigned.length>1?"es have":" has"} no bag (${[...new Set(unassigned.map(o=>o.color??"no colour"))].join(", ")}). Only red → left and blue → right can be sorted. Change the routing colour in Inventory, then Clear workbench and place again.`;return;}
  loadedSwarmTask="workbench";send({cmd:"plan_workbench",snapshot:workbenchState.snapshot()});selectTab("agents");$("observer-overlay").checked=true;};
$("swarm-isolate").onchange=()=>{selectedAgent=$("swarm-isolate").value||null;swarmOverlay.selected=selectedAgent;$("swarm-isolate").blur();};

function setConnected(on) {
  swarmOverlay.connected=on;
  $("conn").classList.toggle("on", on);
  $("conn").title = on ? "observer connected" : "observer offline, retrying";
  $("swarm-demo").disabled=!on; updateStartAgents(on ? lastFrame : null);
  if(!on)$("swarm-status").textContent="Observer disconnected · workers may continue independently.";
  renderTop(on ? lastFrame : null);
  renderSend(on ? lastFrame : null);
  if (lastFrame) renderAgents(lastFrame.agents);
}

// ---- WebSocket -------------------------------------------------------------
function connect() {
  ws = new WebSocket(WS_URL);
  const socket=ws;
  ws.onopen = () => setConnected(true);
  ws.onclose = () => { setConnected(false); setTimeout(connect, 1000); };
  ws.onmessage = ev => {if(socket===ws)renderFrame(JSON.parse(ev.data));};
}
connect();

// ---- placement: independent of all observer items and arm poses ----------------
// Sizes and positions come only from config: the stack sits at the centre of the pick zone,
// the lying can behind it on the same x (sweeperPositionFromConfig).
workbench = new Workbench({ scene, camera, canvas: renderer.domElement, toThree: scenePose, tagColour, table,
  setup: { ...modelConfig.workbench, stackPositionMm: zones.pick ? { x: zones.pick.x, y: zones.pick.y } : null,
    sweeperPositionMm: sweeperPositionFromConfig(rig, modelConfig) },
  onBoundsChanged: () => { fitCamera(); refreshDebug(); } });
lastWorldSignature=worldSignature(workbenchState.snapshot());
document.addEventListener("workbenchchange",event=>{
  updateStartAgents();
  if(loadingSwarmScene)return;
  const signature=worldSignature(event.detail);
  if(lastWorldSignature!==null && signature!==lastWorldSignature && lastFrame?.task)send({cmd:"invalidate"});
  lastWorldSignature=signature;
});
ghostGroup.visible = false;
$("observer-overlay").onchange = () => { ghostGroup.visible = $("observer-overlay").checked; swarmOverlay.visible=ghostGroup.visible; bestLine.visible = ghostGroup.visible && !!bestPath; if (bestBox) bestBox.visible = false; };
document.addEventListener("workbenchclear", () => { $("observer-overlay").checked = false; ghostGroup.visible = false; clearGhosts(); bestLine.visible = false; if (bestBox) bestBox.visible = false; });
// ---- debug overlay ("D"): measured boxes with mm labels and a 100 mm scale bar ----
// Sizes are measured from the rendered geometry, not copied from config, so this
// checks the fitting. Labels read width (x) x depth (y) x height (z), table frame.
const DEBUG = { on: new URLSearchParams(location.search).has("debug"), group: new THREE.Group(), labels: [], attached: [] };
DEBUG.group.visible = false; scene.add(DEBUG.group);
const debugInk = new THREE.LineBasicMaterial({ color: C.accent, depthTest: false, transparent: true });
const debugRed = new THREE.LineBasicMaterial({ color: 0xFF3B30, depthTest: false, transparent: true });
// Intersections between solid meshes of different objects (stick into a box, can into the
// bench). Oriented boxes, shrunk by 0.5 mm so resting contact (box on box, can on bench)
// does not count. Bags and zones are hollow or flat and are left out.
const CONTACT_MM = 0.5;
function obbOf(mesh) {
  mesh.geometry.computeBoundingBox();
  const obb = new OBB().fromBox3(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
  obb.halfSize.subScalar(CONTACT_MM).max(new THREE.Vector3());
  return obb;
}
function collisions(targets) {
  const solids = targets.filter(t => t.object.isMesh && t.group), hits = new Map(solids.map(t => [t.name, []]));
  for (const t of solids) t.object.updateWorldMatrix(true, false);
  const obbs = solids.map(t => obbOf(t.object));
  for (let i = 0; i < solids.length; i++) for (let j = i + 1; j < solids.length; j++) {
    if (solids[i].group === solids[j].group || !obbs[i].intersectsOBB(obbs[j])) continue;
    hits.get(solids[i].name).push(solids[j].name); hits.get(solids[j].name).push(solids[i].name);
  }
  return hits;
}
const fmt = v => (Math.round(v * 10) / 10).toString();
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
function measure(object) {
  object.updateWorldMatrix(true, true);
  const tableAxes = v => { const p = fromThree(v.toArray()); return { x: Math.abs(p.x), y: Math.abs(p.y), z: Math.abs(p.z) }; };
  if (object.isMesh) {                    // oriented: the mesh's own box, axes matched to the nearest world axis
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox, size = local.getSize(new THREE.Vector3());
    const q = object.getWorldQuaternion(new THREE.Quaternion()), scale = object.getWorldScale(new THREE.Vector3());
    const world = new THREE.Vector3();
    AXES.forEach((axis, i) => {
      const dir = axis.clone().applyQuaternion(q).toArray().map(Math.abs), k = dir.indexOf(Math.max(...dir));
      world.setComponent(k, size.getComponent(i) * scale.getComponent(i));
    });
    const centre = local.getCenter(new THREE.Vector3()).applyMatrix4(object.matrixWorld);
    const aabb = new THREE.Box3().setFromObject(object);
    return { size: tableAxes(world), centre: fromThree(centre.toArray()), minZ: aabb.min.y, top: aabb.max.y };
  }
  const box = new THREE.Box3().setFromObject(object);
  return { size: tableAxes(box.getSize(new THREE.Vector3())), centre: fromThree(box.getCenter(new THREE.Vector3()).toArray()), minZ: box.min.y, top: box.max.y };
}
function debugTargets() {
  const list = [["Bench top", tableMesh, "bench"], ["Bench support", supportMesh, "bench"]];
  for (const [side, g] of Object.entries(bagGroups)) list.push([`${cap(side)} bag`, g, null]);
  for (const [name, g] of Object.entries(zoneGroups)) list.push([`${cap(name)} zone`, g, null]);
  for (const part of workbench?.debugParts() ?? []) list.push([part.name, part.object, part.group]);
  return list.filter(([, object]) => object).map(([name, object, group]) => ({ name, object, group }));
}
function textSprite(text) {
  const px = 44, c = document.createElement("canvas"), ctx = c.getContext("2d");
  const font = `600 ${px}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.font = font; c.width = Math.ceil(ctx.measureText(text).width + px); c.height = Math.ceil(px * 1.6);
  ctx.fillStyle = "rgba(27,29,33,0.88)"; ctx.beginPath(); ctx.roundRect(0, 0, c.width, c.height, px * 0.4); ctx.fill();
  ctx.font = font; ctx.fillStyle = "#F5C518"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const h = 11; sprite.scale.set(h * c.width / c.height, h, 1); sprite.renderOrder = 21;
  return sprite;
}
function clearDebug() {
  for (const helper of DEBUG.attached) { helper.parent?.remove(helper); helper.geometry.dispose(); }
  for (const child of [...DEBUG.group.children]) { DEBUG.group.remove(child); child.geometry?.dispose(); child.material?.map?.dispose(); if (child.material !== debugInk) child.material?.dispose?.(); }
  DEBUG.attached = []; DEBUG.labels = []; DEBUG.parts = [];
}
function scaleBar() {                    // 100 mm along +x near the bench's front-left corner, ticks every 10 mm
  const g = new THREE.Group(), z = table.height + 0.6, x0 = 15, y0 = 14;
  const yellow = new THREE.MeshBasicMaterial({ color: C.accent, depthTest: false }), dark = new THREE.MeshBasicMaterial({ color: 0x1B1D21, depthTest: false });
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(100, 3), yellow); bar.rotation.x = -Math.PI / 2;
  bar.position.copy(scenePose({ x: x0 + 50, y: y0, z }).pos); bar.renderOrder = 20; g.add(bar);
  for (let i = 0; i <= 10; i++) {
    const tick = new THREE.Mesh(new THREE.PlaneGeometry(0.8, i % 5 ? 4 : 7), dark); tick.rotation.x = -Math.PI / 2;
    tick.position.copy(scenePose({ x: x0 + i * 10, y: y0 + (i % 5 ? 1 : 2.5), z: z + 0.1 }).pos); tick.renderOrder = 21; g.add(tick);
  }
  const label = textSprite("100 mm"); label.position.copy(scenePose({ x: x0 + 50, y: y0 + 12, z: z + 6 }).pos); g.add(label);
  return g;
}
function refreshDebug() {
  clearDebug();
  const rows = [], targets = debugTargets(), hits = collisions(targets);
  DEBUG.targets = targets;
  for (const { name, object, group } of targets) {
    const m = measure(object);
    rows.push({ object: name, "w x mm": +fmt(m.size.x), "d y mm": +fmt(m.size.y), "h z mm": +fmt(m.size.z),
      "centre x": +fmt(m.centre.x), "centre y": +fmt(m.centre.y), "centre z": +fmt(m.centre.z), "bottom z": +fmt(m.minZ),
      intersects: hits.get(name)?.join(", ") || "", measured: false });
    if (!DEBUG.on) continue;
    if (object.isMesh) {                  // oriented box that follows the mesh (tilt, servo)
      const local = object.geometry.boundingBox, size = local.getSize(new THREE.Vector3());
      const helper = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z)), debugInk);
      helper.position.copy(local.getCenter(new THREE.Vector3())); helper.renderOrder = 20; helper.raycast = () => {};
      object.add(helper); DEBUG.attached.push(helper); DEBUG.parts.push({ name, helper });
    } else {
      const helper = new THREE.Box3Helper(new THREE.Box3().setFromObject(object), C.accent);
      helper.material.depthTest = false; helper.material.transparent = true; helper.renderOrder = 20; DEBUG.group.add(helper);
    }
    const label = textSprite(`${name} ${fmt(m.size.x)} × ${fmt(m.size.y)} × ${fmt(m.size.z)}`);
    DEBUG.group.add(label); DEBUG.labels.push({ label, object });
  }
  DEBUG.bar ??= scene.add(scaleBar()).children.at(-1);
  DEBUG.bar.visible = DEBUG.on;
  DEBUG.group.visible = DEBUG.on;
  updateDebugLabels();
  console.table(rows);
  return rows;
}
// Red outline on every part that currently intersects another object (sliders stay visual-only).
function updateDebugCollisions() {
  if (!DEBUG.targets) return;
  const hits = collisions(DEBUG.targets);
  for (const { name, helper } of DEBUG.parts ?? []) helper.material = hits.get(name)?.length ? debugRed : debugInk;
}
function updateDebugLabels() {
  // Each label starts just above its object and moves up until its on-screen
  // rectangle overlaps no label placed before it.
  const w = host.clientWidth, h = host.clientHeight, used = [], p = new THREE.Vector3();
  const rect = (label, pos) => {
    p.copy(pos).project(camera);
    const dist = camera.position.distanceTo(pos), px = (h / 2) / Math.tan(camera.fov * DEG / 2) / dist;
    const cx = (p.x + 1) / 2 * w, cy = (1 - p.y) / 2 * h, hw = label.scale.x * px / 2 + 3, hh = label.scale.y * px / 2 + 2;
    return { x0: cx - hw, x1: cx + hw, y0: cy - hh, y1: cy + hh };
  };
  const hits = r => used.some(u => r.x0 < u.x1 && r.x1 > u.x0 && r.y0 < u.y1 && r.y1 > u.y0);
  for (const { label, object } of DEBUG.labels) {
    const box = new THREE.Box3().setFromObject(object), pos = box.getCenter(new THREE.Vector3());
    pos.y = box.max.y + 8;
    let r = rect(label, pos);
    for (let i = 0; i < 40 && hits(r); i++) { pos.y += 4; r = rect(label, pos); }
    used.push(r); label.position.copy(pos);
  }
}
addEventListener("keydown", e => {
  if (document.querySelector("dialog[open]") || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  if (e.key !== "d" && e.key !== "D") return;
  DEBUG.on = !DEBUG.on; refreshDebug();
});
window.gekkoDebug = { refresh: refreshDebug, get on() { return DEBUG.on; } };
refreshDebug();
// ---- loop ------------------------------------------------------------------
let previousTime = performance.now() / 1000;
fitCamera(); resize();
renderer.setAnimationLoop(() => {
  const now = performance.now() / 1000;
  swarmOverlay.update(now);
  workbench.update(now - previousTime); previousTime = now;
  updateGhosts(now);
  updateBest(now, lastFrame?.phase);
  if (DEBUG.on) { updateDebugLabels(); updateDebugCollisions(); }
  if (controls.enabled) controls.update();
  renderer.clear();
  renderer.render(scene, camera);

});
