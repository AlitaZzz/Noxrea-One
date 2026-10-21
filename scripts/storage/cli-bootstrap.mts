/**
 * 存储类一次性 CLI 的部分引导（specs/storage-s3-backend.md 规则 9/11 的三个命令共用）：
 * 不复用 bootstrap()——那会清空 _tmp 临时区并挂载 GC 定时器，CLI 不得触碰在途临时文件。
 *
 * 分层：
 * - bootstrapCliCore：配置 → 数据库连接串校验 → 设置快照（migrate：存储后端单例不参与，
 *   脚本直连 S3 与 storage.backend 当前值无涉）；
 * - bootstrapCliStorage：core + 存储后端单例构建 + 连通性探测（audit / gc：经 getStorageBackend
 *   消费后端能力，探测失败即失败，与运行时「禁止静默降级」同口径）。
 */
import { loadConfig } from "@server/core/config";
import { assertDatabaseUrl } from "@server/core/database/connection-string";
import { initSettings } from "@server/core/settings";
import { getStorageBackend, initStorageBackend } from "@server/services/storage/service";

export async function bootstrapCliCore(): Promise<void> {
  loadConfig();
  assertDatabaseUrl();
  await initSettings();
}

export async function bootstrapCliStorage(): Promise<void> {
  await bootstrapCliCore();
  initStorageBackend();
  await getStorageBackend().probe?.();
}
