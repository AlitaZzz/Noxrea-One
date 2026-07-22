// 静态姿势预设：每项 = { 关节key: 角度(度), ... }（键取自 jointConfig.key）。
// 静止位是 Mixamo T-Pose（手臂水平张开），故"站立"需把手臂放下；"T型"才是全 0。
//
// 约定（已校准）：
//   lLegFwd/rLegFwd 正=向前抬腿、lArmFwd/rArmFwd 正=向前举、
//   lArmAbd/rArmAbd 负=下垂/正=外展、lKnee/rKnee/lFore/rFore 正=弯曲。
// 其余关节（身体/躯干/头的转身·扭转·侧倾·点头等）方向按动作理解设定，
// 可能需浏览器实测微调正负。

const STAND = { lArmAbd: -80, rArmAbd: -80, lFore: 8, rFore: 8 };

export interface PosePreset {
  key: string;
  label: string;
  values: Record<string, number>;
}

export const POSE_PRESETS: PosePreset[] = [
  { key: "stand", label: "站立", values: { ...STAND } },
  { key: "tpose", label: "T型", values: {} },

  // 行走：左腿前迈、右腿后蹬，对侧摆臂（左臂后/右臂前）
  { key: "walk", label: "行走", values: { ...STAND, lLegFwd: 30, rLegFwd: -20, lKnee: 25, rKnee: 35,
                                          lArmFwd: -20, rArmFwd: 25, lFore: 25, rFore: 30 } },
  // 行走2：右腿前迈、左腿后蹬（相反迈步阶段），对侧摆臂
  { key: "walk2", label: "行走2", values: { ...STAND, lLegFwd: -20, rLegFwd: 30, lKnee: 35, rKnee: 25,
                                            lArmFwd: 25, rArmFwd: -20, lFore: 30, rFore: 25 } },
  // 跑步：大幅迈步、前倾、肘大弯
  { key: "run", label: "跑步", values: { ...STAND, spineX: 15, lLegFwd: 50, rLegFwd: -30, lKnee: 60, rKnee: 80,
                                         lArmFwd: -50, rArmFwd: 55, lFore: 90, rFore: 95 } },
  // 叉腰：双手叉腰间，肘弯手向腰
  { key: "akimbo", label: "叉腰", values: { ...STAND, lArmAbd: 35, rArmAbd: 35, lArmFwd: 25, rArmFwd: 25,
                                           lFore: 100, rFore: 100, lArmTwist: 35, rArmTwist: -35 } },
  // 鞠躬：弯腰 + 微前倾 + 点头
  { key: "bow", label: "鞠躬", values: { ...STAND, spineX: 45, bodyX: 15, headX: 15 } },
  // 思考：右手托腮，微低头歪头
  { key: "think", label: "思考", values: { ...STAND, headX: 12, headZ: 10, rArmFwd: 45, rArmAbd: 35, rFore: 115 } },
  // 格斗：微蹲护脸，前后站，双拳举高
  { key: "fight", label: "格斗", values: { ...STAND, spineX: 12, bodyY: 15, lLegFwd: -15, rLegFwd: 12,
                                           lKnee: 35, rKnee: 35, lArmFwd: 45, rArmFwd: 45, lArmAbd: 35, rArmAbd: 35,
                                           lFore: 95, rFore: 95, lArmTwist: 35, rArmTwist: -35 } },
  // 踢球：右腿前踢，微后仰，双臂展开平衡
  { key: "kick", label: "踢球", values: { ...STAND, spineX: -12, rLegFwd: 85, rKnee: 35, lKnee: 12,
                                         lArmAbd: 40, rArmAbd: 40, lArmFwd: -30, rArmFwd: -30 } },
  // 投掷：右臂后拉准备，转身扭腰，前后站
  { key: "throw", label: "投掷", values: { ...STAND, bodyY: -25, spineY: -30, lLegFwd: -15, rLegFwd: 12,
                                           rArmFwd: 140, rArmAbd: 45, rFore: 90, lArmFwd: 60, lArmAbd: -40 } },
  // 推进：双手前推，前倾，前后站，后腿弯蹬
  { key: "push", label: "推进", values: { ...STAND, spineX: 20, lLegFwd: -20, rLegFwd: 15, lKnee: 20, rKnee: 45,
                                          lArmFwd: 85, rArmFwd: 85, lArmAbd: -25, rArmAbd: 25, lFore: 10, rFore: 10 } },
  // 招手：右臂举高招手，微转头
  { key: "wave", label: "招手", values: { ...STAND, rArmAbd: 90, rArmFwd: 25, rFore: 80, rArmTwist: -40, headY: -12 } },
  // 伸手：右臂前伸探，微前倾
  { key: "reach", label: "伸手", values: { ...STAND, spineX: 8, rArmFwd: 90, rArmAbd: 55, rFore: 5 } },
  // 抱臂：双手交叉胸前
  { key: "cross", label: "抱臂", values: { ...STAND, lArmFwd: 35, rArmFwd: 35, lArmAbd: -45, rArmAbd: 45,
                                           lFore: 105, rFore: 105, lArmTwist: 45, rArmTwist: -45 } },
];

export const POSE_PRESET_MAP: Record<string, PosePreset> = Object.fromEntries(
  POSE_PRESETS.map((p) => [p.key, p])
);
