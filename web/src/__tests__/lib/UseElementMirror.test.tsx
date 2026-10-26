// @vitest-environment jsdom
/**
 * 元素身份镜像（`useElementMirror`）：DOM 元素换实例后，旧元素的事件镜像必须作废。
 * 新元素若暂停在 0 就不会补发 pause，镜像停在旧值会让界面显示「暂停中、实际在播」。
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useElementMirror } from "@/lib/use-element-mirror";

const INITIAL = { playing: false, progress: 0 };

describe("useElementMirror", () => {
  it("身份不变时保留已有镜像", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useElementMirror(identity, INITIAL),
      { initialProps: { identity: "a" } },
    );
    act(() => result.current[1]({ playing: true }));
    expect(result.current[0].playing).toBe(true);

    rerender({ identity: "a" });
    expect(result.current[0]).toEqual({ playing: true, progress: 0 });
  });

  it("身份变化即回到初始值（同一轮渲染，不闪旧值）", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useElementMirror(identity, INITIAL),
      { initialProps: { identity: "a" } },
    );
    act(() => result.current[1]({ playing: true, progress: 12 }));

    rerender({ identity: "b" });
    expect(result.current[0]).toEqual(INITIAL);
  });

  it("部分更新不丢其它字段", () => {
    const { result } = renderHook(() => useElementMirror("a", INITIAL));
    act(() => result.current[1]({ progress: 7 }));
    act(() => result.current[1]({ playing: true }));
    expect(result.current[0]).toEqual({ playing: true, progress: 7 });
  });

  it("换身份后的更新以初始值为基底，不继承旧身份的字段", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useElementMirror(identity, INITIAL),
      { initialProps: { identity: "a" } },
    );
    act(() => result.current[1]({ progress: 12 }));
    rerender({ identity: "b" });

    act(() => result.current[1]({ playing: true }));
    expect(result.current[0]).toEqual({ playing: true, progress: 0 });
  });

  it("patch 身份稳定：同一 identity 下不随渲染变化", () => {
    const { result, rerender } = renderHook(
      ({ identity }: { identity: string }) => useElementMirror(identity, INITIAL),
      { initialProps: { identity: "a" } },
    );
    const first = result.current[1];
    rerender({ identity: "a" });
    expect(result.current[1]).toBe(first);
  });
});
