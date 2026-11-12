// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { nodeViewProps } from "@/__tests__/test-utils/canvas-node";
import GroupNode from "@/features/canvas/nodes/GroupNode";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/ui/AppIcon", () => ({
  GroupIcon: () => null,
}));

vi.mock("@/features/canvas/shared/canvas-derived", () => ({
  getGroupMembership: () => ({
    membersByGroup: new Map([
      ["group-1", [{ position: { x: 40, y: 40 }, style: { width: 100, height: 60 } }]],
    ]),
  }),
}));

vi.mock("@/features/canvas/stores/canvas-store", () => ({
  useCanvasStore: (selector: (state: unknown) => unknown) =>
    selector({ agentPreviewNodeIds: [], dragOverGroupId: null, nodes: [] }),
}));

vi.mock("@/features/canvas/controls/GroupConnectRail", () => ({ default: () => null }));
vi.mock("@/features/canvas/nodes/AgentGhostOverlay", () => ({ default: () => null }));
vi.mock("@/features/canvas/nodes/SelectionResizeHandle", () => ({ default: () => null }));

vi.mock("@/features/canvas/nodes/NodeTitle", async () => {
  const React = await import("react");
  return {
    default: ({ className }: { className?: string }) =>
      React.createElement("div", { "data-testid": "node-title", className }),
  };
});

/**
 * 组可见框回归：组标题是框外标签，body 只占标题栏以下的剩余高度（flex-1）。
 * 框选外框通过四边 40px 内边距与组 body 对齐；若把 body 改成
 * absolute inset-0，标题会被并入组的可见框，框选/编组两框虽然等高但语义错误。
 */
function renderGroup(color: string) {
  const props = nodeViewProps<typeof GroupNode>("group-1", "group-node", {
    label: "",
    color,
  });
  return render(<GroupNode {...props} />);
}

describe("GroupNode 可见框", () => {
  afterEach(cleanup);

  it("body 只占标题栏以下，标题留在框外", () => {
    const { container } = renderGroup("default");

    const body = container.querySelector(".node-body");
    const title = container.querySelector('[data-testid="node-title"]');

    expect(body).not.toBeNull();
    expect(body).toHaveClass("flex-1");
    expect(body).not.toHaveClass("absolute");
    expect(title).not.toHaveClass("z-10");
    expect(title?.nextElementSibling).toBe(body);
  });
});

/** 组表面必须不透明：画布点阵与下层内容不得透出（对齐即梦组节点表面）。 */
describe("GroupNode 表面", () => {
  afterEach(cleanup);

  it("默认配色使用不透明组底色", () => {
    const { container } = renderGroup("default");
    const body = container.querySelector<HTMLElement>(".node-body");

    expect(body).toHaveClass("canvas-group-surface");
    expect(body?.style.getPropertyValue("--group-surface")).toBe("var(--canvas-group-bg)");
    // 背景由 CSS 读取 --group-surface；内联 background 会盖住拖线降透明规则
    expect(body?.style.background).toBe("");
  });

  it("彩色配色在组底色上叠 16% 色相", () => {
    const { container } = renderGroup("blue");
    const body = container.querySelector<HTMLElement>(".node-body");

    expect(body?.style.getPropertyValue("--group-surface")).toBe(
      "color-mix(in srgb, #1677ff 16%, var(--canvas-group-bg))"
    );
  });
});
