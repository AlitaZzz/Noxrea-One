/**
 * S3 兼容提供方 profile（specs/storage-provider-portability.md 规则 1 / 4）。
 *
 * 厂商差异只在这里表达一次：profile 决定「寻址风格候选」与「已知能力基线」，
 * 启动探测再以真实结果覆盖能力位。此后业务代码只读能力位，不读 profile 名
 * （规则 1.2 / 4.4）——否则就是把配置知识漏进业务层。
 */

/** 支持方：`generic` 表示未知实现，寻址风格交由启动探测决定 */
export type StorageProvider = "minio" | "aws" | "r2" | "oss" | "cos" | "generic";

/** 寻址风格：path-style（`<host>/<bucket>/<key>`）与虚拟主机（`<bucket>.<host>/<key>`） */
export type AddressingStyle = "path" | "virtual";

/**
 * 进程级能力位（规则 4.1）：启动探测得出，运行期不变量（规则 3.8）。
 *
 * 只收「可能为假、且为假时改变行为」的位。预签名回读不在此列：它是探测致命项，
 * 不通过即启动失败，进入服务态的进程该位恒为真——一个恒真且无人分支的位只会
 * 让人以为存在降级路径。
 */
export interface StorageCapabilities {
  /** 实际生效的寻址风格（`generic` 由探测得出） */
  addressing: AddressingStyle;
  /** 端点是否遵守预签名 URL 的 `response-*` 覆盖；false 时下载降级为 `stream`（规则 4.2） */
  responseOverrides: boolean;
  /** bucket 是否对浏览器跨源放行（只警告不失败：缺陷面仅限浏览器读图） */
  browserCors: boolean;
}

interface StorageProviderProfile {
  /**
   * 寻址候选，顺序即尝试顺序。已知 profile 只有一个候选（配错即刻暴露），
   * `generic` 先虚拟主机后 path-style（规则 1.3 / 1.6）。
   */
  readonly addressing: readonly [AddressingStyle, ...AddressingStyle[]];
  /**
   * 能力基线：探测前（或后端被注入、未执行探测时）的口径。
   * `responseOverrides` 按「已知实现遵守或忽略」取 true——最坏后果只是响应头未生效
   * （下载名退化），不构成正确性问题；探测会把真实结果写回。
   * CORS 是环境/桶配置的属性，没有任何先验理由取 true，只由探测置真。
   */
  readonly capabilities: Omit<StorageCapabilities, "addressing">;
}

const BASELINE_CAPABILITIES: Omit<StorageCapabilities, "addressing"> = {
  responseOverrides: true,
  browserCors: false,
};

/** profile 表（规则 1.3）：寻址风格一栏的唯一来源 */
export const STORAGE_PROVIDER_PROFILES: Record<StorageProvider, StorageProviderProfile> = {
  // 自建端点通常没有通配 DNS / 证书，只有 path-style 可达
  minio: { addressing: ["path"], capabilities: BASELINE_CAPABILITIES },
  aws: { addressing: ["virtual"], capabilities: BASELINE_CAPABILITIES },
  // R2 两种寻址皆可，取官方推荐形态
  r2: { addressing: ["virtual"], capabilities: BASELINE_CAPABILITIES },
  // 阿里云 OSS 的 S3 兼容接口不支持 path-style
  oss: { addressing: ["virtual"], capabilities: BASELINE_CAPABILITIES },
  // 腾讯云 COS 2024-01-01 后新建桶强制虚拟主机寻址
  cos: { addressing: ["virtual"], capabilities: BASELINE_CAPABILITIES },
  // 未知实现：先虚拟主机，失败再退回 path-style；两种都失败即启动失败
  generic: { addressing: ["virtual", "path"], capabilities: BASELINE_CAPABILITIES },
};

/** 探测顺序（规则 1.3）：首个候选即构造后端时的缺省寻址 */
export function addressingCandidates(provider: StorageProvider): readonly AddressingStyle[] {
  return STORAGE_PROVIDER_PROFILES[provider].addressing;
}

/** 能力基线（探测前的口径；探测完成后由后端以真实结果覆盖） */
export function baselineCapabilities(provider: StorageProvider): StorageCapabilities {
  const profile = STORAGE_PROVIDER_PROFILES[provider];
  return { ...profile.capabilities, addressing: profile.addressing[0] };
}
