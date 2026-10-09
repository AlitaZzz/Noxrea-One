import type { Context } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodType } from "zod";
import type { FrameSelection } from "@noxrea/shared";

import type { MediaEditContext } from "@server/http/routes/media-edit";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(), probeImage: vi.fn(), persist: vi.fn(),
}));
vi.mock("@server/services/storage/video-frames", () => ({ captureVideoFrame: mocks.capture }));
vi.mock("@server/services/storage/media-probe", () => ({
  probeImageMeta: mocks.probeImage,
}));
vi.mock("@server/http/routes/media-edit", () => ({
  persistDerived: mocks.persist,
  createMediaEditRoute: (options: { schema: ZodType; run: (ctx: MediaEditContext<{ video_key: string; selection: FrameSelection }>) => Promise<Response> }) => async (c: Context) => {
    const parsed = options.schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "invalid_request" }, 422);
    try {
      return await options.run({ c, data: parsed.data, sourceKey: "1/test.mp4", sourcePath: "source.mp4", userId: 1, signal: c.req.raw.signal, tmpDir: "temp" });
    } catch {
      return c.json({ error: "capture_failed" }, 500);
    }
  },
}));

import { router } from "@server/http/routes/capture-frame";

const post = (selection: unknown, signal?: AbortSignal) => router.request("/api/files/capture-frame", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ video_key: "1/test.mp4", selection }), signal,
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.capture.mockResolvedValue(32.8);
  mocks.probeImage.mockResolvedValue({ width: 1280, height: 720 });
  mocks.persist.mockResolvedValue({ key: "1/frame.jpg", url: "/api/files/1/frame.jpg" });
});

describe("capture-frame source metadata", () => {
  it("resolves last-frame intent on the server and returns the captured image dimensions", async () => {
    const res = await post({ kind: "last" });
    expect(res.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledWith("source.mp4", expect.any(String), { kind: "last" }, expect.any(AbortSignal));
    expect(await res.json()).toMatchObject({ data: { time: 32.8, width: 1280, height: 720 } });
  });

  it("returns the actual selected timestamp for a truncated video's last frame", async () => {
    mocks.capture.mockResolvedValue(6.5);
    const res = await post({ kind: "last" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { time: 6.5 } });
  });

  it("captures an explicit time without requiring video duration probing", async () => {
    mocks.capture.mockResolvedValue(5);
    const res = await post({ kind: "time", seconds: 5 });
    expect(res.status).toBe(200);
    expect(mocks.capture).toHaveBeenCalledWith("source.mp4", expect.any(String), { kind: "time", seconds: 5 }, expect.any(AbortSignal));
    expect(await res.json()).toMatchObject({ data: { time: 5 } });
  });

  it("fails explicitly when no frame can be decoded", async () => {
    mocks.capture.mockRejectedValue(new Error("No decoded video frame available"));
    expect((await post({ kind: "last" })).status).toBe(500);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("passes cancellation to tail decoding and never persists an aborted result", async () => {
    const controller = new AbortController();
    mocks.capture.mockImplementation(async (_source, _output, _time, signal: AbortSignal) => {
      controller.abort();
      signal.throwIfAborted();
    });
    expect((await post({ kind: "last" }, controller.signal)).status).toBe(500);
    expect(mocks.capture.mock.calls[0][3].aborted).toBe(true);
    expect(mocks.probeImage).not.toHaveBeenCalled();
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it("does not persist a result cancelled during image probing", async () => {
    const controller = new AbortController();
    mocks.probeImage.mockImplementation(async () => {
      controller.abort();
      return { width: 1280, height: 720 };
    });
    expect((await post({ kind: "last" }, controller.signal)).status).toBe(500);
    expect(mocks.persist).not.toHaveBeenCalled();
  });

  it.each([null, -1, -2, "5", { kind: "time", seconds: -1 }, { kind: "time", seconds: "5" }, { kind: "last", seconds: 3 }])("rejects invalid frame selection %s", async (selection) => {
    expect((await post(selection)).status).toBe(422);
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
