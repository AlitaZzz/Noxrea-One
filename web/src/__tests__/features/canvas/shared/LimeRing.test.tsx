// @vitest-environment jsdom
/**
 * 共享流光描边的结构契约（specs/canvas-selection-chrome-scheduling.md 5.3）。
 *
 * 性能约束是「静态遮罩环 + 只旋转内层 transform」；本测试只锁定组件结构
 * （外层唯一子元素是旋转层），动画是否确实落在内层由 globals.css 与独立
 * 探针验证，不在此处断言。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import LimeRing from "@/features/canvas/shared/LimeRing";

afterEach(cleanup);

describe("LimeRing", () => {
  it("外层是静态遮罩环，只有内层承载旋转渐变", () => {
    const { container } = render(<LimeRing />);
    const ring = container.firstElementChild as HTMLElement;

    expect(ring.tagName).toBe("SPAN");
    expect(ring).toHaveClass("lime-ring");
    expect(ring).toHaveAttribute("aria-hidden", "true");
    // 外层只允许一个子元素：多出的渐变/动画节点说明动画重新落到了遮罩层
    expect(ring.childElementCount).toBe(1);

    const spin = ring.firstElementChild as HTMLElement;
    expect(spin).toHaveClass("lime-ring__spin");
    expect(spin.childElementCount).toBe(0);
  });

  it("透传调用方类名", () => {
    const { container } = render(<LimeRing className="custom-ring" />);
    expect(container.firstElementChild).toHaveClass("lime-ring", "custom-ring");
  });
});
