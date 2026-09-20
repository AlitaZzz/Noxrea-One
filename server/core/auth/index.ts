/**
 * 认证模块聚合出口。
 * 统一导出 JWT 签发/校验与密码哈希等纯逻辑能力；
 * 依赖 Hono 的请求鉴权中间件在 http/middleware/auth.ts。
 */
export { createAccessToken, decodeAccessToken } from "./jwt";
export type { TokenPayload } from "./jwt";
export { hashPassword, verifyPassword } from "./password";
