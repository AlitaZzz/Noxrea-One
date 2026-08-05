/**
 * 三维实体拾取与高亮。
 * 基于 Raycaster 完成点击选择，并在地面绘制选中蓝环指示。
 */
import * as THREE from "three";

import type { DirectorEntity } from "../types";
import { worldBox } from "../util/measure";

// Raycaster 选择 + 地面蓝环高亮。
export class Selection {
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  scene: THREE.Scene;
  getEntities: () => DirectorEntity[];
  onSelect: (id: string | null) => void;

  ray = new THREE.Raycaster();
  ndc = new THREE.Vector2();
  private _down = new THREE.Vector2();
  ring: THREE.Mesh;
  selectedEntity: DirectorEntity | null = null;
  private _shouldSkip: () => boolean = () => false;
  _filterInvisible = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene,
    getEntities: () => DirectorEntity[],
    onSelect: (id: string | null) => void
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.scene = scene;
    this.getEntities = getEntities;
    this.onSelect = onSelect;

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.46, 0.56, 48),
      new THREE.MeshBasicMaterial({
        color: 0x4f8ef7,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    this.ring.visible = false;
    this.ring.renderOrder = 2;
    scene.add(this.ring);

    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", (e) => {
      this._down.set(e.clientX, e.clientY);
    });
    dom.addEventListener("pointerup", (e) => {
      const moved = Math.hypot(e.clientX - this._down.x, e.clientY - this._down.y);
      if (moved > 4) return;
      if (this._shouldSkip()) return;
      this._pick(e);
    });
  }

  setSkipPredicate(fn: () => boolean) {
    this._shouldSkip = fn;
  }

  _pick(e: PointerEvent) {
    const dom = this.renderer.domElement;
    const r = dom.getBoundingClientRect();
    this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    this.ray.setFromCamera(this.ndc, this.camera);

    const roots = this.getEntities()
      .filter((en) => en.visible)
      .map((en) => en.root);
    let hits = this.ray.intersectObjects(roots, true);
    // 机位视角下过滤隐藏的相机 body/helper（仅在 camera view 启用）
    if (this._filterInvisible) {
      hits = hits.filter((h) => {
        for (let o: THREE.Object3D | null = h.object; o; o = o.parent) { if (o.visible === false) return false; }
        return true;
      });
    }
    if (!hits.length) {
      this.onSelect(null);
      return;
    }
    let o: THREE.Object3D | null = hits[0].object;
    while (o && o.userData.entityId == null) o = o.parent;
    this.onSelect(o ? o.userData.entityId : null);
  }

  highlight(entity: DirectorEntity | null) {
    this.selectedEntity = entity;
    this.ring.visible = !!entity;
    if (entity) this._sizeRing(entity);
  }

  _sizeRing(entity: DirectorEntity) {
    const box = worldBox(entity.root, { useBones: entity.type === "character" });
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const rad = Math.max(0.4, 0.5 * Math.hypot(size.x, size.z) + 0.12);
    this.ring.scale.setScalar(rad / 0.5);
  }

  update() {
    if (!this.selectedEntity) return;
    const p = new THREE.Vector3();
    this.selectedEntity.root.getWorldPosition(p);
    this.ring.position.x = p.x;
    this.ring.position.z = p.z;
  }
}
