// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReferenceItem } from "@/features/canvas/shared/reference";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

vi.mock("@/lib/api/client", () => ({ api: vi.fn() }));

vi.mock("@/features/canvas/shared/MentionDropdown", () => ({
  default: () => <div data-testid="mention-dropdown" />,
}));

// chip 是 React NodeView：保留 ReactRenderer 路径（flushSync 触发的来源），
// 只替换渲染内容，避免拖入媒体与预设目录依赖。
vi.mock("@/features/canvas/shared/MentionChip", async () => {
  const { NodeViewWrapper } = await import("@tiptap/react");
  return {
    default: ({ node }: { node: { attrs: { kind: string; src: string } } }) => (
      <NodeViewWrapper as="span" data-testid="chip" data-src={node.attrs.src}>
        {node.attrs.kind}
      </NodeViewWrapper>
    ),
  };
});

import MentionPrompt from "@/features/canvas/shared/MentionPrompt";

// jsdom 未实现 Range 几何测量；ProseMirror 在输入后滚动到选区时会读取它。
if (!Range.prototype.getClientRects) {
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
    toJSON: () => ({}),
  };
  Range.prototype.getClientRects = () => [rect] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
}

const references: ReferenceItem[] = [
  { src: "images/a.png", index: 0, kind: "image" },
  { src: "images/b.png", index: 1, kind: "image" },
];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MentionPrompt 目标切换", () => {
  it("保留编辑器实例并写入新目标内容，且不在 React 生命周期内同步刷新", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { container, rerender } = render(
      <MentionPrompt
        nodeId="t1"
        active
        references={references}
        value="图片1"
        onChange={() => {}}
        placeholder="prompt"
      />,
    );

    await waitFor(() => expect(container.querySelector(".ProseMirror")).not.toBeNull());
    await waitFor(() => expect(container.querySelector('[data-testid="chip"]')).not.toBeNull());
    const editorDom = container.querySelector(".ProseMirror") as HTMLElement;

    // 打开 @ 候选栏：切目标时宿主会 setMention(null)，让本次提交存在待处理
    // 的 React 同步更新——这是 flushSync 警告实际出现的条件。
    editorDom.focus();
    const paragraph = editorDom.querySelector("p")!;
    paragraph.appendChild(document.createTextNode("@"));
    const range = document.createRange();
    range.setStart(paragraph, paragraph.childNodes.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await waitFor(() => expect(screen.queryByTestId("mention-dropdown")).not.toBeNull());
    errorSpy.mockClear();

    rerender(
      <MentionPrompt
        nodeId="t2"
        active
        references={references}
        value="图片2 新目标"
        onChange={() => {}}
        placeholder="prompt"
      />,
    );

    // 重建必须离开 React 提交阶段：否则 mention 的 React NodeView 会在
    // layout effect 内触发 Tiptap ReactRenderer 的 flushSync（浏览器中报错）。
    expect(editorDom.textContent).not.toContain("新目标");

    await waitFor(() =>
      expect(container.querySelector(".ProseMirror")?.textContent).toContain("新目标"),
    );

    expect(container.querySelector(".ProseMirror")).toBe(editorDom);
    expect(errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(
      "flushSync was called",
    );
  });

  it("切换目标时不用旧文档的清理结果回写新目标", async () => {
    const onChange = vi.fn();
    const refsA: ReferenceItem[] = [{ src: "images/a.png", index: 0, kind: "image" }];
    const refsB: ReferenceItem[] = [{ src: "images/b.png", index: 0, kind: "image" }];

    const { container, rerender } = render(
      <MentionPrompt
        nodeId="t1"
        active
        references={refsA}
        value="图片1"
        onChange={onChange}
        placeholder="prompt"
      />,
    );

    await waitFor(() => expect(container.querySelector('[data-testid="chip"]')).not.toBeNull());
    const editorDom = container.querySelector(".ProseMirror") as HTMLElement;
    const chipSrc = () => container.querySelector('[data-testid="chip"]')?.getAttribute("data-src");
    onChange.mockClear();

    // 旧目标的 chip（a.png）不在新目标的引用里。若引用清理 effect 在重建前
    // 按新 references 处理旧文档，会删掉 chip 并把空文本回写成新目标的提示词。
    rerender(
      <MentionPrompt
        nodeId="t2"
        active
        references={refsB}
        value="图片1"
        onChange={onChange}
        placeholder="prompt"
      />,
    );

    await waitFor(() => expect(chipSrc()).toBe("images/b.png"));
    expect(onChange).not.toHaveBeenCalled();

    // 反向切换同理：不能在 t1 的文档上执行 t2 的引用清理
    rerender(
      <MentionPrompt
        nodeId="t1"
        active
        references={refsA}
        value="图片1"
        onChange={onChange}
        placeholder="prompt"
      />,
    );

    await waitFor(() => expect(chipSrc()).toBe("images/a.png"));
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".ProseMirror")).toBe(editorDom);
  });
});
