/**
 * 一次性回填：为存量 file_objects 补探测媒体元数据（宽高 / 时长）。
 * 元数据本应在落盘时写入（persistFileObject），此脚本只服务迁移前的存量行。
 * 运行：npm run backfill:file-meta（tsx --env-file=.env server/scripts/backfill-file-meta.ts）
 */
import fs from "fs/promises";
import path from "path";

import { prisma } from "@server/core/database/client";
import { buildStorageKey } from "@server/services/storage/service";
import { probePersistedMediaMeta } from "@server/services/storage/media";
import { localStorage } from "@server/services/storage/backends/local";

/** 同时 spawn 的探测进程上限，避免大批量回填时压垮机器 */
const PROBE_CONCURRENCY = 4;

async function main() {
  const rows = await prisma.fileObject.findMany();
  // 只回填缺元数据的媒体行：图片缺宽高、视频/音频缺时长才需要探测
  const pending = rows.filter((row) => {
    if (row.mimeType.startsWith("image/")) return row.width == null || row.height == null;
    if (row.mimeType.startsWith("video/")) return row.width == null || row.height == null || row.duration == null;
    if (row.mimeType.startsWith("audio/")) return row.duration == null;
    return false;
  });

  console.log(`file_objects 共 ${rows.length} 行，待回填 ${pending.length} 行`);

  let updated = 0;
  let missing = 0;
  let failed = 0;

  for (let i = 0; i < pending.length; i += PROBE_CONCURRENCY) {
    await Promise.all(
      pending.slice(i, i + PROBE_CONCURRENCY).map(async (row) => {
        const key = buildStorageKey(row.userId, row.hash, row.ext);
        const filePath = path.resolve(localStorage.baseDir, key);
        try {
          await fs.access(filePath);
        } catch {
          missing += 1;
          return;
        }
        const meta = await probePersistedMediaMeta(key, row.mimeType);
        if (meta.width == null && meta.height == null && meta.duration == null) {
          failed += 1;
          return;
        }
        await prisma.fileObject.update({
          where: { userId_hash: { userId: row.userId, hash: row.hash } },
          data: {
            width: meta.width ?? undefined,
            height: meta.height ?? undefined,
            duration: meta.duration ?? undefined,
          },
        });
        updated += 1;
      }),
    );
  }

  console.log(`回填完成：成功 ${updated}，文件缺失 ${missing}，探测失败 ${failed}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
