// @vitest-environment jsdom
/**
 * 悬浮大图的懒解析（specs/storage-signed-direct-delivery.md 规则 3.3 / 3.5 / 3.6）：
 * 浮层未打开前不解析、不发描述请求；打开后地址就绪才挂载媒体元素；描述失败就地重试。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { makeStorageKey } from "@/__tests__/test-utils/storage-fixtures";

const mocks = vi.hoisted(() => {
  const state = {
    url: undefined as string | undefined,
    failed: false,
    reloadToken: 0,
    retrySigned: vi.fn<() => Promise<string | null>>(),
    refresh: vi.fn<() => Promise<string | undefined>>(),
    values: [] as (string | null | undefined)[],
  };
  return {
    state,
    useFileAccessUrl: vi.fn((value: string | null | undefined) => {
      state.values.push(value);
      return {
        url: state.url,
        failed: state.failed,
        refresh: state.refresh,
        retrySigned: state.retrySigned,
        reloadToken: state.reloadToken,
      };
    }),
  };
});

vi.mock("@/lib/use-file-access-url", () => ({
  useFileAccessUrl: mocks.useFileAccessUrl,
}));

import { HoverCard } from "@/components/ui/hover-card";
import { ResolvedHoverMedia } from "@/features/media/components/ResolvedHoverMedia";

const KEY = makeStorageKey("resolved-hover-media", ".png");

beforeEach(() => {
  mocks.state.url = undefined;
  mocks.state.failed = false;
  mocks.state.reloadToken = 0;
  mocks.state.retrySigned.mockReset();
  mocks.state.refresh.mockReset();
  mocks.state.values.length = 0;
});

afterEach(cleanup);

/** 浮层内容必须挂在 HoverCard 上下文内（Radix Portal 依赖它） */
function renderPreview(ui: React.ReactElement) {
  return render(<HoverCard open>{ui}</HoverCard>);
}

describe("ResolvedHoverMedia", () => {
  it("浮层未打开时不解析：解析层拿到 undefined，不渲染任何内容", () => {
    renderPreview(<ResolvedHoverMedia value={KEY} width={480} open={false} mediaType="image" />);

    expect(mocks.state.values.at(-1)).toBeUndefined();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("打开后才解析：width 派生为逻辑 URL 的 ?w=，地址就绪后渲染元素", () => {
    mocks.state.url = "https://signed/a.png";
    const { rerender } = renderPreview(
      <ResolvedHoverMedia value={KEY} width={480} open={false} mediaType="image" alt="cover" />,
    );
    expect(mocks.state.values.at(-1)).toBeUndefined();

    rerender(<HoverCard open><ResolvedHoverMedia value={KEY} width={480} open mediaType="image" alt="cover" /></HoverCard>);

    expect(mocks.state.values.at(-1)).toBe(`/api/files/${KEY}?w=480`);
    // 媒体元素在 loading 阶段 visibility: hidden，按 DOM 查而不是可访问性角色
    expect(document.querySelector('[data-slot="hover-card-content"] img')?.getAttribute("src"))
      .toBe("https://signed/a.png");
  });

  it("地址未就绪时不渲染空 src 的媒体元素", () => {
    renderPreview(<ResolvedHoverMedia value={KEY} open mediaType="image" alt="cover" />);

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("关闭后保持武装：不收回解析请求，退场动画仍有内容", () => {
    mocks.state.url = "https://signed/a.png";
    const { rerender } = renderPreview(
      <ResolvedHoverMedia value={KEY} open mediaType="image" alt="cover" />,
    );
    rerender(<HoverCard open><ResolvedHoverMedia value={KEY} open={false} mediaType="image" alt="cover" /></HoverCard>);

    expect(mocks.state.values.at(-1)).toBe(KEY);
    expect(document.querySelector('[data-slot="hover-card-content"] img')).toBeTruthy();
  });

  it("描述失败时就地给出重试，重试走 refresh 而非元素重试", async () => {
    mocks.state.failed = true;
    renderPreview(<ResolvedHoverMedia value={KEY} open mediaType="image" alt="cover" />);

    expect(screen.queryByRole("img")).toBeNull();
    const retry = screen.getByRole("button");
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(mocks.state.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.state.retrySigned).not.toHaveBeenCalled();
  });

  it("元素加载失败时重新描述一次（规则 3.6），闩锁由 Hook 持有", async () => {
    mocks.state.url = "https://signed/a.png";
    mocks.state.retrySigned.mockResolvedValue("https://signed/retried.png");
    renderPreview(<ResolvedHoverMedia value={KEY} open mediaType="image" alt="cover" />);

    const img = document.querySelector('[data-slot="hover-card-content"] img');
    expect(img).toBeTruthy();
    await act(async () => {
      fireEvent.error(img!);
    });
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);
  });

  it("元素失败后用户点重试：走 refresh 强制重新描述，不用已用尽的自动重试闩锁", async () => {
    mocks.state.url = "https://signed/a.png";
    // 自动重试的闩锁已用尽（同一源只重试一次）：再调 retrySigned 不会有任何效果
    mocks.state.retrySigned.mockResolvedValue(null);
    renderPreview(<ResolvedHoverMedia value={KEY} open mediaType="image" alt="cover" />);

    const img = document.querySelector('[data-slot="hover-card-content"] img');
    await act(async () => {
      fireEvent.error(img!);
    });
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "media.retry" }));
    });
    // 手动重试必须能换出新地址：复用 onMediaError 会让按钮在闩锁用尽后只重挂同一个过期地址
    expect(mocks.state.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);
  });

  it("视频用原图：不传 width 时不追加档位参数", () => {
    mocks.state.url = "https://signed/a.mp4";
    renderPreview(<ResolvedHoverMedia value={KEY} open mediaType="video" />);

    // 无 width 时原样把引用值交给解析层（它同时接受存储 key 与托管 URL）
    expect(mocks.state.values.at(-1)).toBe(KEY);
    expect(document.querySelector("video")?.getAttribute("src")).toBe("https://signed/a.mp4");
  });
});
