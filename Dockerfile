# syntax=docker/dockerfile:1

# ============================================================
# Noxrea AI Canvas - 单容器镜像
#   - web (Next.js)  : 3000（对外暴露）
#   - server (Hono)   : 4000（仅容器内部）
#   - SQLite + uploads: /data（挂载卷持久化）
# ============================================================

# ------------------------------------------------------------
# 阶段 1：builder - 安装依赖 + 构建前端
# ------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /app

# 前端反向代理目标（单容器部署固定为 localhost:4000）
ARG SERVER_URL=http://localhost:4000
ARG APP_NAME=Noxrea One

# 先复制全部源码：postinstall 的 prisma generate 需要 prisma/schema.prisma
COPY . .

# 生成 .env（next.config.ts 在构建期读取 SERVER_URL / NEXT_PUBLIC_*）
RUN printf 'SERVER_URL=%s\nAPP_NAME=%s\nNEXT_PUBLIC_APP_NAME=%s\n' "$SERVER_URL" "$APP_NAME" "$APP_NAME" > .env

# 安装依赖（postinstall 自动执行 prisma generate）
RUN npm ci

# 构建前端（产物在 web/.next）
RUN npm run build

# ------------------------------------------------------------
# 阶段 2：runner - 精简运行环境
# ------------------------------------------------------------
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

# ffmpeg：视频抽帧；ca-certificates：出网访问上游 API
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 复制全部构建产物 + 完整依赖 + 源码（server 由 tsx 直接运行 TS）
COPY --from=builder /app /app

# 入口脚本
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# 数据卷：SQLite 数据库 + 上传文件
VOLUME ["/data"]

# 对外暴露 web 端口
EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
