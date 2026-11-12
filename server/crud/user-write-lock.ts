/**
 * 用户级写串行化（specs/asset-write-serialization.md R1–R7）。
 *
 * 同一用户的资产/目录/账本写事务会同时锁定 asset_items、asset_folders、
 * file_refs、file_objects 等多个资源；不同入口的加锁顺序不一致（创建：
 * 资产行 → 目录 → 账本；删除：资产行 → 账本 → 目录；移动：资产行 → 旧目录 →
 * 目标目录），交叉执行时构成 ABBA 等待环，PostgreSQL 以 40P01 终止其中一个
 * 事务。逐路径调整顺序要求所有现有与未来调用方永远遵守同一顺序，难以长期
 * 保证；这里在写入口用用户级数据库锁把同一用户的业务写整体串行化，从结构上
 * 消除环。
 *
 * 两层结构：
 * - 进程内闸门（createKeyedGate）：同一用户的写先在本进程排队，等待不开启
 *   Prisma 事务、不占用连接池连接。若直接在事务内等待数据库锁，每个排队请求
 *   都会占住一条连接，同一用户足以耗尽每进程连接池，其他用户将在 maxWait 后
 *   以 P2028 失败。
 * - 事务内 pg_advisory_xact_lock：跨进程/跨实例的最终串行化权威。进程闸门只是
 *   本进程的排队优化，不能替代数据库锁——多实例部署下每个进程各有一道闸门。
 *   同一进程每个用户至多一个事务在数据库锁上等待，连接占用上界为「每用户每
 *   进程 1 条」。
 *
 * 约束：
 * - 事务的第一条语句必须是锁获取（由 withUserWriteTx 保证）。画布/头像等非
 *   资产入口经账本写原语（R4）在改动 file_refs / file_objects 之前获取同一把
 *   锁；它们在此之前只允许锁定自身业务行（canvas_projects、users），这些行
 *   不会被资产事务持有（R5）。
 * - 应用内闸门的嵌套顺序固定为「项目闸门 → 用户闸门」；反向获取会形成数据库
 *   看不到的进程内等待环（尚未开启的事务不进入锁管理器）。
 * - PostgreSQL 的 advisory 锁与行锁共用同一锁管理器与等待图，死锁检测同样覆盖
 *   advisory 锁等待；违反 R5 仍会以 40P01（Prisma P2034）终止，而不是 P2028。
 * - pg_advisory_xact_lock 随提交/回滚自动释放；同一事务内重复获取可重入，
 *   资产路径内「入口锁 + 账本原语锁」不会自我阻塞。
 */
import { createKeyedGate } from "@server/core/keyed-gate";
import { withTransaction, type DbTx } from "@server/core/database/transaction";

const userWriteGate = createKeyedGate<number>();

/**
 * 获取当前用户的写事务锁，直到事务结束。
 *
 * 锁键包含 current_database()：advisory 锁是集群级的，必须按库隔离，避免开发库、
 * 测试库与生产库互相阻塞（与 server/crud/user.ts 的首用户注册锁同一口径）。
 * 子查询把 void 返回值包成可反序列化的 int：Prisma 无法反序列化 void 列。
 */
export async function lockUserWriteTx(tx: DbTx, userId: number): Promise<void> {
  // userId 以字符串参数参与拼接：text || text 不依赖参数类型推断。
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended('noxrea:user-write:' || current_database() || ':' || ${String(userId)}, 0))) AS user_write_lock`;
}

/**
 * 用户写事务的唯一入口：先在本进程闸门内排队（不占连接），再开启事务并为该
 * 用户获取数据库写锁。所有会写资产/目录/账本的业务事务都必须经此进入。
 */
export function withUserWriteTx<T>(userId: number, fn: (tx: DbTx) => Promise<T>): Promise<T> {
  return userWriteGate.run(userId, () =>
    withTransaction(async (tx) => {
      await lockUserWriteTx(tx, userId);
      return fn(tx);
    }),
  );
}
