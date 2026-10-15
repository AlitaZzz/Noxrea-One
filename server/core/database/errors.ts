/**
 * Prisma 错误解读（双模式均为 driver adapter，specs/postgres-dialect-unification.md）。
 * driver adapter 下 P2002 的约束信息在 meta.driverAdapterError.cause.constraint（列名为
 * snake_case 落库列名），经典引擎的 meta.target 形态不存在；判重逻辑统一收敛在此。
 */
import { Prisma } from "./generated/client";

/** P2002 唯一约束冲突命中的列名（snake_case）；非 P2002 或取不到约束信息时为空数组。 */
function uniqueConstraintFields(error: unknown): string[] {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return [];
  }
  const meta = error.meta as {
    driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
  } | undefined;
  return meta?.driverAdapterError?.cause?.constraint?.fields ?? [];
}

/** 判断唯一约束冲突是否命中指定列（任一命中即可，列名与 @map 后的落库列名一致）。 */
export function isUniqueConstraintError(error: unknown, ...columns: string[]): boolean {
  const fields = uniqueConstraintFields(error);
  return columns.some((column) => fields.includes(column));
}
