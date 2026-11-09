/**
 * 资产文件夹的纯函数派生规则。
 *
 * 属于资产领域 UI 的组织逻辑（树形展示、计数聚合、未分类目录定位），
 * 由资产界面与画布注入的资产浏览器共用；实体层只维护数据本身。
 */
import type { AssetFolder, AssetScope } from "@/entities/asset";

/** 列出某个父目录下的普通子文件夹；未分类目录不参与树形层级。 */
function selectChildFolders(
  folders: AssetFolder[],
  scope: AssetScope,
  parentId?: string,
): AssetFolder[] {
  return folders.filter(
    (folder) =>
      folder.scope === scope &&
      folder.kind === "normal" &&
      (folder.parentId || undefined) === (parentId || undefined),
  );
}

/**
 * 计算每个文件夹的递归资产数量（含其所有子文件夹）。
 * 输入只包含普通文件夹；未分类目录是根级固定目录，直接读取自身 count。
 */
export function computeRecursiveFolderCounts(folders: AssetFolder[]): Record<string, number> {
  const childrenOf = new Map<string | undefined, AssetFolder[]>();
  for (const folder of folders) {
    const key = folder.parentId || undefined;
    const list = childrenOf.get(key) ?? [];
    list.push(folder);
    childrenOf.set(key, list);
  }

  const result: Record<string, number> = {};
  const calculate = (folder: AssetFolder): number => {
    let total = folder.count || 0;
    for (const child of childrenOf.get(folder.id) ?? []) total += calculate(child);
    result[folder.id] = total;
    return total;
  };

  for (const folder of childrenOf.get(undefined) ?? []) calculate(folder);
  for (const folder of folders) if (result[folder.id] === undefined) calculate(folder);
  return result;
}

/** 查找指定范围的「未分类」固定目录（模块内部按范围取根级固定目录）。 */
function getUncategorizedFolder(
  folders: AssetFolder[],
  scope: AssetScope = "personal",
): AssetFolder | undefined {
  return folders.find((folder) => folder.scope === scope && folder.kind === "uncategorized");
}

/**
 * 返回从根到指定文件夹的完整链（含当前项）。
 * 空 id、缺失目录或 parentId 断链时返回可解析的部分；调用方自行拼接根空间标签。
 */
export function getFolderPath(
  folders: AssetFolder[],
  folderId: string | null | undefined,
): AssetFolder[] {
  if (!folderId) return [];
  const byId = new Map<string, AssetFolder>();
  for (const folder of folders) {
    // 与 Array.find 一致：重复 id 取首个
    if (!byId.has(folder.id)) byId.set(folder.id, folder);
  }
  const path: AssetFolder[] = [];
  const seen = new Set<string>();
  let current = byId.get(folderId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/**
 * 网格首屏可见的文件夹：当前目录的直接子文件夹；根视图前置本地化的
 * 「未分类」固定目录。数量由 AssetGrid 的 folderCounts 统一投影。
 */
export function selectGridFolders(
  folders: AssetFolder[],
  scope: AssetScope,
  activeFolderId: string | null,
  uncategorizedLabel: string,
): AssetFolder[] {
  const children = selectChildFolders(folders, scope, activeFolderId ?? undefined);
  if (activeFolderId !== null) return children;
  const uncategorized = getUncategorizedFolder(folders, scope);
  return uncategorized
    ? [{ ...uncategorized, name: uncategorizedLabel }, ...children]
    : children;
}
