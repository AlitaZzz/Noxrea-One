// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import DestructiveConfirmModal from "@/components/ui/DestructiveConfirmModal";

afterEach(cleanup);

describe("DestructiveConfirmModal", () => {
  it("renders an alert dialog with a destructive action", () => {
    render(
      <DestructiveConfirmModal
        open
        title="Delete project"
        description="This cannot be undone."
        onConfirm={vi.fn().mockResolvedValue(true)}
        onCancel={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete project");
    expect(dialog).toHaveClass("bg-popover", "text-popover-foreground");
    expect(document.activeElement).toBe(dialog);
    expect(screen.getByRole("button", { name: "common.delete" })).toHaveAttribute("data-variant", "destructive");
  });

  it("keeps the dialog open when confirmation fails and disables cancel while pending", async () => {
    let resolve: (value: boolean) => void = () => undefined;
    const onConfirm = vi.fn(() => new Promise<boolean>((next) => { resolve = next; }));
    const onCancel = vi.fn();

    render(
      <DestructiveConfirmModal
        open
        title="Delete project"
        description="This cannot be undone."
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "common.delete" });
    fireEvent.click(confirmButton);
    expect(confirmButton.tagName).toBe("BUTTON");
    expect(confirmButton).not.toHaveClass("animate-spin");
    expect(confirmButton.querySelector("svg")).toHaveClass("animate-spin");
    expect(confirmButton).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "common.cancel" })).toBeDisabled();

    resolve(false);
    await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "common.cancel" })).not.toBeDisabled();
  });

  it("closes only after confirmation succeeds", async () => {
    const onCancel = vi.fn();
    render(
      <DestructiveConfirmModal
        open
        title="Delete project"
        description="This cannot be undone."
        onConfirm={vi.fn().mockResolvedValue(true)}
        onCancel={onCancel}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});
