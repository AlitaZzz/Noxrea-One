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
# 运行期业务参数（注册开关、上传限制、Worker、超时、代理等）不在此文件，
# 存放在数据库 system_settings 表，首次启动自动写入默认值
# 变量按归属分区：后端 / 前后端共用 / 前端（WEB_ 前缀）
# ============================================================

# ---------- 后端：必填 ----------
# JWT 签名密钥（首次启动自动生成；更换：openssl rand -hex 32）
JWT_SECRET_KEY="${JWT_SECRET_KEY:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}"

# ---------- 后端：数据库 ----------
DATABASE_URL="${DATABASE_URL:-file:/data/noxrea.db}"
DB_TIMEOUT="${DB_TIMEOUT:-30}"

# ---------- 后端：服务 ----------
# 容器内 API 监听 0.0.0.0:4000，与镜像构建期固化的前端 /api 代理目标一致，不提供配置
LOG_LEVEL="${LOG_LEVEL:-INFO}"

# ---------- 后端：路径 ----------
UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin}"
# JSON 配置与技能文件根目录（首次启动已播种出厂配置到 /data/resources）
# 支持热更新：改文件即生效，无需重启
RESOURCES_DIR="${RESOURCES_DIR:-/data/resources}"

# ---------- 后端：安全 ----------
ALLOW_INSECURE_SECRETS="${ALLOW_INSECURE_SECRETS:-false}"
JWT_ALGORITHM="${JWT_ALGORITHM:-HS256}"

# ---------- 前后端共用 ----------
# 单次批量上传总大小上限（MiB）；Next 代理层与后端共用
UPLOAD_BATCH_MAX_MB="${UPLOAD_BATCH_MAX_MB:-128}"

# ---------- 前端（Next，WEB_ 前缀）----------
# 路由门在后端不可达时的放行策略：fail-open（默认）/ fail-closed
WEB_AUTH_GATE_MODE="${WEB_AUTH_GATE_MODE:-fail-open}"
# 应用名与 /api 代理目标（WEB_APP_NAME / WEB_API_ORIGIN）在镜像构建期固化，
# 此处修改无效；构建参数见 Dockerfile
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
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export API_PORT=4000
export API_HOST=0.0.0.0
export UPLOAD_DIR="${UPLOAD_DIR:-/data/uploads}"
export FFMPEG_PATH="${FFMPEG_PATH:-/usr/bin}"
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

echo "== Noxrea: web -> 0.0.0.0:3000, api -> ${API_HOST}:${API_PORT} =="

# ------------------------------------------------------------
# 启动 web + server（concurrently，同容器）
# ------------------------------------------------------------
exec npm run start
