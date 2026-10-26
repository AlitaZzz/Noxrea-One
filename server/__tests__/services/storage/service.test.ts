/**
 * 存储服务引导单测（specs/storage-s3-backend.md 规则 1/2）：
 * local 默认构建、s3 缺必填键启动失败并指明键名、s3 全键构建成功、
 * 重复初始化 fail-fast。service 为进程级单例，逐测试 vi.resetModules 隔离；
 * 设置快照走 hoisted 共享状态，与替身模块的实例身份解耦（resetModules 安全）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({ uploadDir: "uploads" }));
const settingsState = vi.hoisted(() => ({ current: new Map<string, unknown>() }));

vi.mock("@server/core/config", () => ({
  getConfig: () => ({
    UPLOAD_DIR: cfg.uploadDir,
    FFMPEG_PATH: "ffmpeg",
    LOG_LEVEL: "silent",
    ALLOW_INSECURE_SECRETS: true,
  }),
}));
vi.mock("@server/core/settings", () => ({
  getSetting: (key: string) => settingsState.current.get(key),
}));

/** 播种注册表默认值后覆盖单项（registry 为真实模块，仅 index 被替身） */
async function configureSettings(overrides: Record<string, unknown> = {}): Promise<void> {
  const { SETTING_DEFS } = await import("@server/core/settings/registry");
  settingsState.current = new Map(
    Object.entries(SETTING_DEFS).map(([key, def]) => [key, def.default]),
  );
  for (const [key, value] of Object.entries(overrides)) settingsState.current.set(key, value);
}

beforeEach(() => {
  vi.resetModules();
});

describe("initStorageBackend", () => {
  it("backend=local（默认）构建 LocalStorageBackend", async () => {
    await configureSettings();
    const service = await import("@server/services/storage/service");
    const { LocalStorageBackend } = await import("@server/services/storage/backends/local");
    service.initStorageBackend();
    expect(service.getStorageBackend()).toBeInstanceOf(LocalStorageBackend);
  });

  it("backend=s3 且必填键全部缺失：启动失败并指明全部缺失键名", async () => {
    await configureSettings({ "storage.backend": "s3" });
    const service = await import("@server/services/storage/service");
    expect(() => service.initStorageBackend()).toThrow(
      /storage\.s3\.endpoint, storage\.s3\.bucket, storage\.s3\.region, storage\.s3\.access_key_id, storage\.s3\.secret_access_key/,
    );
  });

  it("backend=s3 部分缺失：只指明缺失的键", async () => {
    await configureSettings({
      "storage.backend": "s3",
      "storage.s3.endpoint": "http://minio.local:9000",
      "storage.s3.bucket": "noxrea",
    });
    const service = await import("@server/services/storage/service");
    expect(() => service.initStorageBackend()).toThrow(
      /storage\.s3\.region, storage\.s3\.access_key_id, storage\.s3\.secret_access_key/,
    );
  });

  it("backend=s3 全键齐备：构建 S3Backend（连接参数透传，可预签名）", async () => {
    await configureSettings({
      "storage.backend": "s3",
      "storage.s3.endpoint": "http://minio.local:9000",
      "storage.s3.bucket": "noxrea",
      "storage.s3.region": "us-east-1",
      "storage.s3.access_key_id": "AKIA_TEST",
      "storage.s3.secret_access_key": "SECRET_TEST",
      "storage.s3.prefix": "app",
    });
    const service = await import("@server/services/storage/service");
    service.initStorageBackend();
    const backend = service.getStorageBackend();
    expect(typeof backend.presignPut).toBe("function");
    expect(typeof backend.presignGet).toBe("function");
    expect((backend as unknown as { endpoint: string }).endpoint).toBe("http://minio.local:9000");
  });

  it("S3 连接参数由 provider profile 决定（不再有独立寻址开关）", async () => {
    await configureSettings({ "storage.s3.provider": "minio" });
    const service = await import("@server/services/storage/service");
    expect(service.s3OptionsFromSettings().provider).toBe("minio");

    await configureSettings();
    const defaults = await import("@server/services/storage/service");
    expect(defaults.s3OptionsFromSettings().provider).toBe("generic");
    expect("pathStyle" in defaults.s3OptionsFromSettings()).toBe(false);
  });

  it("CORS 探测来源取自 network.public_base_url 的 scheme+host；未配置则不传", async () => {
    await configureSettings({ "network.public_base_url": "https://noxrea.example/some/path?x=1" });
    const service = await import("@server/services/storage/service");
    // CORS 按来源白名单放行：探测必须拿站点来源（scheme+host），路径与查询不参与
    expect(service.s3OptionsFromSettings().browserOrigin).toBe("https://noxrea.example");

    await configureSettings();
    expect((await import("@server/services/storage/service")).s3OptionsFromSettings().browserOrigin)
      .toBeUndefined();
  });

  it("probeStorageBackend：local 后端不支持探测，返回 null 且就绪恒为真", async () => {
    await configureSettings();
    const service = await import("@server/services/storage/service");
    service.initStorageBackend();
    await expect(service.probeStorageBackend()).resolves.toBeNull();
    expect(service.storageReady()).toBe(true);
  });

  it("重复初始化 fail-fast", async () => {
    const service = await import("@server/services/storage/service");
    const { LocalStorageBackend } = await import("@server/services/storage/backends/local");
    service.initStorageBackend(new LocalStorageBackend(cfg.uploadDir));
    expect(() => service.initStorageBackend()).toThrow(/already initialized/);
  });
});
