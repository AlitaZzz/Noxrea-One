// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AudioWaveform from "@/features/canvas/nodes/AudioWaveform";

const { create, player } = vi.hoisted(() => {
  const player = {
    on: vi.fn(),
    setOptions: vi.fn(),
    destroy: vi.fn(),
  };
  return { create: vi.fn(() => player), player };
});

const { hook } = vi.hoisted(() => ({ hook: vi.fn() }));

vi.mock("wavesurfer.js", () => ({ default: { create } }));
vi.mock("@/lib/use-file-access-url", () => ({ useFileAccessUrl: hook }));

beforeEach(() => {
  hook.mockReturnValue({
    url: "/audio.mp3",
    delivery: undefined,
    failed: false,
    refresh: vi.fn(),
    retrySigned: vi.fn(),
    reloadToken: 0,
  });
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark", "light");
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("AudioWaveform theme rendering", () => {
  it("redraws the waveform from its computed foreground without replacing the player", async () => {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({
      color: document.documentElement.classList.contains("dark") ? "rgb(250, 250, 250)" : "rgb(23, 23, 23)",
    }) as CSSStyleDeclaration);

    const { unmount } = render(<AudioWaveform url="/audio.mp3" duration={19} />);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ waveColor: "rgb(23, 23, 23)" }));
    expect(screen.getByText("00:00 / 00:19")).toHaveClass("opacity-70");

    await act(async () => { document.documentElement.classList.add("dark"); });
    expect(player.setOptions).toHaveBeenLastCalledWith({ waveColor: "rgb(250, 250, 250)" });
    await act(async () => { document.documentElement.classList.remove("dark"); });
    expect(player.setOptions).toHaveBeenLastCalledWith({ waveColor: "rgb(23, 23, 23)" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(player.destroy).not.toHaveBeenCalled();

    unmount();
    expect(player.destroy).toHaveBeenCalledTimes(1);
    const redraws = player.setOptions.mock.calls.length;
    await act(async () => { document.documentElement.classList.add("dark"); });
    expect(player.setOptions).toHaveBeenCalledTimes(redraws);
  });

  it("does not redraw when a root class changes without changing the foreground", async () => {
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ color: "rgb(23, 23, 23)" } as CSSStyleDeclaration);
    render(<AudioWaveform url="/audio.mp3" />);
    await act(async () => { document.documentElement.classList.add("light"); });
    expect(player.setOptions).not.toHaveBeenCalled();
  });

  it("keeps the parent's white foreground on a fixed dark preview in either theme", async () => {
    document.documentElement.classList.add("light");
    render(
      <div style={{ backgroundColor: "black", color: "white" }}>
        <AudioWaveform url="/audio.mp3" duration={19} />
      </div>,
    );
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ waveColor: "rgb(255, 255, 255)" }));
    expect(getComputedStyle(screen.getByText("00:00 / 00:19")).color).toBe("rgb(255, 255, 255)");
    await act(async () => {
      document.documentElement.classList.replace("light", "dark");
    });
    expect(player.setOptions).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("AudioWaveform 访问地址失败态", () => {
  it("元素加载失败时重新描述一次签名地址", async () => {
    const retrySigned = vi.fn().mockResolvedValue(null);
    hook.mockReturnValue({
      url: "/audio.mp3",
      delivery: "signed",
      failed: false,
      refresh: vi.fn(),
      retrySigned,
      reloadToken: 0,
    });
    render(<AudioWaveform url="/audio.mp3" />);

    const onError = player.on.mock.calls.find((call) => call[0] === "error")?.[1] as
      | (() => void)
      | undefined;
    await act(async () => { onError?.(); });
    expect(retrySigned).toHaveBeenCalledTimes(1);
  });

  it("描述本身失败时提供手动重试入口，不再空转 retrySigned", () => {
    const refresh = vi.fn();
    const retrySigned = vi.fn();
    hook.mockReturnValue({
      url: undefined,
      delivery: undefined,
      failed: true,
      refresh,
      retrySigned,
      reloadToken: 0,
    });
    render(<AudioWaveform url="/audio.mp3" />);

    expect(screen.getByText("音频加载失败")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(retrySigned).not.toHaveBeenCalled();
  });
});
