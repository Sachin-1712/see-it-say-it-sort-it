// Independent playback of the simulator's collision bodies. Enabled by ?sim=1.
import * as THREE from "three";
import { assetRouter } from "./assets.mjs";
import { toThree } from "./frame.mjs";
import { applyJoint } from "./model-assets.mjs";
import { workbenchState } from "./workbench-state.mjs";
import { physicsUrl } from "./world-physics.mjs";

const radians = Math.PI / 180;
const rotationAxes = [
  new THREE.Vector3(...toThree({ z: 1 })),
  new THREE.Vector3(...toThree({ y: 1 })),
  new THREE.Vector3(...toThree({ x: 1 })),
];

function orientation(sample, target, component) {
  target.identity();
  for (const [index, angle] of [sample[6], sample[5], sample[4]].entries()) {
    target.multiply(component.setFromAxisAngle(rotationAxes[index], angle * radians));
  }
}

function point([, x, y, z]) {
  return toThree({ x, y, z });
}

function meshBox(scene, { width, depth, height }, color, options) {
  const geometry = new THREE.BoxGeometry(...toThree({ x: width, y: depth, z: height }).map(Math.abs));
  const material = new THREE.MeshStandardMaterial({ color, ...options });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  return mesh;
}

function animate(host, rig, models, snapshot, result, assembly) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9eaec);
  if (assembly) scene.add(assembly);
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 4000);
  const { table, bags } = rig;
  camera.position.fromArray(toThree({ x: table.width * 1.5, y: -table.depth,
    z: table.height + table.depth }));
  camera.lookAt(...toThree({ x: table.width / 2, y: table.depth / 2, z: table.height / 2 }));
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d949b, 2.6));
  const bench = meshBox(scene, { ...table, height: table.thickness }, 0x727985);
  bench.position.fromArray(toThree({ x: table.width / 2, y: table.depth / 2,
    z: table.height - table.thickness / 2 }));
  for (const [key, bag] of Object.entries(bags)) {
    const { x, y, width, depth, height, wall_thickness: t } = bag;
    const color = key === "left" ? 0xcd4949 : 0x3d76ac;
    const base = meshBox(scene, { width, depth, height: t }, color);
    base.position.fromArray(toThree({ x, y, z: t / 2 }));
    for (const sign of [-1, 1]) {
      const side = meshBox(scene, { width: t, depth: depth - 2 * t, height }, color,
        { transparent: true, opacity: 0.25, depthWrite: false });
      side.position.fromArray(toThree({ x: x + sign * (width - t) / 2, y, z: height / 2 }));
      const end = meshBox(scene, { width, depth: t, height }, color,
        { transparent: true, opacity: 0.25, depthWrite: false });
      end.position.fromArray(toThree({ x, y: y + sign * (depth - t) / 2, z: height / 2 }));
    }
  }

  const boxes = new Map(snapshot.objects.filter(item => item.type === "box").map(item => [
    item.instanceId, meshBox(scene, item.dimensionsMm,
      item.color === "red" ? 0xcd4949 : item.color === "blue" ? 0x3d76ac : 0x969696),
  ]));
  const { stick } = models.sweeper;
  boxes.set("stick", meshBox(scene, {
    width: stick.lengthMm, depth: stick.widthMm, height: stick.thicknessMm,
  }, 0xb58b5b));

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  host.replaceChildren(renderer.domElement);
  function resize() {
    const width = host.clientWidth;
    const height = Math.max(240, Math.round(width * 0.62));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  const start = performance.now();
  const tracks = Object.entries(result.trajectories).filter(([id, path]) => boxes.has(id) && path.length);
  const nextPoint = new THREE.Vector3();
  const nextRotation = new THREE.Quaternion();
  const component = new THREE.Quaternion();
  let frame;
  function draw(now) {
    const seconds = (now - start) / 1000;
    let playing = false;
    for (const [id, path] of tracks) {
      const interval = path[1]?.[0] - path[0][0];
      const index = interval > 0 ? Math.min(path.length - 1, Math.floor(seconds / interval)) : 0;
      const first = path[index], next = path[Math.min(index + 1, path.length - 1)];
      const fraction = next === first ? 0 : THREE.MathUtils.clamp((seconds - first[0]) / (next[0] - first[0]), 0, 1);
      const mesh = boxes.get(id);
      mesh.position.fromArray(point(first)).lerp(nextPoint.fromArray(point(next)), fraction);
      orientation(first, mesh.quaternion, component);
      orientation(next, nextRotation, component);
      mesh.quaternion.slerp(nextRotation, fraction);
      playing ||= next !== first;
    }
    renderer.render(scene, camera);
    if (playing) frame = requestAnimationFrame(draw);
  }
  frame = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    assembly?.removeFromParent(); // The model library shares this clone’s geometry and materials.
    scene.traverse(object => {
      if (object.isMesh) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    renderer.dispose();
    host.replaceChildren();
  };
}

async function installPreview() {
  const socket = new WebSocket(physicsUrl());
  const trigger = Object.assign(document.createElement("button"), { type: "button", textContent: "Simulate push" });
  const toolbar = document.querySelector("#workbench-toolbar .world-actions");
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Physics preview");
  dialog.style.width = "min(680px, 90vw)";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const canvas = document.createElement("div");
  const close = Object.assign(document.createElement("button"), { type: "button", textContent: "Close preview" });
  close.onclick = () => dialog.close();
  dialog.append(status, canvas, close);
  let activeSnapshot;
  let dispose;
  let pending = false;
  const config = Promise.all(["rig", "models"].map(async name => {
    const response = await fetch(`../config/${name}.json`);
    if (!response.ok) throw new Error(`Could not load ${name} config`);
    return response.json();
  })).catch(error => ({ error }));
  socket.addEventListener("open", () => {
    toolbar?.append(trigger);
    document.body.append(dialog);
  });
  socket.addEventListener("close", () => {
    trigger.remove();
    if (dialog.open && pending) status.textContent = "Simulation service disconnected.";
    pending = false;
  });
  dialog.addEventListener("close", () => {
    dispose?.();
    dispose = undefined;
  });
  trigger.onclick = () => {
    if (pending || socket.readyState !== WebSocket.OPEN) return;
    activeSnapshot = workbenchState.snapshot();
    const parcels = activeSnapshot.objects.filter(item => item.type === "box");
    const target = parcels.find(item => item.instanceId === activeSnapshot.selectedId)
      ?? parcels.sort((a, b) => b.baseZ - a.baseZ)[0];
    dialog.showModal();
    if (!target || !activeSnapshot.objects.some(item => item.type === "sweeper")) {
      status.textContent = "Place a box and the sweeper to rehearse a push.";
      return;
    }
    pending = true;
    trigger.disabled = true;
    status.textContent = "Rehearsing pushes…";
    socket.send(JSON.stringify({ cmd: "search", snapshot: activeSnapshot, target: target.instanceId, budget: 200 }));
  };
  socket.addEventListener("message", async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === "candidate") {
      if (dialog.open) status.textContent = `Rehearsed ${message.attempt} pushes…`;
      return;
    }
    pending = false;
    trigger.disabled = false;
    if (!dialog.open) return;
    if (message.type === "error") {
      status.textContent = message.reason;
      return;
    }
    const result = message.best?.result ?? message.result;
    if (!result) {
      status.textContent = "No clear approach to the selected box.";
      return;
    }
    status.textContent = result.success
      ? `Landed in the ${result.target.landed_bag} bag after ${message.attempts ?? 1} attempts.`
      : result.reason;
    if (result.robust_score != null) {
      const percent = Math.round(result.robust_score * 100);
      status.textContent += ` Robustness ${percent}% across ${result.robust_trials} trials.`;
      if (result.meets_search_goal === false) status.textContent += " Below the 80% search target.";
    }
    if (result.invalid) return;
    const current = activeSnapshot;
    const sweeper = current.objects.find(item => item.type === "sweeper");
    const loaded = await config;
    if (current !== activeSnapshot || !dialog.open) return;
    try {
      if (loaded.error) throw loaded.error;
      let assembly;
      if (sweeper) {
        const { root, joints } = await assetRouter.instantiate(sweeper);
        if (current !== activeSnapshot || !dialog.open) return;
        root.position.fromArray(toThree({ ...sweeper.position, z: sweeper.baseZ }));
        applyJoint(joints.tilt, result.realized_tilt_deg);
        joints.servo.node.visible = false; // The independent stick follows the solved trajectory.
        assembly = root;
      }
      dispose?.();
      dispose = animate(canvas, ...loaded, current, result, assembly);
    } catch (error) {
      status.textContent += ` Playback unavailable: ${error.message}`;
    }
  });
}

if (new URLSearchParams(location.search).get("sim") === "1") installPreview();
