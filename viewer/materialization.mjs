import * as THREE from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { sampleModelSurface } from "./surface-points.mjs";
// 2.2 s: slow enough to see the photo dissolve and the points settle onto the model.
export const MATERIALIZATION_DURATION_MS = 2200;

// A contained photo -> surface-particle -> opaque-model transition, never reconstruction.
export class Materializer {
  token = 0; frame = null; resources = null; finish = null;
  constructor(scene, camera, draw) {
    Object.assign(this, { scene, camera, draw });
    this.motion = matchMedia("(prefers-reduced-motion: reduce)");
    this.motion.addEventListener("change", () => { if (this.motion.matches) this.cancel(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.cancel(); });
  }
  cancel() {
    this.token++;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null; this.finish?.(); this.finish = null;
    if (this.resources) {
      const { points, plane, texture, root } = this.resources;
      this.scene.remove(points, plane);
      for (const object of [points, plane]) { object.geometry.dispose(); object.material.dispose(); }
      texture.dispose(); root.visible = true; this.resources = null; this.draw();
    }
  }
  async play(root, photoUrl) {
    this.cancel();
    if (this.motion.matches || !photoUrl) { root.visible = true; this.draw(); return; }
    const token = this.token;
    const texture = await new THREE.TextureLoader().loadAsync(photoUrl);
    if (token !== this.token) { texture.dispose(); return; }
    texture.colorSpace = THREE.SRGBColorSpace;
    const count = 1800, targets = sampleModelSurface(THREE, MeshSurfaceSampler, root, count);
    const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
    const distance = this.camera.position.distanceTo(center), maxHeight = 2 * distance * Math.tan(this.camera.fov * Math.PI / 360) * .88;
    const aspect = texture.image.width / texture.image.height;
    const height = Math.min(maxHeight, maxHeight * this.camera.aspect / aspect), width = height * aspect;
    const starts = new Float32Array(count * 3), seeds = new Float32Array(count), point = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      const u = (i % 45 + .5) / 45, v = (Math.floor(i / 45) + .5) / 40;
      point.set((u - .5) * width, (v - .5) * height, 0).applyQuaternion(this.camera.quaternion).add(center).toArray(starts, i * 3);
      seeds[i] = Math.random();
    }
    const progress = { value: 0 };
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(starts, 3));
    geometry.setAttribute("aTarget", new THREE.BufferAttribute(targets, 3));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    const points = new THREE.Points(geometry, new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false,
      uniforms: { uProgress: progress, uSpread: { value: radius * .16 }, uSize: { value: 1.8 * Math.min(devicePixelRatio, 2) } },
      vertexShader: `attribute vec3 aTarget; attribute float aSeed; uniform float uProgress; uniform float uSpread; uniform float uSize; varying float vAlpha;
        void main() { float t=smoothstep(0.1,0.9,uProgress); vec3 scatter=vec3(sin(aSeed*97.0),cos(aSeed*63.0),sin(aSeed*43.0))*uSpread*sin(t*3.14159265);
          vec3 p=mix(position,aTarget,t)+scatter; gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0); gl_PointSize=uSize;
          vAlpha=smoothstep(0.02,0.18,uProgress)*(1.0-smoothstep(0.88,1.0,uProgress)); }`,
      fragmentShader: `varying float vAlpha; void main(){float d=length(gl_PointCoord-0.5); if(d>0.5)discard; gl_FragColor=vec4(vec3(0.86),vAlpha*(1.0-smoothstep(0.25,0.5,d)));}`,
    }));
    points.frustumCulled = false; points.renderOrder = 12;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
      uniforms: { uPhoto: { value: texture }, uProgress: progress },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D uPhoto; uniform float uProgress; varying vec2 vUv;
        void main(){ vec2 tile=floor(vUv*vec2(70.0,50.0)); float noise=fract(sin(dot(tile,vec2(12.9898,78.233)))*43758.5453);
          if(noise<smoothstep(0.03,0.55,uProgress)) discard; gl_FragColor=texture2D(uPhoto,vUv);
          #include <colorspace_fragment>
        }`,
    }));
    plane.position.copy(center); plane.quaternion.copy(this.camera.quaternion); plane.renderOrder = 11;
    this.scene.add(points, plane); root.visible = false;
    this.resources = { points, plane, texture, root };
    await new Promise(resolve => {
      this.finish = resolve; const start = performance.now();
      const step = now => {
        if (token !== this.token) return;
        const t = Math.min(1, (now - start) / MATERIALIZATION_DURATION_MS);
        progress.value = t; root.visible = t >= .88; this.draw();
        if (t < 1) this.frame = requestAnimationFrame(step); else this.cancel();
      };
      this.frame = requestAnimationFrame(step);
    });
  }
}
