/**
 * 配置数值文本的规范形态：system_settings 存储值与环境变量引导配置共用同一套规则，
 * 避免 Number() 把空串 / 空白 / 科学计数法 / Infinity 等宽松接受为有效值。
 */
const INTEGER_TEXT = /^\d+$/;
const DECIMAL_TEXT = /^\d+(\.\d+)?$/;

/** 整数文本解析结果：失败原因区分形态非法与超出安全整数域，调用方据此给出准确错误。 */
export type IntegerTextResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: "not-plain-digits" | "unsafe-integer" };

/** 规范整数文本 → 安全整数；非规范文本或超出安全整数域返回带原因的失败结果。 */
export function parseIntegerText(text: string): IntegerTextResult {
  if (!INTEGER_TEXT.test(text)) return { ok: false, reason: "not-plain-digits" };
  const value = Number(text);
  return Number.isSafeInteger(value)
    ? { ok: true, value }
    : { ok: false, reason: "unsafe-integer" };
}

/**
 * 规范小数文本 → 有限数值；非规范文本或位数溢出至 Infinity 返回 null。
 * 取值范围（正数、业务上限）由调用方的 zod pipe 继续约束。
 */
export function parseDecimalText(text: string): number | null {
  if (!DECIMAL_TEXT.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
