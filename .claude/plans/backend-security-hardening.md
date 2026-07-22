# 后端安全与加固实施计划（P0–P2）

## 范围与决策

- **范围**:P0(崩溃/可读任意文件)+ P1(SSRF/凭证泄漏/上传限制)+ P2(注册开关、删除引用计数、schema 收敛及若干低危加固)。
- **不含**:P3 大重构(worker self-HTTP 回环、输入校验完整统一走 schema、provider/工具函数去重、`_claim_tasks` 裸 SQL 重构)——按 architecture-notes「大改不主动塞」原则单独排期。
- **`ALLOW_REGISTRATION` 默认开启**(向后兼容),`.env.example` 标注生产建议关闭。
- **已知缺口本次不动**:`get_file` 文件读取无鉴权(routers/files.py:104 docstring 已标注为阶段性决策)、`cancel` 用独立 `cancelled` 状态(需前端配合)、API key DB at-rest 加密(独立排期)。
- **迁移链已核查完整**,无断链。

执行遵循项目协作规则:每阶段改完给 diff 摘要 + 验证步骤,不自动提交,等确认后 `git add + commit + push`。新增依赖:无(限流用内存实现,magic bytes 用白名单,均不引包)。

---

## 阶段一:P0(崩溃 + 路径穿越)

### 1.1 `get_file` 路径穿越 → `app/routers/files.py:104`
- **改法**:进入函数即用 `os.path.realpath` 解析,断言结果在 `UPLOAD_DIR` 的 realpath 之内,否则 404。
  ```python
  full_path = os.path.realpath(os.path.join(UPLOAD_DIR, filepath))
  upload_root = os.path.realpath(UPLOAD_DIR)
  if not (full_path == upload_root or full_path.startswith(upload_root + os.sep)):
      raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
  ```
- **要点**:前缀比较用 `upload_root + os.sep` 防 `uploads2` 撞库;越界统一 404 不暴露存在性。
- **测试**:`tests/test_p0_path_traversal.py` —— `GET /api/files/../../../../etc/passwd`、`..%2f` 编码、`../../Windows/win.ini` 均断言 404;正常上传路径断言 200。

### 1.2 `capture_frame` NameError → `app/routers/files.py:176`
- **改法**:`time={time}s` → `time={seek_time}s`(无需 import)。
- **测试**:`tests/test_p0_capture_frame.py` —— monkeypatch `media.extract_video_frame` 返回有效路径(免 ffmpeg),POST capture-frame 断言 200 + 返回 url(修复前 500 NameError)。

---

## 阶段二:P1(SSRF + 上传限制)

### 2.1 抽公共 SSRF 服务并接入生成链路
- **新建** `app/services/ssrf.py`:把 `ai_proxy.py:43-183` 的 `_dns_pin`/`_resolve_and_validate`/`_is_private_ip`/`_HOSTNAME_BLOCKLIST`/`_ALLOWED_INTERNAL_HOSTS` 整体迁入,导出 `resolve_and_validate(base_url) -> (ip, hostname, scheme, port)` 与 `dns_pin(hostname, ip, port)` 上下文管理器。
- **改 `ai_proxy.py`**:`from app.services.ssrf import resolve_and_validate, dns_pin`,删除本地副本(行数大幅下降)。
- **改 `worker.py:_process_task`**(约 170 行):拿到 `base_url` 后调用 `resolve_and_validate`,把 `httpx.AsyncClient` 请求包进 `with dns_pin(...)`。
- **改 `base.py:download_and_save`**(122-153):
  - 删除 401 重发带 `auth_header` 逻辑(凭证泄漏)。
  - `follow_redirects=False`。
  - 对 `cdn_url` 先 `resolve_and_validate` + `dns_pin`。
  - 保留 `_is_self_url` 短路(已是本地 url 直接返回)。
- **改 `worker.py:_resolve_refs`**(101-121):本地 ref 下载同样过 `resolve_and_validate`(本地 host 走白名单)。
- **测试**:
  - `tests/test_p1_ssrf.py`:`POST /api/model-config/channels` 传 `127.0.0.1`/`169.254.169.254`/`192.168.1.1`/`localhost` 断言 400(修复前直接存库)。
  - `tests/test_p1_download_no_credential_leak.py`:mock httpx 捕获发往 cdn_url 的请求头,断言不含 provider apiKey。

### 2.2 上传大小限制 + 真实类型校验 → `app/routers/files.py:40` + `config.py`
- **改 `config.py`**:加 `MAX_UPLOAD_SIZE_MB: int = 30`。
- **改 `files.py:upload_file`**:
  - 分块读(1MB/块)累加,超限即 413,不再 `await file.read()` 一次读全。
  - 加 `_sniff_mime(data)` 白名单(PNG/JPEG/WEBP/GIF/MP4/WebM magic bytes),以 sniff 为准忽略客户端 `content_type`。
- **测试**:`tests/test_p1_upload_limits.py` —— 2MB 内容 + 1MB 上限断言 413;`content_type: image/png` 但内容为 `b"alert(1)"` 断言 400。

---

## 阶段三:P2(加固 + 一致性)

### 3.1 注册开关 + 限流 → `config.py` + 新建 `app/services/ratelimit.py` + `auth.py`
- **`config.py`**:`ALLOW_REGISTRATION: bool = True`(默认开启,`.env.example` 注释建议生产关)。
- **`auth.py:register`** 开头:`if not settings.ALLOW_REGISTRATION: raise 403`。
- **`ratelimit.py`**:内存滑动窗口,按 `(ip, scope)` 计数。login 失败 5min/10 次、register 1h/5 次超限返回 429。用 `Depends` 注入。多进程不共享——计划内标注。
- **测试**:`tests/test_p2_registration_and_ratelimit.py` —— 关注册返回 403;连错 11 次密码第 11 次 429。

### 3.2 `delete_file` 改引用计数 → `app/routers/files.py:180`
- **改法**:删 `file_objects` 中该 `(user_id, hash)` 记录;查全表该 hash 引用计数,归零才 `os.remove` 物理文件 + 清缓存缩略图。
- **测试**:扩展 `test_supplement_1_cross_user.py` —— A、B 上传同一内容,A 删除后 B 的 url 仍 200,物理文件在两人都删后才消失。

### 3.3 schema 双重管理收敛 → `main.py:24` + 文档
- **改法**:`create_all` 保留作开发兜底,加 `logger.warning("create_all ran (dev fallback); production use: alembic upgrade head")`;README/`.env.example` 补「生产必须 `alembic upgrade head`」说明。
- **迁移链**:已确认 `…→d4cf9a7e2b12→a1b2c3d4e5f6→c0d1e2f3a4b5(head)` 完整,本次不动迁移。
- **测试**:启动 smoke——断言 `create_all` 后 users/generation_tasks/file_objects/file_references 表存在(已有 conftest 覆盖)。

### 3.4 CORS 误配修正 → `main.py:49-55`
- **改法**:`allow_origins=["*"]` 时强制 `allow_credentials=False`;非 `*` 时才 `True`。
- **测试**:`tests/test_p2_cors.py` —— `CORS_ORIGINS="*"` 下响应头无 `Access-Control-Allow-Credentials: true`。

### 3.5 密钥占位符启动校验 → `config.py` 或 `main.py` lifespan
- **改法**:`JWT_SECRET_KEY`/`ADMIN_PASSWORD` 仍为 `change-me-*` 占位值时,启动即报错退出(开发环境可设 `ALLOW_INSECURE_SECRETS=true` 跳过)。
- **测试**:`tests/test_p2_secret_guard.py` —— 占位值启动抛错;合法值正常。

### 3.6 API key 掩码回显 → `routers/model_config.py:12-24`
- **改法**:`list_channels` 不回传明文 `api_key`,改为掩码(如 `sk-***1234`)或空字符串;前端编辑时走独立「显示明文」端点(本次先做掩码,显示端点可作为后续)。create/update 仍接受明文写入。
- **测试**:`tests/test_p2_apikey_mask.py` —— list_channels 返回的 apiKey 不含原始明文。

### 3.7 死代码与签名清理
- **`deps.py:50`** 删除未被调用的 `get_current_user_or_none`。
- **`crud/canvas.py`**:`get_projects`/`create_project`/`update_project`/`delete_project` 的 `user_id` 由 `Optional` 收紧为 `int`;删除 `delete_project` 未使用的 `user_id` 形参(调用方同步改)。
- **`schemas/user.py:20`** 删除未使用的 `UserCreate`;`User.role` 默认改 `"user"`、`crud.create_user` 默认改 `"user"`(admin 仅 `ensure_admin_exists` 显式传)。
- **测试**:跑全量 `pytest` 确认无回归;`grep` 确认无残留引用。

### 3.8 轻量加固(低风险顺手项)
- **SSE 断连检测** `generate.py:113`:轮询内加 `if await request.is_disconnected(): break`(需把 `Request` 注入);循环内 `from app.database import ...` 提到循环外。
- **`n` 字段白名单** `generate.py:59`:`n` clamp 到 `[1, 4]`(完整 schema 统一归 P3)。
- **`worker.py:464`**:`_ensure_wal()` 移入 `try`,失败不致 worker 静默挂掉。
- **测试**:SSE 测客户端断开后生成器退出;`n=999` 被 clamp。

---

## 测试策略

- 复用现有 `tests/conftest.py`(内存 SQLite + ASGITransport + 真实 JWT + dependency override)。新增测试文件按上述命名放入 `tests/`。
- 每阶段结束跑 `pytest -q` 全量,确保旧测试不回归。SSRF/限流/mock httpx 的测试用 `monkeypatch` 注入假 client,不发起真实外网请求。
- 路径穿越/上传/删除等文件系统测试用 conftest 的 `TEST_UPLOAD_DIR` 隔离。

## 提交策略

按阶段拆 commit(中文 message,说明改了啥/为啥):
1. `fix(files): 修复 get_file 路径穿越与 capture_frame 日志 NameError`
2. `fix(security): SSRF 防护抽公共服务并接入生成链路,修复 download 凭证泄漏`
3. `feat(files): 上传增加大小限制与 magic bytes 校验`
4. `feat(auth): 注册开关与登录限流` / `fix(files): delete_file 改引用计数` / 其余 P2 小项按相关性分组

每 commit 前检查无遗留调试代码;不自动 push,等确认。

## 风险

- **2.1 SSRF 抽取**改动面最大(ai_proxy+worker+base 三处),是本次唯一有回归风险的项——会先出完整 diff 待确认再落地。
- **3.6 API key 掩码**可能影响前端编辑流程(前端依赖回显明文),需同步检查前端 `model-store`/设置页;若前端强依赖明文,则降级为「仅日志脱敏,接口暂不掩码」。
- **3.7 role 默认值**变更不影响既有数据(仅影响新建用户默认),但需确认无地方依赖默认 admin。
