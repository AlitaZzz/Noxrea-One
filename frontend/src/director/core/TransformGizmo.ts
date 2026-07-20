import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

// TransformControls 封装：模式切换、与 Orbit 互斥、变更回调。
export class TransformGizmo {
  control: TransformControls;
  private _helper: any;
  private _onObjectChange: (() => void) | null = null;
  attached: THREE.Object3D | null = null;

  constructor(
    camera: THREE.Camera,
    domElement: HTMLElement,
    scene: THREE.Scene,
    orbit: OrbitControls,
    orbitAllowed: () => boolean = () => true,
  ) {
    this.control = new TransformControls(camera, domElement);
    this.control.setMode("translate");
    this.control.setSpace("local");
    this.control.setSize(0.85);

    this._helper =
      typeof (this.control as any).getHelper === "function"
        ? (this.control as any).getHelper()
        : this.control;
    scene.add(this._helper);
    this.control.enabled = false;
    this._setHelperVisible(false);

    this.control.addEventListener("dragging-changed", (e: any) => {
      orbit.enabled = !e.value && orbitAllowed();
    });

    this.control.addEventListener("objectChange", () => {
      this._onObjectChange && this._onObjectChange();
    });
  }

  private _setHelperVisible(v: boolean) {
    if (this._helper) this._helper.visible = v;
  }

  onObjectChange(fn: () => void) {
    this._onObjectChange = fn;
  }

  get dragging(): boolean {
    return !!(this.control as any).dragging;
  }

  get overAxis(): boolean {
    return (this.control as any).axis != null;
  }

  setMode(mode: string) {
    this.control.setMode(mode as any);
  }

  attach(root: THREE.Object3D) {
    this.attached = root;
    this.control.attach(root);
    this.control.enabled = true;
    this._setHelperVisible(true);
  }

  detach() {
    this.attached = null;
    this.control.detach();
    this.control.enabled = false;
    this._setHelperVisible(false);
  }

  setVisible(v: boolean) {
    if (!this.attached) return;
    this.control.enabled = v;
    this._setHelperVisible(v);
  }
}
