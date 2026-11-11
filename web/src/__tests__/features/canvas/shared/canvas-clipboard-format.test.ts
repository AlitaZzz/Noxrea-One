import { describe, expect, it } from "vitest";

import {
  buildCanvasClipboardHtml,
  CANVAS_CLIPBOARD_HTML_ATTR,
  CANVAS_CLIPBOARD_KIND,
  CANVAS_CLIPBOARD_MAX_BYTES,
  CANVAS_CLIPBOARD_MAX_EDGES,
  CANVAS_CLIPBOARD_MAX_NODES,
  CANVAS_CLIPBOARD_MIME,
  CANVAS_CLIPBOARD_VERSION,
  CANVAS_CLIPBOARD_WEB_MIME,
  type CanvasClipboardNode,
  type CanvasClipboardPayload,
  createCanvasClipboardPayload,
  encodeCanvasClipboardPayload,
  getUtf8ByteLength,
  parseCanvasClipboard,
  sanitizeEdgeForClipboard,
  sanitizeNodeForClipboard,
  textOnlyPlainText,
} from "@/features/canvas/shared/canvas-clipboard-format";
import type { AnyEdge, AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";

function textNode(
  id: string,
  plainText = id,
  extra: Record<string, unknown> = {},
): AnyNode {
  return {
    id,
    type: NODE_TYPE.TEXT,
    position: { x: 0, y: 0 },
    data: { label: id, content: `<p>${plainText}</p>`, plainText, ...extra },
  } as AnyNode;
}

function imageNode(
  id: string,
  extra: Record<string, unknown> = {},
): AnyNode {
  return {
    id,
    type: NODE_TYPE.IMAGE,
    position: { x: 0, y: 0 },
    data: {
      label: id,
      src: "uploads/a.png",
      lockAspectRatio: true,
      naturalWidth: 100,
      naturalHeight: 80,
      ...extra,
    },
  } as AnyNode;
}

function videoNode(id: string): AnyNode {
  return {
    id,
    type: NODE_TYPE.VIDEO,
    position: { x: 0, y: 0 },
    data: { label: id, src: "uploads/v.mp4", naturalWidth: 320, naturalHeight: 180 },
  } as AnyNode;
}

function audioNode(id: string): AnyNode {
  return {
    id,
    type: NODE_TYPE.AUDIO,
    position: { x: 0, y: 0 },
    data: { label: id, src: "uploads/a.mp3" },
  } as AnyNode;
}

function directorNode(id: string): AnyNode {
  return {
    id,
    type: NODE_TYPE.DIRECTOR,
    position: { x: 0, y: 0 },
    data: { label: id, directorState: { shots: [{ id: "s1" }] } },
  } as AnyNode;
}

function groupNode(id: string, extra: Record<string, unknown> = {}): AnyNode {
  return {
    id,
    type: NODE_TYPE.GROUP,
    position: { x: 0, y: 0 },
    data: { label: id, ...extra },
    style: { width: 400, height: 300 },
  } as AnyNode;
}

function edge(id: string, source: string, target: string): AnyEdge {
  return { id, source, target } as AnyEdge;
}

function validPayload(
  overrides: Partial<CanvasClipboardPayload> = {},
): CanvasClipboardPayload {
  return {
    kind: CANVAS_CLIPBOARD_KIND,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: [sanitizeNodeForClipboard(textNode("text"))],
    edges: [],
    ...overrides,
  };
}

function parse(payload: unknown) {
  return parseCanvasClipboard(JSON.stringify(payload));
}

describe("格式常量", () => {
  it("使用 Noxrea 独立命名，不复用即梦的格式名", () => {
    expect(CANVAS_CLIPBOARD_MIME).toBe("application/vnd.noxrea.canvas-selection+json");
    expect(CANVAS_CLIPBOARD_WEB_MIME).toBe(`web ${CANVAS_CLIPBOARD_MIME}`);
    expect(CANVAS_CLIPBOARD_KIND).toBe("noxrea.canvas-selection");
    expect(CANVAS_CLIPBOARD_VERSION).toBe(1);
    expect(CANVAS_CLIPBOARD_HTML_ATTR).toBe("data-noxrea-canvas-selection");
    expect(CANVAS_CLIPBOARD_KIND).not.toContain("dreamina");
    expect(CANVAS_CLIPBOARD_KIND).not.toContain("octo");
  });
});

describe("sanitizeNodeForClipboard", () => {
  it("只保留可迁移顶层字段，剥离运行时状态与瞬时数据", () => {
    const source = {
      ...imageNode("img", {
        taskBinding: { taskId: "task-1", status: "pending" },
        upload: { uploading: true, previewUrl: "blob:http://x/1" },
        rotation: 90,
        flipH: true,
        flipV: false,
        genSettings: { kind: "image", prompt: "p", modelKey: "m", refOrder: ["a"] },
        multiResultKeys: ["uploads/1.png", "uploads/2.png"],
        pendingNaturalSize: { width: 100, height: 80 },
        source: "generate",
      }),
      selected: true,
      measured: { width: 320, height: 240 },
      positionAbsolute: { x: 1, y: 2 },
      internals: { positionAbsolute: { x: 1, y: 2 } },
      width: 320,
      height: 240,
      zIndex: 4,
      hidden: false,
      className: "x",
      parentId: "g1",
      style: { width: 320, height: 240, minWidth: 10 },
    } as unknown as AnyNode;

    const sanitized = sanitizeNodeForClipboard(source);

    expect(Object.keys(sanitized).sort()).toEqual([
      "data",
      "id",
      "parentId",
      "position",
      "style",
      "type",
    ]);
    expect(sanitized.style).toEqual({ width: 320, height: 240 });
    expect(sanitized.data).not.toHaveProperty("taskBinding");
    expect(sanitized.data).not.toHaveProperty("upload");
    expect(sanitized.data).not.toHaveProperty("rotation");
    expect(sanitized.data).not.toHaveProperty("flipH");
    expect(sanitized.data).not.toHaveProperty("flipV");
    expect(sanitized.data.genSettings).toEqual({
      kind: "image",
      prompt: "p",
      modelKey: "m",
      refOrder: ["a"],
    });
    expect(sanitized.data.multiResultKeys).toEqual(["uploads/1.png", "uploads/2.png"]);
    expect(sanitized.data.pendingNaturalSize).toEqual({ width: 100, height: 80 });
    expect(sanitized.parentId).toBe("g1");
  });

  it("上传失败原因与上传中状态一样整体剥离，已落定 src 保留", () => {
    const source = imageNode("img", {
      src: "/api/files/old.png",
      upload: {
        uploading: false,
        version: 1,
        previewUrl: "blob:http://x/1",
        error: { category: "network", message: "网络错误", retryable: true },
      },
    });

    const sanitized = sanitizeNodeForClipboard(source);

    expect(sanitized.data).not.toHaveProperty("upload");
    expect(sanitized.data.src).toBe("/api/files/old.png");
  });

  it("data 是深拷贝，不共享 store 内嵌套引用", () => {
    const source = textNode("text", "hello", { genSettings: { refOrder: ["a"] } });
    const sanitized = sanitizeNodeForClipboard(source);
    (sanitized.data.genSettings as { refOrder: string[] }).refOrder.push("b");
    expect((source.data as { genSettings: { refOrder: string[] } }).genSettings.refOrder).toEqual(["a"]);
  });

  it("组节点不携带 parentId，无效尺寸不进入 style", () => {
    const sanitized = sanitizeNodeForClipboard({
      ...groupNode("group"),
      parentId: "outer",
      style: { width: 0, height: Number.NaN },
    } as AnyNode);
    expect(sanitized.parentId).toBeUndefined();
    expect(sanitized.style).toBeUndefined();
  });
});

describe("createCanvasClipboardPayload", () => {
  it("系统载荷只保留两端在节点集内且符合连接规则的内部连线", () => {
    const nodes = [
      sanitizeNodeForClipboard(textNode("a")),
      sanitizeNodeForClipboard(textNode("b")),
      sanitizeNodeForClipboard(imageNode("imgUpload", { source: "upload" })),
      sanitizeNodeForClipboard(groupNode("group")),
    ];
    const edges = [
      edge("e1", "a", "b"),
      edge("e2", "a", "a"),
      edge("e3", "a", "group"),
      edge("e4", "outside", "a"),
      edge("e5", "a", "b"),
      edge("e6", "a", "imgUpload"),
      edge("e7", "b", "a"),
    ].map(sanitizeEdgeForClipboard);

    const payload = createCanvasClipboardPayload(nodes, edges);

    expect(payload.kind).toBe(CANVAS_CLIPBOARD_KIND);
    expect(payload.version).toBe(CANVAS_CLIPBOARD_VERSION);
    expect(payload.edges.map((edge) => edge.id)).toEqual(["e1", "e7"]);
    expect(payload.nodes).toBe(nodes);
  });
});

describe("textOnlyPlainText", () => {
  it("纯文本选择按节点顺序以空行连接", () => {
    const nodes = [
      sanitizeNodeForClipboard(textNode("a", "第一段")),
      sanitizeNodeForClipboard(textNode("b", "第二段")),
    ];
    expect(textOnlyPlainText(nodes)).toBe("第一段\n\n第二段");
  });

  it("混合选择与非空白文本才写 text/plain", () => {
    const mixed = [
      sanitizeNodeForClipboard(textNode("a", "文字")),
      sanitizeNodeForClipboard(imageNode("img")),
    ];
    expect(textOnlyPlainText(mixed)).toBeUndefined();
    expect(textOnlyPlainText([sanitizeNodeForClipboard(textNode("empty", "   "))])).toBeUndefined();
  });
});

describe("buildCanvasClipboardHtml", () => {
  it("属性内是转义 JSON，可见文本只含 plainText", () => {
    const payload = validPayload({
      nodes: [sanitizeNodeForClipboard(textNode("text", "a < b & c"))],
    });
    const html = buildCanvasClipboardHtml(payload, "a < b & c");

    expect(html.startsWith(`<span ${CANVAS_CLIPBOARD_HTML_ATTR}="`)).toBe(true);
    expect(html).toContain("a &lt; b &amp; c");
    expect(html).toContain("&quot;kind&quot;");
    // 属性值之外不出现可读 JSON（所有引号都已转义）
    expect(html.slice(html.indexOf(">") + 1)).not.toContain("noxrea.canvas-selection");
  });

  it("非文本选择为空 span，不泄露任何可见 JSON", () => {
    const payload = validPayload({ nodes: [sanitizeNodeForClipboard(imageNode("img"))] });
    const html = buildCanvasClipboardHtml(payload);
    expect(html.slice(html.indexOf(">") + 1)).toBe("</span>");
  });
});

describe("getUtf8ByteLength", () => {
  it("按 UTF-8 计算，ASCII 与多字节字符一致", () => {
    expect(getUtf8ByteLength("abc")).toBe(3);
    expect(getUtf8ByteLength("中文")).toBe(6);
    expect(getUtf8ByteLength("😀")).toBe(4);
  });
});

describe("parseCanvasClipboard：往返", () => {
  it("六类节点与可选内容字段完整往返", () => {
    const nodes: CanvasClipboardNode[] = [
      sanitizeNodeForClipboard(textNode("text", "hello", {
        genSettings: { kind: "text", prompt: "p", modelKey: "m", refOrder: [], refAudioOrder: ["a"], refVideoOrder: ["v"] },
        createdAt: 1,
      })),
      sanitizeNodeForClipboard(imageNode("img", {
        genSettings: { kind: "image", prompt: "p", modelKey: "m", refOrder: ["r"] },
        multiResultKeys: ["uploads/1.png", "uploads/2.png"],
        multiResultTotalCount: 2,
        source: "generate",
        pendingNaturalSize: { width: 100, height: 80 },
        fileSize: 1234,
        createdAt: 2,
      })),
      sanitizeNodeForClipboard({
        ...videoNode("video"),
        data: { ...videoNode("video").data, duration: 12.5, hasAudio: true, source: "generate", fileSize: 999 },
      } as AnyNode),
      sanitizeNodeForClipboard({
        ...audioNode("audio"),
        data: { ...audioNode("audio").data, duration: 3.2 },
      } as AnyNode),
      sanitizeNodeForClipboard(directorNode("director")),
      sanitizeNodeForClipboard(groupNode("group", { color: "blue" })),
      sanitizeNodeForClipboard({
        ...textNode("member", "member"),
        parentId: "group",
      } as AnyNode),
    ];
    const edges = [
      sanitizeEdgeForClipboard(edge("e1", "text", "img")),
      sanitizeEdgeForClipboard(edge("e2", "img", "text2")),
    ];
    // text2 不在节点集内，e2 会被载荷构建器剔除
    const payload = createCanvasClipboardPayload(nodes, edges);
    payload.edges.push({ id: "e3", source: "img", target: "video" });
    // 手工加入的 e3 也必须符合规则：image → video 合法

    const parsed = parseCanvasClipboard(encodeCanvasClipboardPayload(payload));
    if (!parsed.ok) throw new Error(`unexpected parse failure: ${parsed.reason}`);
    expect(parsed.ok).toBe(true);
    expect(parsed.payload.nodes).toEqual(payload.nodes);
    expect(parsed.payload.edges).toEqual([
      { id: "e1", source: "text", target: "img" },
      { id: "e3", source: "img", target: "video" },
    ]);
  });

  it("导入时剥离 taskBinding / upload / rotation / flipH / flipV", () => {
    const node = sanitizeNodeForClipboard(imageNode("img"));
    node.data = {
      ...node.data,
      taskBinding: { taskId: "t" },
      upload: { uploading: true },
      rotation: 90,
      flipH: true,
      flipV: true,
    };
    const parsed = parse(validPayload({ nodes: [node] }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.payload.nodes[0].data).not.toHaveProperty("taskBinding");
    expect(parsed.payload.nodes[0].data).not.toHaveProperty("upload");
    expect(parsed.payload.nodes[0].data).not.toHaveProperty("rotation");
    expect(parsed.payload.nodes[0].data).not.toHaveProperty("flipH");
    expect(parsed.payload.nodes[0].data).not.toHaveProperty("flipV");
  });
});

describe("parseCanvasClipboard：整包拒绝", () => {
  it("空串 / 非法 JSON / 非对象", () => {
    expect(parseCanvasClipboard("")).toEqual({ ok: false, reason: "empty" });
    expect(parseCanvasClipboard("{")).toEqual({ ok: false, reason: "malformed" });
    expect(parse(null)).toEqual({ ok: false, reason: "shape" });
    expect(parse(1)).toEqual({ ok: false, reason: "shape" });
    expect(parse("text")).toEqual({ ok: false, reason: "shape" });
    expect(parse([])).toEqual({ ok: false, reason: "shape" });
  });

  it("kind / version / 形状错误", () => {
    expect(parse({ ...validPayload(), kind: "other" })).toEqual({ ok: false, reason: "kind" });
    expect(parse({ ...validPayload(), version: 2 })).toEqual({ ok: false, reason: "version" });
    expect(parse({ ...validPayload(), nodes: null })).toEqual({ ok: false, reason: "shape" });
    expect(parse({ ...validPayload(), edges: null })).toEqual({ ok: false, reason: "shape" });
  });

  it("节点为空或超过数量上限", () => {
    expect(parse(validPayload({ nodes: [] }))).toEqual({ ok: false, reason: "limit" });
    expect(
      parse({
        ...validPayload(),
        nodes: new Array(CANVAS_CLIPBOARD_MAX_NODES + 1).fill(null),
      }),
    ).toEqual({ ok: false, reason: "limit" });
    expect(
      parse({
        ...validPayload(),
        edges: new Array(CANVAS_CLIPBOARD_MAX_EDGES + 1).fill(null),
      }),
    ).toEqual({ ok: false, reason: "limit" });
  });

  it("超过 UTF-8 字节上限", () => {
    const payload = validPayload();
    payload.nodes[0].data.big = "x".repeat(CANVAS_CLIPBOARD_MAX_BYTES);
    expect(parse(payload)).toEqual({ ok: false, reason: "too-large" });
  });

  it.each([
    { name: "重复节点 id", reason: "nodes", nodes: [textNode("text"), textNode("text")] },
    { name: "未知节点类型", reason: "nodes", nodes: [{ ...textNode("text"), type: "unknown-node" }] },
    { name: "非有限坐标", reason: "nodes", nodes: [{ ...textNode("text"), position: { x: Number.POSITIVE_INFINITY, y: 0 } }] },
    { name: "缺失坐标", reason: "nodes", nodes: [{ ...textNode("text"), position: {} }] },
    { name: "数据非对象", reason: "nodes", nodes: [{ ...textNode("text"), data: [] }] },
    { name: "标题不是字符串", reason: "nodes", nodes: [{ ...textNode("text"), data: { label: 1, content: "", plainText: "" } }] },
    { name: "文本节点缺 plainText", reason: "nodes", nodes: [{ ...textNode("text"), data: { label: "x", content: "" } }] },
    { name: "图片节点缺 lockAspectRatio", reason: "nodes", nodes: [imageNode("img", { lockAspectRatio: undefined })] },
    { name: "图片节点缺自然尺寸", reason: "nodes", nodes: [imageNode("img", { naturalWidth: undefined })] },
    { name: "视觉节点 src 不是字符串", reason: "nodes", nodes: [{ ...audioNode("audio"), data: { label: "audio", src: 1 } }] },
    { name: "blob: 引用", reason: "nodes", nodes: [imageNode("img", { src: "blob:http://localhost/1" })] },
    { name: "javascript: 引用", reason: "nodes", nodes: [imageNode("img", { src: " javascript:alert(1)" })] },
    { name: "multiResultKeys 含 blob", reason: "nodes", nodes: [imageNode("img", { multiResultKeys: ["blob:http://localhost/1"] })] },
    { name: "非正尺寸 style", reason: "nodes", nodes: [{ ...textNode("text"), style: { width: 0, height: 10 } }] },
    { name: "style 缺高度", reason: "nodes", nodes: [{ ...textNode("text"), style: { width: 10 } }] },
    { name: "组带 parentId", reason: "nodes", nodes: [{ ...groupNode("group"), parentId: "outer" }] },
    { name: "父节点不存在", reason: "groups", nodes: [{ ...textNode("member"), parentId: "missing" }] },
    { name: "父节点不是组", reason: "groups", nodes: [{ ...textNode("parent"), type: NODE_TYPE.IMAGE, data: imageNode("parent").data }, { ...textNode("member"), parentId: "parent" }] },
    { name: "空组", reason: "groups", nodes: [groupNode("group")] },
  ])("拒绝非法节点：$name", ({ nodes, reason }) => {
    expect(parse(validPayload({ nodes: nodes as CanvasClipboardNode[], edges: [] }))).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    { name: "自连", edges: [edge("e", "a", "a")] },
    { name: "悬空端点", edges: [edge("e", "a", "missing")] },
    { name: "组端点", edges: [edge("e", "a", "group")], nodes: [textNode("a"), groupNode("group"), { ...textNode("m"), parentId: "group" }] },
    { name: "重复连线 id", edges: [edge("e", "a", "b"), edge("e", "b", "a")] },
    { name: "重复有序端点", edges: [edge("e1", "a", "b"), edge("e2", "a", "b")] },
    { name: "连接规则不满足", edges: [edge("e", "video", "img")], nodes: [videoNode("video"), imageNode("img")] },
    { name: "上传素材作为目标", edges: [edge("e", "a", "imgUpload")], nodes: [textNode("a"), imageNode("imgUpload", { source: "upload" })] },
  ])("拒绝非法连线：$name", ({ edges, nodes }) => {
    const payloadNodes = (nodes ?? [textNode("a"), textNode("b")]).map(sanitizeNodeForClipboard);
    // 组节点必须有成员：由用例自身保证
    expect(
      parse(validPayload({ nodes: payloadNodes, edges: edges.map(sanitizeEdgeForClipboard) })),
    ).toEqual({ ok: false, reason: "edges" });
  });
});
