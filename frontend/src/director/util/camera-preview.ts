import * as THREE from "three";

import type { Stage } from "../core/stage";

// 按需把某相机 POV 渲成 dataURL（用于 Inspector 预览框和全屏预览）。

let _r: THREE.WebGLRenderer | null = null;

function getRenderer(): THREE.WebGLRenderer {
  if (_r) return _r;
  _r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
  _r.setPixelRatio(1);
  _r.outputColorSpace = THREE.SRGBColorSpace;
  _r.toneMapping = THREE.ACESFilmicToneMapping;
  _r.toneMappingExposure = 1.0;
  return _r;
}

export function renderCameraThumbnail(
  stage: Stage,
  cam: THREE.PerspectiveCamera,
  w: number = 320,
  h: number = 180,
  hooks: { before?: () => void; after?: () => void } = {}
): string {
  const r = getRenderer();
  r.setSize(w, h, false);
  const prevAspect = cam.aspect;
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
  hooks.before?.();
  try {
    r.render(stage.scene, cam);
  } finally {
    hooks.after?.();
    cam.aspect = prevAspect;
    cam.updateProjectionMatrix();
  }
  return r.domElement.toDataURL("image/png");
}
