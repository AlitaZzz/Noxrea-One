// 全身多轴关节表（§6）-- 与《人偶姿势体验_技术改造文档.md》同源。
// 字段：{group, side, key, label, bone, axis, min, max}
// 注意（§5.4）：axis 与 min/max 是起始值；各骨头本地轴方向不一致，必要时在浏览器里
// 实测校准（翻转 min/max 正负或换 axis）。左右成对动作通常镜像（正负相反）。
// bone 字段为语义 token（SemToken），由 boneIdentify.ts 自动识别映射，不再写死 mixamorig 名。
// min/max 已对照人体关节活动度校准（2026-07-21）。

import type { SemToken } from "../util/rig-axis-table";

export interface Joint {
  /** i18n key 后缀（渲染处用 t(`director.joint.group.${group}`) 翻译），同时作为分组标识 */
  group: string;
  /** i18n key 后缀（渲染处用 t(`director.joint.side.${side}`) 翻译），"" 表示无左右之分 */
  side: string;
  key: string;
  /** i18n key 后缀（渲染处用 t(`director.joint.label.${label}`) 翻译） */
  label: string;
  bone: SemToken;
  axis: "x" | "y" | "z";
  min: number;
  max: number;
  sign?: number;
}

export const JOINTS: Joint[] = [
  // 身体（根 Hips：整体朝向）
  { group: "body", side: "", key: "bodyX", label: "leanFwd", bone: "Hips", axis: "x", min: -90, max: 90 },
  { group: "body", side: "", key: "bodyY", label: "turn", bone: "Hips", axis: "y", min: -90, max: 90 },
  { group: "body", side: "", key: "bodyZ", label: "leanSide", bone: "Hips", axis: "z", min: -90, max: 90 },
  // 躯干（Spine1）
  { group: "torso", side: "", key: "spineX", label: "bendFwd", bone: "Spine1", axis: "x", min: -90, max: 90 },
  { group: "torso", side: "", key: "spineY", label: "twist", bone: "Spine1", axis: "y", min: -45, max: 45 },
  { group: "torso", side: "", key: "spineZ", label: "leanSide", bone: "Spine1", axis: "z", min: -30, max: 30 },
  // 头部（Head）
  { group: "head", side: "", key: "headX", label: "nod", bone: "Head", axis: "x", min: -60, max: 60 },
  { group: "head", side: "", key: "headY", label: "headTurn", bone: "Head", axis: "y", min: -80, max: 80 },
  { group: "head", side: "", key: "headZ", label: "headTilt", bone: "Head", axis: "z", min: -45, max: 45 },
  // 手臂-肩 · 左 / 右（Arm）
  { group: "armShoulder", side: "left", key: "lArmFwd", label: "raiseFwd", bone: "LeftArm", axis: "y", min: -50, max: 180, sign: -1 },
  { group: "armShoulder", side: "left", key: "lArmAbd", label: "abduct", bone: "LeftArm", axis: "z", min: -90, max: 90 },
  { group: "armShoulder", side: "left", key: "lArmTwist", label: "twist", bone: "LeftArm", axis: "x", min: -90, max: 90 },
  { group: "armShoulder", side: "right", key: "rArmFwd", label: "raiseFwd", bone: "RightArm", axis: "y", min: -50, max: 180 },
  { group: "armShoulder", side: "right", key: "rArmAbd", label: "abduct", bone: "RightArm", axis: "z", min: -90, max: 90, sign: -1 },
  { group: "armShoulder", side: "right", key: "rArmTwist", label: "twist", bone: "RightArm", axis: "x", min: -90, max: 90 },
  // 肘部（ForeArm）
  { group: "elbow", side: "left", key: "lFore", label: "bend", bone: "LeftForeArm", axis: "y", min: 0, max: 150, sign: -1 },
  { group: "elbow", side: "right", key: "rFore", label: "bend", bone: "RightForeArm", axis: "y", min: 0, max: 150 },
  // 手腕（Hand，可选）
  { group: "wrist", side: "left", key: "lHand", label: "bend", bone: "LeftHand", axis: "x", min: -80, max: 80 },
  { group: "wrist", side: "right", key: "rHand", label: "bend", bone: "RightHand", axis: "x", min: -80, max: 80 },
  // 腿部-髋 · 左 / 右（UpLeg）— lLegFwd/rLegFwd 正=向前（见 Character._inferAxisOverrides 抬腿修正）
  { group: "legHip", side: "left", key: "lLegFwd", label: "legLift", bone: "LeftUpLeg", axis: "x", min: -30, max: 120 },
  { group: "legHip", side: "left", key: "lLegAbd", label: "abduct", bone: "LeftUpLeg", axis: "z", min: -30, max: 45 },
  { group: "legHip", side: "left", key: "lLegTwist", label: "twist", bone: "LeftUpLeg", axis: "y", min: -90, max: 90 },
  { group: "legHip", side: "right", key: "rLegFwd", label: "legLift", bone: "RightUpLeg", axis: "x", min: -30, max: 120 },
  { group: "legHip", side: "right", key: "rLegAbd", label: "abduct", bone: "RightUpLeg", axis: "z", min: -30, max: 45, sign: -1 },
  { group: "legHip", side: "right", key: "rLegTwist", label: "twist", bone: "RightUpLeg", axis: "y", min: -90, max: 90 },
  // 膝（Leg）
  { group: "knee", side: "left", key: "lKnee", label: "bend", bone: "LeftLeg", axis: "x", min: 0, max: 130 },
  { group: "knee", side: "right", key: "rKnee", label: "bend", bone: "RightLeg", axis: "x", min: 0, max: 130 },
  // 踝（Foot）
  { group: "ankle", side: "left", key: "lFoot", label: "footFlex", bone: "LeftFoot", axis: "x", min: -40, max: 40 },
  { group: "ankle", side: "right", key: "rFoot", label: "footFlex", bone: "RightFoot", axis: "x", min: -40, max: 40 },
];

export interface SideGroup {
  side: string;
  joints: Joint[];
}

export interface JointGroup {
  group: string;
  sides: SideGroup[];
}

/** 按出现顺序分组：[{group, sides:[{side, joints:[...]}]}] -- 供 PoseSliders 渲染。 */
export function groupJoints(joints: Joint[] = JOINTS): JointGroup[] {
  const groups: JointGroup[] = [];
  type G = JointGroup & { _smap?: Map<string, SideGroup> };
  const gmap = new Map<string, G>();
  for (const j of joints) {
    let g = gmap.get(j.group);
    if (!g) {
      g = { group: j.group, sides: [], _smap: new Map() };
      gmap.set(j.group, g);
      groups.push(g);
    }
    const sideKey = j.side || "";
    let s = g._smap?.get(sideKey);
    if (!s) {
      s = { side: sideKey, joints: [] };
      g._smap?.set(sideKey, s);
      g.sides.push(s);
    }
    s.joints.push(j);
  }
  for (const g of groups) delete (g as G)._smap;
  return groups;
}
