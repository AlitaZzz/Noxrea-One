/**
 * 启动探测对象残留清扫（specs/storage-provider-portability.md 规则 3.2）。
 *
 * 探测对象 `_probe/<uuid>.txt` 写后即尽力删除；删除失败时该对象不在可读键域、
 * 也不属派生四根，引用回收看不到它——没有本阶段就是永久残留。TTL 固定 24 小时：
 * 探测对象只在启动瞬间存在，残留纯属垃圾，没有可调的业务寿命。
 *
 * 挂接 GC 周期，与引用回收、staging 清扫、派生清扫并列独立成败；
 * 判龄、gc_dry_run 护栏与删除失败留痕的力学复用 sweep.ts。
 */

import { hoursToMs } from "@server/core/duration";
import { getSetting } from "@server/core/settings";
import { PROBE_ROOT_PREFIX } from "./backend";
import { getStorageBackend } from "./service";
import { sweepAgedPrefix } from "./sweep";

const PROBE_RESIDUE_TTL_MS = hoursToMs(24);

/** 回收 `_probe/` 下超龄残留，返回实删/应删（dry-run）总数；枚举失败上抛 */
export async function sweepStaleProbeObjects(): Promise<number> {
  return sweepAgedPrefix(
    getStorageBackend(),
    PROBE_ROOT_PREFIX,
    Date.now() - PROBE_RESIDUE_TTL_MS,
    getSetting("storage.gc_dry_run"),
  );
}
