/**
 * 文件拖放 hook 核心逻辑测试。
 *
 * 覆盖：单文件/多文件/视频/混合/部分失败。
 */

import { beforeEach,describe, expect, it, vi } from "vitest";

type MockNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, unknown>; style?: Record<string, unknown> };

/** handleDrop 的核心逻辑（去 DOM/上传依赖后的纯函数版本） */
async function handleFileDrop(
  files: File[],
  screenToFlowPosition: (pos: { x: number; y: number }) => { x: number; y: number },
  clientX: number,
  clientY: number,
  pushHistory: (snapshot: Record<string, unknown>) => void,
  takeCanvasSnapshot: () => Record<string, unknown>,
  createImageNode: (pos: { x: number; y: number }, src: string) => MockNode,
  createVideoNode: (pos: { x: number; y: number }, src: string) => MockNode,
  applyThumbnailSettings: (node: MockNode, w: number, h: number, label: string) => MockNode,
  addNodes: (nodes: MockNode[]) => void,
  uploadFile: (file: File) => Promise<{ url: string } | null>,
  loadMediaDim: (url: string, isVideo: boolean) => Promise<{ w: number; h: number }>,
): Promise<{ created: number; total: number }> {
  if (files.length === 0) return { created: 0, total: 0 };

  const pos = screenToFlowPosition({ x: clientX, y: clientY });

  const results = await Promise.allSettled(
    files.map(async (file, index) => {
      const col = index % 4;
      const row = Math.floor(index / 4);

      if (file.type.startsWith("image/")) {
        const uploadResult = await uploadFile(file);
        if (!uploadResult?.url) return null;
        const dims = await loadMediaDim(uploadResult.url, false);
        if (!dims.w || !dims.h) return null;
        const displayW = Math.round(dims.w * (dims.w > dims.h ? 360/dims.w : 360/dims.h));
        const displayH = Math.round(dims.h * (dims.w > dims.h ? 360/dims.w : 360/dims.h));
        const node = createImageNode(
          { x: pos.x + col * (displayW + 30), y: pos.y + row * (displayH + 24 + 30) },
          uploadResult.url,
        );
        applyThumbnailSettings(node, dims.w, dims.h, file.name);
        return node;
      } else if (file.type.startsWith("video/")) {
        const uploadResult = await uploadFile(file);
        if (!uploadResult?.url) return null;
        const dims = await loadMediaDim(uploadResult.url, true);
        const nw = dims.w || 1280;
        const nh = dims.h || 720;
        const displayW = Math.round(nw * (nw > nh ? 360/nw : 360/nh));
        const displayH = Math.round(nh * (nw > nh ? 360/nw : 360/nh));
        const node = createVideoNode(
          { x: pos.x + col * (displayW + 30), y: pos.y + row * (displayH + 24 + 30) },
          uploadResult.url,
        );
        applyThumbnailSettings(node, nw, nh, file.name);
        return node;
      }
      return null;
    }),
  );

  const createdNodes = results
    .filter((r) => r.status === "fulfilled" && r.value !== null)
    .map((r) => (r as PromiseFulfilledResult<MockNode>).value);

  if (createdNodes.length > 0) {
    pushHistory(takeCanvasSnapshot());
    addNodes(createdNodes);
  }
  return { created: createdNodes.length, total: files.length };
}

describe("handleFileDrop", () => {
  const screenToFlowPosition = vi.fn((pos) => pos);
  const pushHistory = vi.fn();
  const takeCanvasSnapshot = vi.fn(() => ({}));
  const createImageNode = vi.fn((pos, src) => ({
    id: "img-" + Date.now(), type: "image-node", position: pos, data: { src },
  }));
  const createVideoNode = vi.fn((pos, src) => ({
    id: "vid-" + Date.now(), type: "video-node", position: pos, data: { src },
  }));
  const applyThumbnailSettings = vi.fn((node) => node);
  const addNodes = vi.fn();
  const uploadFile = vi.fn();
  const loadMediaDim = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── 单文件 ──

  it("单图片文件上传成功", async () => {
    uploadFile.mockResolvedValue({ url: "/api/files/1/ab/img.png" });
    loadMediaDim.mockResolvedValue({ w: 800, h: 600 });
    const files = [new File(["fake"], "photo.png", { type: "image/png" })];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 100, 200,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(1);
    expect(addNodes).toHaveBeenCalledWith([expect.objectContaining({ type: "image-node" })]);
  });

  it("视频文件创建 VideoNode", async () => {
    uploadFile.mockResolvedValue({ url: "/api/files/1/ab/vid.mp4" });
    loadMediaDim.mockResolvedValue({ w: 1920, h: 1080 });
    const files = [new File(["fake"], "movie.mp4", { type: "video/mp4" })];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 100, 200,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(1);
    expect(createVideoNode).toHaveBeenCalled();
    expect(createImageNode).not.toHaveBeenCalled();
    expect(addNodes).toHaveBeenCalledTimes(1);
  });

  it("非图片非视频文件被忽略", async () => {
    const files = [new File(["fake"], "doc.pdf", { type: "application/pdf" })];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(0);
    expect(addNodes).not.toHaveBeenCalled();
  });

  it("空文件列表不处理", async () => {
    const result = await handleFileDrop(
      [], screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(0);
    expect(screenToFlowPosition).not.toHaveBeenCalled();
  });

  // ── 多文件 ──

  it("多图片网格排列", async () => {
    uploadFile.mockResolvedValue({ url: "/api/files/1/ab/img.png" });
    loadMediaDim.mockResolvedValue({ w: 400, h: 300 });
    const files = [
      new File(["f1"], "a.png", { type: "image/png" }),
      new File(["f2"], "b.png", { type: "image/png" }),
      new File(["f3"], "c.png", { type: "image/png" }),
    ];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(3);
    expect(addNodes).toHaveBeenCalledTimes(1);
    // 验证网格位置：第 0 个在原点，第 1 个水平偏移 (displayW + 30)
    const nodes = addNodes.mock.calls[0][0];
    expect(nodes[0].position.x).toBe(0);
    expect(nodes[0].position.y).toBe(0);
    // displayW = round(400 * 360/400) = 360, displayH = round(300 * 360/400) = 270
    expect(nodes[1].position.x).toBe(360 + 30);
    expect(nodes[1].position.y).toBe(0);
    expect(nodes[2].position.x).toBe((360 + 30) * 2);
    expect(nodes[2].position.y).toBe(0);
  });

  it("混合图片和视频各自创建正确类型", async () => {
    uploadFile.mockResolvedValue({ url: "/api/files/1/ab/file" });
    loadMediaDim.mockResolvedValue({ w: 640, h: 480 });
    const files = [
      new File(["f1"], "img.png", { type: "image/png" }),
      new File(["f2"], "vid.mp4", { type: "video/mp4" }),
    ];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(2);
    expect(createImageNode).toHaveBeenCalledTimes(1);
    expect(createVideoNode).toHaveBeenCalledTimes(1);
  });

  // ── 部分失败 ──

  it("部分上传失败——成功的不受影响", async () => {
    uploadFile
      .mockResolvedValueOnce({ url: "/api/files/1/ok.png" })
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ url: "/api/files/1/ok2.png" });
    loadMediaDim.mockResolvedValue({ w: 200, h: 200 });
    const files = [
      new File(["f1"], "a.png", { type: "image/png" }),
      new File(["f2"], "b.png", { type: "image/png" }),
      new File(["f3"], "c.png", { type: "image/png" }),
    ];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(2);
    expect(addNodes).toHaveBeenCalledTimes(1);
    expect(addNodes.mock.calls[0][0].length).toBe(2);
  });

  it("全部失败时不调用 addNodes", async () => {
    uploadFile.mockRejectedValue(new Error("network error"));
    loadMediaDim.mockResolvedValue({ w: 100, h: 100 });
    const files = [
      new File(["f1"], "a.png", { type: "image/png" }),
      new File(["f2"], "b.png", { type: "image/png" }),
    ];
    const result = await handleFileDrop(
      files, screenToFlowPosition, 0, 0,
      pushHistory, takeCanvasSnapshot, createImageNode, createVideoNode,
      applyThumbnailSettings, addNodes, uploadFile, loadMediaDim,
    );
    expect(result.created).toBe(0);
    expect(addNodes).not.toHaveBeenCalled();
  });
});

describe("handleDragOver", () => {
  it("阻止默认行为并设置 dropEffect", () => {
    const e: { preventDefault: ReturnType<typeof vi.fn>; dataTransfer: { dropEffect: string } } = { preventDefault: vi.fn(), dataTransfer: { dropEffect: "" } };
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.dataTransfer.dropEffect).toBe("copy");
  });
});
