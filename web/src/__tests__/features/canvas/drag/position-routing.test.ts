import { describe, expect, it, vi } from "vitest";

import {
  type PositionFrameChange,
  type PositionFrameSink,
  routePositionFrames,
} from "@/features/canvas/drag/position-routing";

function createSink(active: boolean): PositionFrameSink {
  return {
    isActive: vi.fn(() => active),
    preview: vi.fn(),
    commit: vi.fn(),
  };
}

describe("routePositionFrames", () => {
  it("会话激活时过程帧只进预览，不经过直接写入口径", () => {
    const sink = createSink(true);
    const applyDirect = vi.fn();
    const changes: PositionFrameChange[] = [{ id: "a", position: { x: 1, y: 2 }, dragging: true }];

    routePositionFrames(changes, sink, applyDirect);

    expect(sink.preview).toHaveBeenCalledWith([{ id: "a", position: { x: 1, y: 2 } }]);
    expect(sink.commit).not.toHaveBeenCalled();
    // 直接写入口径是位置帧触发 markDirty 的唯一路径：过程帧永不经过它
    expect(applyDirect).not.toHaveBeenCalled();
  });

  it("会话激活时终态帧走提交，不经过直接写入口径", () => {
    const sink = createSink(true);
    const applyDirect = vi.fn();

    routePositionFrames(
      [
        { id: "a", position: { x: 3, y: 4 }, dragging: false },
        { id: "b", position: { x: 5, y: 6 } },
      ],
      sink,
      applyDirect,
    );

    expect(sink.commit).toHaveBeenCalledWith([
      { id: "a", position: { x: 3, y: 4 } },
      { id: "b", position: { x: 5, y: 6 } },
    ]);
    expect(sink.preview).not.toHaveBeenCalled();
    expect(applyDirect).not.toHaveBeenCalled();
  });

  it("会话未激活时（无拖动开始的程序化位置变更）两类帧都走直接写入", () => {
    const sink = createSink(false);
    const applyDirect = vi.fn();

    routePositionFrames(
      [
        { id: "a", position: { x: 1, y: 0 }, dragging: true },
        { id: "b", position: { x: 2, y: 0 }, dragging: false },
      ],
      sink,
      applyDirect,
    );

    expect(applyDirect).toHaveBeenNthCalledWith(1, [{ id: "a", position: { x: 1, y: 0 } }]);
    expect(applyDirect).toHaveBeenNthCalledWith(2, [{ id: "b", position: { x: 2, y: 0 } }]);
    expect(sink.preview).not.toHaveBeenCalled();
    expect(sink.commit).not.toHaveBeenCalled();
  });

  it("仅切换 dragging 而缺省 position 的变更被跳过", () => {
    const sink = createSink(true);
    const applyDirect = vi.fn();

    routePositionFrames([{ id: "a", dragging: true }], sink, applyDirect);

    expect(sink.preview).not.toHaveBeenCalled();
    expect(sink.commit).not.toHaveBeenCalled();
    expect(applyDirect).not.toHaveBeenCalled();
  });

  it("同批过程帧与终态帧各自分流：预览先于提交", () => {
    const sink = createSink(true);
    const applyDirect = vi.fn();

    routePositionFrames(
      [
        { id: "a", position: { x: 10, y: 0 }, dragging: true },
        { id: "a", position: { x: 12, y: 0 }, dragging: false },
      ],
      sink,
      applyDirect,
    );

    expect(sink.preview).toHaveBeenCalledWith([{ id: "a", position: { x: 10, y: 0 } }]);
    expect(sink.commit).toHaveBeenCalledWith([{ id: "a", position: { x: 12, y: 0 } }]);
    expect(vi.mocked(sink.preview).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sink.commit).mock.invocationCallOrder[0],
    );
    expect(applyDirect).not.toHaveBeenCalled();
  });
});
