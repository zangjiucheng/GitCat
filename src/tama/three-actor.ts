import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { TamaActor, TamaGesture, TamaState } from "./types";

const MODEL_URL = "/tama/models/kirara/model.glb";

type ThreeActorOptions = {
  mount: HTMLElement;
  onUnavailable: () => void;
};

type Rig = {
  head: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  upperBody: THREE.Object3D | null;
  leftArm: THREE.Object3D | null;
  rightArm: THREE.Object3D | null;
  tail: THREE.Object3D | null;
};

class Tama3DActor implements TamaActor {
  private readonly mount: HTMLElement;
  private readonly onUnavailable: () => void;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.OrthographicCamera | null = null;
  private model: THREE.Object3D | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame = 0;
  private lastFrame = 0;
  private state: TamaState = "idle";
  private paused = false;
  private destroyed = false;
  private pointerX = 0;
  private pointerY = 0;
  private gesture: TamaGesture | null = null;
  private gestureStarted = 0;
  private rig: Rig = { head: null, neck: null, upperBody: null, leftArm: null, rightArm: null, tail: null };
  private baseRotations = new Map<THREE.Object3D, THREE.Euler>();

  constructor(options: ThreeActorOptions) {
    this.mount = options.mount;
    this.onUnavailable = options.onUnavailable;
  }

  async load(): Promise<boolean> {
    try {
      const response = await fetch(MODEL_URL, { method: "HEAD", cache: "no-cache" });
      if (!response.ok || this.destroyed) return false;

      const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
      if (this.destroyed) return false;

      this.canvas = document.createElement("canvas");
      this.canvas.className = "tama-3d-canvas";
      this.canvas.setAttribute("aria-hidden", "true");
      this.canvas.addEventListener("webglcontextlost", this.handleContextLost);
      this.mount.replaceChildren(this.canvas);

      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, powerPreference: "low-power" });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.15;

      this.scene = new THREE.Scene();
      this.scene.add(new THREE.HemisphereLight(0xfff4e8, 0x596477, 2.4));
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(2, 3, 4);
      this.scene.add(key);

      this.model = gltf.scene;
      this.prepareModel();
      this.scene.add(this.model);
      this.frameCamera();
      this.captureRig();
      this.resize();

      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.mount);
      document.addEventListener("visibilitychange", this.handleVisibility);
      this.lastFrame = performance.now();
      this.startLoop();
      return true;
    } catch (error) {
      console.debug("Tama 3D model unavailable; keeping the sprite fallback.", error);
      return false;
    }
  }

  setState(state: TamaState): void {
    this.state = state;
  }

  playGesture(gesture: TamaGesture): void {
    this.gesture = gesture;
    this.gestureStarted = performance.now();
  }

  setPointer(clientX: number, clientY: number): void {
    const rect = this.mount.getBoundingClientRect();
    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height * 0.35);
    this.pointerX = THREE.MathUtils.clamp(dx / Math.max(window.innerWidth * 0.45, 1), -1, 1);
    this.pointerY = THREE.MathUtils.clamp(dy / Math.max(window.innerHeight * 0.45, 1), -1, 1);
  }

  clearPointer(): void {
    this.pointerX = 0;
    this.pointerY = 0;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (!paused && !document.hidden) {
      this.lastFrame = performance.now();
      this.startLoop();
    }
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.frame);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas?.removeEventListener("webglcontextlost", this.handleContextLost);
    this.model?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material?.dispose();
    });
    this.renderer?.dispose();
    this.mount.replaceChildren();
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.model = null;
  }

  private prepareModel(): void {
    if (!this.model) return;
    this.model.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!material) continue;
        material.side = THREE.DoubleSide;
        if ("alphaTest" in material) material.alphaTest = 0.08;
        material.needsUpdate = true;
      }
    });

    const box = new THREE.Box3().setFromObject(this.model);
    const center = box.getCenter(new THREE.Vector3());
    this.model.position.set(-center.x, -box.min.y, -center.z);
  }

  private frameCamera(): void {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    const size = box.getSize(new THREE.Vector3());
    // The sidebar nook is portrait-shaped but tiny. A thigh-up crop keeps the
    // face, ears, hands and tail readable instead of reducing the whole model
    // to a narrow full-body silhouette.
    const centerY = box.min.y + size.y * 0.78;
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, Math.max(100, size.y * 10));
    this.camera.position.set(0, centerY, Math.max(size.y * 1.8, size.z * 3));
    this.camera.lookAt(0, centerY, 0);
    this.camera.userData.modelHeight = size.y;
  }

  private captureRig(): void {
    if (!this.model) return;
    const model = this.model;
    const find = (...names: string[]): THREE.Object3D | null => {
      for (const name of names) {
        const exact = model.getObjectByName(name);
        if (exact) return exact;
      }
      let match: THREE.Object3D | null = null;
      model.traverse((object) => {
        if (!match && names.some((name) => object.name.includes(name))) match = object;
      });
      return match;
    };
    this.rig = {
      head: find("頭", "头", "Head"),
      neck: find("首", "Neck"),
      upperBody: find("上半身2", "上半身", "UpperBody"),
      leftArm: find("左腕", "左腕", "LeftArm"),
      rightArm: find("右腕", "右腕", "RightArm"),
      tail: find("尾", "Tail"),
    };
    for (const bone of Object.values(this.rig)) {
      if (bone) this.baseRotations.set(bone, bone.rotation.clone());
    }
  }

  private resize(): void {
    if (!this.renderer || !this.camera) return;
    const rect = this.mount.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || 78));
    const height = Math.max(1, Math.round(rect.height || 104));
    const modelHeight = Number(this.camera.userData.modelHeight) || 1;
    const halfHeight = modelHeight * 0.38;
    const halfWidth = halfHeight * (width / height);
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.zoom = 1.05;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  private startLoop(): void {
    if (this.frame || this.destroyed || this.paused || document.hidden) return;
    this.frame = requestAnimationFrame(this.animate);
  }

  private animate = (now: number): void => {
    this.frame = 0;
    if (this.destroyed || this.paused || document.hidden) return;
    const delta = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    this.updatePose(now / 1000, delta);
    if (this.renderer && this.scene && this.camera) this.renderer.render(this.scene, this.camera);
    this.startLoop();
  };

  private updatePose(time: number, delta: number): void {
    const smooth = 1 - Math.exp(-delta * 8);
    const apply = (bone: THREE.Object3D | null, x = 0, y = 0, z = 0): void => {
      if (!bone) return;
      const base = this.baseRotations.get(bone);
      if (!base) return;
      bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, base.x + x, smooth);
      bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, base.y + y, smooth);
      bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, base.z + z, smooth);
    };

    const breathe = Math.sin(time * 1.8) * 0.018;
    let headX = this.pointerY * 0.16;
    let headY = this.pointerX * 0.28;
    let headZ = Math.sin(time * 0.75) * 0.018;
    let arm = 0;

    if (this.state === "sleep") {
      headX += 0.2;
      headZ += 0.16;
    } else if (this.state === "thinking") {
      headZ -= 0.13;
      headY += 0.12;
    } else if (this.state === "warn" || this.state === "confused") {
      headZ += Math.sin(time * 7) * 0.035;
    } else if (this.state === "danger") {
      headY += Math.sin(time * 14) * 0.06;
    } else if (this.state === "celebrate" || this.state === "greeting") {
      arm = 0.55 + Math.sin(time * 5) * 0.12;
      headZ += Math.sin(time * 3) * 0.05;
    } else if (this.state === "curious" || this.state === "hint") {
      headZ -= 0.1;
    }

    const gestureAge = performance.now() - this.gestureStarted;
    if (this.gesture && gestureAge < 1100) {
      const phase = gestureAge / 1100;
      if (this.gesture === "nod") headX += Math.sin(phase * Math.PI * 2) * 0.18;
      else headY += Math.sin(phase * Math.PI * 2) * 0.24;
    } else {
      this.gesture = null;
    }

    apply(this.rig.head, headX, headY, headZ);
    apply(this.rig.neck, headX * 0.25, headY * 0.2, headZ * 0.2);
    apply(this.rig.upperBody, breathe, 0, -breathe * 0.5);
    apply(this.rig.leftArm, 0, 0, -arm);
    apply(this.rig.rightArm, 0, 0, arm);
    apply(this.rig.tail, 0, Math.sin(time * 2.4) * 0.14, Math.sin(time * 1.7) * 0.06);
  }

  private handleVisibility = (): void => {
    if (!document.hidden && !this.paused) {
      this.lastFrame = performance.now();
      this.startLoop();
    }
  };

  private handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.onUnavailable();
  };
}

export function createTama3DActor(options: ThreeActorOptions): TamaActor {
  return new Tama3DActor(options);
}
