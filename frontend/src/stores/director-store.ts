import { create } from "zustand";
import type { CameraEntity } from "@/director/entities/camera";
import type { Character } from "@/director/entities/character";
import type { Crowd } from "@/director/entities/crowd";
import type { Prop } from "@/director/entities/prop";
import type { Stage } from "@/director/core/stage";

/** 导演场景中所有实体类型的联合（角色/道具/相机/群众）。 */
export type DirectorEntity = Character | Prop | CameraEntity | Crowd;

import type { DirectorStateData } from "@/lib/types";

// --- Entity metadata (Three.js objects live in ref, not here) ---

export interface DirectorEntityMeta {
  id: string;
  type: "character" | "prop" | "camera" | "crowd";
  name: string;
  visible: boolean;
}

export interface Shot {
  id: string;
  url: string;
  name: string;
  cameraId: string;
  createdAt: number;
  selected?: boolean;
}

export interface SceneState {
  scale: number;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number };
  sky: string;
  labels: boolean;
  ground: {
    visible: boolean;
    opacity: number;
    height: number;
  };
  panoActive: boolean;
  panoRot: number;
  panoRadius: number;
}

// --- Runtime ref interface (exposed by DirectorViewport via useImperativeHandle) ---
// UI calls these, DirectorViewport executes Three.js logic.

export interface DirectorRuntime {
  addCharacter: (bodyType?: string) => Promise<Character | null>;
  addProp: (kind: string) => Prop;
  addCamera: (presetKey?: string) => CameraEntity;
  addCrowd: (rows?: number, cols?: number, spacing?: number) => Promise<Crowd | null>;
  remove: (id: string) => void;
  select: (id: string | null) => void;
  toggleSelect: (id: string) => void;
  setTransformMode: (mode: string) => void;
  setCameraView: (on: boolean) => void;
  setRatio: (ratio: string) => void;
  setSceneScale: (s: number) => void;
  setScenePos: (axis: string, v: number) => void;
  setSceneRot: (axis: string, deg: number) => void;
  setSkyColor: (hex: string) => void;
  setLabelsVisible: (v: boolean) => void;
  setGroundVisible: (v: boolean) => void;
  setGroundOpacity: (v: number) => void;
  setGroundHeight: (y: number) => void;
  applyPosePreset: (characterId: string, presetKey: string) => void;
  setJointValue: (characterId: string, jointKey: string, value: number) => void;
  rename: (id: string, name: string) => void;
  ungroupCrowd: (id: string) => void;
  toggleVisible: (id: string) => void;
  setEntityColor: (id: string, hex: string) => void;
  groupCharacters: (ids: string[]) => void;
  duplicateMany: (ids: string[]) => Promise<void>;
  toggleVisibleMany: (ids: string[]) => void;
  captureShot: () => Promise<{ url: string; name: string; cameraId: string } | null>;
  sendShotToCanvas: (shotId: string) => Promise<void>;
  resetView: () => void;
  captureState: () => DirectorStateData;
  restoreState: (data: DirectorStateData) => Promise<void>;
  // ---- 内部/私有辅助（由 DirectorViewport 实现，供自身与 Inspector 调用）----
  _resolveShotCamera: () => DirectorEntity | null;
  _getEntity: (id: string) => DirectorEntity | null;
  _getStage: () => Stage;
  _getPoseValues: (id: string) => Record<string, number>;
  _beginCleanRender: () => void;
  _endCleanRender: () => void;
  _setSyncInspector: (cb: (() => void) | null) => void;
  _setCameraAttrChange: (cb: (() => void) | null) => void;
  _broadcastPosePreset: (crowdId: string, presetKey: string) => void;
  _broadcastResetPose: (crowdId: string) => void;
  _shotSeq?: Record<string, number>;
}

// --- Zustand Store ---

interface DirectorState {
  // Metadata
  entities: DirectorEntityMeta[];
  selectedId: string | null;
  selectedIds: string[];
  transformMode: "translate" | "rotate" | "scale";
  cameraView: boolean;
  activeCameraId: string | null;
  ratio: string;
  sceneState: SceneState;
  shots: Shot[];

  // Three.js runtime handle (set by DirectorViewport on mount)
  runtime: DirectorRuntime | null;

  // Persistence
  openingNodeId: string | null;
  restoreState: DirectorStateData | null;

  // Actions (pure metadata, no Three.js)
  reset: () => void;
  setRuntime: (r: DirectorRuntime | null) => void;
  setOpeningNodeId: (id: string | null) => void;
  setRestoreState: (s: DirectorStateData | null) => void;
  setEntities: (entities: DirectorEntityMeta[]) => void;
  setSelectedId: (id: string | null) => void;
  toggleSelectedId: (id: string) => void;
  setTransformMode: (mode: "translate" | "rotate" | "scale") => void;
  setCameraView: (on: boolean) => void;
  setRatio: (ratio: string) => void;
  setSceneState: (partial: Partial<SceneState>) => void;
  addShot: (shot: Shot) => void;
  removeShot: (id: string) => void;
  toggleShotSelected: (id: string) => void;
  clearShots: () => void;
}

export const useDirectorStore = create<DirectorState>((set) => ({
  entities: [],
  selectedId: null,
  selectedIds: [],
  transformMode: "translate",
  cameraView: false,
  activeCameraId: null,
  ratio: "auto",
  sceneState: {
    scale: 1,
    pos: { x: 0, y: 0, z: 0 },
    rot: { x: 0, y: 0, z: 0 },
    sky: "#060608",
    labels: true,
    ground: { visible: true, opacity: 0.4, height: 0 },
    panoActive: false,
    panoRot: 0,
    panoRadius: 60,
  },
  shots: [],
  runtime: null,
  openingNodeId: null,
  restoreState: null,

  reset: () => set({
    entities: [],
    selectedId: null,
    selectedIds: [],
    transformMode: "translate",
    cameraView: false,
    activeCameraId: null,
    shots: [],
    runtime: null,
    openingNodeId: null,
    restoreState: null,
  }),
  setRuntime: (r) => set({ runtime: r }),
  setOpeningNodeId: (id) => set({ openingNodeId: id }),
  setRestoreState: (s) => set({ restoreState: s }),
  setEntities: (entities) => set({ entities }),
  setSelectedId: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  toggleSelectedId: (id) => set((s) => {
    const exists = s.selectedIds.includes(id);
    return { selectedIds: exists ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id], selectedId: exists ? (s.selectedIds.length > 1 ? s.selectedIds.find((x) => x !== id) || null : null) : id };
  }),
  setTransformMode: (mode) => set({ transformMode: mode }),
  setCameraView: (on) => set({ cameraView: on }),
  setRatio: (ratio) => set({ ratio }),
  setSceneState: (partial) =>
    set((s) => ({ sceneState: { ...s.sceneState, ...partial } })),
  addShot: (shot) => set((s) => ({ shots: [...s.shots, shot] })),
  removeShot: (id) => set((s) => ({ shots: s.shots.filter((x) => x.id !== id) })),
  toggleShotSelected: (id) =>
    set((s) => ({
      shots: s.shots.map((x) =>
        x.id === id ? { ...x, selected: !x.selected } : x
      ),
    })),
  clearShots: () => set({ shots: [] }),
}));
