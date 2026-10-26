/**
 * 生成结果下载落盘与终态编排。
 *
 * downloadResultsWithHeartbeat：下载阶段没有轮询心跳，大文件下载可能远超心跳间隔，
 * 不推进 updatedAt 的话僵尸清理会把下载中的任务误判为卡死、重置重跑并再次提交
 * 上游（重复生成、重复计费）。下载本身受 body idle + overall 超时约束（见 storage/download），
 * 心跳只负责在合法长下载期间标记执行者存活，不会再为无限挂起的传输续命。
 *
 * finalizeGeneratedResult：「下载落盘 → 空结果判失败 → safe 终态写入 → 收尾日志」
 * 的单源编排——此前 executor（首次执行）与恢复轮询路径各持一份对称
 * 实现，终态语义靠人肉保持一致。
 */
import { logger } from "@server/core/logger";
import { logEvent } from "@server/core/logger/utils";
import {
  getTaskStatus,
  safeCompleteTask,
  safeFailTask,
  touchTaskHeartbeat,
  TASK_HEARTBEAT_INTERVAL_MS,
} from "@server/crud/task";
import {
  fetchMediaBytes,
  identifyMediaBytes,
  persistMediaBytes,
} from "@server/services/storage/download";

/** 下载阶段结果与计数（candidates 原始候选 / attempted 实际取字节 / merged 被合并） */
export interface DownloadOutcome {
  /** 以身份为键、首现顺序的产物 key */
  urls: string[];
  /** 上游给出的候选总数（含重复） */
  candidates: number;
  /** 实际发起取字节的候选数（含失败） */
  attempted: number;
  /** 被合并掉的候选数（已完成原串的重复 + 同字节不同表示） */
  merged: number;
}

/**
 * 候选 → 产物身份集合（specs/generation-artifact-identity.md 规则 4–6）：
 * - L0：同一原串只发起一次取字节（廉价剪枝，零网络成本）；
 * - L1：data URL 解码后即得身份，不必走到落盘；
 * - L2：身份 = 内容 key，同字节不同表示在这里必然合并（跨 URL 也能兜住）。
 * 结果按首现顺序输出，且同一身份自始至终只落盘一次。
 * 剪枝只针对**已完成**的候选：取字节/落盘失败的候选不登记，后续同串候选仍可重试
 * （若在尝试前就登记，剪枝会把一次失败固化成不可重试，错误地丢掉可恢复的产物）。
 */
export async function downloadResultsWithHeartbeat(
  taskId: string,
  userId: number,
  urls: string[],
  logLabel: string,
  startedAt: Date | null
): Promise<DownloadOutcome> {
  const heartbeat = setInterval(() => {
    void touchTaskHeartbeat(taskId, startedAt);
  }, TASK_HEARTBEAT_INTERVAL_MS);

  const resultUrls: string[] = [];
  const seenCandidates = new Set<string>();
  const seenKeys = new Set<string>();
  let attempted = 0;
  let merged = 0;
  try {
    for (const candidate of urls) {
      if (seenCandidates.has(candidate)) {
        merged += 1;
        continue;
      }
      try {
        attempted += 1;
        const buffer = await fetchMediaBytes(candidate, taskId);
        if (!buffer) continue;
        const identity = await identifyMediaBytes(buffer, userId);
        // 同字节不同表示（url + b64、不同签名地址）：合并，不重复落盘
        if (seenKeys.has(identity.key)) {
          merged += 1;
          seenCandidates.add(candidate);
          continue;
        }
        await persistMediaBytes(buffer, identity, userId);
        seenKeys.add(identity.key);
        seenCandidates.add(candidate);
        resultUrls.push(identity.key);
      } catch (err) {
        logger.error({ err, taskId }, logLabel);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }
  const outcome: DownloadOutcome = { urls: resultUrls, candidates: urls.length, attempted, merged };
  if (merged > 0) {
    logEvent("storage.download", {
      stage: "candidate_merged",
      taskId,
      candidates: outcome.candidates,
      unique: resultUrls.length,
      merged,
    });
  }
  return outcome;
}

export interface FinalizeGeneratedResultInput {
  taskId: string;
  userId: number;
  startedAt: Date | null;
  /** 上游产物 URL 列表 */
  urls: string[];
  /** 上游文本产物（如有） */
  text?: string;
  /** 下载失败日志标签 */
  logLabel: string;
  /** 收尾日志频道（executor / resume_poll） */
  logChannel: string;
}

/**
 * 生成结果终态编排（单源）。返回 true = completed 写入成功；
 * false = 已取消 / 下载全失败 / 终态写入被守卫拒绝（均已记日志，不抛错）。
 */
export async function finalizeGeneratedResult(
  input: FinalizeGeneratedResultInput
): Promise<boolean> {
  const { taskId, userId, startedAt, urls, text, logLabel, logChannel } = input;

  // 已被取消：不再下载（终态守卫本会拒绝写入，提前结束省去无谓下载）
  const currentStatus = await getTaskStatus(taskId);
  if (currentStatus === "cancelled") {
    logEvent(logChannel, { stage: "cancelled_before_download", taskId });
    return false;
  }

  // 下载落盘并保持心跳（大文件下载可能远超心跳间隔，防止僵尸清理误判重跑）
  const outcome = await downloadResultsWithHeartbeat(taskId, userId, urls, logLabel, startedAt);
  const resultUrls = outcome.urls;

  // 上游有产物但全部候选都没落盘：显式失败，不能空结果标记 completed。
  // 计数口径由下载阶段给出：原始候选 / 实际取字节 / 被合并，不用原始列表长度冒充预期数
  if (outcome.candidates > 0 && resultUrls.length === 0) {
    logEvent(logChannel, {
      level: "warn",
      stage: "download_failed",
      taskId,
      candidates: outcome.candidates,
      attempted: outcome.attempted,
      merged: outcome.merged,
    });
    // 所有权守卫：执行期间被僵尸清理重置/重新认领时写入被拒绝，重试属于新执行者
    await safeFailTask(taskId, {
      error: "生成结果下载失败",
      errorCode: "generation.download_failed",
    }, { startedAt });
    return false;
  }

  // 终态守卫：期间被取消的话写入会被丢弃，保留 cancelled。
  // safeCompleteTask 自身不抛：写库失败已记日志，任务停留 processing 交僵尸清理
  const finalized = await safeCompleteTask(taskId, { resultUrls, resultText: text }, { startedAt });
  if (!finalized) return false;

  // 全部动作（保存 + 状态更新 + 媒体处理）完成后再输出收尾节点
  const saved = resultUrls.length > 0;
  logEvent(logChannel, {
    banner: true,
    bannerAtEnd: true,
    bannerTitle: saved ? "生成结束，已下载并保存" : "生成结束，但无结果保存",
    stage: "completed",
    taskId,
    saved,
    urls: resultUrls,
    text,
  });
  return true;
}
