import { describe, expect, it } from "vitest";

import type { AssetFolder } from "@/entities/asset";
import { getFolderPath, selectGridFolders } from "@/features/assets/folders";

function folder(overrides: Partial<AssetFolder> & Pick<AssetFolder, "id">): AssetFolder {
  return {
    name: overrides.id,
    scope: "personal",
    kind: "normal",
    parentId: undefined,
    createdAt: 0,
    count: 0,
    ...overrides,
  };
}

describe("资产文件夹选择", () => {
  it("使用最新文件夹数组计算当前目录的子文件夹", () => {
    const root = {
      id: "1", name: "Existing", scope: "personal" as const, kind: "normal" as const,
      parentId: undefined, createdAt: 0, count: 0,
    };
    const added = { ...root, id: "2", name: "Added" };
    const nested = { ...root, id: "3", name: "Nested", parentId: "1" };

    expect(selectGridFolders([root], "personal", null, "未分类")).toEqual([root]);
    expect(selectGridFolders([root, added, nested], "personal", null, "未分类")).toEqual([root, added]);
    expect(selectGridFolders([root, added, nested], "personal", "1", "未分类")).toEqual([nested]);
  });
});

describe("资产文件夹路径", () => {
  const root = folder({ id: "1", name: "Root" });
  const child = folder({ id: "2", name: "Child", parentId: "1" });
  const grandchild = folder({ id: "3", name: "Grandchild", parentId: "2" });
  const all = [root, child, grandchild];

  it("返回根到当前文件夹的完整链", () => {
    expect(getFolderPath(all, "3").map((f) => f.id)).toEqual(["1", "2", "3"]);
    expect(getFolderPath(all, "1").map((f) => f.id)).toEqual(["1"]);
  });

  it("空 id、缺失目录或断链时返回可解析部分", () => {
    expect(getFolderPath(all, null)).toEqual([]);
    expect(getFolderPath(all, "missing")).toEqual([]);
    const orphan = folder({ id: "4", parentId: "missing" });
    expect(getFolderPath([orphan], "4").map((f) => f.id)).toEqual(["4"]);
  });
});

describe("资产网格文件夹派生", () => {
  const uncategorized = folder({ id: "u", name: "Uncategorized", kind: "uncategorized", count: 3 });
  const root = folder({ id: "1", name: "Root" });
  const child = folder({ id: "2", name: "Child", parentId: "1" });
  const sibling = folder({ id: "3", name: "Sibling" });
  const all = [uncategorized, root, child, sibling];

  it("根视图前置本地化的未分类目录", () => {
    expect(selectGridFolders(all, "personal", null, "未分类").map((f) => [f.id, f.name])).toEqual([
      ["u", "未分类"],
      ["1", "Root"],
      ["3", "Sibling"],
    ]);
  });

  it("子目录只返回直接子文件夹", () => {
    expect(selectGridFolders(all, "personal", "1", "未分类").map((f) => f.id)).toEqual(["2"]);
  });
});
