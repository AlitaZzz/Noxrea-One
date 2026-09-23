/**
 * 每种能力最近一次选用的模型（新节点默认值用）。
 * 存 localStorage：这是设备级用户偏好，不属于画布数据——
 * 不进节点 JSON / 数据库（多项目冗余、多设备互踩、清画布误删）。
 * 读取时校验模型仍存在于列表中，失效（被移除 / 重拉换名）静默回退，不悬空。
 */

const KEY_PREFIX = "noxrea.lastModel.";

/** 读取该能力最近一次选用的模型；不可用（无记录 / 已失效 / localStorage 不可用）返回空串 */
export function readLastModel(kind: string, allModels: { value: string }[]): string {
  try {
    const v = localStorage.getItem(KEY_PREFIX + kind);
    if (v && allModels.some((m) => m.value === v)) return v;
  } catch {
    // 隐私模式等 localStorage 不可用：静默回退到「第一个模型」
  }
  return "";
}

/** 记录该能力最近一次选用的模型（用户显式选择时调用） */
export function recordLastModel(kind: string, modelKey: string): void {
  if (!modelKey) return;
  try {
    localStorage.setItem(KEY_PREFIX + kind, modelKey);
  } catch {
    // 写入失败不阻塞：仅影响新节点默认值
  }
}

/**
 * 模型键统一回退链（面板展示与悬空纠偏共用）：
 * 持久化值（已失效视同未持久化）→ 该能力上次使用的模型 → 第一个可用模型。
 * persisted 传 undefined 即得到「悬空纠偏」的目标值。
 */
export function resolveModelKey(
  persisted: string | undefined | null,
  kind: string,
  allModels: { value: string }[],
): string {
  if (persisted && allModels.some((m) => m.value === persisted)) return persisted;
  return readLastModel(kind, allModels) || allModels[0]?.value || "";
}
