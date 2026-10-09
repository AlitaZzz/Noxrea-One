import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  me: vi.fn(), login: vi.fn(), updateMe: vi.fn(), bootstrap: vi.fn(), createAsset: vi.fn(),
  createAssetsBatch: vi.fn(), fetchProviders: vi.fn(), deleteProject: vi.fn(), notify: vi.fn(), language: vi.fn(),
}));
vi.mock("@/features/auth/api", () => ({ authApi: {
  me: mocks.me, login: mocks.login, logout: async () => undefined, updateMe: mocks.updateMe,
} }));
vi.mock("@/features/assets/api", () => ({ ASSET_BATCH_LIMIT: 1, assetApi: {
  bootstrap: mocks.bootstrap, createAsset: mocks.createAsset, createAssetsBatch: mocks.createAssetsBatch,
} }));
vi.mock("@/lib/api/model-api", () => ({ modelApi: {
  fetchProviders: mocks.fetchProviders, fetchPresets: async () => [], fetchModelParams: async () => ({}),
} }));
vi.mock("@/features/project/api", () => ({ projectApi: { deleteProject: mocks.deleteProject } }));
vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: mocks.notify }),
  notifyFailure: () => undefined,
}));
vi.mock("@/lib/i18n/config", () => ({
  default: { t: (key: string) => key, exists: () => false }, setAppLanguage: mocks.language,
}));

import { useAssetsStore } from "@/features/assets/store";
import { useAuthStore } from "@/features/auth/store";
import { useProjectStore } from "@/features/project/store";
import { useModelStore } from "@/lib/model-store";
import { SessionChangedError } from "@/lib/session-lifecycle";

const userA = { id: 1, username: "a", avatarUrl: null, theme: "dark", language: "zh" };
const userB = { ...userA, id: 2, username: "b" };
function summary(id: number) {
  return { folders: [{ id, name: `Folder ${id}`, scope: "personal", kind: "normal", parentId: null,
    createdAt: "2026-10-01T00:00:00Z", count: 1 }], sourceUrls: [`source-${id}`] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function switchToB() {
  await useAuthStore.getState().logout();
  await useAuthStore.getState().login("b", "password");
}

describe("account-owned state lifetime", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useAuthStore.setState({ user: null, loading: false, initialized: false });
    useAuthStore.setState({ user: userA });
    mocks.login.mockResolvedValue({ user: userB });
  });
  afterEach(() => { useAuthStore.setState({ user: null }); });

  it("clears folders, saved URLs, model secrets and project state synchronously on logout", async () => {
    mocks.bootstrap.mockResolvedValue(summary(101));
    await useAssetsStore.getState().initialize();
    useModelStore.setState({ initialized: true, providers: [{ id: "a", name: "A", baseUrl: "", apiKey: "secret", models: [] }] });
    useProjectStore.setState({ activeProjectId: "a" });
    const logout = useAuthStore.getState().logout();
    expect(useAssetsStore.getState()).toMatchObject({ folders: [], initialized: false, libraryVersion: 0 });
    expect(useAssetsStore.getState().knownAssetUrls.size).toBe(0);
    expect(useModelStore.getState()).toMatchObject({ providers: [], initialized: false, modelParamsCache: {} });
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    await logout;
    await useAuthStore.getState().login("b", "password");
    mocks.bootstrap.mockResolvedValue(summary(202));
    await useAssetsStore.getState().initialize();
    expect(useAssetsStore.getState().folders.map((folder) => folder.id)).toEqual(["202"]);
    expect([...useAssetsStore.getState().knownAssetUrls]).toEqual(["source-202"]);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("does not reuse A's pending bootstrap or let its cleanup remove B's pending request", async () => {
    const a = deferred<ReturnType<typeof summary>>();
    const b = deferred<ReturnType<typeof summary>>();
    mocks.bootstrap.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const pendingA = useAssetsStore.getState().initialize();
    await switchToB();
    const pendingB = useAssetsStore.getState().initialize();
    a.resolve(summary(101));
    await pendingA;
    expect(useAssetsStore.getState().folders).toEqual([]);
    const duplicateB = useAssetsStore.getState().initialize();
    expect(duplicateB).toBe(pendingB);
    b.resolve(summary(202));
    await pendingB;
    expect(useAssetsStore.getState().folders[0].id).toBe("202");
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("discards pending writes and stops subsequent batch requests after the session ends", async () => {
    const write = deferred<unknown>();
    const batch = deferred<unknown>();
    mocks.createAsset.mockReturnValue(write.promise);
    mocks.createAssetsBatch.mockReturnValue(batch.promise);
    const input = { name: "A asset", type: "other" as const, mediaType: "image" as const, sourceUrl: "a-url" };
    const pendingWrite = useAssetsStore.getState().addAsset(input);
    const pendingBatch = useAssetsStore.getState().addAssetsBatch([input, input]);
    await switchToB();
    write.resolve({ item: {}, counters: {} });
    batch.resolve({ items: [], counters: {}, skipped: [] });
    expect(await pendingWrite).toBeNull();
    expect(await pendingBatch).toEqual({ ok: false, items: [], skippedCount: 0 });
    expect(mocks.createAssetsBatch).toHaveBeenCalledTimes(1);
    expect(useAssetsStore.getState().knownAssetUrls.size).toBe(0);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("discards old model initialization responses, including failures", async () => {
    const a = deferred<unknown>();
    mocks.fetchProviders.mockReturnValueOnce(a.promise).mockResolvedValueOnce([]);
    const pendingA = useModelStore.getState().initialize();
    await switchToB();
    await useModelStore.getState().initialize();
    a.reject(new Error("old network error"));
    await pendingA;
    expect(useModelStore.getState()).toMatchObject({ providers: [], initialized: true, initializeFailed: false });
  });

  it("does not copy A's model secrets into B from a late successful response", async () => {
    const providers = deferred<unknown>();
    mocks.fetchProviders.mockReturnValueOnce(providers.promise).mockResolvedValueOnce([]);
    const pendingA = useModelStore.getState().initialize();
    await switchToB();
    await useModelStore.getState().initialize();
    providers.resolve([{ id: "a", name: "A", baseUrl: "", apiKey: "secret", models: [] }]);
    await pendingA;
    expect(useModelStore.getState().providers).toEqual([]);
  });

  it("does not restore A's optimistically deleted projects after B logs in", async () => {
    const deletion = deferred<unknown>();
    mocks.deleteProject.mockReturnValue(deletion.promise);
    useProjectStore.setState({ projects: [{ id: "a", name: "A", revision: 1, updatedAt: 0, nodeCount: 0 }] });
    useProjectStore.getState().deleteProject("a");
    await switchToB();
    deletion.reject(new Error("old delete failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not restore A from a delayed /me after B has logged in", async () => {
    const me = deferred<typeof userA>();
    mocks.me.mockReturnValue(me.promise);
    const pending = useAuthStore.getState().initialize();
    await switchToB();
    me.resolve(userA);
    await pending;
    expect(useAuthStore.getState()).toMatchObject({ user: userB, initialized: true, loading: false });
  });

  it("does not roll back B's preference or language when A's save fails", async () => {
    const update = deferred<unknown>();
    mocks.updateMe.mockReturnValue(update.promise);
    const pending = useAuthStore.getState().savePreference("language", "en");
    await switchToB();
    useAuthStore.setState({ user: { ...userB, language: "en" } });
    mocks.language.mockClear();
    update.reject(new Error("old save failed"));
    await pending;
    expect(useAuthStore.getState().user?.language).toBe("en");
    expect(mocks.language).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("invalidates work even when the same user logs out and logs back in", async () => {
    const login = deferred<{ user: typeof userA }>();
    mocks.login.mockReturnValueOnce(login.promise);
    const pending = useAuthStore.getState().login("a", "password");
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    await useAuthStore.getState().logout();
    login.resolve({ user: userA });
    await rejected;
    expect(useAuthStore.getState().user).toBeNull();
  });
});
