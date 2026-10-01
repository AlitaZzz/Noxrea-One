import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key, exists: () => false } }));

import { api, apiRaw, apiUploadWithProgress, setUnauthorizedHandler, UnauthorizedError } from "@/lib/api/client";
import { changeSession, SessionChangedError } from "@/lib/session-lifecycle";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("request session ownership", () => {
  beforeEach(() => { changeSession(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([api, apiRaw])("aborts old requests and ignores a late 401 without logging out B", async (request) => {
    const fetch = vi.fn();
    const old = deferred<Response>();
    fetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(new Response('{"code":200,"data":[]}'));
    vi.stubGlobal("fetch", fetch);
    const logout = vi.fn();
    setUnauthorizedHandler(logout);
    const pending = request("/api/assets");
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    const signal = fetch.mock.calls[0][1].signal as AbortSignal;
    changeSession();
    expect(signal.aborted).toBe(true);
    old.resolve(new Response(null, { status: 401 }));
    await rejected;
    expect(logout).not.toHaveBeenCalled();
    await request("/api/assets");
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it("discards a body that finishes parsing after switching accounts", async () => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json })));
    const pending = api("/api/assets");
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    await vi.waitFor(() => expect(json).toHaveBeenCalled());
    changeSession();
    body.resolve({ code: 200, data: ["A-secret"] });
    await rejected;
  });

  it("preserves a caller's abort signal alongside session cancellation", async () => {
    const caller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{"code":200,"data":[]}'));
    vi.stubGlobal("fetch", fetch);
    await apiRaw("/api/assets", { signal: caller.signal });
    const signal = fetch.mock.calls[0][1]!.signal!;
    caller.abort();
    expect(signal.aborted).toBe(true);
  });

  it("does not redirect B when A's unauthorized logout finishes late", async () => {
    const logout = deferred<void>();
    const location = { pathname: "/project", href: "/project" };
    const setItem = vi.fn();
    vi.stubGlobal("window", { location });
    vi.stubGlobal("sessionStorage", { setItem });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    setUnauthorizedHandler(() => {
      changeSession();
      return logout.promise;
    });
    await expect(api("/api/assets")).rejects.toBeInstanceOf(UnauthorizedError);
    changeSession();
    logout.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(location.href).toBe("/project");
    expect(setItem).not.toHaveBeenCalled();
  });

  it("cancels uploads and releases their timers and event listeners on session change", async () => {
    vi.useFakeTimers();
    const remove = vi.fn();
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: remove });
    const abort = vi.fn();
    vi.stubGlobal("XMLHttpRequest", class {
      upload = {};
      open = vi.fn();
      send = vi.fn();
      abort = abort;
    });
    const pending = apiUploadWithProgress("/api/files", new FormData());
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    expect(vi.getTimerCount()).toBe(1);
    changeSession();
    await rejected;
    expect(abort).toHaveBeenCalledExactlyOnceWith();
    expect(remove).toHaveBeenCalledWith("offline", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
