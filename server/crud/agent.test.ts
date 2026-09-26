import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@server/core/database/client", () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

import { createSession } from "./agent";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      canvasProject: { findFirst: mocks.findFirst },
      agentSession: { create: mocks.create },
    }),
  );
});

describe("createSession", () => {
  it("项目缺失或不属于当前用户时返回 null 且不创建会话", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(
      createSession({ userId: 1, projectId: "missing", title: "New Chat" }),
    ).resolves.toBeNull();
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "missing", userId: 1 },
      select: { id: true },
    });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("项目归属校验通过后在同一事务中创建会话", async () => {
    const session = {
      id: 1,
      userId: 1,
      projectId: "project-1",
      title: "New Chat",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    mocks.findFirst.mockResolvedValue({ id: "project-1" });
    mocks.create.mockResolvedValue(session);

    await expect(
      createSession({ userId: 1, projectId: "project-1", title: "New Chat" }),
    ).resolves.toEqual(session);
    expect(mocks.create).toHaveBeenCalledWith({
      data: {
        userId: 1,
        projectId: "project-1",
        title: "New Chat",
      },
    });
  });

  it("未绑定项目时不做项目预检查", async () => {
    const session = { id: 1, userId: 1, projectId: null, title: "New Chat" };
    mocks.create.mockResolvedValue(session);

    await expect(createSession({ userId: 1 })).resolves.toEqual(session);
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });
});
