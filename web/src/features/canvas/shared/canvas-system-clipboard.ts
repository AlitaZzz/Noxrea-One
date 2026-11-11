/**
 * 画布系统剪贴板传输层：ClipboardItem 写入、read()/readText() 读取、
 * paste 事件内容解析与 HTML 镜像反解。
 *
 * 格式契约（MIME / 载荷 / 上限）见 canvas-clipboard-format.ts。
 * 浏览器行为依据 Chrome 157 实测：
 * - ClipboardItem 同时写入自定义 MIME 与 text/html 时，read() 能读到两者；
 * - 原生 paste 事件只暴露 text/html（自定义 MIME 不可见），因此键盘粘贴
 *   在无标准内容时必须回退到 read()；
 * - Web Custom Format 在系统剪贴板中显示为不可见自定义格式，普通输入框
 *   不会收到它。
 */
import {
  buildCanvasClipboardHtml,
  CANVAS_CLIPBOARD_HTML_ATTR,
  CANVAS_CLIPBOARD_MAX_BYTES,
  CANVAS_CLIPBOARD_MAX_EDGES,
  CANVAS_CLIPBOARD_MAX_NODES,
  CANVAS_CLIPBOARD_MIME,
  CANVAS_CLIPBOARD_WEB_MIME,
  type CanvasClipboardPayload,
  encodeCanvasClipboardPayload,
  getUtf8ByteLength,
} from "@/features/canvas/shared/canvas-clipboard-format";
import i18n from "@/lib/i18n/config";

/** 粘贴入口统一内容模型（键盘 paste 事件与右键主动 read 共用） */
export interface ClipboardPasteContent {
  /** 检测到 Noxrea 自定义 MIME 或带标记 HTML 时存在 */
  payloadJson?: string;
  imageFiles: File[];
  text: string;
}

export type CanvasClipboardWriteResult =
  | { ok: true; mode: "rich" | "html" | "text" }
  | { ok: false; reason: "too-large" | "unsupported" | "rejected" };

type ClipboardItemCtor = typeof ClipboardItem & {
  supports?: (type: string) => boolean;
};

function getClipboard(): Clipboard | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.clipboard;
}

function getClipboardItemCtor(): ClipboardItemCtor | undefined {
  return typeof ClipboardItem === "undefined" ? undefined : (ClipboardItem as ClipboardItemCtor);
}

function clipboardItemSupports(ctor: ClipboardItemCtor, type: string): boolean {
  if (typeof ctor.supports !== "function") return false;
  try {
    return ctor.supports.call(ctor, type) === true;
  } catch {
    return false;
  }
}

/** 纯文本兜底：仅在明确有可读文本时使用（节点载荷永不写入 text/plain） */
function writePlainText(
  clipboard: Clipboard | undefined,
  text: string | undefined,
  unavailableReason: "unsupported" | "rejected",
): Promise<CanvasClipboardWriteResult> {
  if (text === undefined || typeof clipboard?.writeText !== "function") {
    return Promise.resolve({ ok: false, reason: unavailableReason });
  }
  try {
    return Promise.resolve(clipboard.writeText(text)).then(
      () => ({ ok: true, mode: "text" } as const),
      () => ({ ok: false, reason: unavailableReason } as const),
    );
  } catch {
    return Promise.resolve({ ok: false, reason: unavailableReason });
  }
}

/**
 * 写入画布选择。必须在用户手势调用栈内同步调用 `navigator.clipboard.write`——
 * 本函数在首次 await 之前完成全部编码与 API 调用，不得改成 async。
 *
 * - 自定义 MIME 仅在 ClipboardItem.supports 明确返回 true 时加入；
 * - text/html 镜像始终加入（同步 paste 事件与不支持自定义格式的浏览器）；
 * - text/plain 仅由调用方为纯文本选择传入；
 * - 超限/不可用/被拒都不回退写 JSON 文本。
 */
export function writeCanvasClipboard(
  payload: CanvasClipboardPayload,
  plainText?: string,
): Promise<CanvasClipboardWriteResult> {
  if (
    payload.nodes.length > CANVAS_CLIPBOARD_MAX_NODES ||
    payload.edges.length > CANVAS_CLIPBOARD_MAX_EDGES
  ) {
    return Promise.resolve({ ok: false, reason: "too-large" });
  }

  let json: string;
  let html: string;
  try {
    json = encodeCanvasClipboardPayload(payload);
    // 超限判定按编码后的 UTF-8 字节数；不截断、不写部分内容
    if (getUtf8ByteLength(json) > CANVAS_CLIPBOARD_MAX_BYTES) {
      return Promise.resolve({ ok: false, reason: "too-large" });
    }
    html = buildCanvasClipboardHtml(payload, plainText);
  } catch {
    return Promise.resolve({ ok: false, reason: "rejected" });
  }

  const clipboard = getClipboard();
  const ctor = getClipboardItemCtor();
  if (!clipboard?.write || !ctor) {
    return writePlainText(clipboard, plainText, "unsupported");
  }

  const supportsCustom = clipboardItemSupports(ctor, CANVAS_CLIPBOARD_WEB_MIME);
  const parts: Record<string, Blob> = {
    "text/html": new Blob([html], { type: "text/html" }),
  };
  if (supportsCustom) {
    parts[CANVAS_CLIPBOARD_WEB_MIME] = new Blob([json], { type: CANVAS_CLIPBOARD_MIME });
  }
  if (plainText !== undefined) {
    parts["text/plain"] = new Blob([plainText], { type: "text/plain" });
  }

  try {
    const item = new ctor(parts);
    const pending = clipboard.write([item]);
    return pending.then(
      () => ({ ok: true, mode: supportsCustom ? "rich" : "html" } as const),
      () => writePlainText(clipboard, plainText, "rejected"),
    );
  } catch {
    return writePlainText(clipboard, plainText, "rejected");
  }
}

/**
 * 从 HTML 镜像取载荷 JSON。只解析到惰性文档，不插入活动 DOM。
 * 属性存在但为空串时返回空串（视为「有标记但非法」），由载荷校验整包拒绝。
 */
export function extractCanvasPayloadFromHtml(html: string): string | null {
  if (!html || typeof DOMParser === "undefined") return null;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const element = doc.querySelector(`[${CANVAS_CLIPBOARD_HTML_ATTR}]`);
    return element ? element.getAttribute(CANVAS_CLIPBOARD_HTML_ATTR) : null;
  } catch {
    return null;
  }
}

function safeGetData(data: DataTransfer, type: string): string {
  try {
    return data.getData(type) || "";
  } catch {
    return "";
  }
}

function imageFilesFromDataTransfer(data: DataTransfer): File[] {
  const files: File[] = [];
  try {
    for (const item of data.items) {
      if (!item.type.startsWith("image/")) continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  } catch {
    // DataTransfer 在部分环境不可迭代；无图片内容按空处理
  }
  return files;
}

/** 同步解析原生 paste 事件：自定义 MIME（若浏览器暴露）→ 带标记 HTML → 文本 */
export function parsePasteEventContent(data: DataTransfer): ClipboardPasteContent {
  const customPayload =
    safeGetData(data, CANVAS_CLIPBOARD_WEB_MIME) || safeGetData(data, CANVAS_CLIPBOARD_MIME);
  const htmlPayload = extractCanvasPayloadFromHtml(safeGetData(data, "text/html"));
  const payloadJson = customPayload || htmlPayload;
  const content: ClipboardPasteContent = {
    imageFiles: imageFilesFromDataTransfer(data),
    text: safeGetData(data, "text/plain"),
  };
  if (payloadJson !== null && payloadJson !== undefined) content.payloadJson = payloadJson;
  return content;
}

/**
 * 主动读取系统剪贴板（右键菜单与键盘无标准内容时的回退）。
 * 优先级：自定义 MIME → 带标记 HTML → 图片 → 文本。
 * 读取失败（权限拒绝 / 浏览器不支持 read）返回 null；read 不可用时降级
 * readText 只取文本。空剪贴板返回空内容对象，由调用方回退内部剪贴板。
 */
export async function readSystemClipboard(): Promise<ClipboardPasteContent | null> {
  const clipboard = getClipboard();

  if (typeof clipboard?.read === "function") {
    try {
      const items = await clipboard.read();
      let payloadJson: string | undefined;
      const imageFiles: File[] = [];
      let text = "";

      for (const item of items) {
        if (payloadJson === undefined) {
          const customType = item.types.find(
            (type) => type === CANVAS_CLIPBOARD_WEB_MIME || type === CANVAS_CLIPBOARD_MIME,
          );
          if (customType) {
            try {
              payloadJson = await (await item.getType(customType)).text();
            } catch {
              // 该类型读取失败时继续尝试 HTML 镜像
            }
          }
        }
        if (payloadJson === undefined && item.types.includes("text/html")) {
          try {
            const fromHtml = extractCanvasPayloadFromHtml(
              await (await item.getType("text/html")).text(),
            );
            if (fromHtml !== null) payloadJson = fromHtml;
          } catch {
            // HTML 读取失败按无标记处理
          }
        }

        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          try {
            const blob = await item.getType(imageType);
            // 文件名会成为节点标题，走 i18n；扩展名按 MIME 推断供下游识别
            const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
            const name = `${i18n.t("node.clipboardImage")}.${ext}`;
            imageFiles.push(new File([blob], name, { type: imageType }));
          } catch {
            // 单个图片项读取失败不影响其它内容
          }
        }

        if (item.types.includes("text/plain")) {
          try {
            text = await (await item.getType("text/plain")).text();
          } catch {
            // 文本读取失败按空处理
          }
        }
      }

      const content: ClipboardPasteContent = { imageFiles, text };
      if (payloadJson !== undefined) content.payloadJson = payloadJson;
      return content;
    } catch {
      // 权限被拒 / read 不可用 → 尝试 readText
    }
  }

  if (typeof clipboard?.readText === "function") {
    try {
      return { imageFiles: [], text: await clipboard.readText() };
    } catch {
      // 权限被拒
    }
  }

  return null;
}
