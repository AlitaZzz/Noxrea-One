// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import AudioWaveform from "@/features/canvas/nodes/AudioWaveform";

const { create, player } = vi.hoisted(() => {
  const player = {
    on: vi.fn(),
    setOptions: vi.fn(),
    destroy: vi.fn(),
  };
  return { create: vi.fn(() => player), player };
});

vi.mock("wavesurfer.js", () => ({ default: { create } }));

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
