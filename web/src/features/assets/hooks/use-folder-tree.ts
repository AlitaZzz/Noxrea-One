/**
 * 位置选择器的统一文件夹树：上传弹窗（保存位置）与移动弹窗（移动到）共用，
 * 保证两处选项永远一致。个人资产库为根（ROOT_FOLDER_ID），普通文件夹递归构建。
 * 待分类目录是服务端对「无文件夹」的实现细节（folderId 为空的资产统一归入），
 * 与根目录同义，因此不作为独立选项出现在任何选择器中。
 * 命中高亮沿用 use-tree-match 的职责划分：hook 纯数据，JSX 由调用方经 renderTitle 渲染。
 */
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AssetFolder } from "@/features/assets/types";

/** 根目录（个人资产库）在选择器里的哨兵值 */
export const ROOT_FOLDER_ID = "__root__";

export interface FolderTreeNode {
  value: string;
  title: ReactNode;
  label: string;
  disabled?: boolean;
  children?: FolderTreeNode[];
}

/** 待分类目录与根目录同义；对外统一表示为 ROOT_FOLDER_ID（未知 id 原样返回） */
export function normalizeFolderId(folders: AssetFolder[] | undefined, id: string | null | undefined): string {
  if (id == null) return ROOT_FOLDER_ID;
  const f = (folders || []).find((x) => x.id === id);
  return f?.kind === "uncategorized" ? ROOT_FOLDER_ID : id;
}

/**
 * @param renderTitle 名称 → 展示节点（搜索命中高亮），不传则显示纯文本
 * @param disabledId  当前所在位置在选择器中禁选（移到原地无意义），传 normalizeFolderId 的结果
 */
export function useFolderTree(
  folders: AssetFolder[] | undefined,
  renderTitle?: (name: string) => ReactNode,
  disabledId?: string,
): FolderTreeNode[] {
  const { t } = useTranslation();

  return useMemo(() => {
    const title = (name: string) => (renderTitle ? renderTitle(name) : name);
    const normal = (folders || []).filter((f) => f.scope === "personal" && f.kind === "normal");
    function build(parentId: string | undefined): FolderTreeNode[] {
      return normal
        .filter((f) => (f.parentId || undefined) === parentId)
        .map((f) => {
          const children = build(f.id);
          const node: FolderTreeNode = {
            value: f.id,
            label: f.name,
            title: title(f.name),
            disabled: f.id === disabledId,
          };
          if (children.length > 0) node.children = children;
          return node;
        });
    }
    return [{
      value: ROOT_FOLDER_ID,
      label: t("asset.spacePersonal"),
      title: title(t("asset.spacePersonal")),
      disabled: disabledId === ROOT_FOLDER_ID,
      children: build(undefined),
    }];
  }, [folders, renderTitle, disabledId, t]);
}
