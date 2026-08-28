#!/bin/sh
set -e

# ------------------------------------------------------------
# 默认值（compose / -e 传入的环境变量优先）
# ------------------------------------------------------------
export DATABASE_URL="${DATABASE_URL:-file:/data/noxrea.db}"
export APP_NAME="${APP_NAME:-Noxrea One}"
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export SERVER_PORT="${SERVER_PORT:-4000}"
export SERVER_HOST="${SERVER_HOST:-0.0.0.0}"
export UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
export FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin}"
export ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-true}"
export ALLOW_INSECURE_SECRETS="${ALLOW_INSECURE_SECRETS:-false}"

# ------------------------------------------------------------
# 必填校验
# ------------------------------------------------------------
if [ -z "$JWT_SECRET_KEY" ]; then
  echo "ERROR: 必须设置 JWT_SECRET_KEY。" >&2
  echo "       在 docker-compose.yml 的 environment 或 docker run -e JWT_SECRET_KEY=... 传入。" >&2
  echo "       生成方式：openssl rand -hex 32" >&2
  exit 1
fi

# ------------------------------------------------------------
# 生成 .env（server 通过 tsx --env-file=.env 读取）
# ------------------------------------------------------------
cat > /app/.env <<EOF
DATABASE_URL="${DATABASE_URL}"
JWT_SECRET_KEY="${JWT_SECRET_KEY}"
APP_NAME="${APP_NAME}"
LOG_LEVEL="${LOG_LEVEL}"
SERVER_PORT=${SERVER_PORT}
SERVER_HOST="${SERVER_HOST}"
UPLOAD_DIR="${UPLOAD_DIR}"
FFMPEG_PATH="${FFMPEG_PATH}"
ALLOW_REGISTRATION=${ALLOW_REGISTRATION}
ALLOW_INSECURE_SECRETS=${ALLOW_INSECURE_SECRETS}
EOF

# ------------------------------------------------------------
# 数据目录
# ------------------------------------------------------------
mkdir -p /data/uploads

# ------------------------------------------------------------
# 数据库迁移（首次运行建表，之后幂等）
# ------------------------------------------------------------
npx prisma migrate deploy

echo "== Noxrea: web -> 0.0.0.0:3000, server -> ${SERVER_HOST}:${SERVER_PORT} =="

# ------------------------------------------------------------
# 启动 web + server（concurrently，同容器）
# ------------------------------------------------------------
exec npm run start
