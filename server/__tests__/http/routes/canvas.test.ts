import { beforeEach, describe, expect, it, vi } from "vitest";

import catalog from "@server/resources/prompt-template.json";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  loadJson: vi.fn(),
  getProjects: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  updateProject: vi.fn(),
  deleteProject: vi.fn(),
  projectExists: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({ authenticateRequest: mocks.authenticateRequest }));
vi.mock("@server/services/json-loader", () => ({ loadJson: mocks.loadJson }));
vi.mock("@server/core/database/client", () => ({ prisma: {} }));
// CRUD 函数替换为 mock；错误类保持真实实现（路由按 instanceof 分支映射状态码）
vi.mock("@server/crud/canvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@server/crud/canvas")>();
  return {
    ...actual,
    getProjects: mocks.getProjects,
    createProject: mocks.createProject,
    getProject: mocks.getProject,
    updateProject: mocks.updateProject,
    deleteProject: mocks.deleteProject,
    projectExists: mocks.projectExists,
  };
});

import { router } from "@server/http/routes/canvas";
import { resetCanvasPresence } from "@server/services/canvas/editor-lease";
import { CanvasLeaseLostError, CanvasRevisionConflictError } from "@server/crud/canvas";

const selectableIds = [
  "characterFaceThreeView", "characterThreeView", "productThreeView", "cinematicLightCorrection",
  "nineGridScene", "storyboard25", "storyboard4", "forward3s", "back5s", "reverse", "expand",
];

interface SelectableResponse {
  id: string;
  kind: "preset";
  target: "image" | "text";
  group: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  order: number;
  template: string;
}

interface CatalogResponse {
  groups: { id: string; label: { zh: string; en: string }; column: number; order: number }[];
  entries: SelectableResponse[];
}

interface TemplateResponse {
  type: string;
  template: string;
}

const project = {
  id: "p1234567890123",
  userId: 1,
  name: "Demo",
  revision: 3,
  canvasData: { nodes: [] },
  nodeCount: 0,
  thumbnailSrc: null,
  coverUrl: null,
};

async function request<T = unknown>(path: string) {
  const response = await router.request(path);
  return { status: response.status, body: await response.json() as { data: T; error?: string } };
}

async function put(path: string, body: unknown) {
  return router.request(path, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

interface OpenSse {
  readFrames(count: number): Promise<SseFrame[]>;
  expectNoMoreFrames(): Promise<void>;
  close(): Promise<void>;
}

/** 打开 SSE 连接并按帧读取；close 取消 reader 以触发服务端断连清理 */
async function openSse(path: string): Promise<OpenSse> {
  const response = await router.request(path);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const readFrames = async (count: number): Promise<SseFrame[]> => {
    const frames: SseFrame[] = [];
    while (frames.length < count) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`SSE stream ended early: got ${frames.length}/${count} frames`);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      let event = "";
      for (const line of lines) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("event: ")) {
          event = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith("data: ")) continue;
        frames.push({ event: event || "message", data: JSON.parse(line.slice(6)) });
        event = "";
      }
    }
    return frames;
  };

  return {
    readFrames,
    // 所有事件帧都在连接建立时同步 emit（此后路由进入 waitUntilAbort），
    // 短暂静默即证明不会再有后续帧（如 superseded 分支不补发 handshake）
    async expectNoMoreFrames() {
      const result = await Promise.race([
        reader.read(),
        new Promise<"quiet">((resolve) => setTimeout(() => resolve("quiet"), 50)),
      ]);
      expect(result).toBe("quiet");
    },
    async close() {
      await reader.cancel().catch(() => {});
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCanvasPresence();
  mocks.authenticateRequest.mockResolvedValue({ user: { id: 1 } });
  mocks.loadJson.mockReturnValue(catalog);
  mocks.projectExists.mockResolvedValue(true);
  mocks.getProject.mockResolvedValue(project);
});

describe("canvas prompt template routes", () => {
  it("lists all presets in order with public catalog fields", async () => {
    mocks.loadJson.mockReturnValue({ groups: catalog.groups, entries: [...catalog.entries].reverse() });
    const { status, body } = await request<CatalogResponse>("/api/canvas/prompt-templates");
    expect(status).toBe(200);
    expect(body.data.groups.map((group) => group.id))
      .toEqual(["view", "storyboard", "light", "timeline", "prompt"]);
    expect(body.data.entries.map((entry) => entry.id)).toEqual(selectableIds);
    expect(body.data.entries.map((entry) => entry.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const entry of body.data.entries) {
      expect(Object.keys(entry).sort())
        .toEqual(["description", "group", "id", "kind", "label", "order", "target", "template"]);
      expect(entry.kind).toBe("preset");
      expect(entry.target === "image" || entry.target === "text").toBe(true);
      expect(entry.label.zh).toBeTruthy();
      expect(entry.label.en).toBeTruthy();
      expect(entry.description.zh).toBeTruthy();
      expect(entry.description.en).toBeTruthy();
      expect(entry.template).toBeTruthy();
    }
    expect(mocks.loadJson).toHaveBeenCalledWith("prompt-template.json");
  });

  it("reads the catalog for each request, including after a loader refresh", async () => {
    await request<CatalogResponse>("/api/canvas/prompt-templates");
    const updated = structuredClone(catalog);
    updated.entries.find((entry) => entry.id === "productThreeView")!.template = "Updated product prompt";
    mocks.loadJson.mockReturnValue(updated);
    const { body } = await request<CatalogResponse>("/api/canvas/prompt-templates");
    expect(body.data.entries.find((entry) => entry.id === "productThreeView")?.template)
      .toBe("Updated product prompt");
    expect(mocks.loadJson).toHaveBeenCalledTimes(2);
  });

  it("returns a static template by type and interpolates dynamic lighting and angle", async () => {
    const reverse = await request<TemplateResponse>("/api/canvas/prompt-template?type=reverse");
    expect(reverse.body.data).toEqual({ type: "reverse", template: catalog.entries.find((entry) => entry.id === "reverse")!.template });

    const preset = await request<TemplateResponse>("/api/canvas/prompt-template?type=productThreeView");
    expect(preset.body.data).toEqual({ type: "productThreeView", template: catalog.entries.find((entry) => entry.id === "productThreeView")!.template });

    const lighting = await request<TemplateResponse>("/api/canvas/prompt-template?type=lighting&azimuth=90&elevation=16&kelvin=3500&intensity=40");
    expect(lighting.body.data.type).toBe("lighting");
    expect(lighting.body.data.template).toContain("above and to the right of the scene");
    expect(lighting.body.data.template).toContain("approximately 3500K");

    const angle = await request<TemplateResponse>("/api/canvas/prompt-template?type=angle&azimuth=180&elevation=0&zoom=2");
    expect(angle.body.data.type).toBe("angle");
    expect(angle.body.data.template).toContain("directly behind the subject");
    expect(angle.body.data.template).toContain("wide shot");
    expect(angle.body.data.template).not.toMatch(/\{\{/);
  });

  it("rejects absent and unknown types", async () => {
    expect(await request("/api/canvas/prompt-template"))
      .toMatchObject({ status: 400, body: { error: "canvas.missing_type_param" } });
    expect(await request("/api/canvas/prompt-template?type=nonexistent"))
      .toMatchObject({ status: 404, body: { error: "canvas.template_not_found" } });
  });

  it("requires authentication for all endpoints", async () => {
    mocks.authenticateRequest.mockImplementation(async () => ({
      error: Response.json({ error: "auth.not_authenticated" }, { status: 401 }),
    }));
    expect((await request<CatalogResponse>("/api/canvas/prompt-templates")).status).toBe(401);
    expect((await request("/api/canvas/prompt-template?type=reverse")).status).toBe(401);
    expect((await request("/api/canvas/projects/p1234567890123/events?sid=A")).status).toBe(401);
    expect((await put("/api/canvas/projects/p1234567890123", { name: "x" })).status).toBe(401);
    expect(mocks.loadJson).not.toHaveBeenCalled();
    expect(mocks.projectExists).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});

describe("GET /api/canvas/projects/:id/events（原子握手）", () => {
  it("首帧下发 handshake：全量项目快照 + 租约令牌（sync 事件已删除）", async () => {
    const sse = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    const frames = await sse.readFrames(1);

    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("handshake");
    expect(frames[0]!.data.project).toEqual(project);
    expect(frames[0]!.data.lease).toEqual(expect.any(Number));
    expect(frames[0]!.data.lease as number).toBeGreaterThan(0);
    // 权威快照在写临界区内读取（租约轮换之后）
    expect(mocks.getProject).toHaveBeenCalledWith("p1234567890123", 1);
    await sse.expectNoMoreFrames();
    await sse.close();
  });

  it("全新页面实例完成握手后才驱逐他人：先连者收到 evict", async () => {
    const a = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    expect((await a.readFrames(1)).map((frame) => frame.event)).toEqual(["handshake"]);

    // B 全新进入：B 收到 handshake，A 收到 evict（revision 来自同一快照读）
    const b = await openSse("/api/canvas/projects/p1234567890123/events?sid=B");
    expect((await b.readFrames(1)).map((frame) => frame.event)).toEqual(["handshake"]);

    const evict = await a.readFrames(1);
    expect(evict).toEqual([{ event: "evict", data: { revision: project.revision } }]);

    await a.close();
    await b.close();
  });

  it("同 sid 重连：握手令牌不变（回归不轮换租约）", async () => {
    const first = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    const firstLease = (await first.readFrames(1))[0]!.data.lease as number;
    await first.close();

    const second = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    const secondLease = (await second.readFrames(1))[0]!.data.lease as number;
    expect(secondLease).toBe(firstLease);
    await second.close();
  });

  it("superseded 重连：只补发 evict，不补发 handshake", async () => {
    const a = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    await a.readFrames(1);

    // B 抢占，A 断线
    const b = await openSse("/api/canvas/projects/p1234567890123/events?sid=B");
    await b.readFrames(1);
    await a.close();

    // A 同 sid 重连：断线期间已被抢占，只补发 evict 引导其进入过期态
    const rejoin = await openSse("/api/canvas/projects/p1234567890123/events?sid=A");
    const frames = await rejoin.readFrames(1);
    expect(frames).toEqual([{ event: "evict", data: { revision: project.revision } }]);
    await rejoin.expectNoMoreFrames();
    await rejoin.close();
    await b.close();
  });

  it("项目不存在：连接前 404，不建立 SSE 流也不读快照", async () => {
    mocks.projectExists.mockResolvedValue(false);
    const response = await router.request("/api/canvas/projects/p1234567890123/events?sid=A");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "canvas.project_not_found" });
    expect(mocks.projectExists).toHaveBeenCalledWith("p1234567890123", 1);
    expect(mocks.getProject).not.toHaveBeenCalled();
  });

  it("缺失 sid：422", async () => {
    const response = await router.request("/api/canvas/projects/p1234567890123/events");
    expect(response.status).toBe(422);
    expect(mocks.projectExists).not.toHaveBeenCalled();
  });
});

describe("PUT /api/canvas/projects/:id（租约契约）", () => {
  it("带 canvasData 的保存必须同时携带 baseRevision 与 lease：缺一即 422", async () => {
    expect((await put("/api/canvas/projects/p1234567890123", { canvasData: { nodes: [] }, baseRevision: 3 })).status).toBe(422);
    expect((await put("/api/canvas/projects/p1234567890123", { canvasData: { nodes: [] }, lease: 5 })).status).toBe(422);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it("合法保存：baseRevision 与 lease 原样传入 crud", async () => {
    mocks.updateProject.mockResolvedValue(project);
    const response = await put("/api/canvas/projects/p1234567890123", { canvasData: { nodes: [] }, baseRevision: 3, lease: 42 });
    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith(
      "p1234567890123",
      1,
      { name: undefined, canvasData: { nodes: [] }, coverUrl: undefined },
      { baseRevision: 3, lease: 42 },
    );
  });

  it("纯改名不要求租约", async () => {
    mocks.updateProject.mockResolvedValue(project);
    const response = await put("/api/canvas/projects/p1234567890123", { name: "renamed" });
    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith(
      "p1234567890123",
      1,
      { name: "renamed", canvasData: undefined, coverUrl: undefined },
      { baseRevision: undefined, lease: undefined },
    );
  });

  it("租约失效与版本冲突同形映射 409 并携带当前版本", async () => {
    mocks.updateProject.mockRejectedValueOnce(new CanvasLeaseLostError(7));
    const leaseLost = await put("/api/canvas/projects/p1234567890123", { canvasData: { nodes: [] }, baseRevision: 3, lease: 42 });
    expect(leaseLost.status).toBe(409);
    expect(await leaseLost.json()).toMatchObject({
      error: "canvas.project_revision_conflict",
      ctx: { revision: 7 },
    });

    mocks.updateProject.mockRejectedValueOnce(new CanvasRevisionConflictError(9));
    const conflict = await put("/api/canvas/projects/p1234567890123", { canvasData: { nodes: [] }, baseRevision: 3, lease: 42 });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { ctx?: Record<string, number> }).ctx).toEqual({ revision: 9 });
  });
});
