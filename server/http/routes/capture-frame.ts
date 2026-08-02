import { Hono } from "hono";
import { authenticateRequest } from "@server/core/auth/middleware";
import { captureVideoFrame } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, fail } from "@server/core/response";
import path from "path";
import fs from "fs/promises";

const router = new Hono();

// ── POST /api/files/capture-frame ──
router.post("/api/files/capture-frame", async (c) => {
  const request = c.req.raw;
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const { video_key, time } = body as {
    video_key?: string;
    time?: number;
  };

  if (!video_key) return fail(400, "video_key is required");

  const videoPath = path.resolve(localStorage.baseDir, video_key);

  try {
    await fs.access(videoPath);
  } catch {
    return fail(404, "Video file not found");
  }

  const ext = path.extname(video_key);
  const frameKey = video_key.replace(ext, `_frame_${time ?? 1}.jpg`);
  const framePath = path.resolve(localStorage.baseDir, frameKey);

  try {
    await captureVideoFrame(videoPath, framePath, time ?? 1);
    return c.json(
      ok({
        frame_key: frameKey,
        url: `/api/files/${frameKey}`,
      })
    );
  } catch (err: unknown) {
    const e = err as Error & { code?: string };
    if (e.code === "ENOENT" || e.message?.includes("ENOENT")) {
      return fail(500, "ffmpeg not found - please install ffmpeg and set FFMPEG_PATH in .env");
    }
    return fail(500, e.message ?? "Frame capture failed");
  }
});

export { router };
