/**
 * JWT 签发与校验。
 * 基于 jose 实现访问令牌的签发、解码与过期校验。
 */
import * as jose from "jose";
import { getConfig } from "@server/core/config";

export interface TokenPayload {
  sub: string; // user_id as string
  username: string;
  exp?: number;
}

function getSecret(): Uint8Array {
  const cfg = getConfig();
  return new TextEncoder().encode(cfg.JWT_SECRET_KEY);
}

/** 签发 access token */
export async function createAccessToken(
  userId: number,
  username: string
): Promise<string> {
  const cfg = getConfig();
  const secret = getSecret();

  const token = await new jose.SignJWT({
    sub: String(userId),
    username,
  })
    .setProtectedHeader({ alg: cfg.JWT_ALGORITHM })
    .setIssuedAt()
    .setExpirationTime(`${cfg.JWT_EXPIRE_MINUTES}m`)
    .sign(secret);

  return token;
}

/** 校验并解码 access token，失败返回 null */
export async function decodeAccessToken(
  token: string
): Promise<TokenPayload | null> {
  const cfg = getConfig();
  const secret = getSecret();

  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: [cfg.JWT_ALGORITHM],
    });

    if (!payload.sub) return null;

    return {
      sub: payload.sub,
      username: (payload.username as string) ?? "",
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
