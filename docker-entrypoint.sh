#!/bin/sh
set -e

# ------------------------------------------------------------
# 配置来源：/data/.env（数据卷内，即 NAS 的 /share/Container/noxreaone/.env）
# 不存在则自动生成初始配置（幂等：已存在则原样使用，绝不覆盖用户修改）：
#   - 已通过 -e 传入的变量原样写入（环境变量优先）
#   - 未传入的使用 Docker 默认值
#   - JWT_SECRET_KEY 缺失时自动生成随机密钥并持久化（重启不变）
# ------------------------------------------------------------
if [ ! -f /data/.env ]; then
  cat > /data/.env <<EOF
# ============================================================
# Noxrea One 配置（容器首次启动自动生成）
# 宿主机路径: /share/Container/noxreaone/.env
# 修改后重启容器生效
# ============================================================

# ---------- 必填 ----------
# JWT 签名密钥（首次启动自动生成；更换：openssl rand -hex 32）
JWT_SECRET_KEY="${JWT_SECRET_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}"

# ---------- 数据库 ----------
DATABASE_URL="${DATABASE_URL:-file:/data/noxrea.db}"
DB_TIMEOUT="${DB_TIMEOUT:-30}"

# ---------- 应用 ----------
APP_NAME="${APP_NAME:-Noxrea One}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-true}"

# ---------- HTTP 服务 ----------
SERVER_HOST="${SERVER_HOST:-0.0.0.0}"
SERVER_PORT="${SERVER_PORT:-4000}"
SERVER_URL="${SERVER_URL:-http://localhost:4000}"

# ---------- 上传 ----------
MAX_UPLOAD_SIZE_MB="${MAX_UPLOAD_SIZE_MB:-30}"
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
# 对外可访问的服务根地址（配置后参考素材以 URL 发给上游，留空则发 base64）
PUBLIC_URL="${PUBLIC_URL:-}"

# ---------- FFmpeg ----------
FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin}"

# ---------- 资源目录 ----------
# JSON 配置与技能文件根目录（首次启动已播种出厂配置到 /data/resources）
# 支持热更新：改文件即生效，无需重启
RESOURCES_DIR="${RESOURCES_DIR:-/data/resources}"

# ---------- 安全 ----------
ALLOW_INSECURE_SECRETS="${ALLOW_INSECURE_SECRETS:-false}"

# ---------- 可选：JWT ----------
JWT_ALGORITHM="${JWT_ALGORITHM:-HS256}"
JWT_EXPIRE_MINUTES="${JWT_EXPIRE_MINUTES:-1440}"

# ---------- 可选：后台任务 Worker ----------
WORKER_POLL_INTERVAL="${WORKER_POLL_INTERVAL:-1}"
WORKER_MAX_CONCURRENCY="${WORKER_MAX_CONCURRENCY:-10}"
WORKER_API_TIMEOUT="${WORKER_API_TIMEOUT:-240}"
WORKER_STUCK_TIMEOUT="${WORKER_STUCK_TIMEOUT:-5}"
WORKER_ZOMBIE_INTERVAL="${WORKER_ZOMBIE_INTERVAL:-60}"
WORKER_MAX_RETRIES="${WORKER_MAX_RETRIES:-2}"
WORKER_DRAIN_TIMEOUT="${WORKER_DRAIN_TIMEOUT:-15}"
WORKER_POLL_CHECK_INTERVAL="${WORKER_POLL_CHECK_INTERVAL:-200}"
WORKER_ASYNC_POLL_INTERVAL="${WORKER_ASYNC_POLL_INTERVAL:-3.0}"
WORKER_ASYNC_POLL_MAX_ATTEMPTS="${WORKER_ASYNC_POLL_MAX_ATTEMPTS:-120}"
WORKER_ASYNC_POLL_INITIAL_DELAY="${WORKER_ASYNC_POLL_INITIAL_DELAY:-0.5}"

# ---------- 可选：HTTP 超时（秒） ----------
HTTP_TIMEOUT_DL="${HTTP_TIMEOUT_DL:-45}"
HTTP_TIMEOUT_POLL="${HTTP_TIMEOUT_POLL:-15}"
HTTP_TIMEOUT_API="${HTTP_TIMEOUT_API:-120}"
HTTP_TIMEOUT_ASYNC="${HTTP_TIMEOUT_ASYNC:-30}"

# ---------- 可选：SSRF 防护 ----------
# 允许访问的内网主机（逗号分隔），留空表示禁止访问内网
ALLOWED_INTERNAL_HOSTS="${ALLOWED_INTERNAL_HOSTS:-}"

# ---------- 可选：出网代理 ----------
USE_SYSTEM_PROXY="${USE_SYSTEM_PROXY:-false}"
PROXY_URL="${PROXY_URL:-}"
EOF
  echo "== 已生成初始配置 /data/.env（JWT_SECRET_KEY 已自动生成并持久化）=="
fi

# ------------------------------------------------------------
# 统一加载：全量复制为 /app/.env（server 通过 tsx --env-file=.env 读取，
# 包含全部变量），并 source 进环境变量
# tr 去除 CRLF 行尾（Windows 编辑后上传的文件常见，否则值会带上 \r）
# ------------------------------------------------------------
tr -d '\r' < /data/.env > /app/.env
set -a
. /app/.env
set +a

# ------------------------------------------------------------
# 默认值（环境变量优先）
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
  echo "       在 /data/.env（NAS 宿主机: /share/Container/noxreaone/.env）中设置，" >&2
  echo "       或 docker run -e JWT_SECRET_KEY=... 传入。" >&2
  echo "       生成方式：openssl rand -hex 32" >&2
  exit 1
fi

# ------------------------------------------------------------
# 数据目录
# ------------------------------------------------------------
mkdir -p /data/uploads

# ------------------------------------------------------------
# 资源目录播种：把镜像内置的出厂配置复制到 /data/resources
# cp -n 不覆盖已有文件：用户修改安全，镜像升级新增文件自动补齐
# JSON 支持热更新（mtime 缓存），在数据卷里改文件即生效，无需重启
# ------------------------------------------------------------
if [ -d /data ]; then
  mkdir -p /data/resources
  cp -rn /app/server/resources/. /data/resources/ 2>/dev/null || true
fi

# ------------------------------------------------------------
# 数据库迁移（首次运行建表，之后幂等）
# ------------------------------------------------------------
npx prisma migrate deploy

echo "== Noxrea: web -> 0.0.0.0:3000, server -> ${SERVER_HOST}:${SERVER_PORT} =="

# ------------------------------------------------------------
# 启动 web + server（concurrently，同容器）
# ------------------------------------------------------------
exec npm run start
