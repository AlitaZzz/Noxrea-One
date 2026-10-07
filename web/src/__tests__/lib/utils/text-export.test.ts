import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "@/lib/utils/text-export";

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves true when Clipboard API succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("copied text")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied text");
  });

  it("resolves false when Clipboard API rejects without a DOM fallback", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("copied text")).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledWith("copied text");
  });
});
