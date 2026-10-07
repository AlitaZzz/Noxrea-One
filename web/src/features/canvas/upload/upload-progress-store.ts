/**
 * Runtime-only upload progress.
 * Progress is transport feedback, not canvas document data. Keeping it keyed by
 * node id prevents byte-level events from replacing the global nodes array.
 */
import { create } from "zustand";

interface UploadProgressEntry {
  version: number;
  progress: number;
}

interface UploadProgressState {
  byNodeId: Map<string, UploadProgressEntry>;
  begin: (nodeId: string, version: number) => void;
  update: (nodeId: string, version: number, progress: number) => void;
  clear: (nodeId: string, version?: number) => void;
  clearAll: () => void;
}

export const useUploadProgressStore = create<UploadProgressState>((set) => ({
  byNodeId: new Map(),
  begin: (nodeId, version) => {
    set((state) => {
      const next = new Map(state.byNodeId);
      next.set(nodeId, { version, progress: 0 });
      return { byNodeId: next };
    });
  },
  update: (nodeId, version, progress) => {
    set((state) => {
      const current = state.byNodeId.get(nodeId);
      if (!current || current.version !== version || current.progress === progress) return state;
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

export function useUploadProgress(nodeId: string): number | undefined {
  return useUploadProgressStore((state) => state.byNodeId.get(nodeId)?.progress);
}
