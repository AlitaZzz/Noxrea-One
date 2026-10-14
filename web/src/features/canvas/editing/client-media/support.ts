/**
 * 客户端媒体管线的纯逻辑辅助：进度区间映射与输出码率决策。
 * 裁剪矩形钳位已下沉 @noxrea/shared/crop-rect（前后端单一实现）。
 * 不依赖浏览器 API，可在 Node 测试环境中单测。
 */

/**
 * 探测失败的负缓存（会话级，模块生命周期）：键为「探测档位 + 源 URL」。档位
 * 表达探测要求，要求少的档失败蕴含要求多的档必败——
 * - video-mux（容器可解析 + 视频轨有编码描述，分离音轨所需）：失败封杀全部视频操作；
 * - video-decode（在 mux 之上再加 WebCodecs 解码能力，片段截取 / 裁剪所需）：
 *   失败不封杀 mux 档——描述在、无硬解的源仍可客户端纯重封装；
 * - audio（容器可解析 + 音频轨可解码，音频变速 / 音频截取所需）。
 */
type ProbeLevel = "video-mux" | "video-decode" | "audio";

/** 查询各档位时需要检查的缓存键：video-mux 失败蕴含 video-decode 必败，故封杀两档；
    video-decode 失败对 mux 档无定论，不封杀 */
const BLOCKING_LEVELS: Record<ProbeLevel, ProbeLevel[]> = {
  "video-mux": ["video-mux"],
  "video-decode": ["video-mux", "video-decode"],
  audio: ["audio"],
};

const unsupportedProbes = new Set<string>();
const probeCacheKey = (level: ProbeLevel, url: string) => `${level}\n${url}`;

/** 该档位探测此前是否已失败过（命中即跳过打开解析，直接走服务端兜底） */
export function isProbeUnsupported(level: ProbeLevel, url: string): boolean {
  return BLOCKING_LEVELS[level].some(
    (blocked) => unsupportedProbes.has(probeCacheKey(blocked, url)),
  );
}

/** 记录一次探测失败（只记本次探测命中的档位） */
export function markProbeUnsupported(level: ProbeLevel, url: string): void {
  unsupportedProbes.add(probeCacheKey(level, url));
}

/**
 * 子任务进度 → 总进度区间的唯一投影原语：fraction 为 0–1 分数（mediabunny
 * onProgress、逐帧计数与上传百分比的统一换算口径，百分比调用方 /100），
 * 映射到 [base, base+span] 并钳位在段内——浮点边界越界不越过段顶。
 */
export function mapFraction(fraction: number, base: number, span: number): number {
  return Math.min(base + span, base + Math.round(fraction * span));
}

/**
 * 输出码率决策（specs/client-video-editing.md 输出规格）：
 * 重编码无法增加信息，输出码率以源视频码率为上限；画面缩小时按有效像素占比
 * 折减；1 Mbps 下限防止极简画面退化到不可看（下限不超过源上限）。
 * 源码率信息缺失、非有限值或取整后为 0（亚 0.5bps 的病态源）时返回
 * undefined——交由编码器 quality 抽象全权决定
 * （mediabunny computePacketStats 在时长为 0 时会给出 Infinity/NaN）。
 * 返回值恒为正整数：编码器（mediabunny Quality / WebCodecs）拒绝非整数，而
 * 源码率本身是浮点（8×字节数/时长），作上限/下限时同样必须取整。
 */
export function resolveVideoBitrate(
  sourceBitrate: number | null,
  pixelRatio: number,
): number | undefined {
  if (sourceBitrate == null || !Number.isFinite(sourceBitrate) || sourceBitrate <= 0) {
    return undefined;
  }
  // 比例非有限（异常输入）时按整幅处理：保留源码率上限信息，不做缩放
  const ratio = Number.isFinite(pixelRatio) ? Math.min(1, Math.max(0, pixelRatio)) : 1;
  const cap = Math.round(sourceBitrate);
  // 上限取整后为 0（亚 0.5bps 的病态源）：源码率已无可用信息，交由编码器自决
  if (cap === 0) return undefined;
  const raw = Math.round(sourceBitrate * ratio);
  const floor = Math.min(1_000_000, cap);
  return Math.min(cap, Math.max(floor, raw));
}
