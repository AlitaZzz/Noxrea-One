/**
 * 生成任务失败原因的结构化表达 + 上游失败信号的统一解释层。
 *
 * 任务失败信息落库为两个字段，职责分离：
 *   - error      ：人类可读的原始文案。上游返回的原因原样保留，不做翻译。
 *   - error_code ：机器可读的失败分类。前端据此查 i18n，服务端也可按此统计失败分布。
 *
 * 仅在我们自身能判定原因时给出错误码（超时、网络不可达、SSRF 拦截、供应商缺失等）；
 * 上游自带可读文案的场景留空，由前端原样展示原文——这与外部参考实现
 * （Error 存提炼文案、ErrorDetail 存原始 payload）的分层思路一致。
 *
 * 上游响应结构不可控（各渠道状态字段名、层级、错误形态各异且无契约），
 * 失败信号的解释统一收敛在本模块：状态词表、整树证据扫描与可读文案提取。
 * 提交路径（manager）、轮询 4xx 路径（poll-loop）与协议层判定
 * （openai/shared 的 parseScanPollResult）共享同一套规则，不得各自实现。
 */

// ---------- 上游状态词表 ----------

const PENDING_STATUSES = new Set([
  "pending", "queued", "submitted", "processing", "running", "started", "in_progress",
]);

const COMPLETED_STATUSES = new Set([
  "success", "succeeded", "completed", "done", "ready", "finished",
]);

const FAILED_STATUSES = new Set([
  "failed", "error", "cancelled", "canceled", "timeout", "aborted", "invalid",
]);

/** 归一化上游状态到 pending/completed/failed（无法识别时原样返回小写） */
export function normalizeStatus(raw: string): string {
  const s = raw.toLowerCase().trim();
  if (PENDING_STATUSES.has(s)) return "pending";
  if (COMPLETED_STATUSES.has(s)) return "completed";
  if (FAILED_STATUSES.has(s)) return "failed";
  return s;
}

// ---------- 响应树遍历 ----------

/** 用户输入回显键：回显中的 URL / 状态词 / 错误文案都不是上游信号，不参与任何证据判定 */
const ECHO_SKIP_KEYS = new Set(["prompt", "prompts"]);

export type ResponseTreeVisitor = (key: string | null, value: unknown) => void;

/** 深度优先遍历 JSON 树，对每个值（含根）调用 visit，跳过用户输入回显键 */
export function walkResponseTree(value: unknown, key: string | null, visit: ResponseTreeVisitor): void {
  visit(key, value);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) walkResponseTree(item, null, visit);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (ECHO_SKIP_KEYS.has(k)) continue;
    walkResponseTree(v, k, visit);
  }
}

// ---------- 失败证据扫描 ----------

/** 错误专用键：携带非空内容即失败证据。message / msg 是进度字段，不算证据 */
const ERROR_EVIDENCE_KEYS = new Set(["error", "errors", "detail"]);

function errorValueText(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return t !== "" ? t : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const t = errorValueText(item);
      if (t !== null) return t;
    }
    return null;
  }
  if (value !== null && typeof value === "object") {
    const msg = (value as Record<string, unknown>).message;
    if (typeof msg === "string" && msg.trim() !== "") return msg.trim();
  }
  return null;
}

/**
 * 树内任意位置的错误专用键（error / errors / detail）携带非空内容
 * → 返回该文案；无证据返回 null。
 */
export function scanErrorEvidence(root: unknown): string | null {
  let found: string | null = null;
  walkResponseTree(root, null, (key, value) => {
    if (found !== null || key === null || !ERROR_EVIDENCE_KEYS.has(key)) return;
    found = errorValueText(value);
  });
  return found;
}

/**
 * 树内任意字段的值精确命中失败状态词（顶层 status 只是特例，嵌套的
 * state / result 等字段同样生效）→ 返回该词；无返回 null。
 */
export function scanFailureStatus(root: unknown): string | null {
  let found: string | null = null;
  walkResponseTree(root, null, (_key, value) => {
    if (found !== null || typeof value !== "string") return;
    const s = value.trim().toLowerCase();
    if (FAILED_STATUSES.has(s)) found = s;
  });
  return found;
}

// ---------- 可读文案提取 ----------

/**
 * 从上游错误响应体中提取可读的错误说明。
 * 优先整树扫描错误专用键（error / errors / detail），其次顶层 msg / message；
 * 字符串响应体先尝试 JSON 解析，非 JSON（如网关返回的 HTML 错误页）原样截断返回。
 * 提取不到时返回空串，由调用方回退到错误码或状态码描述。
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

  if (typeof data !== "object" || data === null) {
    // JSON 标量字符串体（如 "oops"）：响应体本身就是文案；null / 数字等无信号
    if (typeof data === "string" && data.trim()) return data.trim().slice(0, 200);
    return "";
  }

  const evidence = scanErrorEvidence(data);
  if (evidence !== null) return evidence.slice(0, 200);

  const record = data as Record<string, unknown>;
  for (const value of [record.msg, record.message]) {
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

/**
 * 上游错误的统一翻译：「上游自带可读文案时原样回传（不附错误码，前端原样展示）；
 * 取不到时回退兜底文案 + 错误码（由前端本地化）」。该规则此前在 manager、
 * audio、llm 中各自实现，统一收敛于此。
 */
export function failFromUpstream(
  upstreamMsg: string,
  fallback: { message: string; code: string }
): { error: string; errorCode?: string } {
  return upstreamMsg
    ? { error: upstreamMsg }
    : { error: fallback.message, errorCode: fallback.code };
}

/**
 * 任务已被用户取消（DB 中任务已是 cancelled 终态）。
 * 能力服务收到上游返回的取消信号时抛出；executor 捕获后直接结束本次执行，
 * 不写任何终态——失败终态守卫本会拒绝 cancelled 行，显式抛错让「无需写入」
 * 成为意图而非碰巧。
 */
export class GenerationCancelledError extends Error {
  constructor() {
    super("Task cancelled by user");
    this.name = "GenerationCancelledError";
    Object.setPrototypeOf(this, GenerationCancelledError.prototype);
  }
}
