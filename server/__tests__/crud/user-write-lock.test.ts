/**
 * 用户写事务入口的单进程闸门（specs/asset-write-serialization.md R1/R7）。
 * 锁定：同一用户的第二个写不会在第一个完成前开启事务（排队发生在连接池之外），
 * 不同用户互不排队，事务失败会释放闸门，且用户锁先于业务写获取。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn() }));

vi.mock("@server/core/database/transaction", () => ({
  withTransaction: mocks.withTransaction,
}));

import { withUserWriteTx } from "@server/crud/user-write-lock";

const TX = { $queryRaw: vi.fn(async () => []) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(TX));
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("withUserWriteTx", () => {
  it("同一用户：前一个事务结束前不开启后一个事务", async () => {
    const release = deferred();
    let signalFirstBody!: () => void;
    const firstBody = new Promise<void>((r) => {
      signalFirstBody = r;
    });

    const first = withUserWriteTx(1, async () => {
      signalFirstBody();
      await release.promise;
      return "first";
    });
    await firstBody;
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);

    const second = withUserWriteTx(1, async () => "second");
    // 让微任务队列清空：闸门排队时第二个不应开启事务
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.withTransaction).toHaveBeenCalledTimes(1);

    release.resolve();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
  });

  it("不同用户：互不排队，可同时进入事务", async () => {
    const release = deferred();
    let started = 0;
    let signalBoth!: () => void;
    const both = new Promise<void>((r) => {
      signalBoth = r;
    });
    const body = async (value: string) => {
      started += 1;
      if (started === 2) signalBoth();
      await release.promise;
      return value;
    };

    const a = withUserWriteTx(1, () => body("a"));
    const b = withUserWriteTx(2, () => body("b"));
    await both;
    expect(mocks.withTransaction).toHaveBeenCalledTimes(2);
    release.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
  });

  it("事务失败后释放闸门，后续同用户写继续执行", async () => {
    await expect(
      withUserWriteTx(1, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(withUserWriteTx(1, async () => "next")).resolves.toBe("next");
  });

  it("先获取用户锁，再执行事务体", async () => {
    const order: string[] = [];
    const tx = {
      $queryRaw: vi.fn(async () => {
        order.push("lock");
        return [];
      }),
    };
    mocks.withTransaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(tx));

    await withUserWriteTx(1, async () => {
      order.push("write");
      return 1;
    });

    expect(order).toEqual(["lock", "write"]);
  });
});
