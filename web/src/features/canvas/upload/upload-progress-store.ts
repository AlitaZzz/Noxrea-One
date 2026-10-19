/**
 * Runtime-only upload progress.
 * Progress is transport feedback, not canvas document data. Keeping it keyed by
 * node id prevents byte-level events from replacing the global nodes array.
 */
import { create } from "zustand";

import type { UploadProgressValue } from "@/lib/utils/upload";

function isSameProgress(a: UploadProgressValue, b: UploadProgressValue): boolean {
  if (a.phase === "hashing" && b.phase === "hashing") return a.loadedBytes === b.loadedBytes;
  if (a.phase === "uploading" && b.phase === "uploading") return a.pct === b.pct;
  return false;
}

interface UploadProgressEntry {
  version: number;
  progress: UploadProgressValue;
}

interface UploadProgressState {
  byNodeId: Map<string, UploadProgressEntry>;
  begin: (nodeId: string, version: number) => void;
  update: (nodeId: string, version: number, progress: UploadProgressValue) => void;
  clear: (nodeId: string, version?: number) => void;
  clearAll: () => void;
}

export const useUploadProgressStore = create<UploadProgressState>((set) => ({
  byNodeId: new Map(),
  begin: (nodeId, version) => {
    set((state) => {
      const next = new Map(state.byNodeId);
      // 初值取哈希态：direct 模式的首个真实上报（runOne 同步首报）与之同值同批渲染，
      // 不会闪出 0% 帧；relay 在首个传输事件前短暂沿用该态
      next.set(nodeId, { version, progress: { phase: "hashing", loadedBytes: 0 } });
      return { byNodeId: next };
    });
  },
  update: (nodeId, version, progress) => {
    set((state) => {
      const current = state.byNodeId.get(nodeId);
      if (!current || current.version !== version || isSameProgress(current.progress, progress)) return state;
      const next = new Map(state.byNodeId);
      next.set(nodeId, { version, progress });
      return { byNodeId: next };
    });
  },
  clear: (nodeId, version) => {
    set((state) => {
      const current = state.byNodeId.get(nodeId);
      if (!current || (version !== undefined && current.version !== version)) return state;
      const next = new Map(state.byNodeId);
      next.delete(nodeId);
      return { byNodeId: next };
    });
  },
  clearAll: () => set((state) => (state.byNodeId.size === 0 ? state : { byNodeId: new Map() })),
}));

export function useUploadProgress(nodeId: string): UploadProgressValue | undefined {
  return useUploadProgressStore((state) => state.byNodeId.get(nodeId)?.progress);
}
