// @vitest-environment jsdom
/**
 * 资产卡音频试听：访问地址异步解析，停止 / 重新点击 / 卸载都必须作废在途尝试。
 * 回归：解析迟到时曾在已卸载的卡片上新建 <audio> 并播放（翻页后退仍在响）。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  notify: vi.fn(),
}));

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { error: mocks.notify } }),
}));
vi.mock("@/lib/use-file-access-url", () => import("@/__tests__/test-utils/file-access-mock"));
vi.mock("@/lib/file-access", () => ({ resolveMediaUrlString: mocks.resolve }));

import { TooltipProvider } from "@/components/ui/tooltip";
import AssetCard from "@/features/assets/components/AssetCard";
import type { AssetItem } from "@/features/assets/types";

const ASSET: AssetItem = {
  id: "asset-audio-1",
  name: "song",
  type: "audio",
  mediaType: "audio",
  width: 0,
  height: 0,
  size: 0,
  duration: 12,
  description: "",
  createdAt: Date.UTC(2026, 0, 1),
  updatedAt: Date.UTC(2026, 0, 1),
  tags: [],
  prompt: "",
  scope: "personal",
  fileKey: "1/ab/" + "a".repeat(64) + ".mp3",
};

/** 播放行为可变：媒体元素的 play 是实例自有属性，不能靠替换原型来改变结果 */
let playBehavior: () => Promise<void> = () => Promise.resolve();

class SilentAudio {
  static instances: SilentAudio[] = [];
  src = "";
  currentTime = 0;
  paused = true;
  play = vi.fn(() => playBehavior());
  pause = vi.fn(() => { this.paused = true; });
  addEventListener = vi.fn();
  constructor() { SilentAudio.instances.push(this); }
}

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.notify.mockReset();
  SilentAudio.instances = [];
  playBehavior = () => Promise.resolve();
  vi.stubGlobal("Audio", SilentAudio);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}

function renderCard() {
  render(<TooltipProvider><AssetCard asset={ASSET} selectable={false} /></TooltipProvider>);
  return screen.getByRole("button", { name: "common.play" });
}

describe("AssetCard 音频试听", () => {
  it("解析成功后才创建元素并播放，且写入解析出的地址", async () => {
    let resolveUrl!: (url: string) => void;
    mocks.resolve.mockImplementation(() => new Promise<string>((resolve) => { resolveUrl = resolve; }));

    fireEvent.click(renderCard());
    await flush();
    expect(SilentAudio.instances).toHaveLength(0);

    await act(async () => { resolveUrl("https://signed.example/song.mp3"); });
    await flush();
    expect(SilentAudio.instances).toHaveLength(1);
    expect(SilentAudio.instances[0].src).toBe("https://signed.example/song.mp3");
    expect(SilentAudio.instances[0].play).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "common.stop" })).toBeInTheDocument();
  });

  it("解析途中卡片卸载 → 迟到结果不再创建元素、不出声、不通知", async () => {
    let resolveUrl!: (url: string) => void;
    mocks.resolve.mockImplementation(() => new Promise<string>((resolve) => { resolveUrl = resolve; }));

    fireEvent.click(renderCard());
    await flush();
    cleanup();

    await act(async () => { resolveUrl("https://signed.example/late.mp3"); });
    await flush();
    expect(SilentAudio.instances).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("解析途中鼠标离开卡片 → 该尝试作废，迟到的结果不建元素不出声", async () => {
    let resolveUrl!: (url: string) => void;
    mocks.resolve.mockImplementation(() => new Promise<string>((resolve) => { resolveUrl = resolve; }));

    fireEvent.click(renderCard());
    await flush();
    // 离场判定不能只看 playing（解析成功后才为真）：此时仍在解析
    fireEvent.mouseLeave(document.querySelector('[class*="aspect-square"]')!);
    await act(async () => { resolveUrl("https://signed.example/left.mp3"); });
    await flush();

    expect(SilentAudio.instances).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("解析途中再次点击 → 新尝试接管，上一次尝试的迟到结果被作废", async () => {
    let firstResolve!: (url: string) => void;
    mocks.resolve
      .mockImplementationOnce(() => new Promise<string>((resolve) => { firstResolve = resolve; }))
      .mockImplementationOnce(() => new Promise<string>(() => {}));

    const button = renderCard();
    fireEvent.click(button);
    await flush();
    // 在途期间按钮仍是「播放」：再点一次发起新尝试并作废上一次
    fireEvent.click(button);
    await flush();
    await act(async () => { firstResolve("https://signed.example/cancelled.mp3"); });
    await flush();

    expect(SilentAudio.instances).toHaveLength(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("解析途中再次点击 → 旧尝试的 abort 拒绝不会中止新尝试", async () => {
    let resolveSecond!: (url: string) => void;
    mocks.resolve
      .mockImplementationOnce((_ref: string, options: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
        // 真实实现：signal 中止即以 AbortError 拒绝
        options.signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      }))
      .mockImplementationOnce(() => new Promise<string>((resolve) => { resolveSecond = resolve; }));

    const button = renderCard();
    fireEvent.click(button);
    await flush();
    // 第二次点击会 abort 第一次；旧尝试随之以 AbortError 拒绝
    fireEvent.click(button);
    await flush();

    await act(async () => { resolveSecond("https://signed.example/second.mp3"); });
    await flush();

    expect(SilentAudio.instances).toHaveLength(1);
    expect(SilentAudio.instances[0].src).toBe("https://signed.example/second.mp3");
    expect(SilentAudio.instances[0].play).toHaveBeenCalledTimes(1);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("解析失败 → 停止态 + 轻量错误提示（不静默）", async () => {
    mocks.resolve.mockRejectedValue(new Error("network"));
    fireEvent.click(renderCard());
    await flush();

    expect(SilentAudio.instances).toHaveLength(0);
    expect(mocks.notify).toHaveBeenCalledWith("media.previewPlayFailed");
    expect(screen.getByRole("button", { name: "common.play" })).toBeInTheDocument();
  });

  it("自动播放被策略拒绝（NotAllowedError）不通知", async () => {
    mocks.resolve.mockResolvedValue("https://signed.example/blocked.mp3");
    playBehavior = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));

    fireEvent.click(renderCard());
    await flush();
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "common.play" })).toBeInTheDocument();
  });
});
