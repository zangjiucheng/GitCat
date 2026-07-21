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
  leftEye: THREE.Object3D | null;
  rightEye: THREE.Object3D | null;
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

type AnimatedEyelid = {
  mesh: THREE.Mesh<THREE.TubeGeometry, THREE.MeshBasicMaterial>;
  openY: number;
  closedY: number;
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
    leftEye: null,
    rightEye: null,
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
  private baseScales = new Map<THREE.Object3D, THREE.Vector3>();
  private baseModelPosition = new THREE.Vector3();
  private leftEyelid: AnimatedEyelid | null = null;
  private rightEyelid: AnimatedEyelid | null = null;

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
      this.prepareEyelids();
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
      leftEye: find("左目", "LeftEye"),
      rightEye: find("右目", "RightEye"),
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
        if (bone) {
          this.baseRotations.set(bone, bone.rotation.clone());
          this.baseScales.set(bone, bone.scale.clone());
        }
      }
    }
    if (this.debugEnabled) {
      model.traverse((object) => {
        if (object.type === "Bone" && !this.baseRotations.has(object)) {
          this.baseRotations.set(object, object.rotation.clone());
          this.baseScales.set(object, object.scale.clone());
        }
      });
    }
  }

  private prepareEyelids(): void {
    const head = this.rig.head;
    if (!this.model || !head) return;
    const modelHeight = Number(this.camera?.userData.modelHeight) || 1;
    this.model.updateMatrixWorld(true);

    const createEyelid = (eye: THREE.Object3D | null): AnimatedEyelid | null => {
      if (!eye) return null;
      const eyePosition = eye.getWorldPosition(new THREE.Vector3());
      head.worldToLocal(eyePosition);
      const halfWidth = modelHeight * 0.017;
      const curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(-halfWidth, 0, 0),
        new THREE.Vector3(0, -modelHeight * 0.0045, 0),
        new THREE.Vector3(halfWidth, 0, 0),
      );
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 16, modelHeight * 0.00115, 5, false),
        new THREE.MeshBasicMaterial({
          color: 0x5a2a32,
          depthTest: false,
          depthWrite: false,
          opacity: 0,
          transparent: true,
        }),
      );
      const closedY = eyePosition.y + modelHeight * 0.0005;
      const openY = closedY + modelHeight * 0.014;
      mesh.position.set(eyePosition.x, openY, eyePosition.z + modelHeight * 0.025);
      mesh.renderOrder = 900;
      mesh.visible = false;
      head.add(mesh);
      return { mesh, openY, closedY };
    };

    this.leftEyelid = createEyelid(this.rig.leftEye);
    this.rightEyelid = createEyelid(this.rig.rightEye);
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
    this.camera.zoom = this.debugEnabled ? 0.9 : 1.26;
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
    // Finger curl is deliberately shallow: these MMD fingers share world-like
    // axes, so large Z rotations make the chains cross through one another.
    let leftFingerCurl = 0.08;
    let rightFingerCurl = 0.08;
    let leftFingerRipple = 0;
    let rightFingerRipple = 0;
    let leftFingerSpread = 0;
    let rightFingerSpread = 0;
    const blink = Math.pow(Math.max(0, Math.sin(time * 0.72)), 42);
    let leftEyeOpen = 1 - blink * 0.92;
    let rightEyeOpen = 1 - blink * 0.92;
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
      case "idle": {
        // Calm nekomata idle: breathing rides the big head/torso silhouette,
        // the two ears move independently, and the split tails drift slowly out
        // of phase. Arms stay entirely at rest. Lowest tempo on the ladder.
        const breath = Math.sin(time * 0.9);
        headX += breath * 0.035;                 // gentle chin bob = breathing
        bodyX += breath * 0.03;                  // upper chest rides the same breath
        headZ += Math.sin(time * 0.6) * 0.02;    // slow, low-arousal head roll
        // LEFT ear drifts + fires a sparse sharp up-flick (~every 7-8s); RIGHT
        // just drifts on its own freq/phase -> one ear twitches alone.
        const leftEarFlick = Math.pow(Math.max(0, Math.sin(time * 0.83)), 12) * 0.28;
        leftEarZ = -Math.sin(time * 0.7) * 0.05 + leftEarFlick;
        rightEarZ = Math.sin(time * 1.05 + 1.7) * 0.05;
        leftEarX = rightEarX = Math.sin(time * 0.7) * 0.05;
        tailBaseY = Math.sin(time * 0.5) * 0.1;  // slow, gentle, out-of-phase drift
        leftTailY = Math.sin(time * 0.6) * 0.12;
        rightTailY = Math.sin(time * 0.6 + Math.PI) * 0.12;
        break;
      }
      case "sleep":
        // Head drooped forward + lolled to one side with a slow dozing bob. Kept
        // at 0.40 so the deeper droop doesn't hide the closed eyelids (the key
        // sleep signal) behind the bangs.
        headX += 0.4 + Math.sin(time * 0.4) * 0.05;
        headY += 0.05;
        headZ += 0.22;
        bodyX += 0.16 + Math.sin(time * 0.4) * 0.03;   // settled, slow breathing
        bodyZ += 0.06;
        lowerBodyZ = 0.05;
        // Ears fully relaxed: splayed wide + pitched DOWN, held still (droop).
        leftEarX = rightEarX = 0.16;
        leftEarZ = -0.42;
        rightEarZ = 0.42;
        leftEarY = 0.05;
        rightEarY = -0.05;
        tailBaseY = Math.sin(time * 0.35) * 0.02;      // curled in, nearly still
        leftTailY = rightTailY = 0;
        leftTailZ = 0.28;
        rightTailZ = -0.28;
        lift = -0.018;
        leftEyeOpen = rightEyeOpen = 0.045;
        break;
      case "hint":
        // Look-here: the head and one ear lock onto the target while a lively
        // presenting paw beckons forward and the eyes brighten with attention.
        headY += 0.2;            // turn to face the paw/target (character's left)
        headZ -= 0.16;           // deeper curious head-cock
        headX -= 0.04;           // slight chin-up = bright, inviting
        leftArmZ = 0.32;         // +Z raises the LEFT arm to shoulder height
        leftArmX = -0.12;        // -X swings forward toward camera = offer the tip
        leftElbowZ = 1.7;        // fold so the paw sits up (|Z| < 2.4)
        leftWristY = 0.82;       // palm toward the camera
        leftWristZ = Math.sin(time * 3) * 0.12;        // gentle "come look" beckon
        leftFingerCurl = 0.16 + Math.sin(time * 3) * 0.03;
        leftFingerRipple = 0.02;
        // LEFT ear perks UP + forward onto the target; RIGHT stays relaxed splay.
        leftEarZ = 0.34 + Math.sin(time * 4) * 0.05;
        leftEarY = 0.22;
        rightEarZ = 0.16 + Math.sin(time * 1.6) * 0.03;
        leftEyeOpen = rightEyeOpen = 1.05;
        tailBaseY = Math.sin(time * 2.4) * 0.18;       // peppy, livelier than idle
        leftTailY = Math.sin(time * 2.4 + 0.6) * 0.12;
        rightTailY = Math.sin(time * 2.4 - 0.6) * 0.12;
        leftTailZ = 0.14;
        rightTailZ = -0.06;
        break;
      case "thinking":
        // Clear sideways head COCK + gaze-off turn + gentle chin-down.
        headX += 0.09;
        headZ += -0.2 + Math.sin(time * 0.45) * 0.03;
        headY += 0.16;
        bodyZ -= 0.05;           // subtle matching lean (keeps the breathe term)
        // Right hand toward chin: swing the whole arm FORWARD (-X) so it clears
        // the hair. Arm/elbow Z are IK seeds (the thinking IK overrides elbow.z).
        rightArmX = -0.35;
        rightArmZ = 0.1;
        rightElbowZ = -1.55;
        rightWristX = -0.15;
        rightWristY = -0.6;
        rightWristZ = 0.04;
        rightFingerCurl = 0.2;
        leftEyeOpen = rightEyeOpen = 0.85;             // symmetric concentration squint (lid-free)
        // Asymmetry: RIGHT ear pinned up/alert (slow twitch), LEFT splayed down.
        leftEarZ = -0.28;
        rightEarZ = -0.35 + Math.sin(time * 1.3) * 0.05;
        tailBaseY = Math.sin(time * 0.6) * 0.1;        // slow, deliberate ponder sway
        leftTailY = Math.sin(time * 0.75) * 0.1;
        rightTailY = Math.sin(time * 0.75 + 1.6) * 0.1;
        break;
      case "warn":
        // Chin-up recoil ("careful") + held alert cock + nervous micro-sway.
        headX -= 0.1;
        headZ = 0.06 + Math.sin(time * 8) * 0.03;
        // Raised open "hold on" hand: high, forward (-X), palm to camera, splayed.
        leftArmZ = 0.45;
        leftArmX = -0.16;
        leftElbowZ = 1.95;
        leftWristX = -0.15;
        leftWristY = 0.82;
        leftFingerCurl = 0;
        leftFingerSpread = 0.32;
        leftEyeOpen = rightEyeOpen = 1.12;
        bodyX -= 0.06;                                 // slight upper-body recoil
        // Ears PINNED UP (perk sign) + synced fast twitch = tension. #1 carrier.
        leftEarZ = 0.38 + Math.sin(time * 10) * 0.04;
        rightEarZ = -0.38 - Math.sin(time * 10) * 0.04;
        leftEarX = rightEarX = 0;
        // Stiff tail held to one side + fast tense twitch.
        tailBaseY = 0;
        tailBaseZ = 0.12 + Math.sin(time * 9) * 0.04;
        leftTailY = rightTailY = 0;
        leftTailZ = 0.14;
        rightTailZ = -0.14;
        break;
      case "danger": {
        // Alarm/panic: ears splay hard-flat and lash, twin tails whip fast, the
        // head recoils and scans, and both palms shove forward defensively. Flat
        // ears (earX 0) + fast motion + wide eyes separate this from sleep's
        // still, down-pitched droop.
        const lash = Math.sin(time * 18) * 0.14;       // fast ear flutter
        const shake = Math.sin(time * 16) * 0.09;      // nervous head scan
        headX -= 0.06;                                 // chin-up recoil (lean away)
        headY += shake;
        headZ += Math.sin(time * 13) * 0.05;           // agitated tilt tremor
        bodyX -= 0.04;                                 // torso recoil
        lowerBodyZ = Math.sin(time * 15) * 0.03;
        sway = Math.sin(time * 15 + Math.PI) * 0.02;
        leftArmZ = 0.6 + Math.sin(time * 17) * 0.05;   // high defensive palms, flinching
        rightArmZ = -0.6 - Math.sin(time * 17) * 0.05;
        leftArmX = -0.12;
        rightArmX = -0.12;
        leftElbowZ = 2.14;
        rightElbowZ = -2.14;
        leftWristY = 0.82;
        rightWristY = -0.82;
        leftWristZ = -0.04;
        rightWristZ = 0.04;
        leftFingerCurl = rightFingerCurl = 0;
        leftFingerSpread = rightFingerSpread = 0.2;
        leftEyeOpen = rightEyeOpen = 1.2;              // wide, unblinking panic stare
        leftEarX = rightEarX = 0;
        leftEarZ = -0.46 + lash;
        rightEarZ = 0.46 - lash;
        tailBaseY = Math.sin(time * 10) * 0.34;        // fast, wide whip
        leftTailY = Math.sin(time * 11) * 0.24;
        rightTailY = Math.sin(time * 11 + 1.2) * 0.24;
        leftTailZ = 0.04;
        rightTailZ = -0.04;
        break;
      }
      case "celebrate": {
        // Wide bright eyes carry the joy; open hands lift into a real cheer while
        // hard-perked ears and a broad twin-tail wag add celebratory energy.
        const cheer = Math.sin(time * 6) * 0.06;
        leftArmZ = 0.52 + cheer;                       // raise open hands (safe height)
        rightArmZ = -0.52 - cheer;
        leftElbowZ = 2.0;                              // forearms vertical -> palms up
        rightElbowZ = -2.0;
        leftWristY = 0.82;
        rightWristY = -0.82;
        leftWristZ = -0.03;
        rightWristZ = 0.03;
        leftFingerCurl = 0;
        rightFingerCurl = 0;
        leftFingerSpread = 0.5;                        // open jazz-hands silhouette
        rightFingerSpread = 0.5;
        leftEyeOpen = rightEyeOpen = 1.12;             // wide, bright, joyful
        leftEarZ = 0.26 + Math.sin(time * 7) * 0.05;   // ears pinned UP + lively perk
        rightEarZ = -0.26 - Math.sin(time * 7) * 0.05;
        tailBaseY = Math.sin(time * 5) * 0.3;          // big whole-tail sway
        leftTailY = Math.sin(time * 6) * 0.34;         // broad, out-of-phase wag
        rightTailY = Math.sin(time * 6 + Math.PI) * 0.34;
        headX += -0.06;                                // slight bright look-up (additive)
        headZ += Math.sin(time * 3.4) * 0.05;          // playful side tilt
        lift = Math.max(0, Math.sin(time * 4.5)) * 0.04;   // bouncy hop
        break;
      }
      case "rescue":
        // Offering hand: right arm lifted to chest height and swung forward (-X)
        // with a fold deep enough to lift the OPEN palm above the mid-torso cuff
        // artifact and the side hair, reading as a distinct forward offer.
        rightArmZ = -0.4;        // raise upper arm (-Z raises the right arm)
        rightArmX = -0.3;        // swing forward toward camera = reaching out
        rightElbowZ = -1.0;      // offering fold (RIGHT flex = -Z), lifts the palm
        rightWristY = -0.6;      // palm toward the viewer
        rightWristX = -0.12;     // slight upward palm tilt = open, giving
        rightFingerCurl = 0;
        rightFingerSpread = 0.3; // open welcoming hand
        leftArmZ = -0.5;         // support arm settled at side = grounded
        // Forward-pinned ears: reverse the splay so they stand up + angle forward.
        leftEarZ = 0.24;
        rightEarZ = -0.24;
        leftEarY = -0.18;
        rightEarY = 0.18;
        headX += 0.06;           // slight attentive chin-down toward the person
        headZ -= 0.11;           // sympathetic tilt
        leftEyeOpen = rightEyeOpen = 0.95;             // steady, soft, calm gaze
        bodyX += 0.04;           // subtle lean-in (keeps the breathe on Z)
        lowerBodyZ = 0.03;       // settled hip
        tailBaseY = Math.sin(time * 0.9) * 0.09;       // calm, slow, steady sway
        leftTailY = Math.sin(time * 0.9) * 0.1;
        rightTailY = Math.sin(time * 0.9 + Math.PI) * 0.1;
        break;
      case "confused":
        // "Huh?" carried by a hard head-cock and strongly mismatched ears -- the
        // two channels that survive the tiny front crop. Hands stay at rest (any
        // raise hides behind the hair). Slow motion (mid arousal).
        headX -= 0.05;
        headY += 0.08;
        headZ += 0.45 + Math.sin(time * 2) * 0.03;     // hard quizzical cock
        leftEyeOpen = rightEyeOpen = 0.85;             // slight quizzical squint (lid-free)
        // Opposite POSES carry the mismatch: LEFT perks upright (small swivel),
        // RIGHT flops out/down.
        leftEarZ = 0.52 + Math.sin(time * 3.5) * 0.06;
        leftEarY = 0.1;
        rightEarZ = 0.56;
        rightEarX = 0.12;
        // Twin tails sweep to one side (base) + hook the tips back (chains) into
        // a lazy question-mark; slow drift only.
        tailBaseZ = 0.32;
        tailBaseY = Math.sin(time * 1.1) * 0.1;
        leftTailZ = -0.18;
        rightTailZ = -0.18;
        leftTailY = Math.sin(time * 1.4) * 0.05;
        rightTailY = Math.sin(time * 1.4 + 1.3) * 0.06;
        bodyZ += -0.03;          // counter-lean so the cocked head pops
        break;
      case "curious":
        // Intrigued: ears snap erect + forward, eyes go wide, the head cocks +
        // turns to peer in, and the chest/hips lean toward the stimulus. Hands
        // stay tucked (they die behind the hair). Lively tempo (above idle).
        headX += 0.05;
        headY -= 0.12;
        headZ -= 0.15 + Math.sin(time * 1.8) * 0.03;
        bodyX += 0.045;
        bodyZ += 0.02;
        lowerBodyZ = -0.03;
        leftEyeOpen = rightEyeOpen = 1.1;
        leftEarZ = 0.34;         // BOTH ears erect (perk sign, symmetric = focused)
        rightEarZ = -0.34;
        leftEarY = 0.16 + Math.sin(time * 2.6) * 0.04; // forward swivel + life
        rightEarY = 0.16 - Math.sin(time * 2.6) * 0.04;
        tailBaseZ = -0.07;       // tails cocked slightly to one side = alert
        tailBaseY = Math.sin(time * 2.2) * 0.06;
        leftTailY = Math.sin(time * 2.2) * 0.14;
        rightTailY = Math.sin(time * 2.2 + 0.7) * 0.14;
        break;
      case "syncing": {
        // Busy git-sync: hands alternate like typing, ears pin forward, tail
        // keeps time. Antiphase elbow flex reads as working hands in silhouette.
        const work = Math.sin(time * 5.5) * 0.3;       // fast rhythmic work tempo
        const twitch = Math.sin(time * 5.5) * 0.035;   // synced attentive ear flick
        headX += 0.1 + Math.sin(time * 5.5) * 0.02;    // dipped to the work + nod
        leftArmX = -0.16;
        rightArmX = -0.16;
        leftArmZ = 0.02;
        rightArmZ = -0.02;
        leftElbowZ = 2.05 + work;                      // peaks 2.35 < 2.4 limit
        rightElbowZ = -2.05 + work;
        leftWristX = 0.16;
        rightWristX = 0.16;
        leftWristY = 0.2;
        rightWristY = -0.2;
        leftWristZ = -0.04;
        rightWristZ = 0.04;
        leftFingerCurl = 0.16 + work * 0.4;
        rightFingerCurl = 0.16 - work * 0.4;
        leftEyeOpen = rightEyeOpen = 0.85;             // concentration squint (lid-free)
        leftEarZ = 0.18 + twitch;                      // ears pinned forward + twitch
        rightEarZ = -0.18 - twitch;
        tailBaseY = Math.sin(time * 4) * 0.18;         // metronomic (in-phase)
        leftTailY = Math.sin(time * 4) * 0.14;
        rightTailY = Math.sin(time * 4) * 0.14;
        leftTailZ = 0.04;
        rightTailZ = -0.04;
        bodyX = 0.05 + Math.sin(time * 4) * 0.02;      // lean into the work
        bodyY = Math.sin(time * 2.5) * 0.016;
        break;
      }
      case "greeting": {
        // Big open-palm wave held high and out to the model's-right (viewer's
        // left), clear of the hair/face. Perked bobbing ears carry the warmth;
        // the always-visible tail adds a broad welcoming wag.
        const wave = Math.sin(time * 5.4) * 0.34;      // wider forearm sweep
        rightArmZ = -0.85;                             // raise the whole arm high
        rightArmX = -0.12;                             // ease forward, clear the hair
        rightElbowZ = -1.95 + wave;                    // swing forearm (|Z| peak 2.29)
        rightWristY = -0.85;                           // palm square to camera
        rightWristZ = -wave;                           // counter-rotate, palm stays front
        rightFingerCurl = 0.02;
        rightFingerSpread = 0.32;
        rightFingerRipple = 0.03;
        const earBob = Math.sin(time * 5.4) * 0.06;
        leftEarZ = 0.24 + earBob;                      // ears perked UP + friendly bob
        rightEarZ = -0.24 - earBob;
        leftEarY = -0.07;                              // mild forward yaw = welcoming
        rightEarY = 0.07;
        headX += -0.06 + Math.sin(time * 5.4) * 0.04;  // engaged look-up + nod-bob
        headZ -= 0.06;                                 // warm friendly tilt
        leftEyeOpen = rightEyeOpen = 1.05;             // bright, awake, welcoming
        tailBaseY = Math.sin(time * 3.0) * 0.22;       // broad welcoming wag
        leftTailY = Math.sin(time * 3.2) * 0.18;
        rightTailY = Math.sin(time * 3.2 + 1.1) * 0.18;
        break;
      }
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
    if (
      this.state === "thinking" &&
      this.model &&
      this.rig.head &&
      this.rig.rightArm &&
      this.rig.rightElbow &&
      this.rig.rightWrist
    ) {
      const modelHeight = Number(this.camera?.userData.modelHeight) || 1;
      const target = this.rig.head.getWorldPosition(new THREE.Vector3());
      target.x -= modelHeight * 0.005;
      target.y += modelHeight * 0.015;
      target.z += modelHeight * 0.035;
      const effectorPosition = new THREE.Vector3();
      const jointPosition = new THREE.Vector3();
      const solveJoint = (joint: THREE.Object3D): void => {
        this.model?.updateMatrixWorld(true);
        joint.getWorldPosition(jointPosition);
        this.rig.rightWrist?.getWorldPosition(effectorPosition);
        const toEffectorX = effectorPosition.x - jointPosition.x;
        const toEffectorY = effectorPosition.y - jointPosition.y;
        const toTargetX = target.x - jointPosition.x;
        const toTargetY = target.y - jointPosition.y;
        const cross = toEffectorX * toTargetY - toEffectorY * toTargetX;
        const dot = toEffectorX * toTargetX + toEffectorY * toTargetY;
        joint.rotation.z += THREE.MathUtils.clamp(Math.atan2(cross, dot), -0.65, 0.65);
      };
      for (let iteration = 0; iteration < 4; iteration += 1) {
        solveJoint(this.rig.rightElbow);
        solveJoint(this.rig.rightArm);
      }
    }
    const applyFingers = (
      bones: THREE.Object3D[],
      curl: number,
      ripple: number,
      spread: number,
      mirror: number,
    ): void => {
      const jointStrength = [0.42, 0.7, 0.58];
      const spreadPattern = [-0.75, -0.22, 0.24, 0.72];
      bones.forEach((bone, index) => {
        const finger = Math.floor(index / 3);
        const joint = index % 3;
        const staggeredCurl = curl + Math.sin(time * 6 + finger * 0.7) * ripple;
        const amount = staggeredCurl * jointStrength[index % 3];
        // Curl on local X to move each chain through the palm plane without
        // crossing neighboring fingers. Only the root receives a small,
        // per-finger Z fan so an open hand reads as four distinct fingers.
        const fingerSpread = joint === 0 ? mirror * spreadPattern[finger] * spread : 0;
        apply(bone, amount, 0, fingerSpread);
      });
    };
    const applyThumb = (bones: THREE.Object3D[], curl: number, mirror: number): void => {
      bones.forEach((bone, index) => {
        const amount = curl * (index === 0 ? 0.28 : 0.5);
        apply(bone, amount, mirror * amount * 0.1, 0);
      });
    };
    applyFingers(this.rig.leftFingers, leftFingerCurl, leftFingerRipple, leftFingerSpread, -1);
    applyFingers(this.rig.rightFingers, rightFingerCurl, rightFingerRipple, rightFingerSpread, 1);
    applyThumb(this.rig.leftThumb, leftFingerCurl, -1);
    applyThumb(this.rig.rightThumb, rightFingerCurl, 1);
    const applyEyeOpen = (eye: THREE.Object3D | null, openness: number): void => {
      if (!eye) return;
      const base = this.baseScales.get(eye);
      if (!base) return;
      eye.scale.x = THREE.MathUtils.lerp(eye.scale.x, base.x, smooth);
      eye.scale.y = THREE.MathUtils.lerp(eye.scale.y, base.y * openness, smooth);
      eye.scale.z = THREE.MathUtils.lerp(eye.scale.z, base.z, smooth);
    };
    applyEyeOpen(this.rig.leftEye, leftEyeOpen);
    applyEyeOpen(this.rig.rightEye, rightEyeOpen);
    const applyEyelid = (eyelid: AnimatedEyelid | null, openness: number): void => {
      if (!eyelid) return;
      const closure = THREE.MathUtils.clamp(1 - openness, 0, 1);
      const easedClosure = THREE.MathUtils.smoothstep(closure, 0, 1);
      const targetY = THREE.MathUtils.lerp(eyelid.openY, eyelid.closedY, easedClosure);
      eyelid.mesh.position.y = THREE.MathUtils.lerp(eyelid.mesh.position.y, targetY, smooth);
      // The two lid tubes are wider than the eye gap, so at partial opacity they
      // overlap into a translucent maroon band across the face. Only fade them in
      // near FULL closure (blink dips + sleep) so concentration squints (openness
      // ~0.8, driven by the eye-scale alone) stay clean and lid-free.
      eyelid.mesh.material.opacity = THREE.MathUtils.lerp(
        eyelid.mesh.material.opacity,
        THREE.MathUtils.smoothstep(closure, 0.5, 0.88),
        smooth,
      );
      eyelid.mesh.visible = eyelid.mesh.material.opacity > 0.01;
    };
    applyEyelid(this.leftEyelid, leftEyeOpen);
    applyEyelid(this.rightEyelid, rightEyeOpen);
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
