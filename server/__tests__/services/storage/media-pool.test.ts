/**
 * 媒体池并发门：三池隔离、重型池两级准入（个人名额 → 全局槽位）、过载拒绝与日志
 * （specs/media-processing-concurrency.md）。设置默认值取自真实注册表
 * （heavy 2/4/60s + 每人 1/2，light 2/16/10s，sharp 2/64/10s）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@server/core/settings", async () => (await import("../../helpers/settings")).settingsModuleMock());
vi.mock("@server/core/logger/utils", () => ({ logEvent: vi.fn() }));

import { logEvent } from "@server/core/logger/utils";
import { acquireHeavySlot, acquireMediaSlot, MediaPoolBusyError } from "@server/services/storage/media-pool";
import { resetTestSettings } from "../../helpers/settings";

beforeEach(() => {
  vi.clearAllMocks();
  resetTestSettings();
});

describe("轻型池与 sharp 池", () => {
  it("未满时立即获取槽位，释放幂等", async () => {
    const release = await acquireMediaSlot("sharp");
    expect(typeof release).toBe("function");
    release();
    release();
    const again = await acquireMediaSlot("ffmpeg_light");
    again();
  });

  it("达到上限后排队并按 FIFO 放行", async () => {
    const a = await acquireMediaSlot("ffmpeg_light");
    const b = await acquireMediaSlot("ffmpeg_light");
    const order: string[] = [];
    const c = acquireMediaSlot("ffmpeg_light").then((release) => { order.push("c"); return release; });
    const d = acquireMediaSlot("ffmpeg_light").then((release) => { order.push("d"); return release; });
    await Promise.resolve();
    expect(order).toEqual([]);

    a();
    (await c)();
    expect(order).toEqual(["c"]);

    b();
    (await d)();
    expect(order).toEqual(["c", "d"]);
  });

  it("队列满时立即拒绝（scope=global）且记过载日志", async () => {
    resetTestSettings({ "media.sharp_max_pending": 0 });
    const a = await acquireMediaSlot("sharp");
    const b = await acquireMediaSlot("sharp");

    await expect(acquireMediaSlot("sharp")).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      pool: "sharp",
      scope: "global",
      reason: "queue_full",
    });
    expect(logEvent).toHaveBeenCalledWith("media", expect.objectContaining({
      stage: "media_pool_rejected",
      pool: "sharp",
      scope: "global",
      reason: "queue_full",
      max_concurrency: 2,
      max_pending: 0,
      active: 2,
    }));

    a();
    b();
  });

  it("排队超时拒绝并释放队列名额", async () => {
    resetTestSettings({ "media.ffmpeg_light_max_wait_seconds": 0.02 });
    const a = await acquireMediaSlot("ffmpeg_light");
    const b = await acquireMediaSlot("ffmpeg_light");

    await expect(acquireMediaSlot("ffmpeg_light")).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "global",
      reason: "wait_timeout",
    });

    b();
    const c = await acquireMediaSlot("ffmpeg_light");
    a();
    c();
  });

  it("排队期间中止立即出队，不泄漏槽位", async () => {
    const a = await acquireMediaSlot("ffmpeg_light");
    const b = await acquireMediaSlot("ffmpeg_light");
    const controller = new AbortController();
    const queued = acquireMediaSlot("ffmpeg_light", controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    b();
    const c = await acquireMediaSlot("ffmpeg_light");
    a();
    c();
  });

  it("轻型池与 sharp 池互不占用槽位", async () => {
    const a = await acquireMediaSlot("ffmpeg_light");
    const b = await acquireMediaSlot("ffmpeg_light");
    const s = await acquireMediaSlot("sharp");
    a();
    b();
    s();
  });
});

describe("重型池两级准入（个人名额 → 全局槽位）", () => {
  it("个人排队满立即拒绝（scope=user，回 429 语义），其他用户不受影响", async () => {
    // 个人排队取 0：用户 1 持有名额后，同一用户的下一个请求立即被拒
    resetTestSettings({ "media.ffmpeg_heavy_user_max_pending": 0 });
    const first = await acquireHeavySlot(1);
    const other = await acquireHeavySlot(2);

    await expect(acquireHeavySlot(1)).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      pool: "ffmpeg_heavy",
      scope: "user",
      reason: "queue_full",
    });
    expect(logEvent).toHaveBeenCalledWith("media", expect.objectContaining({
      stage: "media_pool_rejected",
      pool: "ffmpeg_heavy",
      scope: "user",
      userId: 1,
      reason: "queue_full",
    }));

    first();
    other();
  });

  it("个人阶段等待超时同样 scope=user", async () => {
    resetTestSettings({ "media.ffmpeg_heavy_max_wait_seconds": 0.05 });
    const first = await acquireHeavySlot(1);
    // 用户 1 的第二个请求在个人队列等待（默认排队 2），超过等待时限被拒
    await expect(acquireHeavySlot(1)).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "user",
      reason: "wait_timeout",
    });
    first();
  });

  it("全局排队满拒绝（scope=global，回 503 语义），此前个人名额已释放不阻塞他人", async () => {
    resetTestSettings({ "media.ffmpeg_heavy_user_max_pending": 0, "media.ffmpeg_heavy_max_pending": 0 });
    const a = await acquireHeavySlot(1);
    const b = await acquireHeavySlot(2);

    await expect(acquireHeavySlot(3)).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "global",
      reason: "queue_full",
    });

    // 全局拒绝时个人名额已回退：同一用户立即重试仍能正常进入（并在此处拿到空出的槽位）
    a();
    const again = await acquireHeavySlot(3);
    again();
    b();
  });

  it("每人至多 1 个任务进入全局阶段：第二个在个人队列等待，不占全局槽位", async () => {
    const a = await acquireHeavySlot(1);
    const b = await acquireHeavySlot(2);
    // 用户 1 的第二个请求进入个人队列（不占第 3 个全局位——全局只有 2 个槽位，已满）
    let secondGlobalRejected = false;
    const queued = acquireHeavySlot(1).catch((err: unknown) => {
      if (err instanceof MediaPoolBusyError && err.scope === "global") secondGlobalRejected = true;
      throw err;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 全局只有 2 槽且被 A/B 占满，用户 1 的排队者在个人阶段等待而非全局队列
    expect(queued).toBeInstanceOf(Promise);

    a();
    // a 释放后：用户 1 的排队者先进（FIFO），b 释放后用户 2 无影响
    const released = await queued;
    b();
    released();

    // 清理后一切可重新获取
    const c = await acquireHeavySlot(3);
    c();
    expect(secondGlobalRejected).toBe(false);
  });

  it("个人排队边界：user_max_pending=2 时第 2、3 个排队，第 4 个立即拒绝（scope=user）", async () => {
    const a = await acquireHeavySlot(1); // 用户1：运行中（个人名额 + 全局槽位1）
    const b = await acquireHeavySlot(2); // 用户2：运行中（全局槽位2）
    const r2 = acquireHeavySlot(1); // 用户1：个人队列 pending=1
    const r3 = acquireHeavySlot(1); // 用户1：个人队列 pending=2

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(acquireHeavySlot(1)).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "user",
      reason: "queue_full",
    });

    a(); // 全局槽位1与个人名额同时释放：r2 依次取得后完成
    const release2 = await r2;
    release2(); // r2 释放（全局 + 个人）→ 用户 1 的下一个排队者 r3 进
    const release3 = await r3;
    b();
    release3();
  });

  it("全局阶段排队超时拒绝（scope=global），个人名额一并释放", async () => {
    resetTestSettings({ "media.ffmpeg_heavy_max_wait_seconds": 0.05 });
    const a = await acquireHeavySlot(1);
    const b = await acquireHeavySlot(2);

    // 用户 3：个人名额立即可得（全局槽位被 A/B 占用），在全局阶段等待超时
    await expect(acquireHeavySlot(3)).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "global",
      reason: "wait_timeout",
    });

    // 个人名额已随失败释放：用户 3 立即重试仍能进入个人阶段（此处拿到 a 释放的全局槽位）
    a();
    const c = await acquireHeavySlot(3);
    c();
    b();
  });

  it("等待时限两段合计：个人阶段消耗的预算从全局阶段的余量中扣除", async () => {
    resetTestSettings({
      "media.ffmpeg_heavy_user_max_concurrency": 2,
      "media.ffmpeg_heavy_max_wait_seconds": 0.3,
    });
    const startedAt = Date.now();
    // 两个长期持有者占满全局；r1/r2 在全局队列排队（个人名额即得）；q 在用户1 的个人阶段排队
    const holder2P = acquireHeavySlot(2);
    const holder3P = acquireHeavySlot(3);
    const r1p = acquireHeavySlot(1);
    const r2p = acquireHeavySlot(1);
    const qP = acquireHeavySlot(1);
    const holder2 = await holder2P;
    const holder3 = await holder3P;

    setTimeout(holder2, 120); // t≈120ms：r1 获得全局槽位（已耗 120ms 预算）
    const r1release = await r1p;
    setTimeout(r1release, 120); // t≈240ms：r1 释放个人名额 → q 进个人阶段；其全局槽位被 r2 接走
    const r2release = await r2p;

    // 全局被 r1/r2 占满（holder3 持有到断言结束）：q 以剩余预算（约 60ms）在全局阶段超时
    await expect(qP).rejects.toMatchObject({
      name: "MediaPoolBusyError",
      scope: "global",
      reason: "wait_timeout",
    });
    const elapsed = Date.now() - startedAt;
    // 预算若在两段间不共享（全局阶段重新拿满 0.3s），q 会在约 540ms 才超时
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(420);

    holder3();
    r2release();
  });

  it("排队中途中止：不占名额、不占槽位、不启动处理", async () => {
    const a = await acquireHeavySlot(1);
    const controller = new AbortController();
    const queued = acquireHeavySlot(2, controller.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;

    // 中止不泄漏：全局 2 槽中仍有一个空闲，用户 3 立即获取成功
    const c = await acquireHeavySlot(3);
    c();
    a();
  });
});
