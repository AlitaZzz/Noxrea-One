/**
 * PostgreSQL 连接串校验（specs/pglite-removal.md）。
 * 应用只允许一种数据库运行时：外置 PostgreSQL。PGlite 本地模式已移除，
 * 不再接受 file: / 未设置 / 其他前缀，也不存在任何回退路径。
 */

export function isPostgresDatabaseUrl(url: string): boolean {
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

/**
 * 把连接串解析为 URL；校验与错误文案只在这里定义。
 * assertDatabaseUrl 与 describeDatabaseTarget 共用同一入口，调用方无法绕过校验。
 */
function parsePostgresDatabaseUrl(url: string, label: string): URL {
  if (!isPostgresDatabaseUrl(url)) {
    throw new Error(
      `${label} 必须是 postgres:// 或 postgresql:// 连接串。` +
        "PGlite 本地模式已移除，请提供外置 PostgreSQL 连接串，并先执行 `npm run db:migrate:deploy` 初始化数据库。",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} 不是合法的连接 URL，请检查格式（postgres://用户:密码@主机:端口/库名）。`);
  }
  if (!parsed.hostname || !parsed.pathname.replace(/^\/+/, "")) {
    throw new Error(`${label} 缺少主机或数据库名，请检查格式（postgres://用户:密码@主机:端口/库名）。`);
  }
  return parsed;
}

export interface DatabaseTarget {
  host: string;
  port: string;
  database: string;
}

/**
 * 解析连接串的数据库目标，供“是否同一个数据库”判定共用。
 * 只比较 host/port/database，忽略协议写法与查询参数差异。
 */
export function parsePostgresDatabaseTarget(url: string, label = "数据库连接串"): DatabaseTarget {
  const parsed = parsePostgresDatabaseUrl(url, label);
  let database: string;
  try {
    database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error(`${label} 的数据库名包含非法 URL 编码，请检查连接串。`);
  }
  return {
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || "5432",
    database,
  };
}

export function isSameDatabaseTarget(a: DatabaseTarget, b: DatabaseTarget): boolean {
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

/**
 * 断言两个连接串不指向同一个数据库：shadow 回放、测试库清空都会破坏目标库数据。
 * 任一不是 postgres 连接串时跳过；缺失/非法的语义由调用方决定（应用启动由 assertDatabaseUrl 负责），
 * 这里只负责同库判定，避免每个调用方各自实现一套比较与文案。
 */
export function assertDistinctDatabaseTargets(
  first: { url: string; label: string },
  second: { url: string; label: string },
  consequence: string,
): void {
  if (!isPostgresDatabaseUrl(first.url) || !isPostgresDatabaseUrl(second.url)) return;
  const firstTarget = parsePostgresDatabaseTarget(first.url, first.label);
  const secondTarget = parsePostgresDatabaseTarget(second.url, second.label);
  if (!isSameDatabaseTarget(firstTarget, secondTarget)) return;
  throw new Error(
    `${first.label} 与 ${second.label} 指向同一个数据库` +
      `（${firstTarget.host}:${firstTarget.port}/${firstTarget.database}）：${consequence}`,
  );
}

/**
 * 读取并校验 DATABASE_URL；缺失、前缀非法或 URL 不可解析时直接失败。
 * bootstrap 启动早期与数据库客户端首次实例化都会调用，保证启动期暴露。
 */
export function assertDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  parsePostgresDatabaseUrl(url, "DATABASE_URL");
  return url;
}

/** 连接目标的可读描述（供启动日志）：pg 用户@host:port/库；密码一律不出现。 */
export function describeDatabaseTarget(url: string): string {
  const parsed = parsePostgresDatabaseUrl(url, "数据库连接串");
  const user = parsed.username ? `${parsed.username}@` : "";
  return `pg ${user}${parsed.host}${parsed.pathname}`;
}
