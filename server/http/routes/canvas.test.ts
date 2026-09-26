import { beforeEach, describe, expect, it, vi } from "vitest";

import catalog from "../../resources/prompt-template.json";

const { authenticateRequest, loadJson } = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  loadJson: vi.fn(),
}));

vi.mock("@server/http/middleware/auth", () => ({ authenticateRequest }));
vi.mock("@server/services/json-loader", () => ({ loadJson }));

import { router } from "./canvas";

const selectableIds = [
  "reverse", "characterFaceThreeView", "characterThreeView", "productThreeView", "cinematicLightCorrection",
  "nineGridScene", "storyboard25", "storyboard4", "forward3s", "back5s",
];

interface SelectableResponse {
  id: string;
  kind: "preset" | "reverse";
  group: string;
  label: { zh: string; en: string };
  description: { zh: string; en: string };
  order: number;
  template: string;
}

interface CatalogResponse {
  groups: { id: string; label: { zh: string; en: string }; order: number }[];
  entries: SelectableResponse[];
}

interface TemplateResponse {
  type: string;
  template: string;
}

async function request<T = unknown>(path: string) {
  const response = await router.request(path);
  return { status: response.status, body: await response.json() as { data: T; error?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  authenticateRequest.mockResolvedValue({ user: { id: 1 } });
  loadJson.mockReturnValue(catalog);
});

describe("canvas prompt template routes", () => {
  it("lists reverse and nine presets in order with public catalog fields", async () => {
    loadJson.mockReturnValue({ groups: catalog.groups, entries: [...catalog.entries].reverse() });
    const { status, body } = await request<CatalogResponse>("/api/canvas/prompt-templates");
    expect(status).toBe(200);
    expect(body.data.groups.map((group) => group.id))
      .toEqual(["view", "storyboard", "light", "timeline"]);
    expect(body.data.entries.map((entry) => entry.id)).toEqual(selectableIds);
    expect(body.data.entries.map((entry) => entry.order)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(body.data.entries.map((entry) => entry.kind)).toEqual(["reverse", ...Array(9).fill("preset")]);
    for (const entry of body.data.entries) {
      // preset 携带分组与描述字段；reverse 由独立按钮承载，不进分组菜单
      expect(Object.keys(entry).sort()).toEqual(entry.kind === "preset"
        ? ["description", "group", "id", "kind", "label", "order", "template"]
        : ["id", "kind", "label", "order", "template"]);
      expect(entry.label.zh).toBeTruthy();
      expect(entry.label.en).toBeTruthy();
      if (entry.kind === "preset") {
        expect(entry.description!.zh).toBeTruthy();
        expect(entry.description!.en).toBeTruthy();
      }
      expect(entry.template).toBeTruthy();
    }
    expect(loadJson).toHaveBeenCalledWith("prompt-template.json");
  });

  it("reads the catalog for each request, including after a loader refresh", async () => {
    await request<CatalogResponse>("/api/canvas/prompt-templates");
    const updated = structuredClone(catalog);
    updated.entries.find((entry) => entry.id === "productThreeView")!.template = "Updated product prompt";
    loadJson.mockReturnValue(updated);
    const { body } = await request<CatalogResponse>("/api/canvas/prompt-templates");
    expect(body.data.entries.find((entry) => entry.id === "productThreeView")?.template)
      .toBe("Updated product prompt");
    expect(loadJson).toHaveBeenCalledTimes(2);
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
    expect(await request("/api/canvas/prompt-template?type=expand"))
      .toMatchObject({ status: 404, body: { error: "canvas.template_not_found" } });
  });

  it("requires authentication for both endpoints", async () => {
    authenticateRequest.mockImplementation(async () => ({
      error: Response.json({ error: "auth.not_authenticated" }, { status: 401 }),
    }));
    expect((await request<CatalogResponse>("/api/canvas/prompt-templates")).status).toBe(401);
    expect((await request("/api/canvas/prompt-template?type=reverse")).status).toBe(401);
    expect(loadJson).not.toHaveBeenCalled();
  });
});
