/**
 * 密码哈希与校验。
 * 基于 bcrypt 提供密码的单向哈希与比对能力。
 *
 * 哈希与比对前统一做 Unicode NFC 规范化：
 * 同一个字符可能存在多种 Unicode 表示（如 é 既可以是 U+00E9 单个码位，
 * 也可以是 e + U+0301 两个码位）。若不规范化，用户在不同输入法 / 设备上
 * 注册与登录会产出不同的字节序列，导致必然登录失败且用户无法自查。
 *
 * 依据 NIST SP 800-63B：接受 Unicode 密码的 verifier SHOULD 在哈希前
 * 应用 NFC 规范化。纯 ASCII 密码经 NFC 后完全不变，
 * 因此该改动对既有账号向后兼容，无需迁移。
 */
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

/**
 * 密码规范化（NFC）。
 * 哈希侧与比对侧必须都经过本函数，才能保证同一密码
 * 在任何输入方式下得到一致的字节序列。
 */
function normalizePassword(password: string): string {
  return password.normalize("NFC");
}

/** 哈希密码，返回 $2b$ 格式 */
export async function hashPassword(password: string): Promise<string> {
  const salt = await bcrypt.genSalt(BCRYPT_ROUNDS);
  return bcrypt.hash(normalizePassword(password), salt);
}

/** 校验明文密码与哈希值 */
export async function verifyPassword(
  plainPassword: string,
  hashedPassword: string
): Promise<boolean> {
  return bcrypt.compare(normalizePassword(plainPassword), hashedPassword);
}
