/**
 * 打光面板三维预览（three.js）。
 * 经纬线球体 + 中心图片平面 + 球面光源（颜色/强度实时映射），
 * 拖拽画布改变光源方位角/仰角；透视 / 正面双相机。
 * 场景静态，仅在 props 变化时渲染，卸载时完整释放 WebGL 资源。
 */
"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type LightViewMode = "perspective" | "front";

interface Props {
  src: string;
  color: string;
  intensity: number; // 0-100
  azimuth: number; // 0-359
  elevation: number; // -90~90
  mode: LightViewMode;
  onDrag: (azimuth: number, elevation: number) => void;
}

const R = 1;
// 正交视锥半高：透视相机（fov 40，距离 3.57）的垂直半高与之相等，保证双视角球体等大
const HALF = 1.3;

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camPersp: THREE.PerspectiveCamera;
  camOrtho: THREE.OrthographicCamera;
  pointLight: THREE.DirectionalLight;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  halo: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  ray: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial>;
  imageMat: THREE.MeshStandardMaterial;
  overlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  texture: THREE.Texture | null;
}

// 方位角/仰角 → 场景坐标（相机在 +Z，az=0 面向前方，az=90 指向右侧，Y 向上）
function lightPosition(azDeg: number, elDeg: number): THREE.Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(
    R * Math.cos(el) * Math.sin(az),
    R * Math.sin(el),
    R * Math.cos(el) * Math.cos(az),
  );
}

export default function LightingScene3D({ src, color, intensity, azimuth, elevation, mode, onDrag }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);
  const dragRef = useRef({ on: false, lastX: 0, lastY: 0 });
  const onDragRef = useRef(onDrag);
  const modeRef = useRef(mode);
  useEffect(() => {
    onDragRef.current = onDrag;
    modeRef.current = mode;
  }, [onDrag, mode]);

  // ── 初始化 / 销毁 ──
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const width = host.clientWidth || 200;
    const height = host.clientHeight || 200;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.touchAction = "none";
    renderer.domElement.style.cursor = "grab";
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();

    // 透视相机放在斜侧上方：图片呈斜视角，光源拖到背后时仍可见。
    // 取行业惯用的 3/4 视角（偏航约 32°、俯角约 24°），距离 3.57 保持与正面正交等大取景
    const camPersp = new THREE.PerspectiveCamera(40, width / height, 0.05, 100);
    camPersp.position.set(1.73, 1.45, 2.77);
    const aspect = width / height;
    const camOrtho = new THREE.OrthographicCamera(-HALF * aspect, HALF * aspect, HALF, -HALF, 0.05, 100);
    camOrtho.position.set(0, 0, 5);
    camPersp.lookAt(0, 0, 0);
    camOrtho.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));

    // 经纬线球体（赤道加亮；行业灯光 gizmo 常规样式，结点即方位预设的直观映射）
    const ringMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 });
    const equatorMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 });
    const circlePoints = (segments: number) =>
      Array.from({ length: segments + 1 }, (_, i) => {
        const a = (i / segments) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      });
    const circle = (radius: number, mat: THREE.LineBasicMaterial) => {
      const geo = new THREE.BufferGeometry().setFromPoints(circlePoints(64).map((p) => p.multiplyScalar(radius)));
      return new THREE.Line(geo, mat);
    };
    for (const lat of [-60, -30, 0, 30, 60]) {
      const phi = ((90 - lat) * Math.PI) / 180;
      const r = R * Math.sin(phi);
      const line = circle(r, lat === 0 ? equatorMat : ringMat);
      line.rotation.x = Math.PI / 2;
      line.position.y = -R * Math.cos(phi);
      scene.add(line);
    }
    for (const mer of [0, 30, 60, 90, 120, 150]) {
      const line = circle(R, ringMat);
      line.rotation.y = (mer * Math.PI) / 180;
      scene.add(line);
    }

    // 中心图片平面（加载后按贴图长宽比缩放；自发光保留底亮度，光源转到背面时不至于全黑）
    const imageMat = new THREE.MeshStandardMaterial({
      color: 0x808080,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
      emissive: 0xffffff,
      emissiveIntensity: 0,
    });
    const imagePlane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), imageMat);
    scene.add(imagePlane);

    // 方向渐变叠加：平面受平行光是均匀的，方向感靠这层 shader——
    // 亮侧朝光源投影方向（光色 × 强度），暗侧反向压黑，正前方（投影≈0）不叠加
    const overlayMat = new THREE.ShaderMaterial({
      uniforms: {
        uDir: { value: new THREE.Vector2(1, 0) },
        uColor: { value: new THREE.Color(0xffffff) },
        uStrength: { value: 0 },
      },
      vertexShader: `
        varying vec2 vPos;
        void main() {
          vPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec2 uDir;
        uniform vec3 uColor;
        uniform float uStrength;
        varying vec2 vPos;
        void main() {
          float t = clamp(dot(vPos / 0.55, uDir), -1.0, 1.0);
          if (t >= 0.0) gl_FragColor = vec4(uColor, t * uStrength);
          else gl_FragColor = vec4(0.0, 0.0, 0.0, -t * (1.0 - uStrength) * 0.7);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    const overlay = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), overlayMat);
    overlay.position.z = 0.006;
    overlay.renderOrder = 1;
    scene.add(overlay);

    // 光源：平行光表达「整个画面从某方向被打光」（无位置衰减，不会出现局部亮斑），
    // position 只承担方向语义：光从该球面点射向原点
    const pointLight = new THREE.DirectionalLight(0xffffff, 1.5);
    scene.add(pointLight);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    marker.renderOrder = 3;
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(0.095, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    halo.renderOrder = 2;
    scene.add(marker, halo);
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, R)]);
    const ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
    ray.renderOrder = 1;
    scene.add(ray);
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 1, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    cone.renderOrder = 1;
    scene.add(cone);

    refs.current = { renderer, scene, camPersp, camOrtho, pointLight, marker, halo, ray, cone, imageMat, overlay, texture: null };

    // 拖拽：pointer capture 住画布，delta 换算方位/仰角（悬浮面板内比 window 监听稳）
    const el = renderer.domElement;
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      dragRef.current = { on: true, lastX: e.clientX, lastY: e.clientY };
      el.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current.on) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      onDragRef.current(dx * 0.8, -dy * 0.8);
    };
    const onUp = (e: PointerEvent) => {
      dragRef.current.on = false;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);

    // 面板列高变化时画布自适应；透视/正交同步改宽高比，等大取景保持不变
    const ro = new ResizeObserver(() => {
      const r = refs.current;
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!r || !w || !h) return;
      r.renderer.setSize(w, h);
      const a = w / h;
      r.camPersp.aspect = a;
      r.camPersp.updateProjectionMatrix();
      r.camOrtho.left = -HALF * a;
      r.camOrtho.right = HALF * a;
      r.camOrtho.updateProjectionMatrix();
      r.renderer.render(r.scene, modeRef.current === "front" ? r.camOrtho : r.camPersp);
    });
    ro.observe(host);

    return () => {
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose();
      });
      renderer.dispose();
      refs.current?.texture?.dispose();
      host.removeChild(el);
      refs.current = null;
    };
  }, []);

  // ── 贴图 ──
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.setCrossOrigin("anonymous");
    loader.load(
      src,
      (tex) => {
        if (cancelled || !refs.current) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        r.texture?.dispose();
        r.texture = tex;
        r.imageMat.map = tex;
        r.imageMat.emissiveMap = tex;
        r.imageMat.emissive.set(0xffffff);
        r.imageMat.emissiveIntensity = 0.3;
        r.imageMat.color.set(0xffffff);
        r.imageMat.needsUpdate = true;
        const aspect = (tex.image as HTMLImageElement).width / (tex.image as HTMLImageElement).height || 1;
        const plane = r.scene.children.find((c) => c instanceof THREE.Mesh && c.geometry instanceof THREE.PlaneGeometry) as THREE.Mesh | undefined;
        if (plane) {
          const base = 1.1;
          const sx = aspect >= 1 ? base : base * aspect;
          const sy = aspect >= 1 ? base / aspect : base;
          plane.scale.set(sx, sy, 1);
          refs.current?.overlay.scale.set(sx, sy, 1);
        }
        r.renderer.render(r.scene, modeRef.current === "front" ? r.camOrtho : r.camPersp);
      },
      undefined,
      () => {
        // CORS 或加载失败：保留灰色占位面
      },
    );
    return () => {
      cancelled = true;
    };
  }, [src]);

  // ── 参数/视角变化：更新场景并渲染 ──
  useEffect(() => {
    const r = refs.current;
    if (!r) return;

    const c = new THREE.Color(color);
    const pos = lightPosition(azimuth, elevation);
    const inFront = pos.z >= 0;

    r.pointLight.color.copy(c);
    r.pointLight.intensity = 0.35 + (intensity / 100) * 2.4;
    r.pointLight.position.copy(pos);

    r.marker.material.color.copy(c);
    r.marker.material.opacity = inFront ? 1 : 0.45;
    r.marker.position.copy(pos);
    r.halo.material.color.copy(c);
    r.halo.material.opacity = inFront ? 0.22 : 0.08;
    r.halo.position.copy(pos);

    r.ray.material.color.copy(c);
    r.ray.material.opacity = inFront ? 0.55 : 0.25;
    r.ray.geometry.setFromPoints([new THREE.Vector3(), pos]);

    // 方向渐变：投影方向（x 右 / y 上），幅度随强度；光源在正前方时投影≈0，不叠加
    const proj = new THREE.Vector2(
      Math.cos((elevation * Math.PI) / 180) * Math.sin((azimuth * Math.PI) / 180),
      Math.sin((elevation * Math.PI) / 180),
    );
    const projLen = proj.length();
    if (projLen > 1e-4) proj.divideScalar(projLen);
    else proj.set(1, 0);
    r.overlay.material.uniforms.uDir.value.copy(proj);
    r.overlay.material.uniforms.uColor.value.copy(c);
    r.overlay.material.uniforms.uStrength.value = (intensity / 100) * 0.85 * Math.min(projLen * 4, 1);

    // 光锥：锥尖在光源，开口朝向图片
    const dist = pos.length();
    const dir = pos.clone().negate().normalize();
    r.cone.material.color.copy(c);
    r.cone.material.opacity = inFront ? 0.16 : 0.06;
    r.cone.scale.set(1, Math.max(dist - 0.1, 0.05), 1);
    r.cone.position.copy(pos.clone().add(dir.clone().multiplyScalar((dist - 0.1) / 2)));
    r.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.negate());

    r.renderer.render(r.scene, mode === "front" ? r.camOrtho : r.camPersp);
  }, [color, intensity, azimuth, elevation, mode]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full rounded-lg"
      style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}
    />
  );
}
