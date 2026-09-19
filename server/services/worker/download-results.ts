/**
 * 生成结果下载落盘（带心跳）。
 * executor 首次执行与 resume-polling 恢复轮询共用：下载阶段没有轮询心跳，
 * 大文件下载可能远超心跳间隔，不推进 updatedAt 的话僵尸清理会把下载中的
 * 任务误判为卡死、重置重跑并再次提交上游（重复生成、重复计费）。
 */
import { logger } from "@server/core/logger";
import { touchTaskHeartbeat, TASK_HEARTBEAT_INTERVAL_MS } from "@server/crud/task";
import { downloadAndSave } from "@server/services/storage/download";

export async function downloadResultsWithHeartbeat(
  taskId: string,
  userId: number,
  urls: string[],
  logLabel: string,
  startedAt: Date | null
): Promise<string[]> {
  const heartbeat = setInterval(() => {
    void touchTaskHeartbeat(taskId, startedAt);
  }, TASK_HEARTBEAT_INTERVAL_MS);

  const resultUrls: string[] = [];
  try {
    for (const url of urls) {
      try {
        const key = await downloadAndSave(url, userId, taskId);
        if (key) resultUrls.push(key);
      } catch (err) {
        logger.error({ err, taskId }, logLabel);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  return resultUrls;
}
