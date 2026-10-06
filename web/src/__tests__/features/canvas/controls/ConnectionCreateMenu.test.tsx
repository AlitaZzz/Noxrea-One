// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ConnectionCreateMenu from "@/features/canvas/controls/ConnectionCreateMenu";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const pending = {
  sourceNodeIds: ["source"],
  sourceNodeTypes: ["text"],
  direction: "output" as const,
  canvasPosition: { x: 100, y: 100 },
  screenPosition: { x: 100, y: 100 },
};

describe("ConnectionCreateMenu", () => {
  it("closes from a document context menu without installing a blocking mask", () => {
    const onClose = vi.fn();

    render(
      <ConnectionCreateMenu
        pending={pending}
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(document.querySelector(".fixed.inset-0.z-40")).toBeNull();
    fireEvent.contextMenu(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
