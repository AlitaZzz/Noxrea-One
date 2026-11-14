/**
 * DirectorOverlay 公共 props 契约：快照注入、关闭回写顺序与运行时动作转发。
 *
 * 三维视口按 `ssr: false` 动态载入，测试用替身接收 props；布局子面板
 * 只验证挂载，不参与契约。store 使用真实实现，确保关闭时的 reset 生效。
 */
// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectorStateData } from "@/entities/director";
import type { DirectorRuntime } from "@/features/director/director-store";

vi.mock("react-i18next", () => import("@/__tests__/test-utils/react-i18next-mock"));

vi.mock("next/dynamic", () => ({
  default: () => (props: {
    initialState: DirectorStateData | null;
    onCreateImageNode: (input: { ref: string; width: number; height: number; name: string }) => Promise<void>;
  }) => (
    <div data-testid="director-viewport" data-initial={props.initialState ? "present" : "none"}>
      <button
        type="button"
        onClick={() => void props.onCreateImageNode({ ref: "r", width: 1, height: 1, name: "n" })}
      >
        viewport-create
      </button>
    </div>
  ),
}));

vi.mock("@/features/director/components/Outliner", () => ({ default: () => <div data-testid="outliner" /> }));
vi.mock("@/features/director/components/Dock", () => ({ default: () => <div data-testid="dock" /> }));
vi.mock("@/features/director/components/ScenePanel", () => ({ default: () => <div data-testid="scene-panel" /> }));
vi.mock("@/features/director/components/Inspector", () => ({ default: () => <div data-testid="inspector" /> }));

import DirectorOverlay from "@/features/director/components/DirectorOverlay";
import { useDirectorStore } from "@/features/director/director-store";

const STATE = { shots: [], entities: [] } as unknown as DirectorStateData;

function fakeRuntime(overrides: Partial<DirectorRuntime> = {}): DirectorRuntime {
  return {
    captureState: vi.fn(() => STATE),
    setCameraView: vi.fn(),
    ...overrides,
  } as unknown as DirectorRuntime;
}

function renderOverlay(runtime: DirectorRuntime = fakeRuntime()) {
  useDirectorStore.getState().setRuntime(runtime);
  const props: ComponentProps<typeof DirectorOverlay> = {
    initialState: STATE,
    onSaveState: vi.fn(),
    onCreateImageNode: vi.fn(async () => {}),
    onClose: vi.fn(),
  };
  render(<DirectorOverlay {...props} />);
  return { ...props, runtime };
}

beforeEach(() => {
  useDirectorStore.getState().reset();
});

describe("DirectorOverlay 关闭契约", () => {
  it("关闭顺序：抓取运行时快照 → 回写 → 重置 store → 通知页面", () => {
    const { runtime, onSaveState, onClose } = renderOverlay();

    fireEvent.click(screen.getByRole("button", { name: "common.close" }));

    expect(runtime.captureState).toHaveBeenCalledTimes(1);
    expect(onSaveState).toHaveBeenCalledWith(STATE);
    expect(useDirectorStore.getState().runtime).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("运行时无快照时跳过回写，仍重置并关闭", () => {
    const runtime = fakeRuntime({ captureState: vi.fn(() => null as unknown as DirectorStateData) });
    const { onSaveState, onClose } = renderOverlay(runtime);

    fireEvent.click(screen.getByRole("button", { name: "common.close" }));

    expect(onSaveState).not.toHaveBeenCalled();
    expect(useDirectorStore.getState().runtime).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("DirectorOverlay 视口与动作", () => {
  it("把初始快照与出图回调原样交给视口", () => {
    const { onCreateImageNode } = renderOverlay();

    expect(screen.getByTestId("director-viewport")).toHaveAttribute("data-initial", "present");

    fireEvent.click(screen.getByRole("button", { name: "viewport-create" }));
    expect(onCreateImageNode).toHaveBeenCalledWith({ ref: "r", width: 1, height: 1, name: "n" });
  });

  it("无初始快照时视口收到 null", () => {
    useDirectorStore.getState().setRuntime(fakeRuntime());
    render(
      <DirectorOverlay
        initialState={null}
        onSaveState={vi.fn()}
        onCreateImageNode={vi.fn(async () => {})}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId("director-viewport")).toHaveAttribute("data-initial", "none");
  });

  it("视角标签切换转发给运行时", () => {
    // 真实运行时会把 cameraView 写回 store；替身同样同步，受控 Tabs 才能切回导演视角
    const setCameraView = vi.fn((on: boolean) => useDirectorStore.getState().setCameraView(on));
    const { runtime } = renderOverlay(fakeRuntime({ setCameraView }));

    // Radix Tabs 在 mouseDown 时激活触发器（click 不会触发）
    fireEvent.mouseDown(screen.getByRole("tab", { name: "director.cameraView" }));
    expect(runtime.setCameraView).toHaveBeenCalledWith(true);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "director.directorView" }));
    expect(runtime.setCameraView).toHaveBeenLastCalledWith(false);
  });
});
