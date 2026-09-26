/**
 * 前后端契约一致性测试（T8a/T8b）。
 *
 * 前后端分离部署，跨包契约由 shared/（@noxrea/shared）单一数据源 + 本测试守护：
 * 1. 任务状态：shared/index.ts 的 taskStatusSchema 单源，web types/canvas.ts
 *    只允许转出（export type { TaskStatus }），不得 reintroduce 本地字面量联合
 * 2. 错误码：server/core/errors/codes.ts 的 ERROR_CODES ↔ web i18n error 命名空间
 *    （codes.ts 头部约定：每个登记码必须有 zh-CN / en-US 双语文案，否则前端退回
 *    通用兜底并在开发环境告警）
 * 3. 能力名：server capabilities 各 service 的 registerCapability ↔ web types/models.ts
 *    的 ModelCapability（边界经 normalizeCapability 的 text↔llm 归一化）
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "@server/core/errors/codes";
import { normalizeCapability } from "@server/services/model-config";
import { TASK_STATUSES } from "@noxrea/shared";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const webSrc = (...p: string[]) => readFileSync(path.join(repoRoot, "web/src", ...p), "utf-8");

describe("前后端契约一致性", () => {
  it("TASK_STATUSES 与 web TaskStatus 完全一致", () => {
    // 单一来源已在 shared 落地并经类型检查守护；此处守护「web 不再自行声明
    // 字面量联合」，防止有人绕开单源重新引入本地副本
    const src = webSrc("lib/types/canvas.ts");
    expect(
      /export type TaskStatus\s*=[^;]+;/.test(src),
      "web types/canvas.ts 不得本地声明 TaskStatus，应从 @noxrea/shared 转出"
    ).toBe(false);
    expect(/export type \{ TaskStatus \};/.test(src)).toBe(true);

    // 运行时全集来自 zod schema 派生，钉住语义
    expect([...TASK_STATUSES]).toEqual([
      "pending",
      "processing",
      "completed",
      "failed",
      "cancelled",
    ]);
  });

  it("每个错误码在 zh-CN / en-US 的 error 命名空间都有文案", () => {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const tree = JSON.parse(
        readFileSync(path.join(repoRoot, `web/src/lib/i18n/${locale}.json`), "utf-8")
      ) as Record<string, unknown>;
      const errorNs = tree["error"] as Record<string, unknown> | undefined;
      expect(errorNs, `${locale} 缺少 error 命名空间`).toBeTruthy();

      const missing = ERROR_CODES.filter((code) => {
        let node: unknown = errorNs;
        for (const part of code.split(".")) {
          if (typeof node !== "object" || node === null || !(part in node)) return true;
          node = (node as Record<string, unknown>)[part];
        }
        return typeof node !== "string" || node.length === 0;
      });
      expect(missing, `${locale} 缺少文案的错误码`).toEqual([]);
    }
  });

  it("注册的能力名经 text↔llm 归一化后与 web ModelCapability 一致", () => {
    const capsDir = path.join(repoRoot, "server/services/capabilities");
    const serverCaps = new Set<string>();
    for (const entry of readdirSync(capsDir)) {
      const serviceSrc = (() => {
        try {
          return readFileSync(path.join(capsDir, entry, "service.ts"), "utf-8");
        } catch {
          return null; // 非 capability 目录
        }
      })();
      if (!serviceSrc) continue;
      for (const m of serviceSrc.matchAll(/registerCapability\("(\w+)"/g)) serverCaps.add(m[1]);
    }
    expect(serverCaps.size, "服务端至少应注册 4 个能力").toBeGreaterThanOrEqual(4);

    // 能力名在边界处有一处显式归一化：web/DB 层叫 "text"，服务端生成能力叫 "llm"
    // （server/services/model-config/index.ts normalizeCapability）。钉住该映射本身，
    // 再把服务端注册名反算回 web 词汇后比对。
    expect(normalizeCapability("text")).toBe("llm");
    const toWebVocabulary = (cap: string) => (cap === "llm" ? "text" : cap);

    const src = webSrc("lib/types/models.ts");
    const m = /export type ModelCapability = ([^;]+);/.exec(src);
    expect(m, "web types/models.ts 中找不到 ModelCapability 定义").toBeTruthy();
    const webCaps = new Set([...m![1].matchAll(/"(\w+)"/g)].map((x) => x[1]));

    const serverAsWeb = new Set([...serverCaps].map(toWebVocabulary));
    expect([...serverAsWeb].sort()).toEqual([...webCaps].sort());
  });
});
