import { describe, expect, it } from "vitest";

import { taskCreateSchema } from "@server/schemas/task";

/** ref* 入库值域与资产 fileKey 同一规则（fileRefSchema）：key 严格形态或外部 http(s) URL。 */
describe("生成任务请求契约", () => {
  // hash 段 64 位 hex：前 2 位 "ab" 与目录段一致
  const KEY = `1/ab/ab${"a".repeat(62)}.png`;

  it("ref* 接受存储 key 与外部 URL，缺省合法", () => {
    expect(taskCreateSchema.safeParse({ refImages: [KEY, "https://img.example/a.png"] }).success).toBe(true);
    expect(taskCreateSchema.safeParse({ refAudios: [KEY], refVideos: [] }).success).toBe(true);
    expect(taskCreateSchema.safeParse({}).success).toBe(true);
  });

  it("ref* 拒绝 data:/blob: 与裸路径形态", () => {
    expect(taskCreateSchema.safeParse({ refImages: [`/api/files/${KEY}`] }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ refImages: ["blob:https://x/abc"] }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ refAudios: ["data:image/png;base64,AAAA"] }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ refVideos: ["raw-path"] }).success).toBe(false);
  });
});
