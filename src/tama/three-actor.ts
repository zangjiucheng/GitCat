import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { TamaActor, TamaGesture, TamaState } from "./types";

const MODEL_URL = "/tama/models/kirara/model.glb";

type ThreeActorOptions = {
  mount: HTMLElement;
  onUnavailable: () => void;
  debug?: boolean;
};

export type TamaDebugRotation = { x: number; y: number; z: number };

export interface Tama3DDebugActor extends TamaActor {
  getDebugBoneNames(): string[];
  getDebugBoneOffset(name: string): TamaDebugRotation;
  selectDebugBone(name: string): boolean;
  setDebugBoneOffset(name: string, rotation: TamaDebugRotation): boolean;
  resetDebugBone(name: string): void;
  resetAllDebugBones(): void;
  setDebugMarkerVisible(visible: boolean): void;
}

type Rig = {
  head: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  upperBody: THREE.Object3D | null;
  lowerBody: THREE.Object3D | null;
  leftShoulder: THREE.Object3D | null;
  rightShoulder: THREE.Object3D | null;
  leftArm: THREE.Object3D | null;
  rightArm: THREE.Object3D | null;
  leftElbow: THREE.Object3D | null;
  rightElbow: THREE.Object3D | null;
  leftWrist: THREE.Object3D | null;
  rightWrist: THREE.Object3D | null;
  leftThumb: THREE.Object3D[];
  rightThumb: THREE.Object3D[];
  leftFingers: THREE.Object3D[];
  rightFingers: THREE.Object3D[];
  leftEar: THREE.Object3D[];
  rightEar: THREE.Object3D[];
  tailBase: THREE.Object3D | null;
  leftTail: THREE.Object3D[];
  rightTail: THREE.Object3D[];
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
  private readonly debugEnabled: boolean;
  private readonly debugOffsets = new Map<string, THREE.Vector3>();
  private debugBone: THREE.Object3D | null = null;
  private debugMarker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
  private rig: Rig = {
    head: null,
    neck: null,
    upperBody: null,
    lowerBody: null,
    leftShoulder: null,
    rightShoulder: null,
    leftArm: null,
    rightArm: null,
    leftElbow: null,
    rightElbow: null,
    leftWrist: null,
    rightWrist: null,
    leftThumb: [],
    rightThumb: [],
    leftFingers: [],
    rightFingers: [],
    leftEar: [],
    rightEar: [],
    tailBase: null,
    leftTail: [],
    rightTail: [],
  };
  private baseRotations = new Map<THREE.Object3D, THREE.Euler>();
  private baseModelPosition = new THREE.Vector3();

  constructor(options: ThreeActorOptions) {
    this.mount = options.mount;
    this.onUnavailable = options.onUnavailable;
    this.debugEnabled = options.debug ?? false;
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

  getDebugBoneNames(): string[] {
    if (!this.debugEnabled || !this.model) return [];
    const names: string[] = [];
    this.model.traverse((object) => {
      if (object.type === "Bone" && object.name && !object.name.endsWith("_end")) names.push(object.name);
    });
    return names.sort((left, right) => left.localeCompare(right, "ja"));
  }

  getDebugBoneOffset(name: string): TamaDebugRotation {
    const offset = this.debugOffsets.get(name);
    return { x: offset?.x ?? 0, y: offset?.y ?? 0, z: offset?.z ?? 0 };
  }

  selectDebugBone(name: string): boolean {
    if (!this.debugEnabled || !this.model || !this.scene) return false;
    const bone = this.model.getObjectByName(name);
    if (!bone || bone.type !== "Bone") return false;
    this.debugBone = bone;
    if (!this.debugMarker) {
      const modelHeight = Number(this.camera?.userData.modelHeight) || 1;
      this.debugMarker = new THREE.Mesh(
        new THREE.SphereGeometry(modelHeight * 0.012, 18, 12),
        new THREE.MeshBasicMaterial({ color: 0xff4f91, depthTest: false, transparent: true, opacity: 0.95 }),
      );
      this.debugMarker.renderOrder = 1000;
      this.scene.add(this.debugMarker);
    }
    this.debugMarker.visible = true;
    return true;
  }

  setDebugBoneOffset(name: string, rotation: TamaDebugRotation): boolean {
    if (!this.debugEnabled || !this.model?.getObjectByName(name)) return false;
    this.debugOffsets.set(name, new THREE.Vector3(rotation.x, rotation.y, rotation.z));
    return true;
  }

  resetDebugBone(name: string): void {
    this.debugOffsets.delete(name);
  }

  resetAllDebugBones(): void {
    this.debugOffsets.clear();
  }

  setDebugMarkerVisible(visible: boolean): void {
    if (this.debugMarker) this.debugMarker.visible = visible;
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
    this.debugMarker?.geometry.dispose();
    this.debugMarker?.material.dispose();
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
    this.baseModelPosition.copy(this.model.position);
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
    const chain = (...names: string[]): THREE.Object3D[] =>
      names.map((name) => model.getObjectByName(name)).filter((bone): bone is THREE.Object3D => Boolean(bone));
    this.rig = {
      head: find("頭", "头", "Head"),
      neck: find("首", "Neck"),
      upperBody: find("上半身2", "上半身", "UpperBody"),
      lowerBody: find("下半身", "LowerBody"),
      leftShoulder: find("左肩", "LeftShoulder"),
      rightShoulder: find("右肩", "RightShoulder"),
      leftArm: find("左腕", "左腕", "LeftArm"),
      rightArm: find("右腕", "右腕", "RightArm"),
      leftElbow: find("左ひじ", "LeftElbow"),
      rightElbow: find("右ひじ", "RightElbow"),
      leftWrist: find("左手首", "LeftWrist"),
      rightWrist: find("右手首", "RightWrist"),
      leftThumb: chain("左親指０", "左親指１", "左親指２"),
      rightThumb: chain("右親指０", "右親指１", "右親指２"),
      leftFingers: ["人指", "中指", "薬指", "小指"].flatMap((finger) =>
        chain(`左${finger}１`, `左${finger}２`, `左${finger}３`),
      ),
      rightFingers: ["人指", "中指", "薬指", "小指"].flatMap((finger) =>
        chain(`右${finger}１`, `右${finger}２`, `右${finger}３`),
      ),
      // Weight inspection of the GLB shows that the head ornaments use the
      // TJ chains, while Kirara's two tails share 右W_1 before splitting into
      // the right W chain and the 左W branch. The node named 尾 is only a
      // skinned mesh, so rotating it was never a real tail animation.
      leftEar: chain("左TJ_0_1", "左TJ_1_1", "左TJ_2_1"),
      rightEar: chain("右TJ_0_1", "右TJ_1_1", "右TJ_2_1"),
      tailBase: find("右W_1"),
      leftTail: chain("左W_1", "左W_2", "左W_3", "左W_4"),
      rightTail: chain("右W_3", "右W_4", "右W_5", "右W_6"),
    };
    for (const value of Object.values(this.rig)) {
      const bones = Array.isArray(value) ? value : [value];
      for (const bone of bones) {
        if (bone) this.baseRotations.set(bone, bone.rotation.clone());
      }
    }
    if (this.debugEnabled) {
      model.traverse((object) => {
        if (object.type === "Bone" && !this.baseRotations.has(object)) {
          this.baseRotations.set(object, object.rotation.clone());
        }
      });
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
    this.camera.zoom = 1.26;
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
    const appliedBones = new Set<THREE.Object3D>();
    const apply = (bone: THREE.Object3D | null, x = 0, y = 0, z = 0): void => {
      if (!bone) return;
      const base = this.baseRotations.get(bone);
      if (!base) return;
      appliedBones.add(bone);
      const debug = this.debugOffsets.get(bone.name);
      bone.rotation.x = THREE.MathUtils.lerp(bone.rotation.x, base.x + x + (debug?.x ?? 0), smooth);
      bone.rotation.y = THREE.MathUtils.lerp(bone.rotation.y, base.y + y + (debug?.y ?? 0), smooth);
      bone.rotation.z = THREE.MathUtils.lerp(bone.rotation.z, base.z + z + (debug?.z ?? 0), smooth);
    };

    const breathe = Math.sin(time * 1.8) * 0.018;
    let headX = this.pointerY * 0.16;
    let headY = this.pointerX * 0.28;
    let headZ = Math.sin(time * 0.75) * 0.018;
    let bodyX = breathe;
    let bodyY = 0;
    let bodyZ = -breathe * 0.5;
    // Relax the imported MMD A-pose at both joints. Moving only the upper-arm
    // bone leaves the sleeve/shoulder flared, so a small mirrored shoulder drop
    // is paired with a stronger upper-arm rotation toward the body.
    let leftShoulderZ = -0.12;
    let rightShoulderZ = 0.12;
    let leftArmZ = -0.56;
    let rightArmZ = 0.56;
    let leftArmX = 0;
    let rightArmX = 0;
    // Keep relaxed elbows almost straight. The old large mirrored bend moved
    // the hands inward, but visibly kicked both elbows away from the torso.
    let leftElbowZ = -0.06;
    let rightElbowZ = 0.06;
    let leftWristX = 0;
    let rightWristX = 0;
    let leftWristY = 0;
    let rightWristY = 0;
    let leftWristZ = 0;
    let rightWristZ = 0;
    // A relaxed hand is never perfectly flat. Keep a subtle living curl in
    // all states, then open or close the fingers for individual gestures.
    let leftFingerCurl = 0.16 + Math.sin(time * 1.15) * 0.018;
    let rightFingerCurl = 0.16 + Math.sin(time * 1.15 + 0.8) * 0.018;
    let leftFingerRipple = 0;
    let rightFingerRipple = 0;
    let lift = Math.sin(time * 1.8) * 0.004;
    let sway = 0;
    let lowerBodyZ = 0;
    const leftFlick = Math.pow(Math.max(0, Math.sin(time * 0.83)), 18) * 0.1;
    const rightFlick = Math.pow(Math.max(0, Math.sin(time * 0.71 + 2.2)), 20) * 0.08;
    let leftEarX = 0;
    let leftEarY = 0;
    let leftEarZ = -leftFlick;
    let rightEarX = 0;
    let rightEarY = 0;
    let rightEarZ = rightFlick;
    let tailBaseY = Math.sin(time * 1.35) * 0.08;
    let tailBaseZ = 0;
    let leftTailY = Math.sin(time * 1.35 + 0.7) * 0.07;
    let leftTailZ = 0.04;
    let rightTailY = Math.sin(time * 1.35 - 0.7) * 0.07;
    let rightTailZ = -0.04;

    // This model uses an MMD rig whose arms point diagonally down from the
    // shoulders. Raising them therefore needs mirrored Z rotations: positive
    // on the model's left, negative on its right. Elbows also bend visibly on
    // Z; the old X-only bends mostly moved the forearm in depth and made the
    // poses look unchanged (or anatomically wrong) from the front camera.
    switch (this.state) {
      case "idle":
        // Relaxed nekomata idle: the two ears twitch independently while the
        // split tails drift out of phase. Arms stay entirely at rest.
        headZ += Math.sin(time * 0.75) * 0.012;
        break;
      case "sleep":
        // Ears loosen outward, tails curl close, and the whole torso settles.
        headX += 0.3;
        headZ += 0.11;
        bodyX += 0.1;
        leftEarX = rightEarX = 0.08;
        leftEarZ = -0.2;
        rightEarZ = 0.2;
        tailBaseY = Math.sin(time * 0.55) * 0.025;
        leftTailY = rightTailY = 0;
        leftTailZ = 0.2;
        rightTailZ = -0.2;
        lift = -0.012;
        break;
      case "hint":
        // One ear locks onto the target before a restrained presenting paw.
        headZ -= 0.1;
        headY += 0.08;
        leftArmZ = 0.28;
        leftElbowZ = 1.8;
        leftWristY = 1.05;
        leftWristZ = -0.16 + Math.sin(time * 3) * 0.05;
        leftFingerCurl = 0.5 + Math.sin(time * 3) * 0.08;
        leftFingerRipple = 0.035;
        leftEarZ = 0.08;
        rightEarZ = 0.02;
        tailBaseY = Math.sin(time * 2.2) * 0.13;
        leftTailZ = 0.12;
        rightTailZ = -0.08;
        break;
      case "thinking":
        // Asymmetric ears and a slow tail tip sell concentration; only one
        // hand supports the cheek instead of both arms forming a big pose.
        headZ -= 0.11;
        headY += 0.12;
        rightArmZ = -0.5;
        rightElbowZ = -2.02;
        rightWristY = -1.05;
        rightWristZ = 0.3;
        rightFingerCurl = 0.42;
        leftEarZ = -0.14;
        rightEarZ = -0.02;
        tailBaseY = Math.sin(time * 0.85) * 0.045;
        leftTailY = Math.sin(time * 1.1) * 0.04;
        rightTailY = Math.sin(time * 1.1 + 1.4) * 0.04;
        break;
      case "warn":
        // Ears pin back and the tails go rigid before one small stop gesture.
        headX -= 0.07;
        headZ += Math.sin(time * 7) * 0.025;
        leftArmZ = 0.3;
        leftElbowZ = 1.82;
        leftWristX = -0.2;
        leftWristY = 1.05;
        leftFingerCurl = 0.04;
        bodyX -= 0.035;
        leftEarZ = -0.25;
        rightEarZ = 0.25;
        tailBaseY = 0;
        leftTailY = rightTailY = 0;
        leftTailZ = 0.1;
        rightTailZ = -0.1;
        break;
      case "danger": {
        // Pinned ears and rapidly lashing twin tails lead the panic motion.
        const panic = Math.sin(time * 11) * 0.07;
        headY += Math.sin(time * 14) * 0.045;
        leftArmZ = 0.55 + panic * 0.4;
        rightArmZ = -0.55 - panic * 0.4;
        leftElbowZ = 2.14;
        rightElbowZ = -2.14;
        leftWristY = 1.05;
        rightWristY = -1.05;
        leftWristZ = -0.22;
        rightWristZ = 0.22;
        leftFingerCurl = 0.7;
        rightFingerCurl = 0.7;
        leftEarZ = -0.32 + panic * 0.2;
        rightEarZ = 0.32 - panic * 0.2;
        tailBaseY = Math.sin(time * 8.5) * 0.22;
        leftTailY = Math.sin(time * 9.5) * 0.18;
        rightTailY = Math.sin(time * 9.5 + 1.2) * 0.18;
        sway = Math.sin(time * 16) * 0.01;
        break;
      }
      case "celebrate": {
        // Hands become compact cat paws by the cheeks; ears perk and both
        // tails wag broadly in opposite phases.
        const cheer = Math.sin(time * 5) * 0.045;
        leftArmZ = 0.4 + cheer;
        rightArmZ = -0.4 - cheer;
        leftElbowZ = 2.02;
        rightElbowZ = -2.02;
        leftWristY = 1.05;
        rightWristY = -1.05;
        leftWristZ = -0.22;
        rightWristZ = 0.22;
        leftFingerCurl = 0.76 + Math.sin(time * 5) * 0.05;
        rightFingerCurl = 0.76 - Math.sin(time * 5) * 0.05;
        leftFingerRipple = 0.035;
        rightFingerRipple = 0.035;
        leftEarZ = 0.08;
        rightEarZ = -0.08;
        tailBaseY = Math.sin(time * 4.2) * 0.2;
        leftTailY = Math.sin(time * 5.2) * 0.2;
        rightTailY = Math.sin(time * 5.2 + Math.PI) * 0.2;
        headZ += Math.sin(time * 3) * 0.035;
        lift = Math.max(0, Math.sin(time * 4)) * 0.022;
        break;
      }
      case "rescue":
        // Forward ears, grounded hips and a modest open hand communicate help.
        rightArmX = -0.18;
        rightArmZ = -0.16;
        rightElbowZ = 0.18;
        rightWristX = -0.18;
        rightFingerCurl = 0.05;
        leftArmZ = -0.25;
        bodyZ = -0.045;
        headZ -= 0.045;
        lowerBodyZ = 0.025;
        leftEarY = -0.08;
        rightEarY = 0.08;
        tailBaseY = Math.sin(time * 1.15) * 0.055;
        break;
      case "confused":
        // One ear up, one ear out, and mismatched tails form the question.
        headZ += 0.15 + Math.sin(time * 2.4) * 0.02;
        leftEarZ = 0.1;
        rightEarZ = 0.24;
        tailBaseZ = 0.08;
        leftTailY = Math.sin(time * 1.2) * 0.04;
        rightTailY = Math.sin(time * 1.9 + 1) * 0.1;
        break;
      case "curious":
        // Ears lead toward the sound, head and hips follow, arms remain loose.
        headZ -= 0.12;
        headY -= 0.05;
        leftArmX = 0.12;
        rightArmX = -0.08;
        bodyZ = 0.018;
        lowerBodyZ = -0.02;
        leftEarY = 0.12;
        rightEarY = 0.08;
        leftEarZ = 0.08;
        rightEarZ = 0.02;
        tailBaseZ = -0.08;
        leftTailY = Math.sin(time * 1.7) * 0.08;
        rightTailY = Math.sin(time * 1.7 + 0.8) * 0.08;
        break;
      case "syncing": {
        // Focused ears and metronomic tails carry the working rhythm; hands
        // stay compact in front instead of pumping up and down.
        const work = Math.sin(time * 5) * 0.06;
        headX += 0.055;
        leftArmZ = -0.18;
        rightArmZ = 0.18;
        leftElbowZ = 2.9;
        rightElbowZ = -2.9;
        leftWristY = work * 0.7;
        rightWristY = -work * 0.7;
        leftFingerCurl = 0.52 + work;
        rightFingerCurl = 0.52 - work;
        leftEarZ = -0.03;
        rightEarZ = 0.03;
        tailBaseY = Math.sin(time * 3.2) * 0.12;
        leftTailY = Math.sin(time * 3.2) * 0.11;
        rightTailY = Math.sin(time * 3.2 + Math.PI) * 0.11;
        bodyY = Math.sin(time * 2.5) * 0.018;
        break;
      }
      case "greeting":
        // A small wave is supported by one ear flick and friendly twin tails.
        rightArmZ = -0.66;
        rightElbowZ = -2.02;
        rightWristY = -1.05 + Math.sin(time * 6) * 0.08;
        rightWristZ = 0.18 + Math.sin(time * 6) * 0.2;
        rightFingerCurl = 0.28 + Math.sin(time * 6) * 0.22;
        rightFingerRipple = 0.14;
        rightEarZ = -Math.pow(Math.max(0, Math.sin(time * 1.4)), 10) * 0.12;
        tailBaseY = Math.sin(time * 2.4) * 0.16;
        leftTailY = Math.sin(time * 2.8) * 0.14;
        rightTailY = Math.sin(time * 2.8 + 1.1) * 0.14;
        headZ -= 0.045;
        break;
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
    apply(this.rig.upperBody, bodyX, bodyY, bodyZ);
    apply(this.rig.lowerBody, 0, 0, lowerBodyZ);
    apply(this.rig.leftShoulder, 0, 0, leftShoulderZ);
    apply(this.rig.rightShoulder, 0, 0, rightShoulderZ);
    apply(this.rig.leftArm, leftArmX, 0, leftArmZ);
    apply(this.rig.rightArm, rightArmX, 0, rightArmZ);
    apply(this.rig.leftElbow, 0, 0, leftElbowZ);
    apply(this.rig.rightElbow, 0, 0, rightElbowZ);
    apply(this.rig.leftWrist, leftWristX, leftWristY, leftWristZ);
    apply(this.rig.rightWrist, rightWristX, rightWristY, rightWristZ);
    const applyFingers = (bones: THREE.Object3D[], curl: number, ripple: number, mirror: number): void => {
      const jointStrength = [0.55, 0.78, 0.68];
      bones.forEach((bone, index) => {
        const finger = Math.floor(index / 3);
        const staggeredCurl = curl + Math.sin(time * 6 + finger * 0.7) * ripple;
        const amount = staggeredCurl * jointStrength[index % 3];
        // The MMD finger bones are aligned mostly in screen space. Their
        // visible curl is therefore primarily local Z and mirrored per hand;
        // using X as the main axis fans the fingers outward after wrist twist.
        apply(bone, amount * 0.12, 0, -mirror * amount * 0.72);
      });
    };
    const applyThumb = (bones: THREE.Object3D[], curl: number, mirror: number): void => {
      bones.forEach((bone, index) => {
        const amount = curl * (index === 0 ? 0.38 : 0.62);
        apply(bone, amount * 0.22, mirror * amount * 0.12, -mirror * amount * 0.48);
      });
    };
    applyFingers(this.rig.leftFingers, leftFingerCurl, leftFingerRipple, -1);
    applyFingers(this.rig.rightFingers, rightFingerCurl, rightFingerRipple, 1);
    applyThumb(this.rig.leftThumb, leftFingerCurl, -1);
    applyThumb(this.rig.rightThumb, rightFingerCurl, 1);
    const applyChain = (bones: THREE.Object3D[], x: number, y: number, z: number): void => {
      bones.forEach((bone, index) => {
        const falloff = Math.pow(0.62, index);
        apply(bone, x * falloff, y * falloff, z * falloff);
      });
    };
    applyChain(this.rig.leftEar, leftEarX, leftEarY, leftEarZ);
    applyChain(this.rig.rightEar, rightEarX, rightEarY, rightEarZ);
    // Most of the W-chain's local Y rotation disappears into camera depth.
    // Project the authored wag primarily onto local Z so both tails remain
    // readable instead of blinking in and out of the tiny portrait crop.
    apply(this.rig.tailBase, 0, tailBaseY * 0.25, tailBaseZ + tailBaseY * 0.55);
    applyChain(this.rig.leftTail, 0, leftTailY * 0.2, leftTailZ + leftTailY * 0.85);
    applyChain(this.rig.rightTail, 0, rightTailY * 0.2, rightTailZ + rightTailY * 0.85);
    for (const name of this.debugOffsets.keys()) {
      const bone = this.model?.getObjectByName(name) ?? null;
      if (!bone || appliedBones.has(bone)) continue;
      apply(bone);
    }
    if (this.model) {
      this.model.position.x = THREE.MathUtils.lerp(this.model.position.x, this.baseModelPosition.x + sway, smooth);
      this.model.position.y = THREE.MathUtils.lerp(this.model.position.y, this.baseModelPosition.y + lift, smooth);
      if (this.debugMarker?.visible && this.debugBone) {
        this.model.updateMatrixWorld(true);
        this.debugBone.getWorldPosition(this.debugMarker.position);
      }
    }
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

export function createTama3DDebugActor(options: Omit<ThreeActorOptions, "debug">): Tama3DDebugActor {
  return new Tama3DActor({ ...options, debug: true });
}
