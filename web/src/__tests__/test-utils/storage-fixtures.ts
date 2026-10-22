/**
 * 存储引用与编辑响应的共享测试夹具。
 *
 * 派生节点的 data.src 持久化值域是存储 key（specs/storage-reference-key-unification.md）：
 * 测试构造 key 必须走真实格式（{userId}/{hash[:2]}/{hash}{ext}），编辑接口响应替身
 * 同时携带 key 与展示 url——「节点创建只消费 key」的契约才有可测前提。
 */
import { createHash } from "node:crypto";

/** 生成合法存储 key（userId 固定为 1：测试不依赖多用户 key 空间）；
    seed 经哈希保证任意两个不同 seed 产出不同哈希。命名与 shared/url 的谓词
    （isStorageKey / storageKeyOf）区分：这是构造器。 */
export function makeStorageKey(seed: string, ext: string): string {
  const hash = createHash("sha256").update(seed).digest("hex");
  return `1/${hash.slice(0, 2)}/${hash}${ext}`;
}

/** 测试用真实 200 Response：信封 JSON。 */
export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** 测试用失败 Response：400 + `{ error }` 信封（各路由失败码共用）。 */
export function errorResponse(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/** 单产物编辑的成功响应：key 与展示 url 同时存在，锁定「只消费 key」的前提。 */
export function editResultResponse(key: string): Response {
  return jsonResponse({ data: { key, url: `/api/files/${key}`, size: 1 } });
}

/** 分离音轨产物形状（video / audio 共用；audio 另带 format）。 */
export function detachedMedia(key: string, mime: string, ext: string) {
  return { key, url: `/api/files/${key}`, mime, ext, size: 1 };
}
