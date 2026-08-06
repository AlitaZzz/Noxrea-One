/**
 * Director feature 公开 API barrel。
 */

// ── 组件 ──
export { default as DirectorOverlay } from "./components/DirectorOverlay";
export { default as DirectorViewport } from "./components/DirectorViewport";
export { default as Dock } from "./components/Dock";
export { default as Outliner } from "./components/Outliner";
export { default as ScenePanel } from "./components/ScenePanel";
export { default as Inspector } from "./components/Inspector";
export { default as PoseSliders } from "./components/PoseSliders";

// ── Store ──
export { useDirectorStore, type DirectorRuntime } from "./director-store";

// ── 类型 ──
export type {
  CameraEntity,
  Character,
  Crowd,
  Prop,
  DirectorEntity,
  DirectorEntityMeta,
  Shot,
  SceneState,
} from "./types";
