/**
 * 浏览器下载触发工具。
 *
 * 托管引用先经访问解析层换取下载描述（specs/storage-signed-direct-delivery.md
 * 规则 3.5）。下载不得以顶层文档导航触发（规则 3.9）：顶层导航会在附件响应头
 * 到达前派发页面 `beforeunload`，画布未保存时表现为「离开此网站?」确认框。
 *
 * 触发形态先过 scheme 白名单，再按交付形态分流：`signed` 用一次性隐藏 iframe 承接（子框架收到
 * `Content-Disposition: attachment` 后直接进入下载管理器，顶层文档不导航）；
 * 同源 http(s) / `blob:` / `data:` 用 `<a download>`；外部跨域 URL 的 `download`
 * 属性会被浏览器忽略，改为新标签打开，避免顶掉当前页面。
 */

import {
  type FileDelivery,
  type ResolvedMediaUrl,
  resolveMediaUrlWithRetry,
} from "@/lib/file-access";
import { managedFileUrl } from "@/lib/file-url";
import { showGlobalMessage } from "@/lib/global-message";
import i18n from "@/lib/i18n/config";
import { sanitizeFileName } from "@/lib/utils/file-name";

/** 下载 iframe 的固定保留时长：附件导航没有可靠的完成信号，不能靠 load 事件回收 */
const DOWNLOAD_FRAME_TTL_MS = 60_000;

/** 允许进入下载分支的 scheme；`javascript:` / `file:` 等一律按失败处理 */
const DOWNLOADABLE_PROTOCOLS = new Set(["http:", "https:", "blob:", "data:"]);

/** 未回收的下载 iframe：定时器可能被后台标签页节流，pagehide 时统一清理 */
const pendingDownloadFrames = new Set<HTMLIFrameElement>();
let frameCleanupBound = false;

type DownloadTarget =
  | { mode: "frame"; url: string }
  | { mode: "anchor"; url: string }
  | { mode: "new-tab"; url: string };

function bindFrameCleanup(): void {
  if (frameCleanupBound) return;
  frameCleanupBound = true;
  window.addEventListener("pagehide", () => {
    for (const frame of pendingDownloadFrames) frame.remove();
    pendingDownloadFrames.clear();
  });
}

/**
 * 下载触发形态（规则 3.9）：所有地址先过 scheme 白名单，再按交付形态分流；
 * `signed` 判断混合内容后进 iframe，其余按 origin 决定锚点或新标签。
 *
 * `stream` 由服务端构造为同源路径，正常情况下必然走锚点；origin 比较是对
 * 异常配置的兜底，不能把跨域地址交给同标签锚点（`download` 属性跨域无效）。
 *
 * @returns `null` 表示该地址不能下载（无法解析或 scheme 不在白名单）
 */
function downloadTargetOf(url: string, delivery: FileDelivery | undefined): DownloadTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return null;
  }
  if (!DOWNLOADABLE_PROTOCOLS.has(parsed.protocol)) return null;

  // `blob:` / `data:` 原样使用：URL 解析会改写部分字符，且无需 origin 判定
  const direct = parsed.protocol === "blob:" || parsed.protocol === "data:";
  const href = direct ? url : parsed.href;

  if (delivery === "signed") {
    // https 页面把 http 资源装进子框架会被混合内容拦截（顶层导航不受此限）：
    // 该组合属部署配置错误，退回新标签保持可见行为
    if (window.location.protocol === "https:" && parsed.protocol === "http:") {
      return { mode: "new-tab", url: href };
    }
    return { mode: "frame", url: href };
  }

  if (direct || parsed.origin === window.location.origin) {
    return { mode: "anchor", url: href };
  }
  return { mode: "new-tab", url: href };
}

function triggerFrameDownload(url: string): void {
  bindFrameCleanup();
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("tabindex", "-1");
  frame.setAttribute("title", "download");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.cssText = "position:absolute;width:0;height:0;border:0;left:-9999px;top:-9999px;";
  // 先挂到文档再赋 src：确保导航发生在已连接的框架上
  document.body.appendChild(frame);
  frame.src = url;
  pendingDownloadFrames.add(frame);
  setTimeout(() => {
    pendingDownloadFrames.delete(frame);
    frame.remove();
  }, DOWNLOAD_FRAME_TTL_MS);
}

function triggerAnchorDownload(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  // download 属性一律设置（空串也有效）：同源附件靠它避免退化为顶层导航
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function triggerNewTabDownload(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function reportDownloadFailure(): void {
  // 下载是用户点击的即时反馈，按 web/AGENTS.md 七.1 用轻量消息而不是通知
  showGlobalMessage().error(i18n.t("common.downloadFailed"));
}

export async function downloadManagedFile(
  value: string | null | undefined,
  suggestedName?: string,
): Promise<void> {
  const logical = managedFileUrl(value);
  if (!logical) return;
  const fileName = sanitizeFileName(suggestedName ?? "");

  // 下载是「需要最终地址的非元素形态」：瞬时故障同样只重新描述一次（规则 3.6）
  let resolved: ResolvedMediaUrl;
  try {
    resolved = await resolveMediaUrlWithRetry(logical, {
      download: true,
      ...(fileName ? { filename: fileName } : {}),
    });
  } catch {
    reportDownloadFailure();
    return;
  }

  const target = downloadTargetOf(resolved.url, resolved.delivery);
  if (!target) {
    reportDownloadFailure();
    return;
  }

  switch (target.mode) {
    case "frame":
      triggerFrameDownload(target.url);
      break;
    case "anchor":
      triggerAnchorDownload(target.url, fileName);
      break;
    case "new-tab":
      triggerNewTabDownload(target.url);
      break;
  }
}
