/**
 * Director feature 公开 API barrel。
 */

// ── 组件 ──
export { default as DirectorOverlay } from "./components/DirectorOverlay";
export { default as DirectorViewport } from "./components/DirectorViewport";
export { default as Dock } from "./components/Dock";
export { default as Inspector } from "./components/Inspector";
export { default as Outliner } from "./components/Outliner";
export { default as PoseSliders } from "./components/PoseSliders";
export { default as ScenePanel } from "./components/ScenePanel";

// ── Store ──
export { type DirectorRuntime,useDirectorStore } from "./director-store";

// ── 类型 ──
export type {
  CameraEntity,
  Character,
  Crowd,
  DirectorEntity,
  DirectorEntityMeta,
  Prop,
  SceneState,
  Shot,
} from "./types";
