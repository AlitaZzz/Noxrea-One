/**
 * 视频上传体检单测（probeUploadVideo，属 media-probe 规则层）：
 * 池过载按「无法体检」吞掉、不使上传失败；截断文件产出 declared/decodable 警告；
 * 探测预算与属主透传给完整解码探测。经 ./ffmpeg 跨模块缝打桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ffmpegMocks = vi.hoisted(() => ({
  probeFfmpeg: vi.fn(),
  probeFfmpegDecode: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: "uploads",
    FFMPEG_PATH: "ffmpeg",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));
vi.mock("@server/core/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));
vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/services/storage/service", () => ({
  // 预签名按 key 派生：探测缓存以输入串为键，用例间不得共享条目
  getStorageBackend: () => ({ presignGet: async (key: string) => `https://signed/${key}` }),
}));
vi.mock("@server/services/storage/ffmpeg", () => ({
  probeFfmpeg: ffmpegMocks.probeFfmpeg,
  probeFfmpegDecode: ffmpegMocks.probeFfmpegDecode,
}));

import { probeUploadVideo } from "@server/services/storage/media-probe";
import { MediaPoolBusyError } from "@server/services/storage/media-pool";

/** probeFfmpeg 的标准容器信息输出（Duration 10s / 128x720 / 30fps） */
const META_STDERR = "Duration: 00:00:10.00, start: 0.000000\nStream #0:0 Video: h264, 128x720, 30 fps,";

describe("probeUploadVideo（视频上传体检）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("媒体池过载：按「无法体检」返回 undefined，不使上传失败", async () => {
    ffmpegMocks.probeFfmpeg.mockResolvedValue({ stderr: META_STDERR, killed: false, spawnFailed: false });
    ffmpegMocks.probeFfmpegDecode.mockRejectedValue(new MediaPoolBusyError("ffmpeg_heavy", "global", "queue_full"));

    await expect(probeUploadVideo("3/aa/busy.mp4", 7)).resolves.toBeUndefined();
  });

  it("截断视频：返回 declared/decodable 警告，探测预算与属主透传", async () => {
    ffmpegMocks.probeFfmpeg.mockResolvedValue({ stderr: META_STDERR, killed: false, spawnFailed: false });
    ffmpegMocks.probeFfmpegDecode.mockResolvedValue({
      stderr: "frame= 1 fps=0.0 q=-1.0 size=N/A time=00:00:05.00 bitrate=N/A speed=10x",
      killed: false,
      spawnFailed: false,
    });

    await expect(probeUploadVideo("3/ab/truncated.mp4", 7)).resolves.toEqual({ declared: 10, decodable: 5 });
    const [, timeoutMs, opts] = ffmpegMocks.probeFfmpegDecode.mock.calls[0];
    expect(timeoutMs).toBe(1500);
    expect(opts).toMatchObject({ owner: 7 });
  });

  it("非视频 key：门槛内聚于探测入口，不探测直接 undefined", async () => {
    await expect(probeUploadVideo("3/ad/pic.png", 7)).resolves.toBeUndefined();
    expect(ffmpegMocks.probeFfmpeg).not.toHaveBeenCalled();
    expect(ffmpegMocks.probeFfmpegDecode).not.toHaveBeenCalled();
  });

  it("无时长元数据：跳过完整解码体检", async () => {
    ffmpegMocks.probeFfmpeg.mockResolvedValue({ stderr: "Duration: N/A", killed: false, spawnFailed: false });

    await expect(probeUploadVideo("3/ac/metaless.mp4", 7)).resolves.toBeUndefined();
    expect(ffmpegMocks.probeFfmpegDecode).not.toHaveBeenCalled();
  });
});
