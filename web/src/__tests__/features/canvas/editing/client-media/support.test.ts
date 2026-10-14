/**
 * 客户端媒体管线的纯逻辑单测：探测失败负缓存（档位格）、裁剪矩形钳位
 * （@noxrea/shared/crop-rect 唯一实现，服务端同用例见
 * server/__tests__/http/routes/crop-video.test.ts）与输出码率决策（源码率封顶、
 * 像素占比折减、1 Mbps 下限）。编解码胶水层依赖浏览器 WebCodecs，由真实浏览器
 * 走查覆盖（jsdom 无 WebCodecs）。
 */
import { clampRect } from "@noxrea/shared/crop-rect";
import { describe, expect, it } from "vitest";

import {
  isProbeUnsupported,
  mapFraction,
  markProbeUnsupported,
  resolveVideoBitrate,
} from "@/features/canvas/editing/client-media/support";

describe("mapFraction（0–1 分数 → 总进度区间映射，段内钳位）", () => {
  it("映射到 [base, base+span] 并钳位在段内", () => {
    expect(mapFraction(0, 0, 90)).toBe(0);
    expect(mapFraction(1, 0, 90)).toBe(90);
    expect(mapFraction(0.5, 40, 40)).toBe(60); // 40 + 20
    expect(mapFraction(0.5, 45, 45)).toBe(68); // 45 + 22.5 → 68（上传段口径同形状）
    // 浮点边界越界钳位在段顶（原内联 Math.min(90, …) 写法的等价收口）
    expect(mapFraction(1.2, 0, 90)).toBe(90);
  });
});

describe("探测失败负缓存（档位格，会话级）", () => {
  // 每用例独立 URL：缓存是模块生命周期，URL 隔离即用例隔离
  it("mux 档失败同时封杀 mux 与 decode 查询（弱档失败蕴含强档必败）", () => {
    const url = "/api/files/mux-fail.mkv";
    markProbeUnsupported("video-mux", url);
    expect(isProbeUnsupported("video-mux", url)).toBe(true);
    expect(isProbeUnsupported("video-decode", url)).toBe(true);
    // audio 档探测独立（音频轨能力与视频轨编码描述无蕴含关系）
    expect(isProbeUnsupported("audio", url)).toBe(false);
  });

  it("decode 档失败不封杀 mux 档（描述在、无硬解仍可纯重封装）", () => {
    const url = "/api/files/decode-fail.mkv";
    markProbeUnsupported("video-decode", url);
    expect(isProbeUnsupported("video-decode", url)).toBe(true);
    expect(isProbeUnsupported("video-mux", url)).toBe(false);
  });

  it("audio 档失败只封杀 audio 查询", () => {
    const url = "/api/files/audio-fail.mkv";
    markProbeUnsupported("audio", url);
    expect(isProbeUnsupported("audio", url)).toBe(true);
    expect(isProbeUnsupported("video-mux", url)).toBe(false);
    expect(isProbeUnsupported("video-decode", url)).toBe(false);
  });

  it("不同 URL 互不干扰", () => {
    markProbeUnsupported("video-mux", "/api/files/one.mp4");
    expect(isProbeUnsupported("video-mux", "/api/files/other.mp4")).toBe(false);
  });

  it("未记录失败的档位查询返回 false（成功不缓存）", () => {
    expect(isProbeUnsupported("video-mux", "/api/files/never-probed.mp4")).toBe(false);
  });
});

describe("clampRect（与服务端同语义）", () => {
  it("宽高与偏移取偶并钳进源画面", () => {
    expect(clampRect({ x: 3, y: 5, width: 101, height: 51 }, 1920, 1080)).toEqual({
      x: 2,
      y: 4,
      width: 100,
      height: 50,
    });
  });

  it("矩形超出源画面时钳回边界内（偏移钳位、尺寸保留）", () => {
    expect(clampRect({ x: 1910, y: 1070, width: 100, height: 100 }, 1920, 1080)).toEqual({
      x: 1820,
      y: 980,
      width: 100,
      height: 100,
    });
  });

  it("小于最小值的宽高兜底到 2×2", () => {
    expect(clampRect({ x: 10, y: 10, width: 1, height: 1 }, 1920, 1080)).toEqual({
      x: 10,
      y: 10,
      width: 2,
      height: 2,
    });
  });
});

describe("resolveVideoBitrate（源码率封顶 + 像素占比折减 + 下限）", () => {
  it("以源码率为上限：低码率源不被膨胀", () => {
    expect(resolveVideoBitrate(2_000_000, 1)).toBe(2_000_000);
  });

  it("画面缩小时按有效像素占比折减", () => {
    expect(resolveVideoBitrate(8_000_000, 0.25)).toBe(2_000_000);
  });

  it("1 Mbps 下限防退化，但不超过源码率", () => {
    // 源 4 Mbps、占比 0.1：原始 0.4 Mbps → 抬到 1 Mbps 下限（低于源上限）
    expect(resolveVideoBitrate(4_000_000, 0.1)).toBe(1_000_000);
    // 源只有 0.5 Mbps：下限不能越过源上限
    expect(resolveVideoBitrate(500_000, 1)).toBe(500_000);
  });

  it("占比超过 1 时按 1 封顶（不因输出大于源而抬升码率）", () => {
    expect(resolveVideoBitrate(2_000_000, 4)).toBe(2_000_000);
  });

  it("占比非有限（NaN / Infinity）按整幅处理，保留源码率上限", () => {
    // 回归：NaN 会穿透 min/max 钳位直达输出，Quality({bitrate: NaN}) 抛错
    expect(resolveVideoBitrate(2_000_000, Number.NaN)).toBe(2_000_000);
    expect(resolveVideoBitrate(8_000_000.6, Number.NaN)).toBe(8_000_001);
    expect(resolveVideoBitrate(4_000_000, Number.POSITIVE_INFINITY)).toBe(4_000_000);
  });

  it("源码率信息缺失时返回 undefined（交由编码器 quality 全权决定）", () => {
    expect(resolveVideoBitrate(null, 1)).toBeUndefined();
    expect(resolveVideoBitrate(0, 1)).toBeUndefined();
  });

  it("亚 0.5bps 病态源（上限取整后为 0）返回 undefined，不产出非法 bitrate", () => {
    // 回归：cap=Math.round(0.4)=0 时原实现返回 0（违反正整数契约），
    // Quality({bitrate: 0}) 抛 TypeError → 不必要的回退服务端
    expect(resolveVideoBitrate(0.4, 1)).toBeUndefined();
  });

  it("非有限源码率（Infinity / NaN）回退 undefined，不产出非法 bitrate", () => {
    // 回归：mediabunny computePacketStats 在时长为 0 时给出 Infinity（8×bytes/0），
    // 原守卫 `<= 0` 拦不住 → Quality({bitrate: Infinity}) 抛错且 URL 进负缓存
    expect(resolveVideoBitrate(Number.POSITIVE_INFINITY, 1)).toBeUndefined();
    expect(resolveVideoBitrate(Number.NaN, 1)).toBeUndefined();
  });

  it("返回值恒为正整数（源码率为浮点时，上限/下限同样取整）", () => {
    // 回归：mediabunny Quality 拒绝非整数 bitrate——浮点源码率在 ratio=1 时
    // 经 Math.min(sourceBitrate, raw) 原样返回浮点，构造 Quality 即抛
    // 「must be a positive integer」（mkv 片段截取实测触发）
    expect(resolveVideoBitrate(999_999.5, 1)).toBe(1_000_000);
    expect(Number.isInteger(resolveVideoBitrate(8_000_000.6, 1))).toBe(true);
    // ratio<1 同样走整数路径（此前恰好因返回折减值而侥幸通过）
    expect(Number.isInteger(resolveVideoBitrate(8_000_000.6, 0.4))).toBe(true);
    // 下限与上限重合（低码率源）时也必须是整数
    expect(Number.isInteger(resolveVideoBitrate(500_000.5, 0.1))).toBe(true);
  });
});
