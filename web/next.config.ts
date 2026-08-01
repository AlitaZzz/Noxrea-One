import path from "path";
import { readFileSync, existsSync } from "fs";
import type { NextConfig } from "next";

// 从项目根目录 .env 读取前端需要的变量（映射到 NEXT_PUBLIC_*）
function loadRootEnv(): Record<string, string> {
  const envPath = path.join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*["']?([^"'\n]+)["']?/);
    if (!match) continue;
    const key = match[1];
    const val = match[2];
    if (key.startsWith("NEXT_PUBLIC_")) {
      env[key] = val;
    } else if (key === "APP_NAME") {
      env["NEXT_PUBLIC_APP_NAME"] = val;
    }
  }
  return env;
}

const nextConfig: NextConfig = {
  env: loadRootEnv(),
  transpilePackages: ["antd", "@ant-design/icons", "@xyflow/react"],
  outputFileTracingRoot: path.join(__dirname, ".."),
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  serverExternalPackages: ["sharp", "pino"],
};

export default nextConfig;
