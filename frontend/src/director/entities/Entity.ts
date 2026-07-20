import * as THREE from "three";

let _idSeq = 0;

// 实体基类（§7）：gizmo 与选择都作用于 root。
export class Entity {
  id: string;
  type: "character" | "prop" | "camera" | "crowd";
  name: string;
  root: THREE.Object3D;
  visible: boolean = true;
  baseScale: number = 1; // 归一化基准缩放（统一缩放滑条以此为 1.0 基准）
  height: number = 1.7;
  labelEl: HTMLElement | null = null;

  constructor(
    type: "character" | "prop" | "camera" | "crowd",
    name: string,
    root: THREE.Object3D
  ) {
    this.id = `e${++_idSeq}`;
    this.type = type;
    this.name = name;
    this.root = root;
    root.userData.entityId = this.id; // 选择时向上回溯用
  }

  setVisible(v: boolean) {
    this.visible = v;
    this.root.visible = v;
  }

  /** 子类可覆盖以释放 GPU 资源。 */
  dispose() {
    this.root.traverse((o: any) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
        else m?.dispose?.();
      }
    });
  }
}
