// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(), me: vi.fn(), login: vi.fn(), updateMe: vi.fn(), bootstrap: vi.fn(), createAsset: vi.fn(),
  createAssetsBatch: vi.fn(), fetchProviders: vi.fn(), deleteProject: vi.fn(), notify: vi.fn(), language: vi.fn(),
}));
vi.mock("@/lib/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/client")>();
  return { ...actual, api: mocks.api };
});
vi.mock("@/lib/api/model-api", () => ({ modelApi: {
  fetchProviders: mocks.fetchProviders, fetchPresets: async () => [], fetchModelParams: async () => ({}),
} }));
vi.mock("@/lib/global-notification", () => ({
  showGlobalNotification: () => ({ error: mocks.notify }),
  notifyFailure: () => undefined,
}));
vi.mock("@/lib/i18n/config", () => ({
  default: { t: (key: string) => key, exists: () => false }, setAppLanguage: mocks.language,
}));

import {
  addAsset, addAssetsBatch,   type CreateAssetInput,
initialize as initializeAssets,
  useAssetFolders, useAssetLibraryVersion, useAssetsInitialized, useKnownAssetKeys,
} from "@/entities/asset";
import {
  activateProject, deleteProject, upsertProjectSummary,
  useActiveProjectId, useProjects,
} from "@/entities/project";
import { initializeSession, login, logout, savePreference, useSessionUser } from "@/entities/user";
import { useModelStore } from "@/lib/model-store";
import { SessionChangedError } from "@/lib/session-lifecycle";

const userA = { id: 1, username: "a", avatarKey: null, theme: "dark", language: "zh" };
const userB = { ...userA, id: 2, username: "b" };
function summary(id: number) {
  return { folders: [{ id, name: `Folder ${id}`, scope: "personal", kind: "normal", parentId: null,
    createdAt: "2026-10-01T00:00:00Z", count: 1 }], fileKeys: [`source-${id}`] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function switchToB() {
  await logout();
  await login("b", "password");
}
function useAccountState() {
  return {
    folders: useAssetFolders(),
    assetsInitialized: useAssetsInitialized(),
    libraryVersion: useAssetLibraryVersion(),
    knownAssetKeys: useKnownAssetKeys(),
    projects: useProjects(),
    activeProjectId: useActiveProjectId(),
    user: useSessionUser(),
  };
}

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.api.mockImplementation((path: string, options?: { method?: string }) => {
    if (path === "/api/auth/login") return mocks.login();
    if (path === "/api/auth/me" && options?.method === "PUT") return mocks.updateMe();
    if (path === "/api/auth/me") return mocks.me();
    if (path === "/api/assets/bootstrap?scope=personal") return mocks.bootstrap();
    if (path === "/api/assets/items" && options?.method === "POST") return mocks.createAsset();
    if (path === "/api/assets/items/batch" && options?.method === "POST") return mocks.createAssetsBatch();
    if (path === "/api/canvas/projects/a" && options?.method === "DELETE") return mocks.deleteProject();
    return Promise.resolve(null);
  });
  mocks.me.mockResolvedValue(null);
  mocks.login.mockResolvedValue({ user: userA });
  mocks.bootstrap.mockResolvedValue({ folders: [], fileKeys: [] });
  mocks.updateMe.mockResolvedValue(null);
  await login("a", "password");
});

afterEach(async () => {
  cleanup();
  await logout();
});

describe("account-owned state lifetime", () => {
  it("clears folders, saved URLs, model secrets and project state synchronously on logout", async () => {
    mocks.bootstrap.mockResolvedValue(summary(101));
    const { result } = renderHook(() => useAccountState());
    await act(async () => { await initializeAssets(); });
    expect(result.current.folders.map((folder) => folder.id)).toEqual(["101"]);
    act(() => {
      useModelStore.setState({ initialized: true, providers: [{ id: "a", name: "A", baseUrl: "", apiKey: "secret", models: [] }] });
      activateProject("a");
    });
    expect(result.current.activeProjectId).toBe("a");
    let pending!: Promise<void>;
    act(() => { pending = logout(); });
    expect(result.current.folders).toEqual([]);
    expect(result.current.assetsInitialized).toBe(false);
    expect(result.current.libraryVersion).toBe(0);
    expect(result.current.knownAssetKeys.size).toBe(0);
    expect(useModelStore.getState()).toMatchObject({ providers: [], initialized: false, modelParamsCache: {} });
    expect(result.current.activeProjectId).toBeNull();
    await act(async () => { await pending; });
    mocks.login.mockResolvedValue({ user: userB });
    await act(async () => { await login("b", "password"); });
    mocks.bootstrap.mockResolvedValue(summary(202));
    await act(async () => { await initializeAssets(); });
    expect(result.current.folders.map((folder) => folder.id)).toEqual(["202"]);
    expect([...result.current.knownAssetKeys]).toEqual(["source-202"]);
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("does not reuse A's pending bootstrap or let its cleanup remove B's pending request", async () => {
    const a = deferred<ReturnType<typeof summary>>();
    const b = deferred<ReturnType<typeof summary>>();
    mocks.bootstrap.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const { result } = renderHook(() => useAccountState());
    const pendingA = initializeAssets();
    await act(async () => { await switchToB(); });
    const pendingB = initializeAssets();
    a.resolve(summary(101));
    await act(async () => { await pendingA; });
    expect(result.current.folders).toEqual([]);
    const duplicateB = initializeAssets();
    expect(duplicateB).toBe(pendingB);
    b.resolve(summary(202));
    await act(async () => { await pendingB; });
    expect(result.current.folders[0].id).toBe("202");
    expect(mocks.bootstrap).toHaveBeenCalledTimes(2);
  });

  it("discards pending writes and stops subsequent batch requests after the session ends", async () => {
    const write = deferred<unknown>();
    const batch = deferred<unknown>();
    mocks.createAsset.mockReturnValue(write.promise);
    mocks.createAssetsBatch.mockReturnValue(batch.promise);
    const { result } = renderHook(() => useAccountState());
    const input: CreateAssetInput = { name: "A asset", type: "other", mediaType: "image", fileKey: "a-url" };
    const pendingWrite = addAsset(input);
    const pendingBatch = addAssetsBatch([input, input]);
    await act(async () => { await switchToB(); });
    write.resolve({ item: {}, counters: {} });
    batch.resolve({ items: [], counters: {}, skipped: [] });
    expect(await pendingWrite).toBeNull();
    expect(await pendingBatch).toEqual({ ok: false, items: [], skippedCount: 0 });
    expect(mocks.createAssetsBatch).toHaveBeenCalledTimes(1);
    expect(result.current.knownAssetKeys.size).toBe(0);
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
    const { result } = renderHook(() => useAccountState());
    act(() => {
      upsertProjectSummary({ id: "a", name: "A", revision: 1, updatedAt: 0, nodeCount: 0 });
      void deleteProject("a");
    });
    await act(async () => { await switchToB(); });
    deletion.reject(new Error("old delete failure"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mocks.deleteProject).toHaveBeenCalledTimes(1);
    expect(result.current.projects).toEqual([]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("does not roll back B's preference or language when A's save fails", async () => {
    const update = deferred<unknown>();
    mocks.updateMe.mockReturnValueOnce(update.promise).mockResolvedValue(null);
    const { result } = renderHook(() => useAccountState());
    let pending!: Promise<void>;
    act(() => { pending = savePreference("language", "en"); });
    await act(async () => { await switchToB(); });
    await act(async () => { await savePreference("language", "en"); });
    mocks.language.mockClear();
    update.reject(new Error("old save failed"));
    await pending;
    expect(result.current.user?.language).toBe("en");
    expect(mocks.language).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("invalidates work even when the same user logs out and logs back in", async () => {
    const pendingLogin = deferred<{ user: typeof userA }>();
    mocks.login.mockReturnValueOnce(pendingLogin.promise);
    const pending = login("a", "password");
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    await logout();
    pendingLogin.resolve({ user: userA });
    await rejected;
    expect(await initializeSession()).toBeNull();
  });
});
