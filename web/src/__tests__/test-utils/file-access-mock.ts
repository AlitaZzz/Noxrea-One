/**
 * `@/lib/use-file-access-url` 的测试替身：同步返回逻辑 URL。
 *
 * 组件测试关注自身渲染与交互，访问解析（缓存 / 去重 / 签名 / 并发）由
 * `src/__tests__/lib/file-access.test.ts` 与 hook 专属用例覆盖。用法：
 *
 * ```ts
 * vi.mock("@/lib/use-file-access-url", () => import("@/__tests__/test-utils/file-access-mock"));
 * ```
 */
import { fileRefUrl } from "@/lib/file-url";

/**
 * 待解析集合：命中的逻辑值返回「尚未就绪」（`url: undefined`），用于验证组件在
 * 地址未就绪时不渲染空 `src` 等时序行为。默认为空，不影响其它用例。
 */
const pendingValues = new Set<string>();

export function setFileAccessPending(value: string, pending = true): void {
  if (pending) pendingValues.add(value);
  else pendingValues.delete(value);
}

export function resetFileAccessPending(): void {
  pendingValues.clear();
}

export interface MockFileAccessUrlState {
  url: string | undefined;
  delivery?: "signed" | "stream";
  failed: boolean;
  refresh: () => Promise<string | undefined>;
  /** 替身恒为 stream 语义：不重试签名地址（返回 null），重挂令牌不变（真实重试在 Hook 用例里验证） */
  retrySigned: () => Promise<string | null>;
  reloadToken: number;
}

export function useFileAccessUrl(value?: string | null): MockFileAccessUrlState {
  const logical = value ? fileRefUrl(value) : undefined;
  const url = logical && pendingValues.has(logical) ? undefined : logical;
  return {
    url,
    failed: false,
    refresh: () => Promise.resolve(url),
    retrySigned: () => Promise.resolve(null),
    reloadToken: 0,
  };
}
