/**
 * Director 领域共享类型。
 * 抽出实体联合类型与展示/场景相关的纯类型，供 store 与 engine（core）
 * 共同引用，从而打破 store <-> core 之间的循环依赖
 * （原 selection.ts / camera-rig.ts 直接引用 store.ts 中的 DirectorEntity）。
 */
import type { CameraEntity } from "./entities/camera";
import type { Character } from "./entities/character";
import type { Crowd } from "./entities/crowd";
import type { Prop } from "./entities/prop";

export type { CameraEntity, Character, Crowd, Prop };

/** 导演场景中所有实体类型的联合（角色/道具/相机/群众）。 */
export type DirectorEntity = Character | Prop | CameraEntity | Crowd;

/** 实体元数据（Three.js 对象保存在运行时，此处仅存展示层信息）。 */
export interface DirectorEntityMeta {
  id: string;
  type: "character" | "prop" | "camera" | "crowd";
  name: string;
  visible: boolean;
  _members?: DirectorEntityMeta[];
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
