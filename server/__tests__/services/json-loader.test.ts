/**
 * JSON 热更新加载器回归测试。
 * 锁定 R1 返工后的完整失败语义：validate 是加载成功语义的一部分——
 * 热更「合法 JSON 但结构坏」必须降级旧缓存（此前坏数据被写入缓存使路由持续 500）。
 * 用真实临时文件 + 显式 mtime 前推驱动缓存失效路径。
 */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resourcesDir: "",
  warn: vi.fn(),
}));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({ RESOURCES_DIR: state.resourcesDir }),
}));
vi.mock("@server/core/logger", () => ({
  logger: { warn: state.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { invalidateJson, loadJson } from "@server/services/json-loader";

interface PresetShape {
  name: string;
}

/** 结构校验：必须是含 name 字符串字段的对象数组（模拟 zod/presets 结构门） */
function validatePresets(data: unknown): PresetShape[] {
  if (!Array.isArray(data)) throw new Error("顶层必须是数组");
  for (const item of data) {
    if (!item || typeof item !== "object" || typeof (item as PresetShape).name !== "string") {
      throw new Error("条目缺少 name 字段");
    }
  }
  return data as PresetShape[];
}

let dir: string;
let file: string;
let relPath: string;
let clock = Date.now();

/** 写入内容并显式前推 mtime，规避同毫秒写导致缓存未失效 */
function write(content: string): void {
  writeFileSync(file, content, "utf-8");
  clock += 10_000;
  utimesSync(file, new Date(clock), new Date(clock));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "json-loader-test-"));
  state.resourcesDir = dir;
  clock = Date.now();
  // 每个用例独立文件名，避免模块级缓存跨用例污染
  relPath = `res-${Math.random().toString(36).slice(2)}.json`;
  file = path.join(dir, relPath);
  state.warn.mockClear();
});

afterEach(() => {
  invalidateJson(relPath);
  rmSync(dir, { recursive: true, force: true });
});

describe("loadJson（无校验器，原语义不回归）", () => {
  it("合法 JSON 读入并缓存命中（同引用零重读）", () => {
    write('{"a":1}');
    const first = loadJson<{ a: number }>(relPath);
    const second = loadJson<{ a: number }>(relPath);
    expect(first).toEqual({ a: 1 });
    expect(second).toBe(first);
  });

  it("首载 JSON 非法抛出（fail-fast）", () => {
    write("not-json");
    expect(() => loadJson(relPath)).toThrow();
  });

  it("热更 JSON 非法 → warn + 旧缓存", () => {
    write('{"a":1}');
    const good = loadJson<{ a: number }>(relPath);
    write("corrupted!!!");
    expect(loadJson<{ a: number }>(relPath)).toBe(good);
    expect(state.warn).toHaveBeenCalled();
  });
});

describe("loadJson + validate（R1 返工语义）", () => {
  it("校验通过：返回校验产物并缓存", () => {
    write('[{"name":"a"}]');
    const loaded = loadJson(relPath, validatePresets);
    expect(loaded).toEqual([{ name: "a" }]);
  });

  it("首载结构坏（合法 JSON）→ fail-fast 抛出，坏数据不入缓存（重复调用持续抛出）", () => {
    write('{"wrong":"shape"}');
    expect(() => loadJson(relPath, validatePresets)).toThrow("顶层必须是数组");
    // R1 缺陷的持续性伤害面：若坏数据入缓存，后续请求会 mtime 命中静默返回坏数据
    expect(() => loadJson(relPath, validatePresets)).toThrow("顶层必须是数组");
    // 修复文件后（mtime 前推）应当能读到新数据——证明坏数据从未入缓存
    write('[{"name":"fixed"}]');
    expect(loadJson(relPath, validatePresets)).toEqual([{ name: "fixed" }]);
  });

  it("热更结构坏（合法 JSON）→ warn + 旧缓存，坏文件未修复期间后续请求不静默生效（R1 核心回归）", () => {
    write('[{"name":"good"}]');
    const good = loadJson(relPath, validatePresets);
    state.warn.mockClear();

    write('{"valid":"json-but-bad-shape"}');
    const served = loadJson(relPath, validatePresets);

    expect(served).toBe(good);
    expect(state.warn).toHaveBeenCalledTimes(1);
    expect(state.warn.mock.calls[0][1]).toContain("json reload failed");

    // 坏数据若被写入缓存，此刻会 mtime 命中静默返回坏数据——必须仍服务旧缓存并重试
    const again = loadJson(relPath, validatePresets);
    expect(again).toBe(good);
    expect(again).not.toEqual({ valid: "json-but-bad-shape" });
    expect(state.warn).toHaveBeenCalledTimes(2);
  });

  it("热更恢复：文件修好后读到新数据", () => {
    write('[{"name":"v1"}]');
    expect(loadJson(relPath, validatePresets)).toEqual([{ name: "v1" }]);

    write('[{"name":"v2"}]');
    expect(loadJson(relPath, validatePresets)).toEqual([{ name: "v2" }]);
  });
});
