// @vitest-environment jsdom
/**
 * 已解析媒体元素（specs/storage-signed-direct-delivery.md 规则 3.6）：
 * 解析前不渲染元素、失败时重描述一次、重试用尽进入调用方 fallback。
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

import { ResolvedImage, ResolvedVideo } from "@/features/media/components/ResolvedMedia";

const KEY = makeStorageKey("resolved-media", ".png");

beforeEach(() => {
  mocks.state.url = undefined;
  mocks.state.failed = false;
  mocks.state.reloadToken = 0;
  mocks.state.retrySigned.mockReset();
  mocks.state.refresh.mockReset();
  mocks.state.refresh.mockResolvedValue(undefined);
  mocks.state.values.length = 0;
});

afterEach(cleanup);

/** 元素失败 → 重试回调结算引发的 setState 必须在 act 内完成 */
async function failMedia(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.error(element);
  });
}

describe("ResolvedImage", () => {
  it("解析出地址前只渲染 fallback，不产生空 src 的媒体元素", () => {
    render(<ResolvedImage value={KEY} alt="cover" fallback={<span>loading</span>} />);

    expect(screen.getByText("loading")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("地址就绪后渲染 img 并透传属性，width 派生为逻辑 URL 的 ?w=", () => {
    mocks.state.url = "https://signed/a.png";
    render(
      <ResolvedImage value={KEY} width={300} alt="cover" className="cover" loading="lazy" />,
    );

    const img = screen.getByRole("img", { name: "cover" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://signed/a.png");
    expect(img.className).toBe("cover");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(mocks.state.values.at(-1)).toBe(`/api/files/${KEY}?w=300`);
  });

  it("外部地址原样交给解析层，width 不改变外部 URL", () => {
    mocks.state.url = "https://cdn.example.com/a.png";
    render(<ResolvedImage value="https://cdn.example.com/a.png" width={300} alt="" />);

    expect(mocks.state.values.at(-1)).toBe("https://cdn.example.com/a.png");
  });

  it("元素加载失败时重描述一次，成功后按新令牌重挂元素且不进入 fallback", async () => {
    mocks.state.url = "https://signed/old.png";
    mocks.state.retrySigned.mockResolvedValue("https://signed/new.png");
    const { rerender } = render(
      <ResolvedImage value={KEY} alt="cover" fallback={<span>failed</span>} />,
    );
    const first = screen.getByRole("img");

    await failMedia(first);
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("failed")).toBeNull();

    mocks.state.reloadToken = 1;
    mocks.state.url = "https://signed/new.png";
    rerender(<ResolvedImage value={KEY} alt="cover" fallback={<span>failed</span>} />);

    const second = screen.getByRole("img") as HTMLImageElement;
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe("https://signed/new.png");
  });

  it("重试不可用或仍失败时进入 fallback，且不再反复重试", async () => {
    mocks.state.url = "https://signed/a.png";
    mocks.state.retrySigned.mockResolvedValue(null);
    const onError = vi.fn();
    render(
      <ResolvedImage
        value={KEY}
        alt="cover"
        fallback={<span>failed</span>}
        onError={onError}
      />,
    );

    await failMedia(screen.getByRole("img"));

    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);
  });

  it("描述失败时函数式 fallback 拿到 failed 与 retry，重试走 refresh 并清掉失败态", async () => {
    mocks.state.url = undefined;
    const { rerender } = render(
      <ResolvedImage
        value={KEY}
        alt="cover"
        fallback={({ failed, retry }) => (
          <button type="button" onClick={retry}>{failed ? "retry" : "loading"}</button>
        )}
      />,
    );

    // 解析中：fallback 拿到 failed=false，不显示重试入口
    expect(screen.getByRole("button").textContent).toBe("loading");

    mocks.state.failed = true;
    rerender(
      <ResolvedImage
        value={KEY}
        alt="cover"
        fallback={({ failed, retry }) => (
          <button type="button" onClick={retry}>{failed ? "retry" : "loading"}</button>
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(mocks.state.refresh).toHaveBeenCalledTimes(1);
  });

  it("换源后失败态复位（旧源的失败不继承到新引用）", async () => {
    mocks.state.url = "https://signed/a.png";
    mocks.state.retrySigned.mockResolvedValue(null);
    const { rerender } = render(
      <ResolvedImage value={KEY} alt="a" fallback={<span>failed</span>} />,
    );
    await failMedia(screen.getByRole("img"));

    const NEXT = makeStorageKey("resolved-media-next", ".png");
    mocks.state.url = "https://signed/b.png";
    rerender(<ResolvedImage value={NEXT} alt="b" fallback={<span>failed</span>} />);

    expect(screen.getByRole("img", { name: "b" })).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
  });
});

describe("ResolvedVideo", () => {
  it("渲染 video 并透传播放属性，元素失败时同样重描述一次", async () => {
    mocks.state.url = "https://signed/a.mp4";
    mocks.state.retrySigned.mockResolvedValue(null);
    render(
      <ResolvedVideo
        value={KEY}
        muted
        playsInline
        preload="metadata"
        className="thumb"
        fallback={<span>failed</span>}
      />,
    );

    const video = document.querySelector("video") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("https://signed/a.mp4");
    expect(video.muted).toBe(true);
    expect(video.getAttribute("preload")).toBe("metadata");
    expect(video.className).toBe("thumb");

    await failMedia(video);
    expect(mocks.state.retrySigned).toHaveBeenCalledTimes(1);
    expect(screen.getByText("failed")).toBeTruthy();
  });
});
