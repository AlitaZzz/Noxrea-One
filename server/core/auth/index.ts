/**
 * 认证模块聚合出口。
 * 统一导出 JWT、密码哈希与请求鉴权等认证相关能力。
 */
export { createAccessToken, decodeAccessToken } from "./jwt";
export type { TokenPayload } from "./jwt";
export { hashPassword, verifyPassword } from "./password";
export {
  authenticateRequest,
  ensureAdminExists,
  toAuthUser,
} from "./middleware";
export type { AuthUser } from "./middleware";
