// ── 模型配置服务（对应 backend/app/services/model_params.py + model_capabilities.py） ──

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

// ── 预设 ──

let _presets: Record<string, unknown> | null = null;

export function loadPresets(): Record<string, unknown> {
  if (_presets) return _presets;
  const presetPath = path.resolve(getProjectRoot(), "server/resources/presets.json");
  const raw = fs.readFileSync(presetPath, "utf-8");
  _presets = JSON.parse(raw);
  return _presets!;
}

// ── 模型参数 ──

/** model_params.json 中每个 capability 的配置 */
export interface ModelParamConfig {
  params: string[];
  defaults: Record<string, unknown>;
  constraints: Record<string, string[]>;
  transforms: Record<string, unknown>;
}

let _modelParamsRaw: Record<string, Record<string, unknown>> | null = null;

function loadRaw(): Record<string, Record<string, unknown>> {
  if (_modelParamsRaw) return _modelParamsRaw;
  const paramsPath = path.resolve(getProjectRoot(), "server/resources/model_params.json");
  const raw = fs.readFileSync(paramsPath, "utf-8");
  _modelParamsRaw = JSON.parse(raw) as Record<string, Record<string, unknown>>;
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
 * 对应 Python ModelParamsRegistry.get()
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

// ── 模型能力白名单 ──

let _capabilitiesWhitelist: Record<string, unknown> | null = null;

export function loadCapabilitiesWhitelist(): Record<string, unknown> {
  if (_capabilitiesWhitelist) return _capabilitiesWhitelist;
  const whitelistPath = path.resolve(
    getProjectRoot(),
    "server/resources/model_capabilities_whitelist.json"
  );
  const raw = fs.readFileSync(whitelistPath, "utf-8");
  _capabilitiesWhitelist = JSON.parse(raw);
  return _capabilitiesWhitelist!;
}

/** 根据模型名推断能力 */
export function inferCapabilities(modelName: string): string[] {
  const whitelist = loadCapabilitiesWhitelist();
  const modelLower = modelName.toLowerCase();

  const known = (whitelist as Record<string, string[]>)[modelLower];
  if (known) return known;

  const capabilities: string[] = [];
  if (modelLower.includes("gpt") || modelLower.includes("claude") || modelLower.includes("gemini") || modelLower.includes("llama")) {
    capabilities.push("llm");
  }
  if (modelLower.includes("dall-e") || modelLower.includes("imagen") || modelLower.includes("seedream") || modelLower.includes("stable-diffusion")) {
    capabilities.push("image");
  }
  if (modelLower.includes("sora") || modelLower.includes("seedance") || modelLower.includes("kling")) {
    capabilities.push("video");
  }
  if (modelLower.includes("tts") || modelLower.includes("whisper")) {
    capabilities.push("audio");
  }
  return capabilities;
}
