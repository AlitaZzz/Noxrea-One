/**
 * 资产领域读取接口。
 * 只暴露渲染所需的薄选择器；store 与内部状态形状不对外。
 */
import { useAssetsStore } from "./store";
import type { AssetFolder } from "./types";

export function useAssetFolders(): AssetFolder[] {
  return useAssetsStore((state) => state.folders);
}

export function useAssetsInitialized(): boolean {
  return useAssetsStore((state) => state.initialized);
}

export function useKnownAssetKeys(): Set<string> {
  return useAssetsStore((state) => state.knownAssetKeys);
}

export function useAssetLibraryVersion(): number {
  return useAssetsStore((state) => state.libraryVersion);
}

/**
 * 同步读取初始化结果，供异步流程在 `initialize()` settle 后判定成功与否。
 * 非 React 上下文使用；渲染中请用 useAssetsInitialized。
 */
export function getAssetsInitialized(): boolean {
  return useAssetsStore.getState().initialized;
}
