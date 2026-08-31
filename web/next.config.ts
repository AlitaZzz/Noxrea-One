import { existsSync,readFileSync } from "fs";
import type { NextConfig } from "next";
import path from "path";

// 从项目根目录 .env 读取全部变量
function loadRootEnv(): Record<string, string> {
  const envPath = path.join(__dirname, "..", ".env");
  if (!existsSync(envPath)) return {};
  const raw = readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+)\s*=\s*["']?([^"'\n]+)["']?/);
    if (!match) continue;
    env[match[1]] = match[2];
  }
  return env;
}

const rootEnv = loadRootEnv();

// 仅暴露 NEXT_PUBLIC_* + APP_NAME 给浏览器端
const publicEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(rootEnv)) {
  if (k.startsWith("NEXT_PUBLIC_")) publicEnv[k] = v;
}
if (rootEnv.APP_NAME) publicEnv["NEXT_PUBLIC_APP_NAME"] = rootEnv.APP_NAME;

// proxy body 限制跟随 MAX_UPLOAD_SIZE_MB，留 5MB 余量给 multipart 开销
const maxUploadMB = Number(rootEnv.MAX_UPLOAD_SIZE_MB) || 30;

const nextConfig: NextConfig = {
  reactStrictMode: false,
  env: publicEnv,
  transpilePackages: ["antd", "@ant-design/icons", "@xyflow/react", "react-markdown", "remark-gfm", "rehype-raw", "rehype-sanitize"],
  outputFileTracingRoot: path.join(__dirname, ".."),
  serverExternalPackages: ["sharp", "pino"],
  experimental: {
    proxyClientMaxBodySize: `${maxUploadMB + 5}mb`,
    // 禁用 Turbopack dev 文件系统缓存：Next 16.1+ 默认把编译结果累积进内存，
    // 打开画布等大模块图页面时会持续吃掉堆内存（见 GitHub issue #92246）。
    turbopackFileSystemCacheForDev: false,
  },
  // 画布以 URL 上的项目 ID 为唯一身份标识：/canvas 不带 ID 时直接回项目列表。
  // 不回落至 localStorage 的激活项目——否则同一 URL 在不同设备 / 不同用户下会指向
  // 不同画布，违背 URL 可寻址性，多用户共用浏览器时还会串到别人的画布。
  async redirects() {
    return [
      { source: "/canvas", destination: "/project", permanent: false },
    ];
  },
  // 透明代理：所有 /api/* 请求转发到后端 Hono 服务（目标由 SERVER_URL 指定）
  async rewrites() {
    // SERVER_URL 默认 http://localhost:4000（同机）；分开部署时改为远程 Hono 地址
    const backendUrl = (rootEnv.SERVER_URL || "http://localhost:4000").replace(/\/$/, "");
    return [
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
