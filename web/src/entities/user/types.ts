/**
 * 当前用户领域类型。
 * 只包含身份与储量契约，不依赖 React 或浏览器 API。
 */

export interface UserInfo {
  id: number;
  username: string;
  /** 头像引用：存储 key（{userId}/{hash[:2]}/{hash}{ext}，头像只来自上传）；访问地址由 useFileAccessUrl 换取 */
  avatarKey: string | null;
  theme: string;
  language: string;
}

/** 存储摘要（specs/storage-user-quota.md 规则 5）：quotaBytes 为 null 表示不限量 */
export interface StorageSummary {
  usedBytes: number;
  quotaBytes: number | null;
}

/** GET/PUT /api/auth/me 响应：用户契约字段 + 存储摘要（两处理器恒组合，同资源表示一致） */
export interface MeResponse extends UserInfo {
  storage: StorageSummary;
}

/** 账户资料局部更新：只提交实际变更的字段，密码修改必须同时提供旧密码。 */
export interface ProfilePatch {
  avatarKey?: string;
  password?: string;
  oldPassword?: string;
}
