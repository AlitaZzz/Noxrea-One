/**
 * 轨道球三维预览（打光 / 多角度两面板共用）。
 * 经纬线球体随方位/仰角刚体旋转（球随标记一起动），中心图片平面，
 * 拖拽改方位/仰角；透视 / 正面双相机，等大取景。
 * variant = "light"：标记为光源（光晕/连线/光锥 + 图片方向受光叠加），颜色/亮度实时映射；
 * variant = "camera"：标记为相机模型（朝向球心），zoomScale 缩放中心图片表达景别。
 * 场景静态，仅在 props 变化时渲染，卸载时完整释放 WebGL 资源。
 */
"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

export type OrbitViewMode = "perspective" | "front";

interface Props {
  src: string;
  azimuth: number; // 0-359
  elevation: number; // -90~90
  mode: OrbitViewMode;
  onDrag: (dAzimuth: number, dElevation: number) => void;
  variant: "light" | "camera";
  /** light：光源颜色（hex） */
  color?: string;
  /** light：亮度 0-100 */
  intensity?: number;
  /** camera：中心图片缩放（景别近/中/远） */
  zoomScale?: number;
}

const R = 1;
// 正交视锥半高：透视相机（fov 40，距离 3.57）的垂直半高与之相等，保证双视角球体等大
const HALF = 1.3;

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camPersp: THREE.PerspectiveCamera;
  camOrtho: THREE.OrthographicCamera;
  /** 经纬线球体组：随标记方向刚体旋转（球随标记动） */
  sphere: THREE.Group;
  imagePlane: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  imageMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  /** 贴图长宽比适配系数（几何体固定 1.1，缩放承担比例），zoom 在此之上叠加 */
  baseScale: { x: number; y: number };
  zoom: number;
  // light 专属
  pointLight: THREE.DirectionalLight | null;
  marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  halo: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
  ray: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null;
  overlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null;
  // camera 专属
  cameraRig: THREE.Group | null;
  camRay: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null;
  texture: THREE.Texture | null;
}

// 方位角/仰角 → 场景坐标（相机在 +Z，az=0 面向前方，az=90 指向右侧，Y 向上）
function orbitPosition(azDeg: number, elDeg: number): THREE.Vector3 {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new THREE.Vector3(
    R * Math.cos(el) * Math.sin(az),
    R * Math.sin(el),
    R * Math.cos(el) * Math.cos(az),
  );
}

export default function OrbitScene3D({ src, color, intensity, azimuth, elevation, mode, onDrag, variant, zoomScale }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const refs = useRef<SceneRefs | null>(null);
  const dragRef = useRef({ on: false, lastX: 0, lastY: 0 });
  const onDragRef = useRef(onDrag);
  const modeRef = useRef(mode);
  useEffect(() => { onDragRef.current = onDrag; }, [onDrag]);
  useEffect(() => { modeRef.current = mode; }, [mode]);

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

    // 透视相机放在斜侧上方：图片呈斜视角，标记转到背后时仍可见。
    // 取行业惯用的 3/4 视角（偏航约 32°、俯角约 24°），距离 3.57 保持与正面正交等大取景
    const camPersp = new THREE.PerspectiveCamera(40, width / height, 0.05, 100);
    camPersp.position.set(1.73, 1.45, 2.77);
    const aspect = width / height;
    const camOrtho = new THREE.OrthographicCamera(-HALF * aspect, HALF * aspect, HALF, -HALF, 0.05, 100);
    camOrtho.position.set(0, 0, 5);
    camPersp.lookAt(0, 0, 0);
    camOrtho.lookAt(0, 0, 0);

    // 经纬线球体（赤道加亮；行业 gizmo 常规样式，结点即方位预设的直观映射）。
    // 收进一个 Group：参数变化时整体刚体旋转，球随标记一起动
    const sphere = new THREE.Group();
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
      sphere.add(line);
    }
    for (const mer of [0, 30, 60, 90, 120, 150]) {
      const line = circle(R, ringMat);
      line.rotation.y = (mer * Math.PI) / 180;
      sphere.add(line);
    }
    scene.add(sphere);

    // 中心图片平面（加载后按贴图长宽比缩放）
    const isLight = variant === "light";
    // 打光：standard 材质受平行光 + 自发光保留底亮度（光源转到背面时不至于全黑）；
    // 多角度：basic 材质恒定全亮，图片只承担「被观察对象」语义
    const imageMat: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial = isLight
      ? new THREE.MeshStandardMaterial({
          color: 0x808080,
          roughness: 0.85,
          metalness: 0,
          side: THREE.DoubleSide,
          emissive: 0xffffff,
          emissiveIntensity: 0,
        })
      : new THREE.MeshBasicMaterial({ color: 0x808080, side: THREE.DoubleSide });
    const imagePlane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), imageMat);
    scene.add(imagePlane);

    let pointLight: THREE.DirectionalLight | null = null;
    let marker: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
    let halo: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
    let ray: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;
    let cone: THREE.Mesh<THREE.ConeGeometry, THREE.MeshBasicMaterial> | null = null;
    let overlay: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> | null = null;
    let cameraRig: THREE.Group | null = null;
    let camRay: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> | null = null;

    if (isLight) {
      scene.add(new THREE.AmbientLight(0xffffff, 0.55));

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
      overlay = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), overlayMat);
      overlay.position.z = 0.006;
      overlay.renderOrder = 1;
      scene.add(overlay);

      // 光源：平行光表达「整个画面从某方向被打光」（无位置衰减，不会出现局部亮斑），
      // position 只承担方向语义：光从该球面点射向原点
      pointLight = new THREE.DirectionalLight(0xffffff, 1.5);
      scene.add(pointLight);
      marker = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
      marker.renderOrder = 3;
      halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.095, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false }),
      );
      halo.renderOrder = 2;
      scene.add(marker, halo);
      const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, R)]);
      ray = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 }));
      ray.renderOrder = 1;
      scene.add(ray);
      cone = new THREE.Mesh(
        new THREE.ConeGeometry(0.17, 1, 24, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.14, depthWrite: false }),
      );
      cone.renderOrder = 1;
      scene.add(cone);
    } else {
      // 相机模型：机身 + 镜筒 + 镜片，+Z 朝向球心（lookAt 对非相机对象是 +Z 指向目标）。
      // 整组放大 1.6 倍——光球标记只有 0.045 半径的实心球，相机由多个部件拼成，等比偏小
      cameraRig = new THREE.Group();
      cameraRig.scale.setScalar(1.6);
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.075, 0.05), new THREE.MeshBasicMaterial({ color: 0x2e2e2e, transparent: true }));
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.05, 24), new THREE.MeshBasicMaterial({ color: 0x555555, transparent: true }));
      lens.rotation.x = Math.PI / 2;
      lens.position.z = 0.045;
      const glass = new THREE.Mesh(new THREE.CircleGeometry(0.022, 24), new THREE.MeshBasicMaterial({ color: 0x2299dd, transparent: true }));
      glass.position.z = 0.071;
      cameraRig.add(body, lens, glass);
      scene.add(cameraRig);
      // 相机→画面连线（与旧 CSS 版同款蓝色）
      const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, R)]);
      camRay = new THREE.Line(rayGeo, new THREE.LineBasicMaterial({ color: 0x2299dd, transparent: true, opacity: 0.4 }));
      scene.add(camRay);
    }

    refs.current = {
      renderer, scene, camPersp, camOrtho, sphere,
      imagePlane, imageMat, baseScale: { x: 1, y: 1 }, zoom: 1,
      pointLight, marker, halo, ray, cone, overlay,
      cameraRig, camRay, texture: null,
    };

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
  }, [variant]);

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
        if (r.imageMat instanceof THREE.MeshStandardMaterial) {
          r.imageMat.emissiveMap = tex;
          r.imageMat.emissive.set(0xffffff);
          r.imageMat.emissiveIntensity = 0.3;
        }
        r.imageMat.color.set(0xffffff);
        r.imageMat.needsUpdate = true;
        const aspect = (tex.image as HTMLImageElement).width / (tex.image as HTMLImageElement).height || 1;
        r.baseScale = {
          x: aspect >= 1 ? 1 : aspect,
          y: aspect >= 1 ? 1 / aspect : 1,
        };
        r.imagePlane.scale.set(r.baseScale.x * r.zoom, r.baseScale.y * r.zoom, 1);
        r.overlay?.scale.set(r.baseScale.x, r.baseScale.y, 1);
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

    const pos = orbitPosition(azimuth, elevation);
    const inFront = pos.z >= 0;

    // 球体刚体旋转：R = Ry(az)·Rx(-el) 把球面正前方 (0,0,R) 恰好带到标记位置——
    // 球随标记动（YXZ 欧拉序即 Ry·Rx）
    r.sphere.rotation.order = "YXZ";
    r.sphere.rotation.set(
      (-elevation * Math.PI) / 180,
      (azimuth * Math.PI) / 180,
      0,
    );

    if (variant === "light" && r.pointLight && r.marker && r.halo && r.ray && r.cone && r.overlay) {
      const c = new THREE.Color(color ?? "#FFFFFF");
      const inten = intensity ?? 50;
      r.pointLight.color.copy(c);
      r.pointLight.intensity = 0.35 + (inten / 100) * 2.4;
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
      r.overlay.material.uniforms.uStrength.value = (inten / 100) * 0.85 * Math.min(projLen * 4, 1);

      // 光锥：锥尖在光源，开口朝向图片
      const dist = pos.length();
      const dir = pos.clone().negate().normalize();
      r.cone.material.color.copy(c);
      r.cone.material.opacity = inFront ? 0.16 : 0.06;
      r.cone.scale.set(1, Math.max(dist - 0.1, 0.05), 1);
      r.cone.position.copy(pos.clone().add(dir.clone().multiplyScalar((dist - 0.1) / 2)));
      r.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.negate());
    }

    if (variant === "camera" && r.cameraRig && r.camRay) {
      // 相机标记：贴着球面、镜头朝向球心；转到球背时压暗提示不可达
      r.cameraRig.position.copy(pos);
      r.cameraRig.lookAt(0, 0, 0);
      r.cameraRig.traverse((obj) => {
        const mat = (obj as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
        if (mat) mat.opacity = inFront ? 1 : 0.45;
      });

      // 相机→画面连线随相机位置更新，转背同步压暗
      r.camRay.geometry.setFromPoints([new THREE.Vector3(), pos]);
      r.camRay.material.opacity = inFront ? 0.4 : 0.18;

      // 景别缩放中心图片
      r.zoom = zoomScale ?? 1;
      r.imagePlane.scale.set(r.baseScale.x * r.zoom, r.baseScale.y * r.zoom, 1);
    }

    r.renderer.render(r.scene, mode === "front" ? r.camOrtho : r.camPersp);
  }, [color, intensity, azimuth, elevation, mode, variant, zoomScale]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full rounded-lg"
      style={{ background: "var(--canvas-bg)", border: "1px solid var(--canvas-border)" }}
    />
  );
}
