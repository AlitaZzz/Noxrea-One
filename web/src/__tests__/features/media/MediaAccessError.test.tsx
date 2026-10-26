// @vitest-environment jsdom
/**
 * 访问地址失败态（specs/storage-signed-direct-delivery.md 规则 3.6）：
 * 重试入口必须自带指针事件，且点击走 `onRetry`（`refresh`），不退化为空转。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MediaAccessError } from "@/features/media/components/MediaAccessError";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "zh" } }),
}));

afterEach(cleanup);

describe("MediaAccessError", () => {
  it("compact 形态自行恢复指针事件（调用方容器可能是 pointer-events-none）", () => {
    render(<MediaAccessError compact onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveClass("pointer-events-auto");
  });

  it("点击重试调用 onRetry", () => {
    const onRetry = vi.fn();
    render(<MediaAccessError onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
