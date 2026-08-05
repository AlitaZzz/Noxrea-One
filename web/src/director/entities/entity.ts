/**
 * 场景实体基类。
 * 定义 id / 类型 / 名称 / 根对象与可见性等通用属性，
 * 选择与变换手柄均作用于其 root 节点。
 */
import * as THREE from "three";

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
    this.id = `e_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
        else m?.dispose?.();
      }
    });
  }
}
