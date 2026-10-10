import { afterEach, describe, expect, it, vi } from "vitest";

const upload = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/client", async (original) => ({
  ...await original<typeof import("@/lib/api/client")>(), apiUploadWithProgress: upload,
}));
vi.mock("@/lib/i18n/config", () => ({ default: { t: (key: string) => key } }));

import { changeSession, SessionChangedError } from "@/lib/session-lifecycle";
import { classifyUploadError, uploadWithRetry } from "@/lib/utils/upload";

afterEach(() => { vi.clearAllMocks(); });

describe("upload task session ownership", () => {
  it("does not retry an upload after logout", async () => {
    let reject!: (reason: Error) => void;
    upload.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
    const pending = uploadWithRetry(new File(["data"], "a.png"));
    const rejected = expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    changeSession();
    reject(new Error("old network failure"));
    await rejected;
    expect(upload).toHaveBeenCalledTimes(1);
    expect(classifyUploadError(new SessionChangedError())).toMatchObject({ category: "abort", retryable: false });
  });
});
