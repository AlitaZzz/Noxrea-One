import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

// TransformControls 封装：模式切换、与 Orbit 互斥、变更回调。
export class TransformGizmo {
  control: TransformControls;
  private _helper: THREE.Object3D;
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

    const ctrl = this.control as unknown as { getHelper?: () => THREE.Object3D };
    this._helper = ctrl.getHelper?.()!;
    scene.add(this._helper);
    this.control.enabled = false;
    this._setHelperVisible(false);

    this.control.addEventListener("dragging-changed", (e) => {
      const ev = e as unknown as { value: boolean };
      orbit.enabled = !ev.value && orbitAllowed();
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
    return (this.control as unknown as { dragging: boolean }).dragging;
  }

  get overAxis(): boolean {
    return (this.control as unknown as { axis: unknown }).axis != null;
  }

  setMode(mode: string) {
    this.control.setMode(mode as "translate" | "rotate" | "scale");
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
