/**
 * 取消语义（规则 3.3）：解析层以 `AbortError` 结算被取消的请求（会话切换、
 * 订阅撤销），fetch 中止同样是 `AbortError`。取消不是失败，调用方不得据此进入失败态。
 *
 * 构造与判定放在同一处：两侧若各写一套 name 字符串，改一处漏一处会让取消被当成失败。
 */
const ABORT_MESSAGE = "File access request cancelled";

export function abortError(): DOMException {
  return new DOMException(ABORT_MESSAGE, "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && (error as { name?: unknown }).name === "AbortError";
}
