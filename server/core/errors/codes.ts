/**
 * 错误码字典（服务端唯一真源）。
 *
 * 命名采用「点分域前缀 + snake_case」，与前端 i18n 中 error 命名空间的嵌套 key
 * 一一对应：错误码 `models.upstream_unauthorized` 对应文案 key
 * `error.models.upstream_unauthorized`。
 *
 * 新增错误码流程：先在此登记 → 再补充 zh-CN / en-US 双语文案。
 * 未登记的错误码会因类型约束无法通过编译，避免漏翻。
 */
export const ERROR_CODES = [
  // ── 通用 ──
  /** 请求体不是合法 JSON */
  "common.invalid_json",
  /** 服务端返回内容为空 */
  "common.empty_response",
  /** 服务端响应格式异常 */
  "common.unexpected_response",
  /** 未登录或凭证无效 */
  "common.unauthorized",
  /** 请求参数不合法（字段校验未通过） */
  "common.invalid_request",
  /** 无访问权限 */
  "common.forbidden",
  /** 资源不存在 */
  "common.not_found",
  /** 资源冲突（如重名） */
  "common.conflict",
  /** 触发限流 */
  "common.rate_limited",
  /** 服务端内部错误 */
  "common.internal_error",

  // ── 模型 ──
  /** 拉取模型列表失败 */
  "models.fetch_failed",
  /** 供应商不存在 */
  "models.provider_not_found",
  /** 本地未找到该供应商 */
  "models.provider_not_found_in_store",
  /** 供应商未配置基础 URL */
  "models.provider_no_base_url",
  /** 缺少 providerId 或 baseUrl */
  "models.provider_id_or_base_url_required",
  /** 上游鉴权失败 */
  "models.upstream_unauthorized",
  /** 上游拒绝访问 */
  "models.upstream_forbidden",
  /** 上游接口不存在 */
  "models.upstream_not_found",
  /** 上游触发限流 */
  "models.upstream_rate_limited",
  /** 上游服务异常（5xx） */
  "models.upstream_server_error",
  /** 上游返回错误（其余 4xx） */
  "models.upstream_fetch_failed",
  /** 无法连接上游服务 */
  "models.upstream_unreachable",

  // ── 供应商配置 ──
  /** 供应商 ID 非法 */
  "model_config.invalid_provider_id",
  /** 供应商不存在 */
  "model_config.provider_not_found",
  /** 模型 ID 非法 */
  "model_config.invalid_model_id",
  /** 模型不存在 */
  "model_config.model_not_found",

  // ── 画布 ──
  /** 缺少 type 查询参数 */
  "canvas.missing_type_param",
  /** 提示词模板不存在 */
  "canvas.template_not_found",
  /** 项目 ID 非法 */
  "canvas.invalid_project_id",
  /** 项目不存在 */
  "canvas.project_not_found",

  // ── 素材 ──
  /** 素材分类 ID 非法 */
  "assets.invalid_folder_id",
  /** 素材分类不存在 */
  "assets.folder_not_found",
  /** 素材 ID 非法 */
  "assets.invalid_asset_id",
  /** 素材不存在 */
  "assets.asset_not_found",

  // ── Agent ──
  /** 会话不存在 */
  "agent.session_not_found",
  /** 缺少 sessionId */
  "agent.session_id_required",
  /** 上游模型调用失败 */
  "agent.upstream_failed",

  // ── 生成任务执行（异步，错误码经 SSE 传给前端，不落库） ──
  /** 调用上游超时 */
  "generation.timeout",
  /** 无法连接上游服务 */
  "generation.network_error",
  /** 上游返回 HTTP 错误且未给出可读说明 */
  "generation.upstream_http_error",
  /** 上游既未返回结果也未返回任务 ID，且未给出可读说明 */
  "generation.upstream_no_result",
  /** 任务已被取消 */
  "generation.cancelled",
  /** 任务缺少供应商配置 */
  "generation.missing_provider_id",
  /** 供应商不存在或已被删除 */
  "generation.provider_not_found",
  /** 供应商地址被 SSRF 防护拦截 */
  "generation.ssrf_blocked",
  /** 未知的生成能力类型 */
  "generation.unknown_capability",

  // ── 生成任务接口（同步 HTTP） ──
  /** 请求体超过体积上限 */
  "generate.body_too_large",
  /** 缺少 providerId */
  "generate.provider_id_required",
  /** 供应商不存在 */
  "generate.provider_not_found",
  /** 供应商未配置协议 */
  "generate.provider_protocol_missing",
  /** 任务不存在 */
  "generate.task_not_found",
  /** 任务已处于终态 */
  "generate.task_already_finished",

  // ── 上传 ──
  /** 表单数据解析失败 */
  "upload.invalid_form_data",
  /** 未携带文件 */
  "upload.no_file",
  /** 文件体积超过上限 */
  "upload.file_too_large",
  /** 文件类型不受支持 */
  "upload.unsupported_type",
  /** 上传处理失败（落盘或持久化异常） */
  "upload.upload_failed",

  // ── 文件 ──
  /** 文件路径非法 */
  "files.invalid_path",
  /** 无权访问该文件 */
  "files.access_denied",
  /** 文件不存在 */
  "files.file_not_found",

  // ── 视频抽帧 ──
  /** 源视频不存在 */
  "capture_frame.video_not_found",
  /** 未安装 ffmpeg */
  "capture_frame.ffmpeg_missing",
  /** 抽帧处理失败 */
  "capture_frame.capture_failed",

  // ── 认证 ──
  /** 未携带登录凭证 */
  "auth.not_authenticated",
  /** 登录凭证无效或已过期 */
  "auth.token_invalid",
  /** 用户不存在或已被停用 */
  "auth.user_inactive",
  /** 用户名或密码错误 */
  "auth.invalid_credentials",
  /** 注册功能已关闭 */
  "auth.registration_disabled",
  /** 用户名已被占用 */
  "auth.username_taken",
  /** 登录尝试过于频繁 */
  "auth.login_rate_limited",
  /** 注册尝试过于频繁 */
  "auth.register_rate_limited",
  /** 当前密码不正确 */
  "auth.current_password_incorrect",
  /** 用户不存在 */
  "auth.user_not_found",
] as const;

/** 错误码联合类型，用于约束 failCode 调用，防止拼写错误与漏登记 */
export type ErrorCode = (typeof ERROR_CODES)[number];
