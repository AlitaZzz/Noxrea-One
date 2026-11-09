// @vitest-environment jsdom
import "@/lib/i18n/config";

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateProfile: vi.fn(),
  canvasToBlob: vi.fn(),
  feedback: { message: { error: vi.fn(), info: vi.fn(), success: vi.fn() } },
  userState: {
    user: { id: 1, username: "tester", avatarKey: null, theme: "light", language: "zh" },
    storage: null,
    refreshStorage: vi.fn(),
  },
}));

vi.mock("@/lib/utils/image-utils", () => ({ canvasToBlob: mocks.canvasToBlob }));
vi.mock("@/components/ui/use-app-feedback", () => ({ useAppFeedback: () => mocks.feedback }));
vi.mock("@/entities/user", () => ({
  useSessionUser: () => mocks.userState.user,
  useUserStorage: () => mocks.userState.storage,
  refreshStorage: () => mocks.userState.refreshStorage(),
  updateProfile: (...args: unknown[]) => mocks.updateProfile(...args),
}));

import AvatarCropModal from "@/features/auth/components/AvatarCropModal";
import SettingsModal from "@/features/auth/components/SettingsModal";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("account modals", () => {
  it("resets the settings save state when the API returns no user", async () => {
    mocks.updateProfile.mockResolvedValueOnce(undefined);
    render(<SettingsModal open onClose={vi.fn()} />);

    fireEvent.change(document.getElementById("settings-current-password")!, { target: { value: "old-password" } });
    fireEvent.change(document.getElementById("settings-new-password")!, { target: { value: "new-password" } });
    const saveButton = screen.getByRole("button", { name: "保存修改" });
    fireEvent.click(saveButton);

    await waitFor(() => expect(saveButton).not.toBeDisabled());
    expect(mocks.feedback.message.error).toHaveBeenCalledWith("保存失败");
  });

  it("resets the crop save state when canvas export fails", async () => {
    class MockFileReader {
      result = "data:image/png;base64,mock";
      onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
      readAsDataURL() {
        queueMicrotask(() => this.onload?.({ target: this } as unknown as ProgressEvent<FileReader>));
      }
      abort() {}
    }
    class MockImage {
      naturalWidth = 220;
      naturalHeight = 220;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("FileReader", MockFileReader);
    vi.stubGlobal("Image", MockImage);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    mocks.canvasToBlob.mockRejectedValueOnce(new Error("encode failed"));

    render(<AvatarCropModal open file={new File(["image"], "avatar.png", { type: "image/png" })} onDone={vi.fn()} onClose={vi.fn()} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const saveButton = screen.getByRole("button", { name: "保存" });
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    expect(mocks.feedback.message.error).toHaveBeenCalledWith("头像保存失败");
  });
});
