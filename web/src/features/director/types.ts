/**
 * Director 运行态实体联合类型。
 * 可序列化的场景/展示类型已下沉至 `entities/director`；
 * 这里只保留实体类联合，供 store 与 engine（core）共同引用，
 * 从而打破 store <-> core 之间的循环依赖
 * （原 selection.ts / camera-rig.ts 直接引用 store.ts 中的 DirectorEntity）。
 */
import type { CameraEntity } from "./entities/camera";
import type { Character } from "./entities/character";
import type { Crowd } from "./entities/crowd";
import type { Prop } from "./entities/prop";

export type { CameraEntity, Character, Crowd, Prop };

/** 导演场景中所有实体类型的联合（角色/道具/相机/群众）。 */
export type DirectorEntity = Character | Prop | CameraEntity | Crowd;
