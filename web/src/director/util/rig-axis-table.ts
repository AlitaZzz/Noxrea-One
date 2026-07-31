// rig 类型 + 语义骨 token 类型定义。
// RIG_AXIS 预置表与 getAxis 已由运行时自动推断取代(见 Character._inferAxisOverrides),
// 保留此处供参考或手动覆盖。

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

/** 预置轴向覆盖表(已废弃,由运行时推断取代)。保留供参考。 */
export const RIG_AXIS: Partial<Record<RigType, Partial<Record<string, AxisOverride>>>> = {
  mixamo: {},
  biped: {},
  ue: {},
};

/** 取某 rig 下某 jointKey 的有效 axis/sign(已废弃,由运行时推断取代)。 */
export function getAxis(
  rig: RigType,
  jointKey: string,
  def: { axis: "x" | "y" | "z"; sign?: number }
): AxisOverride {
  const o = RIG_AXIS[rig]?.[jointKey];
  return { axis: o?.axis ?? def.axis, sign: o?.sign ?? def.sign ?? 1 };
}
