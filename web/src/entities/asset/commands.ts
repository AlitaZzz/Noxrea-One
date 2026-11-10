/**
 * 资产领域命令。
 * 组件不直接触达 store：命令是唯一的写入口，返回与 store 动作一致的业务结果。
 */
import type { AddAssetsBatchResult } from "./store";
import { useAssetsStore } from "./store";
import type {
  AssetBatchUpdate,
  AssetFolder,
  AssetItem,
  AssetScope,
  AssetUpdatePatch,
  CreateAssetInput,
} from "./types";

export function initialize(): Promise<void> {
  return useAssetsStore.getState().initialize();
}

export function addAsset(input: CreateAssetInput): Promise<AssetItem | null> {
  return useAssetsStore.getState().addAsset(input);
}

export function addAssetsBatch(inputs: CreateAssetInput[]): Promise<AddAssetsBatchResult> {
  return useAssetsStore.getState().addAssetsBatch(inputs);
}

export function updateAsset(id: string, patch: AssetUpdatePatch): Promise<boolean> {
  return useAssetsStore.getState().updateAsset(id, patch);
}

export function removeAssetsBatch(ids: string[]): Promise<{ ok: boolean; total?: number }> {
  return useAssetsStore.getState().removeAssetsBatch(ids);
}

export function unsaveAssetsByFileKeys(fileKeys: string[]): Promise<boolean> {
  return useAssetsStore.getState().unsaveAssetsByFileKeys(fileKeys);
}

export function updateAssetsBatch(
  ids: string[],
  updates: AssetBatchUpdate,
): Promise<{ ok: boolean; total?: number }> {
  return useAssetsStore.getState().updateAssetsBatch(ids, updates);
}

export function addFolder(
  name: string,
  scope: AssetScope,
  parentId?: string,
): Promise<{ status: "created"; folder: AssetFolder } | { status: "duplicate" } | { status: "failed" }> {
  return useAssetsStore.getState().addFolder(name, scope, parentId);
}

export function renameFolder(
  id: string,
  name: string,
): Promise<{ status: "updated" } | { status: "duplicate" } | { status: "failed" }> {
  return useAssetsStore.getState().renameFolder(id, name);
}

export function removeFolder(id: string): Promise<boolean> {
  return useAssetsStore.getState().removeFolder(id);
}
