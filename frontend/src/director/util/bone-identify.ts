// GLB 骨骼自动识别(L1):把任意常见 rig(mixamo / Biped / UE / VRM)的骨骼名
// 映射到语义 token(SemToken),与 jointConfig.bone 对接,替代写死 mixamorig 名。
// 思路:归一化(去末尾 _数字 后缀 + 去非字母数字)+ rig 识别 + 左右识别 + 部位关键词匹配。

import type * as THREE from "three";
import type { RigType } from "./rigAxisTable";

type Bone = THREE.Bone;

/** 归一化骨名:先去末尾 `_<数字>` 导出后缀(防 mixamorig_Spine1_03 的 03 干扰),
 *  再去非字母数字并转小写。
 *  mixamorig_Head_06 -> mixamorighead ; mixamorig:Spine1 -> mixamorigspine1(保留语义 1) */
function normBone(s: string): string {
  const stripped = (s || "").replace(/_+\d+$/i, "");
  return stripped.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/** 识别 rig 类型(按骨名集合特征)。 */
function detectRig(rawNames: string[]): RigType {
  const all = rawNames.join(" ").toLowerCase();
  if (all.includes("mixamorig")) return "mixamo";
  if (all.includes("bip001")) return "biped";
  // UE mannequin:小写 + _l/_r 后缀
  if (/(upperarm|lowerarm|thigh|calf|hand|foot)_[lr]\b/.test(all)) return "ue";
  return "unknown";
}

/** 识别左右(基于原始名,保留空格/下划线分隔,避免 l/r 误中 forearm/calf 等内部字母)。 */
function detectSide(rawLower: string): "Left" | "Right" | "" {
  if (rawLower.includes("left")) return "Left";
  if (rawLower.includes("right")) return "Right";
  // L_/R_ 前缀(如 L_Thigh、R_Calf)
  if (/^l[_\s.-]/.test(rawLower)) return "Left";
  if (/^r[_\s.-]/.test(rawLower)) return "Right";
  // Biped: " L UpperArm"(独立 L,前后空格)
  if (/(^|\s)l(\s|$)/.test(rawLower)) return "Left";
  if (/(^|\s)r(\s|$)/.test(rawLower)) return "Right";
  // UE: "upperarm_l"(下划线后缀)
  if (/_l($|_)/.test(rawLower)) return "Left";
  if (/_r($|_)/.test(rawLower)) return "Right";
  return "";
}

type PartBase =
  | "Hips" | "Spine1" | "Head" | "Neck"
  | "Arm" | "ForeArm" | "Hand" | "UpLeg" | "Leg" | "Foot";

/** 识别部位(norm 后字符串)。按优先级匹配,排除手指/末端等干扰骨。 */
function detectPart(n: string): PartBase | null {
  if (n.includes("upleg") || n.includes("thigh")) return "UpLeg";
  if (n.includes("forearm") || n.includes("lowerarm")) return "ForeArm";
  if (n.includes("upperarm") || n.includes("arm")) return "Arm";
  if (n.includes("calf")) return "Leg";
  if (n.includes("leg")) return "Leg";
  if (n.includes("hand") && !/hand(index|thumb|middle|ring|pinky)/.test(n)) return "Hand";
  if (n.includes("foot") && !n.includes("ball")) return "Foot";
  if (n.includes("head") && !n.includes("headnub")) return "Head";
  if (n.includes("neck")) return "Neck";
  if (n.includes("spine1") || n.includes("spine01") || n.includes("spine02")) return "Spine1";
  if (n.includes("pelvis") || n.includes("hips")) return "Hips";
  return null;
}

export interface IdentifyResult {
  /** key = SemToken 字面量(如 "LeftArm"),值为对应 Bone。 */
  map: Map<string, Bone>;
  rig: RigType;
  /** 未命中任何语义的原始骨名(调试用)。 */
  missed: string[];
}

/** 遍历模型骨骼,构建 语义token -> Bone 映射 + rig 类型。 */
export function identifyBones(model: THREE.Object3D): IdentifyResult {
  const map = new Map<string, Bone>();
  const missed: string[] = [];
  const rawNames: string[] = [];
  const seen = new Set<Bone>();

  model.traverse((o: any) => {
    if (!o.isBone) return;
    if (seen.has(o)) return;
    seen.add(o);

    // GLTFLoader 有时把原名存到 userData.name,两个都试
    const names = new Set<string>([o.name]);
    const orig = o.userData && o.userData.name;
    if (orig) names.add(orig);

    let matched = false;
    for (const raw of names) {
      rawNames.push(raw);
      const side = detectSide(raw.toLowerCase());
      const part = detectPart(normBone(raw));
      if (!part) continue;
      const token = side + part; // "Left"+"Arm" = "LeftArm" ; ""+"Head" = "Head"
      if (!map.has(token)) map.set(token, o as Bone);
      matched = true;
      break;
    }
    if (!matched && o.name) missed.push(o.name);
  });

  return { map, rig: detectRig(rawNames), missed };
}
