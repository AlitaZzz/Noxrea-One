/**
 * Prisma 错误解读（PostgreSQL driver adapter，specs/pglite-removal.md）。
 *
 * 已验证事实（@prisma/adapter-pg 7.10）：PostgreSQL 23505 的 `error.constraint`
 * 被映射为 meta.driverAdapterError.cause.constraint.index（约束/索引名）；当约束名
 * 存在时 adapter 不填充 fields（fields 仅在无约束名时由 DETAIL 解析）。因此唯一
 * 冲突的判定基准是索引名，而不是列名。
 *
 * 索引名由 prisma/migrations 定义；重命名索引时必须同步调用方与真实库回归测试。
 */
import { Prisma } from "./generated/client";

/** P2002 命中的唯一索引名；非 P2002 或取不到约束名时返回 null。 */
function uniqueConstraintIndex(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return null;
  }
  const meta = error.meta as {
    driverAdapterError?: { cause?: { constraint?: { index?: string } } };
  } | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.index ?? null;
}

/** 判断唯一约束冲突是否命中指定的 PostgreSQL 索引名（任一命中即可）。 */
export function isUniqueConstraintViolation(error: unknown, ...indexNames: string[]): boolean {
  const index = uniqueConstraintIndex(error);
  return index !== null && indexNames.includes(index);
}
