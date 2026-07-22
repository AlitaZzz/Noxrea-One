import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Entity } from "./Entity";
import { JOINTS } from "./jointConfig";
import { POSE_PRESET_MAP } from "./posePresets";
import { buildBoneMap } from "../util/boneUtil";
import { identifyBones } from "../util/boneIdentify";
import type { RigType, AxisOverride } from "../util/rigAxisTable";
import { worldBox } from "../util/measure";

// 统一目标身高（单位），多角色视觉一致（§5.2）
const TARGET_HEIGHT = 1.7;
const DEFAULT_COLOR = 0x34c759; // 截图同款素体绿
const XBOT_URL = "/assets/Xbot.glb"; // 轴向推断的参考模型(mixamo 标准 rigs)

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
  /** 身体组摆姿枢轴(绕脚底),与角色变换 root 分离,避免 gizmo 冲突 + 躺地补偿。 */
  pivot: THREE.Group;
  color: number = DEFAULT_COLOR;
  private _mats: THREE.MeshStandardMaterial[] = [];
  private _targetHeight: number;
  private _girth: number;

  bones: Map<string, any>;
  restQ: Map<any, THREE.Quaternion>;
  bonesUsed: Map<any, any[]>;
  values: Record<string, number> = {};
  rig: RigType = "unknown";
  /** 运行时按模型骨骼本地轴推断的 per-joint 轴向覆盖(替代 rig 预置表)。 */
  axisOverrides: Map<string, AxisOverride> = new Map();
  /** 识别出的语义骨 token -> Bone(供 _inferAxisOverrides 用)。 */
  private boneMap: Map<string, any> = new Map();

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
    this.pivot = new THREE.Group();
    this.pivot.add(this.model);
    root.add(this.pivot);

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
    const { map: boneMap, rig } = identifyBones(this.model);
    this.rig = rig;
    this.restQ = new Map();
    this.bonesUsed = new Map();
    for (const j of JOINTS) {
      const bone = boneMap.get(j.bone);
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

    this.boneMap = boneMap;

    this._normalize();
  }

  /** 对每个关节,找模型本地轴 k 使其世界方向最接近 Xbot 该关节真实旋转轴世界方向
   *  (ref = Xbot worldQ(bone) * axisVec(axis),运行时 three 算,与目标同体系)。
   *  sign = 点积符号 × 原 sign。
   *  另:手臂/腿前举/外展轴按 T-pose 约定(前举=上下,外展=前后)做互换修正,
   *  防止两 rig 本地轴约定不同导致选反。 */
  private _inferAxisOverrides(ref: Map<string, THREE.Vector3>) {
    // 临时 reset root scale,排除 _normalize 的 girth(非 uniform scale)对 getWorldQuaternion 的干扰
    const savedScale = this.root.scale.clone();
    this.root.scale.set(1, 1, 1);
    this.root.updateMatrixWorld(true);
    const axisVec = (axis: "x" | "y" | "z") =>
      new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    const tmpQ = new THREE.Quaternion();
    const signOf = (dir: THREE.Vector3, target: THREE.Vector3, origSign: number) =>
      (dir.dot(target) >= 0 ? 1 : -1) * origSign;
    for (const j of JOINTS) {
      const bone = this.boneMap.get(j.bone);
      const target = ref.get(j.key);
      if (!bone || !target) { this.axisOverrides.set(j.key, { axis: j.axis, sign: j.sign ?? 1 }); continue; }
      bone.getWorldQuaternion(tmpQ);
      let bestAxis = j.axis as "x" | "y" | "z", bestDot = 0, bestAbs = -1;
      for (const k of ["x", "y", "z"] as const) {
        const d = axisVec(k).applyQuaternion(tmpQ).dot(target);
        if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); bestAxis = k; bestDot = d; }
      }
      const sign = (bestDot >= 0 ? 1 : -1) * (j.sign ?? 1);
      this.axisOverrides.set(j.key, { axis: bestAxis, sign });
    }
    // 手臂/腿 前举/外展 修正(T-pose:前举=上下轴 |y|>|z|,外展=前后轴 |z|>|y|)。
    // 若选反(Fwd 轴像前后 / Abd 轴像上下),互换 axis 并按新 axis 重算 sign。
    const fwdAbd: [string, string][] = [
      ["lArmFwd", "lArmAbd"], ["rArmFwd", "rArmAbd"],
      ["lLegFwd", "lLegAbd"], ["rLegFwd", "rLegAbd"],
    ];
    for (const [fwdKey, abdKey] of fwdAbd) {
      const f = this.axisOverrides.get(fwdKey);
      const a = this.axisOverrides.get(abdKey);
      if (!f || !a || f.axis === a.axis) continue;
      const jFwd = JOINTS.find((j) => j.key === fwdKey)!;
      const jAbd = JOINTS.find((j) => j.key === abdKey)!;
      const bone = this.boneMap.get(jFwd.bone);
      const fTarget = ref.get(fwdKey);
      const aTarget = ref.get(abdKey);
      if (!bone || !fTarget || !aTarget) continue;
      bone.getWorldQuaternion(tmpQ);
      const fDir = axisVec(f.axis).applyQuaternion(tmpQ);
      const aDir = axisVec(a.axis).applyQuaternion(tmpQ);
      if (Math.abs(fDir.z) > Math.abs(fDir.y) && Math.abs(aDir.y) > Math.abs(aDir.z)) {
        const fNew = axisVec(a.axis).applyQuaternion(tmpQ);
        const aNew = axisVec(f.axis).applyQuaternion(tmpQ);
        this.axisOverrides.set(fwdKey, { axis: a.axis, sign: signOf(fNew, fTarget, jFwd.sign ?? 1) });
        this.axisOverrides.set(abdKey, { axis: f.axis, sign: signOf(aNew, aTarget, jAbd.sign ?? 1) });
      }
    }
    // 抬腿(lLegFwd/rLegFwd)强制正=向前:腿沿 -Y,绕轴正转腿向 +Z(前)要求轴 X 分量<0;
    // 若轴 X 分量>0(正=向后),翻 sign。(用户要求正=向前,不沿用 mixamo 预设的正=后约定)
    for (const legFwd of ["lLegFwd", "rLegFwd"]) {
      const cfg = this.axisOverrides.get(legFwd);
      const jLeg = JOINTS.find((jj) => jj.key === legFwd)!;
      const bone = this.boneMap.get(jLeg.bone);
      if (!bone || !cfg) continue;
      bone.getWorldQuaternion(tmpQ);
      const dir = axisVec(cfg.axis).applyQuaternion(tmpQ);
      if (dir.x > 0) this.axisOverrides.set(legFwd, { axis: cfg.axis, sign: -cfg.sign });
    }
    this.root.scale.copy(savedScale);
    this.root.updateMatrixWorld(true);
  }

  /** 异步加载工厂：返回 Promise<Character>。 */
  static async load(name: string, url: string, opts: CharacterOpts = {}): Promise<Character> {
    const gltf = await _loader.loadAsync(url);
    const ch = new Character(name, gltf, opts);
    // 用 Xbot 参考推断各关节轴向(参考与目标均用 three getWorldQuaternion,同体系)
    const ref = await Character._getXbotRef();
    ch._inferAxisOverrides(ref);
    return ch;
  }

  /** Xbot 各关节真实旋转轴世界方向(缓存,首次加载 Xbot 算)。 */
  private static _xbotRef: Map<string, THREE.Vector3> | null = null;
  private static async _getXbotRef(): Promise<Map<string, THREE.Vector3>> {
    if (Character._xbotRef) return Character._xbotRef;
    const gltf = await _loader.loadAsync(XBOT_URL);
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const { map } = identifyBones(scene);
    const ref = new Map<string, THREE.Vector3>();
    const tmpQ = new THREE.Quaternion();
    const axisVec = (axis: "x" | "y" | "z") =>
      new THREE.Vector3(axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0);
    for (const j of JOINTS) {
      const bone = map.get(j.bone);
      if (!bone) continue;
      bone.getWorldQuaternion(tmpQ);
      ref.set(j.key, axisVec(j.axis).applyQuaternion(tmpQ));
    }
    Character._xbotRef = ref;
    return ref;
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

  /** 全身 FK 摆姿：最终姿势 = restQ × Σ 各轴增量。
   *  身体组(bodyX/Y/Z)绕脚底(root,本地=世界系)整体旋转——前/后倾以脚底为轴,
   *  后倾 90° 能躺地而非浮空;其他关节绕各自骨骼(轴向由 axisOverrides 推断)。 */
  applyPose() {
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
    for (const [bone, joints] of this.bonesUsed) {
      const rest = this.restQ.get(bone);
      if (!rest) continue;
      bone.quaternion.copy(rest);
      for (const j of joints) {
        if (j.group === "身体") {
          const a = THREE.MathUtils.degToRad((this.values[j.key] || 0) * (j.sign ?? 1));
          if (a === 0) continue;
          const ax = new THREE.Vector3(j.axis === "x" ? 1 : 0, j.axis === "y" ? 1 : 0, j.axis === "z" ? 1 : 0);
          this.pivot.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(ax, a));
        } else {
          const cfg = this.axisOverrides.get(j.key) ?? { axis: j.axis, sign: j.sign ?? 1 };
          const a = THREE.MathUtils.degToRad((this.values[j.key] || 0) * cfg.sign);
          if (a === 0) continue;
          const ax = new THREE.Vector3(
            cfg.axis === "x" ? 1 : 0,
            cfg.axis === "y" ? 1 : 0,
            cfg.axis === "z" ? 1 : 0
          );
          bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(ax, a));
        }
      }
    }
    // 身体组绕脚底旋转后,身体厚度可能转入地下;整体上移使贴地
    this.root.updateMatrixWorld(true);
    const box = worldBox(this.model, { useBones: true });
    if (!box.isEmpty() && box.min.y < -1e-4) {
      this.pivot.position.y = -box.min.y;
      this.root.updateMatrixWorld(true);
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
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
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
    this.pivot.quaternion.identity();
    this.pivot.position.set(0, 0, 0);
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
    // 跟随 Head 骨世界位置:身体组旋转/躺地后脑袋移位,标签仍贴脑袋
    const head = this.boneMap.get("Head");
    if (head) head.getWorldPosition(out);
    else { this.root.getWorldPosition(out); out.y += this.height; }
    return out;
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    super.dispose();
  }
}
