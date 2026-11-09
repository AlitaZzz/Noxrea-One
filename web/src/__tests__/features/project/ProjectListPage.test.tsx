// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectListPage } from "@/features/project";
vi.mock("@/lib/use-file-access-url", () => import("@/__tests__/test-utils/file-access-mock"));

const mocks = vi.hoisted(() => ({
  projects: [
    {
      id: "p1",
      name: "Test1",
      revision: 1,
      updatedAt: Date.UTC(2026, 9, 9, 4, 0),
      thumbnail: "1/aa/x.png",
      nodeCount: 57,
    },
  ],
  push: vi.fn(),
  flushPendingCanvasSaves: vi.fn(() => Promise.resolve()),
  activateProject: vi.fn(),
  createProject: vi.fn(),
  renameProject: vi.fn(),
  refreshProjects: vi.fn(),
  deleteProject: vi.fn(),
  updateCover: vi.fn(),
  uploadMany: vi.fn(),
  notifyError: vi.fn(),
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
vi.mock("@/entities/user", () => ({
  useCurrentUser: () => ({ username: "tester", avatarKey: null }),
  savePreference: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("@/components/ui/DestructiveConfirmModal", () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => Promise<boolean> | boolean }) =>
    open ? <button onClick={() => void onConfirm()}>confirm-delete</button> : null,
}));
vi.mock("@/components/ui/use-app-feedback", () => ({
  useAppFeedback: () => ({ message: { info: vi.fn() }, notification: { error: mocks.notifyError } }),
}));
// 项目摘要与命令归 entity；本页只消费公共 API
vi.mock("@/entities/project", () => ({
  useProjects: () => mocks.projects,
  activateProject: mocks.activateProject,
  createProject: mocks.createProject,
  deleteProject: mocks.deleteProject,
  refreshProjects: mocks.refreshProjects,
  renameProject: mocks.renameProject,
  updateCover: mocks.updateCover,
}));
vi.mock("@/entities/asset", () => ({ uploadMany: mocks.uploadMany }));

afterEach(cleanup);

function renderPage() {
  return render(
    <ProjectListPage
      flushPendingCanvasSaves={mocks.flushPendingCanvasSaves}
      accountMenu={() => null}
      accountSettings={() => null}
    />,
  );
}

describe("项目卡片整卡跳转", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flushPendingCanvasSaves.mockResolvedValue(undefined);
  });

  it("每张卡片只有一个铺满整卡的跳转链接，且带项目名 aria-label", () => {
    const { container } = renderPage();

    const links = container.querySelectorAll("a[href='/canvas/p1']");
    expect(links).toHaveLength(1);

    const link = screen.getByRole("link", { name: "Test1" });
    expect(link.className).toContain("inset-0");
  });

  it("整卡链接点击时记录激活项目", () => {
    renderPage();

    // jsdom 不支持真实导航：阻止默认行为，仅验证 onClick 命令
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    fireEvent(screen.getByRole("link", { name: "Test1" }), event);
    expect(mocks.activateProject).toHaveBeenCalledWith("p1");
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

describe("新建项目", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flushPendingCanvasSaves.mockResolvedValue(undefined);
  });

  it("创建成功后跳转到新项目画布", async () => {
    mocks.createProject.mockResolvedValue({ id: "p9", name: "Project 2" });
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "project.new" }));

    await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/canvas/p9"));
  });

  it("创建失败返回 null 时不跳转，提示由 entity 统一负责", async () => {
    mocks.createProject.mockResolvedValue(null);
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "project.new" }));

    await waitFor(() => expect(mocks.createProject).toHaveBeenCalled());
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("封面改图", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flushPendingCanvasSaves.mockResolvedValue(undefined);
  });

  function pickCover(file: File) {
    fireEvent.keyDown(screen.getByRole("button", { name: "common.moreActions" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "project.setCover" }));
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
  }

  it("经 entity 公共上传通道提交封面 key", async () => {
    mocks.uploadMany.mockResolvedValue({
      outcomes: [{ result: { url: "/files/cover.png", key: "cover/key.png" }, error: null }],
    });
    renderPage();

    pickCover(new File(["data"], "cover.png", { type: "image/png" }));

    await waitFor(() => expect(mocks.uploadMany).toHaveBeenCalledWith([
      { blob: expect.any(File), filename: "cover.png" },
    ]));
    expect(mocks.updateCover).toHaveBeenCalledWith("p1", "cover/key.png");
    expect(mocks.notifyError).not.toHaveBeenCalled();
  });

  it("上传前置校验失败时提示原因且不提交封面", async () => {
    mocks.uploadMany.mockResolvedValue({
      outcomes: [{
        result: null,
        error: { category: "unsupported", message: "unsupported type", retryable: false },
      }],
    });
    renderPage();

    pickCover(new File(["data"], "cover.txt", { type: "text/plain" }));

    await waitFor(() => expect(mocks.notifyError).toHaveBeenCalledWith({
      title: "unsupported type", placement: "bottomRight", duration: 6,
    }));
    expect(mocks.updateCover).not.toHaveBeenCalled();
  });
});

describe("进入列表页的保存 flush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.flushPendingCanvasSaves.mockResolvedValue(undefined);
  });

  it("先等待注入的画布保存完成，再拉取项目列表", async () => {
    const order: string[] = [];
    mocks.flushPendingCanvasSaves.mockImplementation(async () => {
      order.push("flush");
    });
    mocks.refreshProjects.mockImplementation(() => {
      order.push("refresh");
    });

    renderPage();

    await waitFor(() => expect(mocks.refreshProjects).toHaveBeenCalled());
    expect(order).toEqual(["flush", "refresh"]);
  });

  it("删除项目前先等待画布保存完成，再发起删除", async () => {
    const order: string[] = [];
    mocks.flushPendingCanvasSaves.mockImplementation(async () => {
      order.push("flush");
    });
    mocks.deleteProject.mockImplementation(async () => {
      order.push("delete");
      return true;
    });

    renderPage();
    // 进入列表页的既有 flush 与删除无关，清空后只观察确认删除的时序
    await waitFor(() => expect(mocks.flushPendingCanvasSaves).toHaveBeenCalled());
    order.length = 0;

    fireEvent.keyDown(screen.getByRole("button", { name: "common.moreActions" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "common.delete" }));
    fireEvent.click(screen.getByRole("button", { name: "confirm-delete" }));

    await waitFor(() => expect(order).toEqual(["flush", "delete"]));
    expect(mocks.deleteProject).toHaveBeenCalledWith("p1");
  });
});
