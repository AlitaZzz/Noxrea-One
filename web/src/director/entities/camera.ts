/**
 * 相机实体。
 * 在场景中以可视化机身与视锥呈现一台可摆放的拍摄相机，
 * 内含真实透视相机供 POV 出图使用。
 */
import * as THREE from "three";

import { Entity } from "./entity";

const BODY_COLOR = 0xff8a3d;
const FRUSTUM_COLOR = 0x35a7ff;
const VIZ_FAR = 0.5;

function buildCameraBody(): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: BODY_COLOR,
    roughness: 0.5,
    metalness: 0.1,
    emissive: 0x3a1600,
    emissiveIntensity: 0.5,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.11, 0.2), mat);
  g.add(body);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.052, 0.08, 18), mat);
  lens.rotation.x = Math.PI / 2;
  lens.position.set(0, 0, -0.135);
  g.add(lens);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.025, 18), mat);
  reel.rotation.x = Math.PI / 2;
  reel.position.set(0.03, 0.085, 0.02);
  g.add(reel);
  g.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = false; });
  return g;
}

function tintHelper(helper: THREE.CameraHelper, color: number) {
  const mat = helper.material as THREE.LineBasicMaterial;
  mat.vertexColors = false;
  mat.color = new THREE.Color(color);
  mat.transparent = true;
  mat.opacity = 0.85;
  mat.needsUpdate = true;
}

export interface CameraEntityOpts {
  fov?: number;
  aspect?: number;
  near?: number;
  far?: number;
  scene?: THREE.Scene;
}

export class CameraEntity extends Entity {
  cam: THREE.PerspectiveCamera;
  private _viz: THREE.PerspectiveCamera;
  private _scene: THREE.Scene | null;
  body: THREE.Group;
  helper: THREE.CameraHelper;
  height = 0.2;
  _roll = 0;
  lookTarget = new THREE.Vector3(0, 0, -1);
  labelEl: HTMLElement | null = null;

  constructor(name: string, opts: CameraEntityOpts = {}) {
    const root = new THREE.Group();
    super("camera", name, root);
    const { fov = 40, aspect = 16 / 9, near = 0.1, far = 1000, scene } = opts;
    this._scene = scene || null;

    this.cam = new THREE.PerspectiveCamera(fov, aspect, near, far);
    root.add(this.cam);

    this._viz = new THREE.PerspectiveCamera(fov, aspect, 0.05, VIZ_FAR);
    root.add(this._viz);

    this.body = buildCameraBody();
    root.add(this.body);

    this.helper = new THREE.CameraHelper(this._viz);
    tintHelper(this.helper, FRUSTUM_COLOR);
    if (this._scene) this._scene.add(this.helper);
  }

  get fov() { return this.cam.fov; }

  aimAt(point: THREE.Vector3) {
    this.lookTarget.copy(point);
    const m = new THREE.Matrix4().lookAt(this.root.position, point, new THREE.Vector3(0, 1, 0));
    this.root.quaternion.setFromRotationMatrix(m);
    if (this._roll) this.root.rotateZ(this._roll);
    this.root.updateMatrixWorld(true);
    this.update();
  }

  setFov(deg: number) {
    this.cam.fov = deg; this.cam.updateProjectionMatrix();
    this._viz.fov = deg; this._viz.updateProjectionMatrix();
    this.helper.update();
  }

  setAspect(a: number) {
    this.cam.aspect = a; this.cam.updateProjectionMatrix();
    this._viz.aspect = a; this._viz.updateProjectionMatrix();
    this.helper.update();
  }

  update() { this.helper.update(); }

  setVisible(v: boolean) {
    super.setVisible(v);
    this.helper.visible = v;
  }

  getLabelAnchor(out = new THREE.Vector3()): THREE.Vector3 {
    this.body.getWorldPosition(out);
    out.y += 0.16;
    return out;
  }

  dispose() {
    if (this._scene) this._scene.remove(this.helper);
    this.helper.dispose();
    super.dispose();
  }
}
