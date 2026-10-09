// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectListPage from "@/features/project/components/ProjectListPage";

const mocks = vi.hoisted(() => ({
  projects: [
    {
      id: "p1",
      name: "Test1",
      revision: 1,
      updatedAt: Date.UTC(2026, 9, 9, 4, 0),
      thumbnail: "/api/files/x.png",
      nodeCount: 57,
    },
  ],
  push: vi.fn(),
  flushAndWait: vi.fn(() => Promise.resolve()),
  setActiveProject: vi.fn(),
  renameProject: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/project",
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "zh" } }),
}));
vi.mock("@/components/layout/AppShell", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/auth/UserContext", () => ({
  useCurrentUser: () => ({ username: "tester", avatarUrl: null }),
}));
vi.mock("@/features/auth/store", () => ({
  useAuthStore: {
    getState: () => ({ savePreference: vi.fn(), logout: vi.fn() }),
  },
}));
vi.mock("@/features/auth/components/UserMenuPopover", () => ({ UserMenuPopover: () => null }));
vi.mock("@/features/auth/components/SettingsModal", () => ({ default: () => null }));
vi.mock("@/components/ui/DestructiveConfirmModal", () => ({ default: () => null }));
vi.mock("@/features/canvas/stores/canvas-store", () => ({
  flushAndWait: mocks.flushAndWait,
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { info: vi.fn() }, notification: { error: vi.fn() } }),
}));
vi.mock("@/lib/utils/upload", () => ({
  uploadWithRetry: vi.fn(),
  classifyUploadError: vi.fn(),
}));
vi.mock("@/features/project/store", () => ({
  useProjectStore: Object.assign(
    (selector: (s: unknown) => unknown) =>
      selector({
        projects: mocks.projects,
        renameProject: mocks.renameProject,
        deleteProject: vi.fn(),
        setActiveProject: mocks.setActiveProject,
        createProject: vi.fn(),
        refreshProjects: vi.fn(),
      }),
    { getState: () => ({}) },
  ),
}));

afterEach(cleanup);

function renderPage() {
  return render(<ProjectListPage />);
}

describe("项目卡片整卡跳转", () => {
  it("每张卡片只有一个铺满整卡的跳转链接，且带项目名 aria-label", () => {
    const { container } = renderPage();

    const links = container.querySelectorAll("a[href='/canvas/p1']");
    expect(links).toHaveLength(1);

    const link = screen.getByRole("link", { name: "Test1" });
    expect(link.className).toContain("inset-0");
  });

  it("整卡链接点击时记录激活项目", () => {
    renderPage();

    fireEvent.click(screen.getByRole("link", { name: "Test1" }));
    expect(mocks.setActiveProject).toHaveBeenCalledWith("p1");
  });

  it("更多操作按钮浮于整卡链接之上（z-10）", () => {
    renderPage();

    const trigger = screen.getByRole("button", { name: "common.moreActions" });
    expect(trigger.className).toContain("relative");
    expect(trigger.className).toContain("z-10");
  });

  it("重命名输入框浮于整卡链接之上（z-10）", () => {
    renderPage();

    const trigger = screen.getByRole("button", { name: "common.moreActions" });
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "common.rename" }));

    const input = screen.getByRole("textbox");
    expect(input.className).toContain("z-10");
  });
});
