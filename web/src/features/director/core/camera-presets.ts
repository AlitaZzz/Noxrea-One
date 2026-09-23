/**
 * 镜头机位预设表。
 * 依据主体位置与身高计算各类经典机位（特写、过肩、俯拍等）的位姿与视场角。
 */
import * as THREE from "three";

// 机位预设：给定主体（选中角色，否则场景中心）与导演相机，
// 算出机位的位姿与 fov。约定主体正面朝 +Z。

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

export interface CameraPresetCtx {
  subjectCenter: THREE.Vector3;
  subjectHeight: number;
  directorCamera: THREE.PerspectiveCamera;
  directorTarget: THREE.Vector3;
  sceneCenter: THREE.Vector3;
}

export interface CameraPreset {
  key: string;
  /** i18n key 后缀（渲染处用 t(`director.${label}`) 翻译） */
  label: string;
  /** i18n key 后缀（渲染处用 t(`director.${group}`) 翻译），同时作为分组标识 */
  group: string;
  fov: number | null;
  build: (c: CameraPresetCtx) => {
    position: THREE.Vector3;
    target: THREE.Vector3;
    roll?: number;
    fov?: number;
  };
}

export const CAMERA_PRESETS: CameraPreset[] = [
  {
    key: "current",
    label: "cam.current",
    group: "camGroup.view",
    fov: null,
    build: (c) => {
      const pos = c.directorCamera.position.clone();
      const tgt = c.directorTarget.clone();
      const dir = pos.clone().sub(tgt);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      pos.add(dir.normalize().multiplyScalar(0.5));
      return { position: pos, target: tgt, fov: c.directorCamera.fov };
    },
  },
  {
    key: "front_mid",
    label: "cam.front_mid",
    group: "camGroup.front",
    fov: 40,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.05, c.subjectHeight * 2.2)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "front_closeup",
    label: "cam.front_closeup",
    group: "camGroup.front",
    fov: 34,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.18, c.subjectHeight * 1.05)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.18, 0)),
    }),
  },
  {
    key: "front_full",
    label: "cam.front_full",
    group: "camGroup.front",
    fov: 46,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.02, c.subjectHeight * 3.4)),
      target: c.subjectCenter.clone().add(V(0, -c.subjectHeight * 0.18, 0)),
    }),
  },
  {
    key: "side_track",
    label: "cam.side_track",
    group: "camGroup.sideBack",
    fov: 42,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(c.subjectHeight * 1.8, c.subjectHeight * 0.06, c.subjectHeight * 0.9)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "side_close",
    label: "cam.side_close",
    group: "camGroup.sideBack",
    fov: 38,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(c.subjectHeight * 1.15, c.subjectHeight * 0.12, 0)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.12, 0)),
    }),
  },
  {
    key: "back_mid",
    label: "cam.back_mid",
    group: "camGroup.sideBack",
    fov: 40,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.05, -c.subjectHeight * 2.2)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "high_full",
    label: "cam.high_full",
    group: "camGroup.highLow",
    fov: 48,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 2.6, c.subjectHeight * 2.2)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "high_45",
    label: "cam.high_45",
    group: "camGroup.highLow",
    fov: 44,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 1.8, c.subjectHeight * 1.8)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "low_up",
    label: "cam.low_up",
    group: "camGroup.highLow",
    fov: 50,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, -c.subjectHeight * 0.28, c.subjectHeight * 1.6)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.4, 0)),
    }),
  },
  {
    key: "low_wide",
    label: "cam.low_wide",
    group: "camGroup.highLow",
    fov: 72,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, -c.subjectHeight * 0.22, c.subjectHeight * 1.25)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.38, 0)),
    }),
  },
  {
    key: "ots_left",
    label: "cam.ots_left",
    group: "camGroup.special",
    fov: 40,
    build: (c) => ({
      position: c.subjectCenter
        .clone()
        .add(V(-c.subjectHeight * 0.6, c.subjectHeight * 0.95, -c.subjectHeight * 1.05)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.55, c.subjectHeight * 1.6)),
    }),
  },
  {
    key: "ots_right",
    label: "cam.ots_right",
    group: "camGroup.special",
    fov: 40,
    build: (c) => ({
      position: c.subjectCenter
        .clone()
        .add(V(c.subjectHeight * 0.6, c.subjectHeight * 0.95, -c.subjectHeight * 1.05)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.55, c.subjectHeight * 1.6)),
    }),
  },
  {
    key: "birdseye",
    label: "cam.birdseye",
    group: "camGroup.special",
    fov: 55,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(0, c.subjectHeight * 4.5, c.subjectHeight * 0.001)),
      target: c.subjectCenter.clone(),
    }),
  },
  {
    key: "dutch",
    label: "cam.dutch",
    group: "camGroup.special",
    fov: 42,
    build: (c) => ({
      position: c.subjectCenter.clone().add(V(c.subjectHeight * 0.6, c.subjectHeight * 0.15, c.subjectHeight * 1.9)),
      target: c.subjectCenter.clone().add(V(0, c.subjectHeight * 0.1, 0)),
      roll: 13 * DEG,
    }),
  },
];

export function groupedPresets(): { name: string; items: CameraPreset[] }[] {
  const groups: { name: string; items: CameraPreset[] }[] = [];
  const byKey = new Map<string, { name: string; items: CameraPreset[] }>();
  for (const p of CAMERA_PRESETS) {
    let g = byKey.get(p.group);
    if (!g) {
      g = { name: p.group, items: [] };
      byKey.set(p.group, g);
      groups.push(g);
    }
    g.items.push(p);
  }
  return groups;
}
