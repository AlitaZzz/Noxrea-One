/**
 * 通用值形态守卫。
 * 服务端 JSON 列解析、画布引用提取与前端错误体 / 握手载荷校验共用同一判定：
 * 普通对象（排除 null 与数组）。
 */

/** 判断值是否为普通对象（排除 null 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
