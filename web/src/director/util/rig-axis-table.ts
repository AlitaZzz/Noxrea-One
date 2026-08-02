/** rig 类型 + 语义骨 token + 轴向覆盖类型定义。 */

export type RigType = "mixamo" | "biped" | "ue" | "unknown";

/** 语义骨 token:与 jointConfig.bone 字段一致(去掉 mixamorig: 前缀的驼峰名)。 */
export type SemToken =
  | "Hips" | "Spine1" | "Head" | "Neck"
  | "LeftArm" | "LeftForeArm" | "LeftHand"
  | "LeftUpLeg" | "LeftLeg" | "LeftFoot"
  | "RightArm" | "RightForeArm" | "RightHand"
  | "RightUpLeg" | "RightLeg" | "RightFoot";

export interface AxisOverride {
  axis: "x" | "y" | "z";
  sign: number;
}
