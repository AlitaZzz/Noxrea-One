import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { worldBox } from "../util/measure";

// OrbitControls + 聚焦选中 + 取景比例 overlay + 重置视角
export class CameraRig {
  camera: THREE.PerspectiveCamera;
  viewport: HTMLElement;
  frameEl: HTMLElement | null;
  controls: OrbitControls;

  private _home: { pos: THREE.Vector3; target: THREE.Vector3 };
  ratio: number | null = 16 / 9;
  frameRect: { x: number; y: number; w: number; h: number } | null = null;

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    viewportEl: HTMLElement,
    frameEl: HTMLElement | null = null
  ) {
    this.camera = camera;
    this.viewport = viewportEl;
    this.frameEl = frameEl;

    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0.95, 0);
    this.controls.minDistance = 1.5;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // 不穿到地面以下
    this.controls.update();

    this._home = {
      pos: camera.position.clone(),
      target: this.controls.target.clone(),
    };

    this.setRatio("free"); // 默认自由视角，无取景框
  }

  update() {
    this.controls.update();
  }

  /** 用实体包围盒设 target 与相机距离（角色用骨骼世界坐标量真实尺寸）。 */
  focus(entity: any) {
    if (!entity) return;
    const root = entity.root;
    const box = worldBox(root, { useBones: entity.type === "character" });
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const h = Math.max(size.x, size.y, size.z) || 1.7;

    this.controls.target.copy(center);
    const fitDist = (h * 0.5) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const dist = fitDist * 1.8;

    const dir = new THREE.Vector3()
      .subVectors(this.camera.position, this.controls.target)
      .normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.3, 0.2, 1).normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
  }

  /**
   * 自动取景：把主体（角色/道具，跳过相机）拉到占满画面。
   * 宽度只按主体「身体中心跨度 + 身宽余量」算，忽略 T-pose 张开的手臂。
   */
  frameAll(entities: any[], { margin = 1.06, bodyPad = 0.32 }: { margin?: number; bodyPad?: number } = {}) {
    const box = new THREE.Box3();
    let any = false;
    let minX = Infinity,
      maxX = -Infinity;
    for (const e of entities) {
      if (!e || e.type === "camera" || !e.visible) continue;
      const b = worldBox(e.root, { useBones: e.type === "character" });
      if (!b.isEmpty()) {
        box.union(b);
        any = true;
      }
      const c = e.root.getWorldPosition(new THREE.Vector3());
      minX = Math.min(minX, c.x);
      maxX = Math.max(maxX, c.x);
    }
    if (!any || box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const halfH = size.y * 0.5;
    const halfW = (maxX - minX) * 0.5 + bodyPad;
    const dH = halfH / Math.tan(vfov / 2);
    const dW = halfW / Math.tan(hfov / 2);
    let dist = Math.max(dH, dW) * margin;
    dist = Math.max(this.controls.minDistance, Math.min(dist, this.controls.maxDistance));

    this.controls.target.copy(center);
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0.12, 1);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();

    this._home.pos.copy(this.camera.position);
    this._home.target.copy(this.controls.target);
  }

  resetView() {
    this.camera.position.copy(this._home.pos);
    this.controls.target.copy(this._home.target);
    this.controls.update();
  }

  /** 设取景比例。ratioStr ∈ 'free' | 任意 'w:h'（16:9 / 9:16 / 1:1 …） */
  setRatio(ratioStr: string) {
    if (ratioStr === "free" || ratioStr === "auto" || ratioStr == null) {
      this.ratio = null;
      if (this.frameEl) this.frameEl.style.display = "none";
      this.frameRect = null;
      return;
    }
    const [w, h] = ratioStr.split(":").map(Number);
    this.ratio = w / h;
    if (this.frameEl) {
      this.frameEl.style.display = "block";
      this.layoutFrame();
    }
  }

  /** 根据当前比例在视口中央排一个取景框，并记录裁剪矩形。 */
  layoutFrame() {
    if (this.ratio == null) {
      this.frameRect = null;
      return;
    }
    if (!this.frameEl) {
      // 没有 DOM 取景框时，仍按视口中心计算裁剪矩形（供截图用）
      const W = this.viewport.clientWidth;
      const H = this.viewport.clientHeight;
      let fw = W * 0.7;
      let fh = fw / this.ratio;
      if (fh > H * 0.82) {
        fh = H * 0.82;
        fw = fh * this.ratio;
      }
      this.frameRect = { x: (W - fw) / 2, y: (H - fh) / 2, w: fw, h: fh };
      return;
    }
    const W = this.viewport.clientWidth;
    const H = this.viewport.clientHeight;
    let fw = W * 0.7;
    let fh = fw / this.ratio!;
    if (fh > H * 0.82) {
      fh = H * 0.82;
      fw = fh * this.ratio!;
    }
    const x = (W - fw) / 2;
    const y = (H - fh) / 2;
    this.frameRect = { x, y, w: fw, h: fh };
    this.frameEl.style.left = x + "px";
    this.frameEl.style.top = y + "px";
    this.frameEl.style.width = fw + "px";
    this.frameEl.style.height = fh + "px";
  }

  onResize() {
    if (this.ratio != null) this.layoutFrame();
  }
}
