// 全身多轴关节表（§6）-- 与《人偶姿势体验_技术改造文档.md》同源。
// 字段：{group, side, key, label, bone, axis, min, max}
// 注意（§5.4）：axis 与 min/max 是起始值；各骨头本地轴方向不一致，必要时在浏览器里
// 实测校准（翻转 min/max 正负或换 axis）。左右成对动作通常镜像（正负相反）。
// bone 字段为语义 token（SemToken），由 boneIdentify.ts 自动识别映射，不再写死 mixamorig 名。
// min/max 已对照人体关节活动度校准（2026-07-21）。

import type { SemToken } from "../util/rigAxisTable";

export interface Joint {
  group: string;
  side: string;
  key: string;
  label: string;
  bone: SemToken;
  axis: "x" | "y" | "z";
  min: number;
  max: number;
  sign?: number;
}

export const JOINTS: Joint[] = [
  // 身体（根 Hips：整体朝向）
  { group: "身体", side: "", key: "bodyX", label: "前倾", bone: "Hips", axis: "x", min: -90, max: 90 },
  { group: "身体", side: "", key: "bodyY", label: "转身", bone: "Hips", axis: "y", min: -90, max: 90 },
  { group: "身体", side: "", key: "bodyZ", label: "侧倾", bone: "Hips", axis: "z", min: -90, max: 90 },
  // 躯干（Spine1）
  { group: "躯干", side: "", key: "spineX", label: "前倾(弯腰)", bone: "Spine1", axis: "x", min: -90, max: 90 },
  { group: "躯干", side: "", key: "spineY", label: "扭转", bone: "Spine1", axis: "y", min: -45, max: 45 },
  { group: "躯干", side: "", key: "spineZ", label: "侧倾", bone: "Spine1", axis: "z", min: -30, max: 30 },
  // 头部（Head）
  { group: "头部", side: "", key: "headX", label: "点头", bone: "Head", axis: "x", min: -60, max: 60 },
  { group: "头部", side: "", key: "headY", label: "转头", bone: "Head", axis: "y", min: -80, max: 80 },
  { group: "头部", side: "", key: "headZ", label: "歪头", bone: "Head", axis: "z", min: -45, max: 45 },
  // 手臂-肩 · 左 / 右（Arm）
  { group: "手臂-肩", side: "左", key: "lArmFwd", label: "前举", bone: "LeftArm", axis: "y", min: -50, max: 180, sign: -1 },
  { group: "手臂-肩", side: "左", key: "lArmAbd", label: "外展", bone: "LeftArm", axis: "z", min: -90, max: 90 },
  { group: "手臂-肩", side: "左", key: "lArmTwist", label: "扭转", bone: "LeftArm", axis: "x", min: -90, max: 90 },
  { group: "手臂-肩", side: "右", key: "rArmFwd", label: "前举", bone: "RightArm", axis: "y", min: -50, max: 180 },
  { group: "手臂-肩", side: "右", key: "rArmAbd", label: "外展", bone: "RightArm", axis: "z", min: -90, max: 90, sign: -1 },
  { group: "手臂-肩", side: "右", key: "rArmTwist", label: "扭转", bone: "RightArm", axis: "x", min: -90, max: 90 },
  // 肘部（ForeArm）
  { group: "肘部", side: "左", key: "lFore", label: "弯曲", bone: "LeftForeArm", axis: "y", min: 0, max: 150, sign: -1 },
  { group: "肘部", side: "右", key: "rFore", label: "弯曲", bone: "RightForeArm", axis: "y", min: 0, max: 150 },
  // 手腕（Hand，可选）
  { group: "手腕", side: "左", key: "lHand", label: "弯曲", bone: "LeftHand", axis: "x", min: -80, max: 80 },
  { group: "手腕", side: "右", key: "rHand", label: "弯曲", bone: "RightHand", axis: "x", min: -80, max: 80 },
  // 腿部-髋 · 左 / 右（UpLeg）— lLegFwd/rLegFwd 正=向前（见 Character._inferAxisOverrides 抬腿修正）
  { group: "腿部-髋", side: "左", key: "lLegFwd", label: "抬腿", bone: "LeftUpLeg", axis: "x", min: -30, max: 120 },
  { group: "腿部-髋", side: "左", key: "lLegAbd", label: "外展", bone: "LeftUpLeg", axis: "z", min: -30, max: 45 },
  { group: "腿部-髋", side: "左", key: "lLegTwist", label: "扭转", bone: "LeftUpLeg", axis: "y", min: -90, max: 90 },
  { group: "腿部-髋", side: "右", key: "rLegFwd", label: "抬腿", bone: "RightUpLeg", axis: "x", min: -30, max: 120 },
  { group: "腿部-髋", side: "右", key: "rLegAbd", label: "外展", bone: "RightUpLeg", axis: "z", min: -30, max: 45, sign: -1 },
  { group: "腿部-髋", side: "右", key: "rLegTwist", label: "扭转", bone: "RightUpLeg", axis: "y", min: -90, max: 90 },
  // 膝（Leg）
  { group: "膝", side: "左", key: "lKnee", label: "弯曲", bone: "LeftLeg", axis: "x", min: 0, max: 130 },
  { group: "膝", side: "右", key: "rKnee", label: "弯曲", bone: "RightLeg", axis: "x", min: 0, max: 130 },
  // 踝（Foot）
  { group: "踝", side: "左", key: "lFoot", label: "勾绷", bone: "LeftFoot", axis: "x", min: -40, max: 40 },
  { group: "踝", side: "右", key: "rFoot", label: "勾绷", bone: "RightFoot", axis: "x", min: -40, max: 40 },
];

export interface JointGroup {
  group: string;
  sides: { side: string; joints: Joint[] }[];
}

/** 按出现顺序分组：[{group, sides:[{side, joints:[...]}]}] -- 供 PoseSliders 渲染。 */
export function groupJoints(joints: Joint[] = JOINTS): JointGroup[] {
  const groups: JointGroup[] = [];
  type G = JointGroup & { _smap: Map<string, any> };
  const gmap = new Map<string, G>();
  for (const j of joints) {
    let g = gmap.get(j.group) as G | undefined;
    if (!g) {
      g = { group: j.group, sides: [], _smap: new Map() };
      gmap.set(j.group, g);
      groups.push(g);
    }
    const sideKey = j.side || "";
    let s = g._smap.get(sideKey) as any;
    if (!s) {
      s = { side: sideKey, joints: [] };
      g._smap.set(sideKey, s);
      g.sides.push(s);
    }
    s.joints.push(j);
  }
  for (const g of groups) delete (g as any)._smap;
  return groups;
}
