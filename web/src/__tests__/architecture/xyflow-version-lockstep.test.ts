/**
 * `@xyflow/react` 与直接依赖的 `@xyflow/system` 版本锁定检查。
 *
 * 框选会话从 `@xyflow/system` 直接导入 `calcAutoPan`（`@xyflow/react` 不转出），
 * 而 `@xyflow/react` 对 `@xyflow/system` 声明精确版本。升级 `@xyflow/react`
 * 时若不同步升级直接依赖，安装结果会出现两份 system，运行时可能混用两种实现。
 * 本测试把该约束交给测试流程持续检查（web/AGENTS.md 九.2）。
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
}

/** 从包入口向上查找最近的 package.json（system 的 exports 不暴露 ./package.json）。 */
function readManifest(entry: string): PackageManifest {
  let dir = path.dirname(entry);
  while (!existsSync(path.join(dir, "package.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`package.json not found above ${entry}`);
    dir = parent;
  }
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as PackageManifest;
}

describe("@xyflow 版本锁定", () => {
  it("直接依赖的 @xyflow/system 与 @xyflow/react 声明的版本一致", () => {
    const react = readManifest(require.resolve("@xyflow/react"));
    const system = readManifest(require.resolve("@xyflow/system"));
    expect(react.dependencies?.["@xyflow/system"]).toBe(system.version);
  });
});
