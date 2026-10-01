import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestFeedback } from "@/test-utils/TestFeedbackProvider";

beforeEach(() => vi.resetModules());

describe("global feedback lifecycle", () => {
  it("delivers pre-mount events in order through an already captured facade", async () => {
    const { globalFeedback, registerFeedback } = await import("@/lib/feedback");
    const calls: string[] = [];
    const api = createTestFeedback();
    api.message.info = (value) => { calls.push(value); };
    api.notification.error = (value) => { calls.push(value.title); };
    const message = globalFeedback.message;
    message.info("first");
    const options = { title: "second", key: "task" };
    globalFeedback.notification.error(options);
    options.title = "mutated";
    const unregister = registerFeedback(api);
    message.info("third");
    expect(calls).toEqual(["first", "second", "third"]);
    unregister();
  });
  it("isolates registration ownership even when the same adapter is registered twice", async () => {
    const { globalFeedback, registerFeedback } = await import("@/lib/feedback");
    const api = createTestFeedback();
    const staleCleanup = registerFeedback(api);
    const cleanup = registerFeedback(api);
    staleCleanup();
    globalFeedback.message.success("live");
    expect(api.message.success).toHaveBeenCalledWith("live");
    cleanup();
  });
  it("queues during unmount and flushes once across effect cleanup and remount", async () => {
    const { globalFeedback, registerFeedback } = await import("@/lib/feedback");
    const first = createTestFeedback();
    registerFeedback(first)();
    globalFeedback.message.error("between mounts");
    const next = createTestFeedback();
    registerFeedback(next)();
    registerFeedback(next)();
    expect(first.message.error).not.toHaveBeenCalled();
    expect(next.message.error).toHaveBeenCalledExactlyOnceWith("between mounts");
  });
});
