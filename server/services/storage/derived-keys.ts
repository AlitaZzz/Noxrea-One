/**
 * 派生 key 形态知识单点（specs/file-access-ownership.md 业务规则 7、specs/derived-deletion-linkage.md 规则 1/2）。
 *
 * 四个派生命名空间（`_cache`/`_posters`/`_sprite`/`_proxy`）的构造、解析、删除联动枚举三面同址：
 * 构造端（缩放缓存、海报母版、雪碧图、预览代理）、归属解析端（ownership.ts）与删除联动枚举端
 * （backend.ts listDerivedArtifactKeys）共用同一模块——格式知识一旦分裂，构造端的漂移会被读路由的
 * fail-closed 静默化为「缓存未命中」（新产物 404）、被删除联动静默化为「漏删」，唯有同址 +
 * 往返测试能即时暴露。key 形态基础（内容键 stem）单点在 shared/url。
 */
import {
  RESIZE_CACHE_VERSION,
  RESIZE_WIDTH_TIERS,
} from "@noxrea/shared/media-tiers";
import { isStorageKey, STORAGE_KEY_STEM_PATTERN, storageKeyStem } from "@noxrea/shared/url";

/** 当前 `_cache` 命名空间根：版本段由共享常量生成，运行期只识别当前版本（不兼容旧版本） */
const RESIZE_CACHE_ROOT = `_cache/v${RESIZE_CACHE_VERSION}`;

/** 派生档位：四个命名空间与指标 `tier` 标签同一取值集（`@server/core/metrics` 的联合类型与此同构） */
type DerivedTier = "cache" | "poster" | "sprite" | "proxy";

/** 解析端形态（stem 捕获组 = 内嵌源键）与档位同址：与上方构造函数一一对应，同址维护 */
const DERIVED_KEY_PATTERNS: ReadonlyArray<{ tier: DerivedTier; pattern: RegExp }> = [
  { tier: "cache", pattern: new RegExp(`^${RESIZE_CACHE_ROOT}/(?:\\d+)/(.+)\\.webp$`) },
  { tier: "poster", pattern: /^_posters\/v\d+\/(.+)\.webp$/ },
  { tier: "sprite", pattern: /^_sprite\/(.+)_c\d+v\d+\.webp$/ },
  { tier: "proxy", pattern: /^_proxy\/(.+)_w\d+v\d+\.mp4$/ },
];

function matchDerivedKey(key: string): { tier: DerivedTier; stem: string } | null {
  for (const { tier, pattern } of DERIVED_KEY_PATTERNS) {
    const m = pattern.exec(key);
    if (m) return { tier, stem: m[1] };
  }
  return null;
}

/** 缩放缓存（图片与视频海报档位共用）：`_cache/v2/{tier}/{源键去扩展名}.webp` */
export function cacheKeyOf(storageKey: string, tier: number): string {
  return `${RESIZE_CACHE_ROOT}/${tier}/${storageKeyStem(storageKey)}.webp`;
}

/** 视频海报母版：`_posters/v{version}/{源键去扩展名}.webp`（版本由海报特性持有） */
export function posterMasterKey(storageKey: string, version: number): string {
  return `_posters/v${version}/${storageKeyStem(storageKey)}.webp`;
}

/** 帧序列雪碧图：`_sprite/{源键去扩展名}_c{count}v{version}.webp`（帧数 + 参数版本段） */
export function spriteKeyOf(sourceKey: string, count: number, version: number): string {
  return `_sprite/${storageKeyStem(sourceKey)}_c${count}v${version}.webp`;
}

/** 预览代理视频：`_proxy/{源键去扩展名}_w{width}v{version}.mp4`（宽度 + 参数版本段） */
export function proxyKeyOf(sourceKey: string, width: number, version: number): string {
  return `_proxy/${storageKeyStem(sourceKey)}_w${width}v${version}.mp4`;
}

/**
 * 派生 key 的内嵌源键（去扩展名 stem）；非派生命名空间 / 旧单向哈希形态返回 null。
 * ownership.ts 据此取内嵌源键再判归属。
 */
export function derivedSourceStemOf(key: string): string | null {
  return matchDerivedKey(key)?.stem ?? null;
}

/**
 * 派生产物的指标档位（`specs/observability-baseline.md` 规则 3.4 的 `tier` 标签）：
 * 与 key 的命名空间同址推导，非派生 key 返回 null。
 *
 * 标签不由调用方声明：档位是 key 形态的函数，声明式标签在复制一次 generate 调用后
 * 就会与实际写入的命名空间各说各话（`_cache` 里的视频海报档位曾被标成 `poster`，
 * 指标上凭空多出一个不存在的命名空间组合，且没有任何类型能拦住）。
 */
export function derivedTierOf(key: string): DerivedTier | null {
  return matchDerivedKey(key)?.tier ?? null;
}

/**
 * 托管文件的**可读键域**（specs/storage-signed-direct-delivery.md 规则 2.1）：内容键
 * （严格 `STORAGE_KEY_PATTERN`）或四个派生命名空间。
 *
 * staging 键被刻意排除：它是直传在途的临时缓冲，尚未 promote 成托管文件，随时会被
 * 按龄清扫；对它签出访问 URL 等于把「可能消失的对象」当正式文件交付。读路由据此
 * 与「对象不存在」同响应（404，防存在性预言机）；归属解析（ownership.ts）仍接受
 * staging——写路径与清扫需要它。
 */
export function isReadableFileKey(key: string): boolean {
  return isStorageKey(key) || derivedSourceStemOf(key) !== null;
}

/** 删除联动枚举候选：精准 shard list 前缀 + 命中判定（specs/derived-deletion-linkage.md 规则 1/2） */
export interface DerivedCandidate {
  /** 精准 shard list 前缀（含尾随 /），list 结果量级 = 该 shard 内的派生对象数 */
  prefix: string;
  /** 判定 listed key 是否为该源 key 的派生产物 */
  test: (listedKey: string) => boolean;
}

/**
 * 内容源 key 的派生枚举候选，四命名空间零全前缀扫描：
 * - `_cache`：版本段固定为当前共享版本，tier 段域静态展开（RESIZE_WIDTH_TIERS），
 *   stem 唯一无参数段，命中判定为整键等值；
 * - `_posters`：版本段动态累积，posterVersions 由调用方经 listCommonPrefixes 发现后传入；
 * - `_sprite`/`_proxy`：shard 段紧随根，参数段（帧数/宽度、版本）以锚定正则命中。
 * posterVersions 传 null 表示后端无子前缀列举能力：`_posters` 退化为一条全前缀候选
 * （锚定正则），联动语义完整、成本回到全扫描。非内容 key（staging/派生/畸形）返回 []——
 * 联动仅对内容源执行（staging 清扫高频，不为每 key 付 list；staging 源派生由 TTL 兜底）。
 */
export function derivedCandidatesOf(
  key: string,
  posterVersions: readonly string[] | null,
): DerivedCandidate[] {
  const stem = storageKeyStem(key);
  const m = STORAGE_KEY_STEM_PATTERN.exec(stem);
  if (!m) return [];
  // stem 段域为 \d+/[0-9a-f]{2}/[0-9a-f]{64}（形态校验已过），无正则元字符，可直接拼入锚定正则
  const shard = `${m[1]}/${m[2]}/`;
  const candidates: DerivedCandidate[] = [];

  for (const tier of RESIZE_WIDTH_TIERS) {
    const derivedKey = `${RESIZE_CACHE_ROOT}/${tier}/${stem}.webp`;
    candidates.push({ prefix: `${RESIZE_CACHE_ROOT}/${tier}/${shard}`, test: (k) => k === derivedKey });
  }

  if (posterVersions === null) {
    const posterAll = new RegExp(`^_posters/v\\d+/${stem}\\.webp$`);
    candidates.push({ prefix: "_posters/", test: (k) => posterAll.test(k) });
  } else {
    for (const version of posterVersions) {
      const derivedKey = `${version}${stem}.webp`; // version 形如 "_posters/v1/"
      candidates.push({ prefix: `${version}${shard}`, test: (k) => k === derivedKey });
    }
  }

  const sprite = new RegExp(`^_sprite/${stem}_c\\d+v\\d+\\.webp$`);
  candidates.push({ prefix: `_sprite/${shard}`, test: (k) => sprite.test(k) });
  const proxy = new RegExp(`^_proxy/${stem}_w\\d+v\\d+\\.mp4$`);
  candidates.push({ prefix: `_proxy/${shard}`, test: (k) => proxy.test(k) });
  return candidates;
}
