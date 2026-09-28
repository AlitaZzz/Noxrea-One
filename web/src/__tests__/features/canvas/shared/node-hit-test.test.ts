import { describe, expect, it } from "vitest";

import { findNodeAtFlowPoint, getNodeBox, nodeEdgeAnchor } from "@/features/canvas/shared/node-hit-test";
import type { AnyNode } from "@/features/canvas/types";

/** 构造仅含命中测试所需字段（id / position / style 尺寸）的最小节点 */
function makeNode(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number
): AnyNode {
  return {
    id,
    type: "text",
    position: { x, y },
    style: { width, height },
    data: {},
  } as unknown as AnyNode;
}

describe("getNodeBox", () => {
  it("取 style 声明的盒尺寸", () => {
    const box = getNodeBox(makeNode("a", 10, 20, 100, 50));
    expect(box).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it("未声明数值尺寸的节点不参与命中", () => {
    const noSize = { id: "b", type: "text", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
    expect(getNodeBox(noSize)).toBeNull();
  });

  it("style 未声明尺寸时兜底 xyflow 实测尺寸（上传媒体加载窗口期）", () => {
    const measuring = {
      id: "m",
      type: "image-node",
      position: { x: 5, y: 8 },
      measured: { width: 320, height: 180 },
      data: {},
    } as unknown as AnyNode;
    expect(getNodeBox(measuring)).toEqual({ x: 5, y: 8, width: 320, height: 180 });
    expect(findNodeAtFlowPoint([measuring], { x: 100, y: 90 })?.id).toBe("m");
  });
});

describe("nodeEdgeAnchor", () => {
  it("左/右锚点为该侧边缘垂直正中（与已建立连线锚点口径一致）", () => {
    const n = makeNode("a", 10, 20, 100, 50);
    expect(nodeEdgeAnchor(n, "left")).toEqual({ x: 10, y: 45 });
    expect(nodeEdgeAnchor(n, "right")).toEqual({ x: 110, y: 45 });
  });

  it("无有效盒尺寸（未渲染）返回 null", () => {
    const noSize = { id: "b", type: "text", position: { x: 0, y: 0 }, data: {} } as unknown as AnyNode;
    expect(nodeEdgeAnchor(noSize, "right")).toBeNull();
  });
});

describe("findNodeAtFlowPoint", () => {
  it("返回包含落点的节点，含边界", () => {
    const nodes = [makeNode("a", 0, 0, 100, 50)];
    expect(findNodeAtFlowPoint(nodes, { x: 50, y: 25 })?.id).toBe("a");
    expect(findNodeAtFlowPoint(nodes, { x: 100, y: 50 })?.id).toBe("a");
    expect(findNodeAtFlowPoint(nodes, { x: 101, y: 25 })).toBeNull();
  });

  it("重叠时数组靠后的节点绘制在上层、优先命中", () => {
    const nodes = [
      makeNode("bottom", 0, 0, 200, 200),
      makeNode("top", 50, 50, 100, 100),
    ];
    expect(findNodeAtFlowPoint(nodes, { x: 60, y: 60 })?.id).toBe("top");
    // 仅下层覆盖的区域仍命中下层
    expect(findNodeAtFlowPoint(nodes, { x: 10, y: 10 })?.id).toBe("bottom");
  });

  it("发起端节点不排除——自连由调用方判定（与拖拽反馈口径一致）", () => {
    const nodes = [makeNode("self", 0, 0, 100, 100)];
    expect(findNodeAtFlowPoint(nodes, { x: 50, y: 50 })?.id).toBe("self");
  });

  it("组节点不参与命中：组内空白视为画布空白，组内子节点正常命中", () => {
    const group = {
      id: "g",
      type: "group-node",
      position: { x: 0, y: 0 },
      style: { width: 500, height: 400 },
      data: {},
    } as unknown as AnyNode;
    const child = makeNode("child", 30, 30, 100, 60);
    // 组在数组靠后（后创建），若不跳过会先于子节点命中
    const nodes = [child, group];
    expect(findNodeAtFlowPoint(nodes, { x: 60, y: 60 })?.id).toBe("child");
    expect(findNodeAtFlowPoint(nodes, { x: 400, y: 300 })).toBeNull();
  });
});
