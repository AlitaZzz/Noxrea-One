/** 前后端共同使用的托管文件 URL 前缀。 */
export const MANAGED_FILE_PATH = "/api/files/";

/** 提取托管文件 URL 的 pathname，忽略 query、hash 和非 HTTP 资源。 */
export function getManagedFilePathname(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url) return null;
  if (url.startsWith(MANAGED_FILE_PATH)) {
    const end = url.search(/[?#]/);
    return end === -1 ? url : url.slice(0, end);
  }
  if (!url.startsWith("//") && !/^https?:\/\//i.test(url)) return null;

  try {
    const parsed = new URL(url, "http://noxrea.invalid");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.pathname.includes(MANAGED_FILE_PATH) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** 去掉 URL 末尾的一个或多个斜杠。 */
export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * 存储 key 的严格形态：`{userId}/{hash[:2]}/{hash}{ext}`。
 * userId 为十进制数字，hash 为 64 位十六进制 SHA256，扩展名可有可无（含前导点）。
 * 这是托管文件在数据库与画布数据中的唯一持久化形态；`/api/files/` URL 一律为
 * 派生物（DTO 与前端渲染时由 buildManagedFileUrl 构造），不得入库。
 * 捕获组供 hashFromStorageKey 提取 hash，key 段结构知识单点于此。
 */
export const STORAGE_KEY_PATTERN = /^(?:\d+)\/([0-9a-f]{2})\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/;

/** 判断值是否为存储 key 严格形态（外部 URL、data: URL、blob: URL 均不匹配）。 */
export function isStorageKey(value: unknown): value is string {
  return typeof value === "string" && STORAGE_KEY_PATTERN.test(value);
}

/**
 * 从存储 key 中提取 64 位内容 hash（file_objects PK 的构成要素）。
 * 仅识别 key 严格形态：外部 URL 与非法值返回 null（与外部 URL 不入账本的语义一致）。
 * 中段 2 位是 hash 前缀冗余（hash[:2]），完整 hash 即末段扩展名前部分，由捕获组 2 提取。
 */
export function hashFromStorageKey(value: string): string | null {
  const m = STORAGE_KEY_PATTERN.exec(value);
  return m ? m[2] : null;
}

/** 外部文件引用：他源 http(s) URL（画布节点与资产的长期支持值域，不入引用账本）。 */
export function isExternalFileUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/**
 * 托管文件引用值的入库值域（资产 fileKey / 头像 avatarKey 等写入边界的唯一校验规则）：
 * 存储 key 严格形态，或外部 http(s) URL（原样保留、不入引用账本）。
 * data: / blob: 仅存在于渲染期，不持久化，不在入库值域。
 */
export function isFileRefValue(value: string): boolean {
  return isStorageKey(value) || isExternalFileUrl(value);
}

/** 由存储 key 构造托管文件的访问路径（`/api/files/{key}`）。key 必须通过 isStorageKey 校验。 */
export function buildManagedFileUrl(key: string): string {
  return `${MANAGED_FILE_PATH}${key}`;
}

/**
 * 引用值 → 访问 URL 的唯一规则（前后端 DTO/渲染共用）：
 * 存储 key 派生 `/api/files/{key}`；其余值域（外部 http(s)、data:、blob:）原样透传。
 * key 的判别内聚于此，调用方不得再自行 isStorageKey 分流。
 */
export function resolveFileUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  return isStorageKey(value) ? buildManagedFileUrl(value) : value;
}
