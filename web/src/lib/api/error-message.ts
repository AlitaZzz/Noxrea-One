/**
 * 服务端错误响应本地化。
 * 服务端以 { error, ctx } 返回结构化错误码，此处按 error 查 i18n 得到展示文案；
 * 未迁移的旧接口仍返回 { detail } 纯英文文案，原样透出以免丢失信息。
 */
import i18n from "@/lib/i18n/config";

/** 错误文案在 i18n 中的命名空间 */
const ERROR_NS = "error";

/** 服务端错误响应体（failCode 新格式 / 旧版 fail 格式） */
export interface ApiErrorBody {
  /** 机器可读错误码，对应 i18n 中 error 命名空间下的文案 */
  error?: string;
  /** 文案插值参数 */
  ctx?: Record<string, string | number>;
  /** 请求 ID，对应服务端日志，报障时回传 */
  requestId?: string;
  /** 旧格式纯文案，仅未迁移接口返回 */
  detail?: string;
}

/** 判断值是否为对象类型（排除 null），用于响应体结构校验。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 从响应体中提取错误部分，兼容网关返回的 HTML 等非 JSON 内容。 */
export function parseErrorBody(body: unknown): ApiErrorBody | null {
  return isRecord(body) ? (body as ApiErrorBody) : null;
}

/**
 * 直接从 Response 解析错误并生成面向用户的本地化文案。
 * 适用于只持有 Response、不便预先解析响应体的调用方。
 * 注意：内部会消费响应体，调用后不可再读取 res.json()。
 *
 * @param res 失败的响应对象
 * @param fallbackKey 无可用错误码时的兜底 i18n key（相对 error 命名空间）
 */
export async function resolveResponseError(
  res: Response,
  fallbackKey = "unknown"
): Promise<string> {
  const body = parseErrorBody(await res.json().catch(() => null));
  return resolveApiError(body, res.status, fallbackKey);
}

/**
 * 将服务端错误响应解析为面向用户的本地化文案。
 * @param body 已解析的响应体，无法解析时传 null
 * @param status HTTP 状态码，仅用于兜底展示
 * @param fallbackKey 无可用错误码时的兜底 i18n key（相对 error 命名空间）
 * @param opts.withRequestId 是否在文案末尾附加请求 ID（弹窗类提示建议开启）
 */
export function resolveApiError(
  body: ApiErrorBody | null,
  status?: number,
  fallbackKey = "unknown",
  opts?: { withRequestId?: boolean }
): string {
  const fallback = i18n.t(`${ERROR_NS}.${fallbackKey}`, {
    defaultValue: i18n.t(`${ERROR_NS}.unknown`),
  });

  /** 按需附加请求 ID，便于用户报障时回传定位日志 */
  const withRequestId = (message: string): string => {
    if (!opts?.withRequestId || !body?.requestId) return message;
    return i18n.t(`${ERROR_NS}.withRequestId`, {
      message,
      id: body.requestId,
      defaultValue: message,
    });
  };

  // ① 结构化错误码
  if (body?.error) {
    const key = `${ERROR_NS}.${body.error}`;
    if (i18n.exists(key)) {
      return withRequestId(i18n.t(key, { ...(body.ctx ?? {}), defaultValue: fallback }));
    }
    // 错误码未登记翻译时退回通用文案，开发环境下提示补齐，避免把裸错误码展示给用户
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[i18n] 错误码缺少翻译: ${body.error}`);
    }
    return withRequestId(fallback);
  }

  // ② 旧格式：未迁移接口回传的英文文案
  if (body?.detail) return withRequestId(body.detail);

  const message =
    status !== undefined
      ? i18n.t(`${ERROR_NS}.withStatus`, { message: fallback, status, defaultValue: fallback })
      : fallback;
  return withRequestId(message);
}
