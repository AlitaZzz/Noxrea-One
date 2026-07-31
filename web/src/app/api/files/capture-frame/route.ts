import { NextRequest } from "next/server";
import { authenticateRequest } from "@server/core/auth/middleware";
import { captureVideoFrame } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";
import { ok, fail } from "@server/core/response";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

/** 项目根目录的 uploads（兼容 Next.js cwd=web/） */
function getUploadDir(): string {
  let dir = path.resolve(process.cwd(), "uploads");
  const parentDir = path.resolve(process.cwd(), "..");
  const parentUploads = path.resolve(parentDir, "uploads");
  if (existsSync(parentUploads) && existsSync(path.resolve(parentUploads, "3"))) {
    dir = parentUploads;
  }
  return dir;
}

const UPLOAD_DIR = getUploadDir();

export async function POST(request: NextRequest) {
  const auth = await authenticateRequest(request);
  if ("error" in auth) return auth.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  const { video_key, time } = body as {
    video_key?: string;
    time?: number;
  };

  if (!video_key) return fail(400, "video_key is required");

  const videoPath = path.resolve(UPLOAD_DIR, video_key);

  try {
    await fs.access(videoPath);
  } catch {
    return fail(404, "Video file not found");
  }

  const ext = path.extname(video_key);
  const frameKey = video_key.replace(ext, `_frame_${time ?? 1}.jpg`);
  const framePath = path.resolve(UPLOAD_DIR, frameKey);

  try {
    await captureVideoFrame(videoPath, framePath, time ?? 1);
    return Response.json(
      ok({
        frame_key: frameKey,
        url: `/api/files/${frameKey}`,
      })
    );
  } catch (err: any) {
    return fail(500, err.message ?? "Frame capture failed");
  }
}
