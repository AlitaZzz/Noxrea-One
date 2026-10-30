import { vi } from "vitest";

/** 手动推进 rAF：会话每帧最多写一次 DOM，测试逐帧断言 */
export function stubRaf() {
  const queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  return {
    flush() {
      const pending = [...queue.values()];
      queue.clear();
      for (const cb of pending) cb(0);
    },
  };
}
