import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Entity } from "./Entity";
import { JOINTS } from "./jointConfig";
import { POSE_PRESET_MAP } from "./posePresets";
import { buildBoneMap, findBone } from "../util/boneUtil";
import { worldBox } from "../util/measure";

// 统一目标身高（单位），多角色视觉一致（§5.2）
const TARGET_HEIGHT = 1.7;
const DEFAULT_COLOR = 0x34c759; // 截图同款素体绿

const _loader = new GLTFLoader();

export interface CharacterOpts {
  height?: number;
  girth?: number;
}

/**
 * 角色：带骨骼 GLB 加载 + 全身 FK 摆姿 + 预设动画。
 * 每个 Character 各自独立持有 bones / restQ / values / mixer。
 */
export class Character extends Entity {
  model: THREE.Object3D;
  color: number = DEFAULT_COLOR;
  private _mats: THREE.MeshStandardMaterial[] = [];
  private _targetHeight: number;
  private _girth: number;

  bones: Map<string, any>;
  restQ: Map<any, THREE.Quaternion>;
  bonesUsed: Map<any, any[]>;
  values: Record<string, number> = {};

  mixer: THREE.AnimationMixer | null;
  clips: Record<string, THREE.AnimationClip> = {};
  currentClip: string | null = null;
  currentPreset: string | null = null;
  poseMode: "preset" | "manual" = "preset";

  _srcUrl?: string;
  _opts?: CharacterOpts;

  constructor(name: string, gltf: any, opts: CharacterOpts = {}) {
    const root = new THREE.Group();
    super("character", name, root);

    this._targetHeight = opts.height || TARGET_HEIGHT;
    this._girth = opts.girth || 1;

    this.model = gltf.scene;
    root.add(this.model);

    // 统一素体材质（单色），SkinnedMesh 仍自动蒙皮
    this.model.traverse((o: any) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        const m = new THREE.MeshStandardMaterial({
          color: this.color,
          roughness: 0.62,
          metalness: 0.05,
        });
        o.material = m;
        this._mats.push(m);
      }
    });

    this.bones = buildBoneMap(this.model);
    this.restQ = new Map();
    this.bonesUsed = new Map();
    for (const j of JOINTS) {
      const bone = findBone(this.bones, j.bone);
      if (!bone) continue;
      if (!this.restQ.has(bone)) this.restQ.set(bone, bone.quaternion.clone());
      if (!this.bonesUsed.has(bone)) this.bonesUsed.set(bone, []);
      this.bonesUsed.get(bone)!.push(j);
    }

    for (const j of JOINTS) this.values[j.key] = 0;

    this.mixer = new THREE.AnimationMixer(this.model);
    (gltf.animations || []).forEach((a: any) => {
      this.clips[a.name] = a;
    });

    this._normalize();
  }

  /** 异步加载工厂：返回 Promise<Character>。 */
  static async load(name: string, url: string, opts: CharacterOpts = {}): Promise<Character> {
    const gltf = await _loader.loadAsync(url);
    return new Character(name, gltf, opts);
  }

  get clipNames(): string[] {
    return Object.keys(this.clips);
  }

  _normalize() {
    const root = this.root;
    root.updateMatrixWorld(true);
    const box = worldBox(this.model, { useBones: true });
    const size = box.getSize(new THREE.Vector3());
    const height = size.y || Math.max(size.x, size.z) || TARGET_HEIGHT;
    const scale = this._targetHeight / height;
    root.scale.setScalar(scale);
    root.scale.x *= this._girth;
    root.scale.z *= this._girth;
    this.baseScale = scale;

    root.updateMatrixWorld(true);
    const box2 = worldBox(this.model, { useBones: true });
    if (!box2.isEmpty()) {
      root.position.y -= box2.min.y;
    }
    root.updateMatrixWorld(true);
    this.height = TARGET_HEIGHT;
  }

  /** 全身 FK 摆姿：最终姿势 = restQ × Σ 各轴增量。 */
  applyPose() {
    for (const [bone, joints] of this.bonesUsed) {
      const rest = this.restQ.get(bone);
      if (!rest) continue;
      bone.quaternion.copy(rest);
      for (const j of joints) {
        const a = THREE.MathUtils.degToRad(this.values[j.key] || 0);
        if (a === 0) continue;
        const ax = new THREE.Vector3(
          j.axis === "x" ? 1 : 0,
          j.axis === "y" ? 1 : 0,
          j.axis === "z" ? 1 : 0
        );
        bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(ax, a));
      }
    }
  }

  applyPosePreset(presetKey: string) {
    const preset = POSE_PRESET_MAP[presetKey];
    if (!preset) return;
    for (const j of JOINTS) this.values[j.key] = 0;
    for (const [k, v] of Object.entries(preset.values || {})) {
      if (k in this.values) this.values[k] = v;
    }
    this.enterManual();
    this.applyPose();
    this.currentPreset = presetKey;
  }

  enterManual() {
    if (this.poseMode === "preset" && this.mixer) this.mixer.stopAllAction();
    this.poseMode = "manual";
    this.currentClip = null;
  }

  setRest() {
    for (const [bone, rest] of this.restQ) bone.quaternion.copy(rest);
  }

  resetPose() {
    for (const j of JOINTS) this.values[j.key] = 0;
    if (this.mixer) this.mixer.stopAllAction();
    this.setRest();
    this.poseMode = "preset";
    this.currentClip = null;
    this.currentPreset = null;
  }

  playClip(name: string) {
    const clip = this.clips[name];
    if (!clip || !this.mixer) return;
    for (const j of JOINTS) this.values[j.key] = 0;
    this.mixer.stopAllAction();
    const act = this.mixer.clipAction(clip);
    act.reset();
    const isPose = clip.duration <= 0.25 || /pose/i.test(name);
    act.setLoop(isPose ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = isPose;
    act.play();
    this.poseMode = "preset";
    this.currentClip = name;
  }

  stopClip() {
    if (this.mixer) this.mixer.stopAllAction();
    this.setRest();
    this.poseMode = "preset";
    this.currentClip = null;
  }

  update(dt: number) {
    if (this.mixer && this.poseMode === "preset" && this.currentClip) {
      this.mixer.update(dt);
    }
  }

  setColor(hex: number) {
    const c = new THREE.Color(hex);
    this._mats.forEach((m) => m.color.copy(c));
    this.color = c.getHex();
  }

  getLabelAnchor(out = new THREE.Vector3()): THREE.Vector3 {
    this.root.getWorldPosition(out);
    out.y += this.height + 0.16;
    return out;
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    super.dispose();
  }
}
