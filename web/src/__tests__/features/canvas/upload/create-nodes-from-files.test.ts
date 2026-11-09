/**
 * createNodesFromFiles：本地文件 → 画布节点的落位与上传入口。
 *
 * 覆盖网格排布（实际尺寸、第 4 列换行）、音频/不支持类型的透传、
 * 空列表与离线时不探测尺寸。上传本身由 upload-pipeline 的测试覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIO_NODE_HEIGHT, AUDIO_NODE_WIDTH, LAYOUT_GAP } from "@/lib/constants";

const mocks = vi.hoisted(() => ({
  detectMediaKind: vi.fn(),
  runMediaUpload: vi.fn(),
  loadMediaDimensions: vi.fn(),
  computeNodeSize: vi.fn(),
  isOffline: vi.fn(),
}));

vi.mock("@/features/canvas/upload/upload-pipeline", () => ({
  detectMediaKind: mocks.detectMediaKind,
  runMediaUpload: mocks.runMediaUpload,
}));
vi.mock("@/lib/utils/image-utils", () => ({
  loadMediaDimensions: mocks.loadMediaDimensions,
  computeNodeSize: mocks.computeNodeSize,
}));
vi.mock("@/lib/utils/upload", () => ({
  isOffline: mocks.isOffline,
}));

import { createNodesFromFiles } from "@/features/canvas/upload/create-nodes-from-files";

const createObjectURL = vi.fn(() => "blob:preview");

type UploadItemLike = {
  filename: string;
  nodeType?: string;
  naturalWidth?: number;
  naturalHeight?: number;
  previewUrl?: string;
  position?: { x: number; y: number };
};

function file(name: string, type = "image/png"): File {
  return new File(["x"], name, { type });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("URL", { createObjectURL });
  mocks.isOffline.mockReturnValue(false);
  mocks.runMediaUpload.mockResolvedValue(undefined);
  mocks.computeNodeSize.mockReturnValue({ width: 360, height: 270 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createNodesFromFiles", () => {
  it("按实际尺寸做网格排布，第 4 列换行", async () => {
    mocks.detectMediaKind.mockReturnValue("image");
    mocks.loadMediaDimensions.mockResolvedValue({ w: 800, h: 600 });

    const files = Array.from({ length: 5 }, (_, i) => file(`p${i}.png`));
    await createNodesFromFiles(files, { x: 10, y: 20 });

    expect(mocks.runMediaUpload).toHaveBeenCalledTimes(1);
    const { items, sink } = mocks.runMediaUpload.mock.calls[0]![0] as {
      items: UploadItemLike[];
      sink: unknown;
    };
    expect(sink).toEqual({ kind: "create-node" });
    expect(items.map((item) => item.position)).toEqual([
      { x: 10, y: 20 },
      { x: 10 + 360 + LAYOUT_GAP, y: 20 },
      { x: 10 + 2 * (360 + LAYOUT_GAP), y: 20 },
      { x: 10 + 3 * (360 + LAYOUT_GAP), y: 20 },
      { x: 10, y: 20 + 270 + LAYOUT_GAP },
    ]);
    expect(items[0]).toMatchObject({
      filename: "p0.png",
      nodeType: "image",
      naturalWidth: 800,
      naturalHeight: 600,
      previewUrl: "blob:preview",
    });
    expect(mocks.loadMediaDimensions).toHaveBeenCalledTimes(5);
  });

  it("音频使用固定尺寸，不支持的类型原样透传且不推进游标", async () => {
    mocks.detectMediaKind.mockImplementation((_file: File, name: string) =>
      name.endsWith(".mp3") ? "audio" : null,
    );

    const files = [file("a.mp3", "audio/mpeg"), file("doc.pdf", "application/pdf")];
    await createNodesFromFiles(files, { x: 10, y: 20 });

    const { items } = mocks.runMediaUpload.mock.calls[0]![0] as { items: UploadItemLike[] };
    expect(items[0]).toMatchObject({
      filename: "a.mp3",
      nodeType: "audio",
      naturalWidth: 0,
      naturalHeight: 0,
      position: { x: 10, y: 20 },
    });
    expect(items[0]!.previewUrl).toBeUndefined();
    expect(items[1]).toEqual({ blob: expect.any(File), filename: "doc.pdf" });
    expect(mocks.loadMediaDimensions).not.toHaveBeenCalled();
    expect(AUDIO_NODE_WIDTH).toBeGreaterThan(0);
    expect(AUDIO_NODE_HEIGHT).toBeGreaterThan(0);
  });

  it("空列表不调用上传管道", async () => {
    await createNodesFromFiles([], { x: 0, y: 0 });
    expect(mocks.runMediaUpload).not.toHaveBeenCalled();
  });

  it("离线时不创建预览 URL、不探测尺寸，仍交给管道按离线语义处理", async () => {
    mocks.isOffline.mockReturnValue(true);
    mocks.detectMediaKind.mockReturnValue("image");

    await createNodesFromFiles([file("a.png")], { x: 10, y: 20 });

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(mocks.loadMediaDimensions).not.toHaveBeenCalled();
    const { items } = mocks.runMediaUpload.mock.calls[0]![0] as { items: UploadItemLike[] };
    expect(items[0]).toMatchObject({ nodeType: "image", naturalWidth: 0, naturalHeight: 0 });
    expect(items[0]!.previewUrl).toBeUndefined();
  });
});
