/**
 * 文件读取凭据判定（specs/file-access-ownership.md 规则 2）。
 *
 * 只回答「这个请求以什么凭据、代表谁读取」，不判定 key 归属：归属属于读管线
 * （`server/http/file-read.ts`）。描述路由整批只判定一次凭据（{@link requireSessionRead}），
 * 逐条只走归属与派生；字节路由按 key 接受能力签名（{@link resolveByteReadCredential}）。
 */
import { authenticateRequest } from "@server/http/middleware/auth";
import { verifyFileUrlSignature } from "@server/services/storage/file-url-signature";

/** 无有效凭据：沿用会话鉴权生成的 401 响应（含 no-store） */
interface UnauthenticatedRead {
  ok: false;
  sessionErrorResponse: Response;
}

/** 会话凭据：描述路由的唯一合法分支 */
type SessionReadCredential =
  | { ok: true; credential: "session"; userId: number }
  | UnauthenticatedRead;

/** 字节路由的凭据：会话，或该 key 的能力签名 */
export type FileReadCredential =
  | SessionReadCredential
  | { ok: true; credential: "capability"; expiresAt: number };

/**
 * 描述路由的凭据判定：只接受会话。
 *
 * 描述请求由已登录页面发起，让能力参数参与鉴权等于允许「凭一条已签出的 URL
 * 换取新的签名 URL」，绕过寿命上限续签（specs/storage-signed-direct-delivery.md 规则 2.5）。
 */
export async function requireSessionRead(request: Request): Promise<SessionReadCredential> {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return { ok: false, sessionErrorResponse: auth.error };
  return { ok: true, credential: "session", userId: auth.user.id };
}

/**
 * 字节路由的凭据判定：会话优先；无会话时 `?expires&signature` 作为能力凭据。
 * @param key 已从路径解码的存储 key（能力签名锚定它；畸形 key 由读管线 fail-closed）
 */
export async function resolveByteReadCredential(
  request: Request,
  key: string,
): Promise<FileReadCredential> {
  const session = await requireSessionRead(request);
  if (session.ok) return session;

  const params = new URL(request.url).searchParams;
  if (verifyFileUrlSignature(key, params.get("expires"), params.get("signature"))) {
    return { ok: true, credential: "capability", expiresAt: Number(params.get("expires")) };
  }
  // 无有效会话且能力签名不成立：沿用会话鉴权的 401 响应
  return session;
}
