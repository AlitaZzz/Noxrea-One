/**
 * 真实 PostgreSQL 测试的锁等待辅助：只匹配被观察的那把锁。
 *
 * 只统计库内任意 `wait_event_type = 'Lock'` 会话会在无关等待出现时提前返回，
 * 使并发用例在未被真正阻塞的情况下通过（多个测试文件并行时，其他文件的
 * `setupTestDatabase` 会话锁就是一个稳定的无关等待源）。
 */
import type { Client } from "pg";

/** 并发用例里被观察的 promise 的落定结果。 */
export type Settled = { ok: true } | { ok: false; error: unknown };

/**
 * 当前事务 xid（调用方需已开启事务并执行过产生 xid 的语句）。
 *
 * pg_current_xact_id() 返回 64 位 xid8，而 pg_locks.transactionid 是 32 位 xid；
 * 只比较文本会在 full-xid epoch 非 0 后永不匹配。统一取低 32 位，与
 * pg_locks / backend_xid 同一值域。
 */
export async function currentXid(client: Client): Promise<string> {
  const { rows } = await client.query<{ xid: string }>(
    "SELECT (pg_current_xact_id()::text::bigint & 4294967295)::text AS xid",
  );
  return rows[0].xid;
}

/**
 * 等某会话在指定事务 xid 上进入锁等待，返回等待者 pid。
 * 若被观察的 promise 在进入等待前落定，抛出原始错误（或提示提前完成）。
 *
 * 默认轮询上限 2s：正常路径几十毫秒即命中；而被阻塞的 Prisma 交互式事务默认
 * 只有 5s 预算，轮询上限过大会把「测试等得久」变成实现无关的 P2028 假红。
 */
export async function waitForXidLock(
  client: Client,
  params: {
    xid: string;
    excludePid: number;
    outcome: () => Settled | null;
    label: string;
    timeoutMs?: number;
  },
): Promise<number> {
  const deadline = Date.now() + (params.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ pid: number }>(
      `SELECT pid FROM pg_locks
       WHERE locktype = 'transactionid' AND NOT granted
         AND transactionid::text = $1 AND pid <> $2
       ORDER BY pid`,
      [params.xid, params.excludePid],
    );
    if (rows.length > 0) return rows[0].pid;

    const settled = params.outcome();
    if (settled) {
      if (!settled.ok) throw settled.error;
      throw new Error(`${params.label} 未进入锁等待就完成了`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${params.label} 未在事务 ${params.xid} 上进入锁等待`);
}

/**
 * 等某会话在指定持有者持有的 advisory 锁上进入等待，返回等待者 pid。
 *
 * 必须按锁键（classid/objid/objsubid/database）与持有者 pid 精确匹配：advisory
 * 锁等待不产生 transactionid 等待，而库内可能同时存在其他会话的 advisory 锁
 * （例如并行测试文件的建库文件锁、其他用例的用户锁）。只按 locktype 过滤会把
 * 这些无关等待当成命中，让用例在未真正阻塞时通过。
 */
export async function waitForAdvisoryLock(
  client: Client,
  params: {
    holderPid: number;
    outcome: () => Settled | null;
    label: string;
    timeoutMs?: number;
  },
): Promise<number> {
  const deadline = Date.now() + (params.timeoutMs ?? 2_000);
  while (Date.now() < deadline) {
    const { rows } = await client.query<{ pid: number }>(
      `SELECT DISTINCT waiter.pid
         FROM pg_locks AS waiter
         JOIN pg_locks AS holder
           ON holder.locktype = waiter.locktype
          AND holder.classid = waiter.classid
          AND holder.objid = waiter.objid
          AND holder.objsubid = waiter.objsubid
          AND holder.database IS NOT DISTINCT FROM waiter.database
        WHERE waiter.locktype = 'advisory'
          AND NOT waiter.granted
          AND holder.granted
          AND holder.pid = $1
        ORDER BY waiter.pid`,
      [params.holderPid],
    );
    if (rows.length > 0) return rows[0].pid;

    const settled = params.outcome();
    if (settled) {
      if (!settled.ok) throw settled.error;
      throw new Error(`${params.label} 未进入 advisory 锁等待就完成了`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${params.label} 未在 holder=${params.holderPid} 的 advisory 锁上进入等待`);
}
