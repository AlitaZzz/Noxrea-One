/**
 * 模型配置服务。
 * 加载模型参数与能力预设，提供渠道、模型配置与预设的读取入口。
 */

import fs from "fs";
import path from "path";

/** 项目根目录（兼容 Next.js dev/build 和 tsx 直接运行） */
function getProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 3; i++) {
    try {
      const pkgPath = path.resolve(dir, "package.json");
      const serverDir = path.resolve(dir, "server");
      if (fs.existsSync(pkgPath) && fs.existsSync(serverDir)) {
        return dir;
      }
    } catch { /* ignore */ }
    dir = path.resolve(dir, "..");
  }
  return process.cwd();
}

// 预设

// 按文件修改时间缓存，provider-presets.json 变更后（无需重启）自动重新加载。
let _presets: Record<string, unknown> | null = null;
let _presetsMtime = 0;

/** 加载预设配置（供前端 API 使用） */
export function loadPresets(): Record<string, unknown> {
  const presetPath = path.resolve(getProjectRoot(), "server/resources/provider-presets.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(presetPath).mtimeMs;
  } catch { /* 文件暂不可读时保留旧缓存 */ }
  if (_presets && mtime === _presetsMtime) return _presets;
  const raw = fs.readFileSync(presetPath, "utf-8");
  _presets = JSON.parse(raw);
  _presetsMtime = mtime;
  return _presets!;
}

// 模型参数
export interface ModelParamConfig {
  params: string[];
  defaults: Record<string, unknown>;
  constraints: Record<string, string[]>;
  transforms: Record<string, unknown>;
}

// 按文件修改时间缓存，model-params.json 变更后（无需重启）自动重新加载。
let _modelParamsRaw: Record<string, Record<string, unknown>> | null = null;
let _modelParamsMtime = 0;

function loadRaw(): Record<string, Record<string, unknown>> {
  const paramsPath = path.resolve(getProjectRoot(), "server/resources/model-params.json");
  let mtime = 0;
  try {
    mtime = fs.statSync(paramsPath).mtimeMs;
  } catch { /* 文件暂不可读时保留旧缓存 */ }
  if (_modelParamsRaw && mtime === _modelParamsMtime) return _modelParamsRaw;
  const raw = fs.readFileSync(paramsPath, "utf-8");
  _modelParamsRaw = JSON.parse(raw) as Record<string, Record<string, unknown>>;
  _modelParamsMtime = mtime;
  return _modelParamsRaw;
}

/** 返回完整 JSON（供前端 API 使用） */
export function loadModelParams(): Record<string, Record<string, unknown>> {
  return loadRaw();
}

/**
 * 按模型名 + capability 查找参数配置。
 * 匹配优先级：精确名 > fnmatch 通配符 > _default
 * defaults/params/constraints 优先用模型级配置，transforms 从 _default 兜底。
 * 读取模型参数预设
 */
export function getModelParams(modelName: string, capability: string): ModelParamConfig | null {
  const data = loadRaw();

  // _default 配置（transforms 的兜底来源）
  const defaultCap = data["_default"]?.[capability];
  const defaultConfig = defaultCap ? parseConfig(defaultCap) : null;

  // 1. 精确名匹配
  const exact = data[modelName]?.[capability];
  if (exact) {
    return mergeConfig(parseConfig(exact), defaultConfig);
  }

  // 2. fnmatch 通配符匹配
  for (const [pattern, caps] of Object.entries(data)) {
    if (pattern === "_default" || pattern === modelName) continue;
    if (pattern.includes("*") || pattern.includes("?")) {
      const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
      );
      if (regex.test(modelName)) {
        const capConfig = caps[capability];
        if (capConfig) return mergeConfig(parseConfig(capConfig), defaultConfig);
      }
    }
  }

  // 3. _default 兜底
  return defaultConfig;
}

/**
 * 合并配置：模型级配置优先，缺失的字段从 default 配置补充。
 * transforms 尤其重要：模型级通常没有 transforms，需要从 _default 继承。
 */
function mergeConfig(specific: ModelParamConfig, defaultCfg: ModelParamConfig | null): ModelParamConfig {
  if (!defaultCfg) return specific;

  return {
    params: specific.params.length > 0 ? specific.params : defaultCfg.params,
    defaults: { ...defaultCfg.defaults, ...specific.defaults },
    constraints: Object.keys(specific.constraints).length > 0 ? specific.constraints : defaultCfg.constraints,
    transforms: Object.keys(specific.transforms).length > 0 ? specific.transforms : defaultCfg.transforms,
  };
}

function parseConfig(raw: unknown): ModelParamConfig {
  const obj = raw as Record<string, unknown> ?? {};
  return {
    params: (obj.params as string[]) ?? [],
    defaults: (obj.defaults as Record<string, unknown>) ?? {},
    constraints: (obj.constraints as Record<string, string[]>) ?? {},
    transforms: (obj.transforms as Record<string, unknown>) ?? {},
  };
}
