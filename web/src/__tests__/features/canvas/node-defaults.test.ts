/**
 * duplicateNode 回归测试：副本不得继承「进行中」的瞬时状态。
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { createGroupNode, createImageNode, duplicateNode } from "@/features/canvas/node-defaults";
import type { GroupNode, ImageNode } from "@/features/canvas/types";

describe("duplicateNode", () => {
  it("清除生成中与上传中的瞬时状态，保留已完成的静态内容", () => {
    const node = createImageNode({ x: 0, y: 0 }, "/api/files/abc.png");
    node.data.taskBinding = { taskId: "task-1", status: "pending", startedAt: Date.now() };
    node.data.upload = { uploading: true, progress: 40, version: 1, previewUrl: "blob:preview" };

    const copy = duplicateNode(node, { x: 20, y: 20 }) as ImageNode;

    // 任务归属原节点：副本继承会永远停在「生成中」遮罩
    expect(copy.data.taskBinding).toBeUndefined();
    // upload.previewUrl 是 blob: URL，原节点上传结束后会被 revoke
    expect(copy.data.upload).toBeUndefined();
    // 已落定的内容必须保留
    expect(copy.data.src).toBe("/api/files/abc.png");
    expect(copy.data.genSettings).toBeDefined();
  });

  it("新副本有独立 id 与偏移位置，且不处于选中态", () => {
    const node = createImageNode({ x: 10, y: 10 });
    node.selected = true;

    const copy = duplicateNode(node, { x: 20, y: 30 });

    expect(copy.id).not.toBe(node.id);
    expect(copy.selected).toBe(false);
    expect(copy.position).toEqual({ x: 30, y: 40 });
  });

  it("上传失败的节点：保留失败原因，丢弃 blob 预览与进度", () => {
    const node = createImageNode({ x: 0, y: 0 });
    node.data.upload = {
      uploading: true,
      progress: 60,
      version: 1,
      previewUrl: "blob:preview",
      error: { category: "network" as const, message: "网络错误", retryable: true },
    };

    const copy = duplicateNode(node, { x: 0, y: 0 }) as ImageNode;

    expect(copy.data.upload?.error).toBeTruthy();
    expect(copy.data.upload?.previewUrl).toBeUndefined();
    expect(copy.data.upload?.uploading).toBe(false);
    expect(copy.data.upload?.progress).toBe(0);
  });

  it("组节点没有 taskBinding/upload 时复制仍然安全", () => {
    const group = createGroupNode({ x: 0, y: 0 }, { width: 200, height: 120 }, "我的组");

    const copy = duplicateNode(group, { x: 5, y: 5 }) as GroupNode;

    expect(copy.data.label).toBe("我的组");
    expect(copy.id).not.toBe(group.id);
    expect(copy.position).toEqual({ x: 5, y: 5 });
  });

  it("深拷贝：修改副本 data 不影响原节点", () => {
    const node = createImageNode({ x: 0, y: 0 }, "/a.png");
    const copy = duplicateNode(node, { x: 0, y: 0 }) as ImageNode;
    copy.data.src = "/b.png";
    expect(node.data.src).toBe("/a.png");
  });
});
