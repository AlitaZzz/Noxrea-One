/**
 * 密码哈希与校验。
 * 基于 bcrypt 提供密码的单向哈希与比对能力。
 */
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

/** 哈希密码，返回 $2b$ 格式 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  return bcrypt.hash(password, salt);
}

/** 校验明文密码与哈希值 */
export async function verifyPassword(
  plainPassword: string,
  hashedPassword: string
): Promise<boolean> {
  return bcrypt.compare(plainPassword, hashedPassword);
}
