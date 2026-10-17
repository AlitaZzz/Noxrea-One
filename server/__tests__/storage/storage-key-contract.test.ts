/**
 * 存储 key 统一的源码断言（specs/storage-reference-key-unification.md 验收标准）。
 *
 * DB 与画布数据中的托管文件引用一律为存储 key；`/api/files/` URL 只能出现在
 * DTO 派生与路由注册，不得成为入库契约。本测试做静态扫描锁定该不变量：
 * 1. Prisma schema 中不存在承载 URL 的列（source_url / cover_url 已改名，无 *Url 字段）；
 * 2. server / shared / web 源码中旧 URL 契约字段名（sourceUrl / coverUrl）已消灭；
 * 3. crud 层（唯一 DB 写入层）不出现托管 URL 字面量——URL 形态进不了 DB 写路径。
 * web 端 `isManagedFileUrl`（托管 URL 形态识别，用于下载参数判定与缩略参数派生）
 * 是渲染期读取侧逻辑，不属于写入路径。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walk(dir: string, skip: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, skip));
    else if (/\.(mts|ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const SKIP = (name: string) => name === "__tests__" || name === "node_modules" || name === ".next";
const serverFiles = walk(path.join(ROOT, "server"), SKIP);
const sharedFiles = walk(path.join(ROOT, "shared"), SKIP);
const webFiles = walk(path.join(ROOT, path.join("web", "src")), SKIP);
const sourceFiles = [...serverFiles, ...sharedFiles, ...webFiles];

describe("存储 key 源码断言（URL 不入库）", () => {
  it("Prisma schema 中托管文件引用列已 key 化改名（resultUrls 已存 key 按 Spec 不动；baseUrl 为外部配置非托管引用）", () => {
    const schema = readFileSync(path.join(ROOT, "prisma", "schema.prisma"), "utf8");
    expect(schema).toContain("file_key");
    expect(schema).toContain("cover_key");
    expect(schema).not.toContain("source_url");
    expect(schema).not.toContain("cover_url");
  });

  it("旧 URL 契约字段名（sourceUrl / coverUrl）在源码中已消灭", () => {
    const offenders = sourceFiles.filter((file) => {
      const content = readFileSync(file, "utf8");
      return /\bsourceUrl\b|\bcoverUrl\b/.test(content);
    });
    expect(offenders).toEqual([]);
  });

  it("crud 层（DB 写入层）不出现托管 URL 字面量", () => {
    const crudDir = path.join(ROOT, "server", "crud");
    const offenders = walk(crudDir, SKIP).filter((file) => {
      const content = readFileSync(file, "utf8");
      return content.includes("/api/files/") || content.includes("MANAGED_FILE_PATH");
    });
    expect(offenders).toEqual([]);
  });
});
