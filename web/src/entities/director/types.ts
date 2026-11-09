/**
 * Director 领域可序列化类型。
 * 供画布节点数据、导演台 store 与场景快照共同引用；
 * 运行态 Three.js 实体类及其联合类型 `DirectorEntity` 留在 `features/director`。
 */

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
  /** 快照引用值：存储 key 或外部 URL；展示时派生访问 URL */
  ref: string;
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

/** 实体快照：画布节点数据与导演台恢复状态共用的扁平结构。 */
export interface DirectorEntityState {
  id: string;
  type: "character" | "prop" | "camera" | "crowd";
  name: string;
  visible: boolean;
  pos: [number, number, number];
  rot: [number, number, number, number];
  scale: [number, number, number];
  // Character
  bodyType?: string;
  color?: string;
  srcUrl?: string;
  pose?: { mode: "preset" | "manual"; preset?: string | null; values?: Record<string, number> };
  // Prop
  kind?: string;
  // Camera
  fov?: number;
  roll?: number;
  // Crowd
  rows?: number;
  cols?: number;
  spacing?: number;
  members?: Omit<DirectorEntityState, "rows" | "cols" | "spacing" | "members">[];
}

/** 导演出图落回画布的输入：已上传的引用值与画布节点所需的尺寸、名称。 */
export interface DirectorImageNodeInput {
  /** 存储 key 或外部 URL（与画布节点 data.src 同值域）。 */
  ref: string;
  width: number;
  height: number;
  name: string;
}

/** 导演场景完整快照（画布 Director 节点的持久化载荷）。 */
export interface DirectorStateData {
  entities: DirectorEntityState[];
  sceneState: Partial<SceneState>;
  ratio: string;
  cameraView: boolean;
  transformMode: string;
  shots: Shot[];
}
