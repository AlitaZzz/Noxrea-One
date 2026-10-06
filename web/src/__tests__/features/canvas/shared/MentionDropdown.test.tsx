// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import MentionDropdown from "@/features/canvas/shared/MentionDropdown";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe("MentionDropdown", () => {
  it("closes through the controlled popover on Escape", async () => {
    const onClose = vi.fn();

    render(
      <>
        <MentionDropdown
          items={[{ kind: "image", src: "image-1", thumbnail: "thumb-1", index: 0 }]}
          position={{ x: 12, y: 24 }}
          selectedIndex={0}
          onHover={vi.fn()}
          onSelect={vi.fn()}
          onClose={onClose}
        />
      </>,
    );

    expect(screen.getByRole("button", { name: /refImageLabel/ })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("selects an item through button activation", () => {
    const onSelect = vi.fn();
    render(
      <MentionDropdown
        items={[{ kind: "image", src: "image-1", thumbnail: "thumb-1", index: 0 }]}
        position={{ x: 12, y: 24 }}
        selectedIndex={0}
        onHover={vi.fn()}
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /refImageLabel/ });
    fireEvent.click(button);

    expect(onSelect).toHaveBeenCalledWith({ kind: "image", src: "image-1", thumbnail: "thumb-1", index: 0 });
  });

});
