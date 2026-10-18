/**
 * 派生 key 形态知识单点（specs/file-access-ownership.md 业务规则 7）。
 *
 * 四个派生命名空间（`_cache`/`_posters`/`_sprite`/`_proxy`）的构造与解析同址：
 * 构造端（缩放缓存、海报母版、雪碧图、预览代理）与归属解析端（ownership.ts）
 * 共用同一模块——格式知识一旦分裂，构造端的漂移会被读路由的 fail-closed
 * 静默化为「缓存未命中」（新产物 404），唯有同址 + 往返测试能即时暴露。
 * key 形态基础（内容键 stem）单点在 shared/url。
 */
import { storageKeyStem } from "@noxrea/shared/url";

/** 解析端形态（stem 捕获组 = 内嵌源键）；与上方构造函数一一对应，同址维护 */
const DERIVED_KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /^_cache\/\d+\/(.+)\.webp$/,
  /^_posters\/v\d+\/(.+)\.webp$/,
  /^_sprite\/(.+)_c\d+v\d+\.webp$/,
  /^_proxy\/(.+)_w\d+v\d+\.mp4$/,
];

/** 缩放缓存（图片与视频海报档位共用）：`_cache/{tier}/{源键去扩展名}.webp` */
export function cacheKeyOf(storageKey: string, tier: number): string {
  return `_cache/${tier}/${storageKeyStem(storageKey)}.webp`;
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
  for (const pattern of DERIVED_KEY_PATTERNS) {
    const m = pattern.exec(key);
    if (m) return m[1];
  }
  return null;
}
