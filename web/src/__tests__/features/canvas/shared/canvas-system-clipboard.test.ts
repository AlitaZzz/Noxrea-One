// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildCanvasClipboardHtml,
  CANVAS_CLIPBOARD_KIND,
  CANVAS_CLIPBOARD_MAX_BYTES,
  CANVAS_CLIPBOARD_MAX_NODES,
  CANVAS_CLIPBOARD_MIME,
  CANVAS_CLIPBOARD_VERSION,
  CANVAS_CLIPBOARD_WEB_MIME,
  type CanvasClipboardPayload,
} from "@/features/canvas/shared/canvas-clipboard-format";
import {
  extractCanvasPayloadFromHtml,
  parsePasteEventContent,
  readSystemClipboard,
  writeCanvasClipboard,
} from "@/features/canvas/shared/canvas-system-clipboard";

class FakeBlob {
  readonly type: string;
  readonly content: string;

  constructor(parts: BlobPart[], options?: { type?: string }) {
    this.type = options?.type ?? "";
    this.content = parts.map((part) => String(part)).join("");
  }

  text(): Promise<string> {
    return Promise.resolve(this.content);
  }
}

class FakeClipboardItem {
  static supports: (type: string) => boolean = vi.fn(
    (type: string) => type === CANVAS_CLIPBOARD_WEB_MIME,
  );

  readonly items: Record<string, FakeBlob>;

  constructor(items: Record<string, FakeBlob>) {
    this.items = items;
  }
}

function textPayload(text = "hello"): CanvasClipboardPayload {
  return {
    kind: CANVAS_CLIPBOARD_KIND,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: [
      {
        id: "text",
        type: "text-node",
        position: { x: 0, y: 0 },
        data: { label: "text", content: `<p>${text}</p>`, plainText: text },
      },
    ],
    edges: [],
  };
}

function imagePayload(): CanvasClipboardPayload {
  return {
    kind: CANVAS_CLIPBOARD_KIND,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: [
      {
        id: "img",
        type: "image-node",
        position: { x: 0, y: 0 },
        data: {
          label: "img",
          src: "uploads/a.png",
          lockAspectRatio: true,
          naturalWidth: 100,
          naturalHeight: 80,
        },
      },
    ],
    edges: [],
  };
}

function stubClipboard(write = vi.fn().mockResolvedValue(undefined)) {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { write, writeText } });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  vi.stubGlobal("Blob", FakeBlob);
  FakeClipboardItem.supports = vi.fn((type: string) => type === CANVAS_CLIPBOARD_WEB_MIME);
  return { write, writeText };
}

function writtenItem(write: ReturnType<typeof vi.fn>) {
  return write.mock.calls[0]?.[0]?.[0] as FakeClipboardItem;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTML 镜像解析", () => {
  it("从带标记 HTML 中取转义后的载荷，且不插入活动 DOM", () => {
    const payload = textPayload("a < b & c");
    const html = buildCanvasClipboardHtml(payload, "a < b & c");
    expect(extractCanvasPayloadFromHtml(html)).toBe(JSON.stringify(payload));
  });

  it("无标记 HTML 返回 null，空标记返回空串", () => {
    expect(extractCanvasPayloadFromHtml("<span>hello</span>")).toBeNull();
    expect(
      extractCanvasPayloadFromHtml('<span data-noxrea-canvas-selection="">x</span>'),
    ).toBe("");
    expect(extractCanvasPayloadFromHtml("")).toBeNull();
  });
});

describe("parsePasteEventContent", () => {
  function dataTransfer(values: Record<string, string>, items: unknown[] = []): DataTransfer {
    return {
      getData: (type: string) => values[type] ?? "",
      items,
    } as unknown as DataTransfer;
  }

  it("带标记 HTML 优先于 text/plain", () => {
    const payload = textPayload();
    const content = parsePasteEventContent(
      dataTransfer({
        "text/html": `<span data-noxrea-canvas-selection='${JSON.stringify(payload)}'>hello</span>`,
        "text/plain": "hello",
      }),
    );
    expect(content.payloadJson).toBe(JSON.stringify(payload));
    expect(content.text).toBe("hello");
  });

  it("未带标记的 HTML 不解析，只保留文本", () => {
    const content = parsePasteEventContent(
      dataTransfer({ "text/html": "<b>bold</b>", "text/plain": "bold" }),
    );
    expect(content.payloadJson).toBeUndefined();
    expect(content.text).toBe("bold");
  });

  it("浏览器暴露自定义 MIME 时优先使用；同时收集图片与文本", () => {
    const file = new File(["image"], "clip.png", { type: "image/png" });
    const content = parsePasteEventContent(
      dataTransfer(
        {
          [CANVAS_CLIPBOARD_WEB_MIME]: '{"kind":"custom"}',
          "text/plain": "text",
        },
        [{ type: "image/png", getAsFile: () => file }],
      ),
    );
    expect(content.payloadJson).toBe('{"kind":"custom"}');
    expect(content.imageFiles).toEqual([file]);
    expect(content.text).toBe("text");
  });
});

describe("writeCanvasClipboard", () => {
  it("非文本选择写入自定义 MIME + HTML，不写 text/plain", async () => {
    const { write } = stubClipboard();
    const pending = writeCanvasClipboard(imagePayload());

    // 必须在返回 Promise 前同步调用 clipboard.write（保留用户手势）
    expect(write).toHaveBeenCalledTimes(1);
    const item = writtenItem(write);
    expect(Object.keys(item.items).sort()).toEqual(
      [CANVAS_CLIPBOARD_WEB_MIME, "text/html"].sort(),
    );
    expect(item.items[CANVAS_CLIPBOARD_WEB_MIME].type).toBe(CANVAS_CLIPBOARD_MIME);
    expect(item.items["text/html"].type).toBe("text/html");
    expect(item.items["text/html"].content).toContain("data-noxrea-canvas-selection");
    expect(item.items["text/html"].content).not.toContain("noxrea-nodes:");
    await expect(pending).resolves.toEqual({ ok: true, mode: "rich" });
  });

  it("纯文本选择附带可读 text/plain，HTML 只显示可读文本", async () => {
    const { write } = stubClipboard();
    await writeCanvasClipboard(textPayload("可读文字"), "可读文字");
    const item = writtenItem(write);
    expect(item.items["text/plain"].content).toBe("可读文字");
    expect(item.items["text/html"].content).toContain("可读文字");
    expect(item.items["text/html"].content).not.toContain("noxrea-nodes:");
  });

  it("supports 返回 false / 抛错时省略自定义 MIME，仍写 HTML", async () => {
    const { write } = stubClipboard();
    FakeClipboardItem.supports = vi.fn(() => false);
    await expect(writeCanvasClipboard(imagePayload())).resolves.toEqual({
      ok: true,
      mode: "html",
    });
    expect(writtenItem(write).items).not.toHaveProperty(CANVAS_CLIPBOARD_WEB_MIME);

    FakeClipboardItem.supports = vi.fn(() => {
      throw new Error("unsupported");
    });
    await expect(writeCanvasClipboard(imagePayload())).resolves.toEqual({
      ok: true,
      mode: "html",
    });
  });

  it("没有 ClipboardItem 时节点载荷不支持，纯文本降级 writeText", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("ClipboardItem", undefined);

    await expect(writeCanvasClipboard(imagePayload())).resolves.toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(writeText).not.toHaveBeenCalled();

    await expect(writeCanvasClipboard(textPayload("文字"), "文字")).resolves.toEqual({
      ok: true,
      mode: "text",
    });
    expect(writeText).toHaveBeenCalledWith("文字");
  });

  it("写入被拒时节点载荷返回 rejected，纯文本回退 writeText", async () => {
    const write = vi.fn().mockRejectedValue(new Error("denied"));
    const { writeText } = stubClipboard(write);

    await expect(writeCanvasClipboard(imagePayload())).resolves.toEqual({
      ok: false,
      reason: "rejected",
    });
    await expect(writeCanvasClipboard(textPayload("文字"), "文字")).resolves.toEqual({
      ok: true,
      mode: "text",
    });
    expect(writeText).toHaveBeenCalledWith("文字");
  });

  it("超过节点数或字节上限时跳过系统写入", async () => {
    const { write } = stubClipboard();
    const tooMany = {
      ...imagePayload(),
      nodes: new Array(CANVAS_CLIPBOARD_MAX_NODES + 1).fill(imagePayload().nodes[0]),
    };
    await expect(writeCanvasClipboard(tooMany)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });

    const tooBig = imagePayload();
    tooBig.nodes[0].data.big = "x".repeat(CANVAS_CLIPBOARD_MAX_BYTES);
    await expect(writeCanvasClipboard(tooBig)).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("readSystemClipboard", () => {
  function stubRead(
    read: () => Promise<Array<{ types: string[]; getType: (type: string) => Promise<unknown> }>>,
    readText?: () => Promise<string>,
  ) {
    vi.stubGlobal("navigator", { clipboard: { read, readText } });
  }

  function textBlob(text: string) {
    return { text: () => Promise.resolve(text) };
  }

  it("读取自定义 MIME 载荷", async () => {
    stubRead(() =>
      Promise.resolve([
        {
          types: [CANVAS_CLIPBOARD_MIME],
          getType: () => Promise.resolve(textBlob('{"kind":"payload"}')),
        },
      ]),
    );
    await expect(readSystemClipboard()).resolves.toEqual({
      payloadJson: '{"kind":"payload"}',
      imageFiles: [],
      text: "",
    });
  });

  it("自定义类型读取失败时回退带标记 HTML", async () => {
    stubRead(() =>
      Promise.resolve([
        {
          types: [CANVAS_CLIPBOARD_MIME, "text/html"],
          getType: (type) =>
            type === CANVAS_CLIPBOARD_MIME
              ? Promise.reject(new Error("denied"))
              : Promise.resolve(
                  textBlob('<span data-noxrea-canvas-selection="payload">x</span>'),
                ),
        },
      ]),
    );
    await expect(readSystemClipboard()).resolves.toMatchObject({ payloadJson: "payload" });
  });

  it("同一项中的图片与文本都读取；空剪贴板返回空内容", async () => {
    const image = new Blob(["image"], { type: "image/png" });
    stubRead(() =>
      Promise.resolve([
        {
          types: ["image/png", "text/plain"],
          getType: (type) =>
            Promise.resolve(type === "image/png" ? image : textBlob("text")),
        },
      ]),
    );
    const content = await readSystemClipboard();
    expect(content?.text).toBe("text");
    expect(content?.imageFiles).toHaveLength(1);
    expect(content?.imageFiles[0].type).toBe("image/png");

    stubRead(() => Promise.resolve([]));
    await expect(readSystemClipboard()).resolves.toEqual({ imageFiles: [], text: "" });
  });

  it("read 被拒时降级 readText；两者都失败返回 null", async () => {
    stubRead(
      () => Promise.reject(new Error("denied")),
      () => Promise.resolve("fallback"),
    );
    await expect(readSystemClipboard()).resolves.toEqual({
      imageFiles: [],
      text: "fallback",
    });

    stubRead(
      () => Promise.reject(new Error("denied")),
      () => Promise.reject(new Error("denied")),
    );
    await expect(readSystemClipboard()).resolves.toBeNull();
  });
});
