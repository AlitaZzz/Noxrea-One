/**
 * 模型配置写操作回归测试：写请求失败时不得修改本地状态。
 *
 * 覆盖此前的问题：updateProvider / deleteProvider / toggleModelCapability
 * 不校验业务码，UI 已经提示成功，刷新后配置又回到原样。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProvider: vi.fn(),
  deleteProvider: vi.fn(),
  setModelCapability: vi.fn(),
  addModel: vi.fn(),
  createProvider: vi.fn(),
  setProviderModels: vi.fn(),
  fetchProviders: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/features/settings/api", () => ({
  modelApi: {
    updateProvider: (...args: unknown[]) => mocks.updateProvider(...args),
    deleteProvider: (...args: unknown[]) => mocks.deleteProvider(...args),
    setModelCapability: (...args: unknown[]) => mocks.setModelCapability(...args),
    addModel: (...args: unknown[]) => mocks.addModel(...args),
    createProvider: (...args: unknown[]) => mocks.createProvider(...args),
    setProviderModels: (...args: unknown[]) => mocks.setProviderModels(...args),
    fetchProviders: (...args: unknown[]) => mocks.fetchProviders(...args),
    fetchPresets: vi.fn(async () => ({ code: 200, data: [], msg: "" })),
    fetchModelParams: vi.fn(async () => ({ code: 200, data: {}, msg: "" })),
  },
}));

vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => mocks.notify,
}));

vi.mock("@/lib/i18n/config", () => ({
  default: { t: (k: string) => k, exists: () => false },
}));

import { useModelStore } from "@/lib/model-store";

const PROVIDER = {
  id: "p1",
  name: "旧名称",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test",
  models: [{ id: "m1", name: "gpt-x", capabilities: [] as ("image")[] }],
};

describe("model-store 写操作", () => {
  beforeEach(() => {
    mocks.updateProvider.mockReset();
    mocks.deleteProvider.mockReset();
    mocks.setModelCapability.mockReset();
    mocks.addModel.mockReset();
    mocks.createProvider.mockReset();
    mocks.setProviderModels.mockReset();
    mocks.fetchProviders.mockReset();
    mocks.fetchProviders.mockResolvedValue({ code: 200, data: [structuredClone(PROVIDER)], msg: "" });
    mocks.notify.error.mockReset();
    useModelStore.setState({ providers: [structuredClone(PROVIDER)] });
  });

  it("更新供应商失败时不改本地状态并提示", async () => {
    mocks.updateProvider.mockResolvedValue({ code: 500, data: null, msg: "服务内部错误" });

    const ok = await useModelStore.getState().updateProvider("p1", { name: "新名称" });

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers[0].name).toBe("旧名称");
    expect(mocks.notify.error).toHaveBeenCalled();
  });

  it("更新供应商成功时合并本地状态", async () => {
    mocks.updateProvider.mockResolvedValue({ code: 200, data: null, msg: "" });

    const ok = await useModelStore.getState().updateProvider("p1", { name: "新名称" });

    expect(ok).toBe(true);
    expect(useModelStore.getState().providers[0].name).toBe("新名称");
    expect(mocks.notify.error).not.toHaveBeenCalled();
  });

  it("删除供应商失败时保留该供应商", async () => {
    mocks.deleteProvider.mockResolvedValue({ code: 403, data: null, msg: "无权访问" });

    const ok = await useModelStore.getState().deleteProvider("p1");

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers).toHaveLength(1);
    expect(mocks.notify.error).toHaveBeenCalled();
  });

  it("能力勾选失败时不写入本地", async () => {
    mocks.setModelCapability.mockResolvedValue({ code: 500, data: null, msg: "服务内部错误" });

    const ok = await useModelStore.getState().toggleModelCapability("p1", "m1", "image");

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers[0].models[0].capabilities).toEqual([]);
    expect(mocks.notify.error).toHaveBeenCalled();
  });

  it("能力勾选成功时写入本地", async () => {
    mocks.setModelCapability.mockResolvedValue({ code: 200, data: null, msg: "" });

    const ok = await useModelStore.getState().toggleModelCapability("p1", "m1", "image");

    expect(ok).toBe(true);
    expect(useModelStore.getState().providers[0].models[0].capabilities).toEqual(["image"]);
  });

  it("新增模型失败时不写入本地", async () => {
    mocks.addModel.mockResolvedValue({ code: 400, data: null, msg: "模型名重复" });

    const ok = await useModelStore.getState().addModel("p1", "gpt-y");

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers[0].models).toHaveLength(1);
    expect(mocks.notify.error).toHaveBeenCalled();
  });

  it("批量写入失败时不改本地能力", async () => {
    mocks.setProviderModels.mockResolvedValue({ code: 500, data: null, msg: "服务内部错误" });

    const ok = await useModelStore.getState().setProviderModels("p1", [
      { name: "gpt-x", capabilities: ["image"] },
    ]);

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers[0].models[0].capabilities).toEqual([]);
    expect(mocks.notify.error).toHaveBeenCalled();
  });

  it("写入成功但重新拉取失败时仍算成功，并按入参就地更新本地", async () => {
    mocks.setProviderModels.mockResolvedValue({ code: 200, data: null, msg: "" });
    mocks.fetchProviders.mockResolvedValue({ code: 500, data: null, msg: "服务内部错误" });

    const ok = await useModelStore.getState().setProviderModels("p1", [
      { name: "gpt-x", capabilities: ["image"] },
    ]);

    // 服务端已写入，不能因刷新列表失败就提示「批量更新失败」
    expect(ok).toBe(true);
    expect(useModelStore.getState().providers[0].models[0].capabilities).toEqual(["image"]);
  });

  it("新增供应商失败时不写入本地", async () => {
    mocks.createProvider.mockResolvedValue({ code: 0, data: null, msg: "无法连接服务器" });

    const ok = await useModelStore.getState().addProvider("p2", "https://x.com/v1", "sk");

    expect(ok).toBe(false);
    expect(useModelStore.getState().providers).toHaveLength(1);
    expect(mocks.notify.error).toHaveBeenCalled();
  });
});
