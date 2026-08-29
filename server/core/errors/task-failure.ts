/**
 * 生成任务失败原因的结构化表达。
 *
 * 任务失败信息落库为两个字段，职责分离：
 *   - error      ：人类可读的原始文案。上游返回的原因原样保留，不做翻译。
 *   - error_code ：机器可读的失败分类。前端据此查 i18n，服务端也可按此统计失败分布。
 *
 * 仅在我们自身能判定原因时给出错误码（超时、网络不可达、SSRF 拦截、供应商缺失等）；
 * 上游自带可读文案的场景留空，由前端原样展示原文——这与外部参考实现
 * （Error 存提炼文案、ErrorDetail 存原始 payload）的分层思路一致。
 */

/**
 * 从上游错误响应体中提取可读的错误说明。
 * OpenAI 兼容协议普遍使用 error.message，部分厂商使用 msg / message。
 * 提取不到时返回空串，由调用方回退到错误码或状态码描述。
 *
 * @param body 响应体，可为 JSON 字符串、已解析的对象，或纯文本
 */
export function extractUpstreamMessage(body: unknown): string {
  let data: unknown = body;

  if (typeof body === "string") {
    const text = body.trim();
    if (!text) return "";
    try {
      data = JSON.parse(text);
    } catch {
      // 非 JSON（如网关返回的 HTML 错误页），原样截断返回
      return text.slice(0, 200);
    }
  }

  if (typeof data !== "object" || data === null) return "";

  const record = data as Record<string, unknown>;
  const nested =
    typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>).message
      : record.error;

  for (const value of [nested, record.msg, record.message]) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return "";
}

/**
 * 携带错误码的生成失败异常。
 * message 为人类可读的原始文案（落库供用户查看与日志排查），
 * errorCode 为失败分类（落库供前端本地化与统计）。
 */
export class GenerationFailureError extends Error {
  readonly errorCode?: string;

  constructor(message: string, errorCode?: string) {
    super(message);
    this.name = "GenerationFailureError";
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, GenerationFailureError.prototype);
  }
}

/** 从任意异常中提取错误码（仅 GenerationFailureError 携带）。 */
export function extractFailureCode(err: unknown): { code?: string } {
  if (err instanceof GenerationFailureError) {
    return { code: err.errorCode };
  }
  return {};
}
