/**
 * 事务边界的统一入口（specs/server-crud-service-boundary.md 事务与 Unit of Work 约定）。
 * `DbTx` 是 Prisma 事务客户端的唯一别名；`*Tx` 原语一律接收它，禁止各模块
 * 自行定义同名类型或包装，也禁止在被传入 `DbTx` 后再开事务（嵌套事务）。
 */
import { prisma } from "./client";
import type { Prisma } from "./generated/client";

export type DbTx = Prisma.TransactionClient;

export function withTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}
