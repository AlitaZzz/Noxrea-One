import { BorderInnerOutlined, CameraOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { MenuDivider, MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useViewport } from "@xyflow/react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

import WheelGuard from "@/components/ui/WheelGuard";
import { NODE_TITLE_HEIGHT } from "@/lib/constants";
import { AspectRatioIcon } from "@/components/ui/icons/canvas/AspectRatioIcon";
import { Grid4Icon } from "@/components/ui/icons/canvas/Grid4Icon";
import { Grid8Icon } from "@/components/ui/icons/canvas/Grid8Icon";
import { Grid12Icon } from "@/components/ui/icons/canvas/Grid12Icon";
import { computeDerivedGrid, gridPositionAt, uploadAndAddNode } from "@/lib/utils/image-utils";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

interface Props {
  src: string;
  sourceId: string;
  onClose: () => void;
}

// 截图输出比例：默认(原始 2:1)、16:9、9:16、21:9
type AspectKey = "original" | "16:9" | "9:16" | "21:9";
const ASPECT_RATIOS: Record<Exclude<AspectKey, "original">, number> = {
  "16:9": 16 / 9,
  "9:16": 9 / 16,
  "21:9": 21 / 9,
};

// 多视角截图数量：4 / 8 / 12，对应 90° / 45° / 30° 等分 360°
type ViewCount = 4 | 8 | 12;

export default function PanoramaPanel({ src, sourceId, onClose }: Props) {
  const { t } = useTranslation();
  const { zoom } = useViewport();

  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [loading, setLoading] = useState(false);
  // 多视角截图加载标记
  const [multiLoading, setMultiLoading] = useState(false);
  // 截图输出比例
  const [aspect, setAspect] = useState<AspectKey>("original");
  // 比例菜单开关
  const [aspectOpen, setAspectOpen] = useState(false);
  // 三分构图线开关（默认不显示）
  const [showGrid, setShowGrid] = useState(false);
  // 容器尺寸，用于计算取景框覆盖层
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  // 监听容器尺寸变化，保持取景框与画布同步
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const update = () => setContainerSize({ w: el.offsetWidth, h: el.offsetHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 取景框：垂直取满容器，宽度按所选比例放大缩小，水平居中（21:9 会超出两侧，由 overflow hidden 裁剪）
  const frame = useMemo(() => {
    if (aspect === "original") return null;
    const ratio = ASPECT_RATIOS[aspect];
    const { w, h } = containerSize;
    if (!w || !h) return null;
    const fh = h;
    const fw = h * ratio;
    return {
      left: (w - fw) / 2,
      top: (h - fh) / 2,
      width: fw,
      height: fh,
    };
  }, [aspect, containerSize]);

  useEffect(() => {
    if (mountRef.current && !viewerRef.current) {
      viewerRef.current = new Viewer({
        container: mountRef.current,
        panorama: src,
        defaultZoomLvl: 30,
        navbar: [],
        // 彻底隐藏空 navbar 容器，避免底部残留灰色底栏
        caption: null,
        // 保留 WebGL 绘制缓冲，便于截图时读取画布像素
        rendererParameters: { preserveDrawingBuffer: true },
      });
      // 隐藏 navbar 容器本身（navbar 设为空数组后仍会渲染一个空底栏）
      const navbarEl = mountRef.current.querySelector(".psv-navbar");
      if (navbarEl) (navbarEl as HTMLElement).style.display = "none";
    }
    return () => {
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [src]);

  // 截图目标尺寸上限：按原始分辨率输出，但避免超大全景图导致内存峰值过高
  const MAX_SCREENSHOT_SIZE = 4096;

  // 截图回调：用于异常时恢复被临时移出视口/改尺寸的容器
  const restoreRef = useRef<(() => void) | null>(null);

  // 截取当前全景视角，新建图片节点（逻辑与裁剪确认一致）
  const handleScreenshot = useCallback(async () => {
    if (loading || !viewerRef.current) return;
    setLoading(true);
    try {
      const viewer = viewerRef.current;
      const canvas = mountRef.current?.querySelector("canvas");
      if (!canvas) throw new Error("Panorama canvas not found");

      // 加载原始全景图，获取其自然分辨率
      const img = new Image();
      img.src = src;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load panorama"));
      });

      // 确定输出尺寸：默认按原始 2:1 全幅；选择比例时保持垂直视场不变，
      // 高度取原始高度，宽度按比例换算。均带上限避免超大图内存峰值过高。
      let targetW: number;
      let targetH: number;
      if (aspect === "original") {
        targetW = img.naturalWidth;
        targetH = img.naturalHeight;
      } else {
        targetH = img.naturalHeight;
        targetW = Math.round(targetH * ASPECT_RATIOS[aspect]);
      }
      const scale = Math.min(1, MAX_SCREENSHOT_SIZE / Math.max(targetW, targetH));
      targetW = Math.round(targetW * scale);
      targetH = Math.round(targetH * scale);

      // 记录原始容器样式，并把容器移出视口，避免 resize 引起 modal 布局闪动
      const mount = mountRef.current!;
      const origSize = { width: `${mount.offsetWidth}px`, height: `${mount.offsetHeight}px` };
      const prevPos = mount.style.position;
      const prevLeft = mount.style.left;
      const prevTop = mount.style.top;

      const restore = () => {
        mount.style.position = prevPos;
        mount.style.left = prevLeft;
        mount.style.top = prevTop;
        viewer.resize(origSize);
        viewer.needsUpdate();
      };
      restoreRef.current = restore;

      mount.style.position = "fixed";
      mount.style.left = "-100000px";
      mount.style.top = "0";

      viewer.resize({ width: `${targetW}px`, height: `${targetH}px` });
      viewer.needsUpdate();
      // 等待一帧完成重绘，确保 canvas 已按目标尺寸重渲染
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
      );

      restore();
      restoreRef.current = null;

      await uploadAndAddNode(
        sourceId,
        blob,
        " (screenshot)",
        useCanvasStore.getState(),
        { naturalWidth: targetW, naturalHeight: targetH, source: "derived" },
        undefined,
        "derived",
      );
      // 截图成功后保持全景模式，不退出
    } catch (e) {
      console.error("Panorama screenshot failed:", e);
    } finally {
      restoreRef.current?.();
      restoreRef.current = null;
      setLoading(false);
    }
  }, [loading, sourceId, src, aspect]);

  // 多视角截图：按 viewCount 等分 360°，每个方向截一帧并生成为独立节点
  const handleMultiScreenshot = useCallback(async (count: ViewCount) => {
    if (multiLoading || !viewerRef.current) return;
    setMultiLoading(true);
    try {
      const viewer = viewerRef.current;
      const canvas = mountRef.current?.querySelector("canvas");
      if (!canvas) throw new Error("Panorama canvas not found");

      // 加载原始全景图，获取其自然分辨率
      const img = new Image();
      img.src = src;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to load panorama"));
      });

      // 单帧尺寸：默认 2:1 全幅；选择比例时高取原始高、宽按比例换算。均带上限。
      let frameW: number;
      let frameH: number;
      if (aspect === "original") {
        frameW = img.naturalWidth;
        frameH = img.naturalHeight;
      } else {
        frameH = img.naturalHeight;
        frameW = Math.round(frameH * ASPECT_RATIOS[aspect]);
      }
      const scale = Math.min(1, MAX_SCREENSHOT_SIZE / Math.max(frameW, frameH));
      frameW = Math.round(frameW * scale);
      frameH = Math.round(frameH * scale);

      // 记录原始容器样式与当前视角，结束后恢复
      const mount = mountRef.current!;
      const origSize = { width: `${mount.offsetWidth}px`, height: `${mount.offsetHeight}px` };
      const prevPos = mount.style.position;
      const prevLeft = mount.style.left;
      const prevTop = mount.style.top;
      const prevYaw = viewer.getPosition().yaw;
      const prevPitch = viewer.getPosition().pitch;

      const restore = () => {
        mount.style.position = prevPos;
        mount.style.left = prevLeft;
        mount.style.top = prevTop;
        viewer.rotate({ yaw: prevYaw, pitch: prevPitch });
        viewer.resize(origSize);
        viewer.needsUpdate();
      };
      restoreRef.current = restore;

      // 等分 360°，生成 n 个采样方向（从正前方 0° 顺时针取角）
      const COUNT = count;
      const STEP_DEG = 360 / COUNT;
      const VIEWS = Array.from({ length: COUNT }, (_, i) => {
        const yaw = i * STEP_DEG;
        // 4 视角用方位词，其余用角度标注
        const label =
          COUNT === 4
            ? { 0: t("panorama.viewFront"), 90: t("panorama.viewRight"), 180: t("panorama.viewBack"), 270: t("panorama.viewLeft") }[yaw] ?? `${yaw}°`
            : `${yaw}°`;
        return { yaw, label };
      });

      // 以源节点为基准，用统一派生网格布局错开摆放（显示尺寸 + 间隙），避免新节点互相遮挡
      const store = useCanvasStore.getState();
      const origNode = store.nodes.find((n) => n.id === sourceId);
      // 多视角按接近方形的宫格排布：4 视角用 2×2，8/12 视角用多行 4 列，避免横着平铺
      const COLS = COUNT <= 4 ? 2 : 4;
      const layout = computeDerivedGrid(origNode, frameW, frameH, COLS);

      const currentPitch = viewer.getPosition().pitch;
      for (let i = 0; i < VIEWS.length; i++) {
        const view = VIEWS[i];
        viewer.rotate({ yaw: view.yaw, pitch: currentPitch });
        mount.style.position = "fixed";
        mount.style.left = "-100000px";
        mount.style.top = "0";
        viewer.resize({ width: `${frameW}px`, height: `${frameH}px` });
        viewer.needsUpdate();
        // 等待两帧完成重绘
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png"),
        );

        await uploadAndAddNode(
          sourceId,
          blob,
          ` (${view.label})`,
          useCanvasStore.getState(),
          { naturalWidth: frameW, naturalHeight: frameH, source: "derived" },
          gridPositionAt(layout, i),
          "derived",
        );
      }

      restore();
      restoreRef.current = null;
      // 全部节点生成后保持全景模式，不退出
    } catch (e) {
      console.error("Panorama multi-view screenshot failed:", e);
    } finally {
      restoreRef.current?.();
      restoreRef.current = null;
      setMultiLoading(false);
    }
  }, [multiLoading, sourceId, src, aspect, t]);

  // 重置视角：回到初始的 FOV/缩放与旋转（v5 无 setDefault，需手动恢复初始 yaw/pitch/zoom）
  const handleReset = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    viewer.rotate({ yaw: 0, pitch: 0 });
    viewer.zoom(30);
  }, []);

  return (
    <>
      {/* 全景专属工具栏：样式/位置完全参考裁剪、标注 */}
      <WheelGuard
        className="canvas-toolbar nodrag absolute left-1/2 flex items-center gap-1 rounded-xl z-40 pointer-events-auto"
        style={{
          height: 50,
          padding: "6px 10px",
          whiteSpace: "nowrap",
          bottom: `calc(100% + ${NODE_TITLE_HEIGHT + 8 / zoom}px)`,
          transform: `translateX(-50%) scale(${1 / zoom})`,
          transformOrigin: "center bottom",
        }}
      >
        {/* 截图：截取当前视角并新建图片节点 */}
        <Tooltip title={t("panorama.screenshot")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8 }}
            icon={<CameraOutlined />}
            loading={loading}
            onClick={handleScreenshot}
          />
        </Tooltip>

        {/* 多视角截图：4/8/12 视角等分 360°，每个方向生成独立节点 */}
        <Tooltip title={t("panorama.view4")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8 }}
            icon={<Grid4Icon />}
            loading={multiLoading}
            onClick={() => handleMultiScreenshot(4)}
          />
        </Tooltip>
        <Tooltip title={t("panorama.view8")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8 }}
            icon={<Grid8Icon />}
            loading={multiLoading}
            onClick={() => handleMultiScreenshot(8)}
          />
        </Tooltip>
        <Tooltip title={t("panorama.view12")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8 }}
            icon={<Grid12Icon />}
            loading={multiLoading}
            onClick={() => handleMultiScreenshot(12)}
          />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 画面比例：选择截图输出比例，同时显示对应取景框 */}
        <MenuPopover
          open={aspectOpen}
          onOpenChange={setAspectOpen}
          placement="bottom"
          trigger={
            <Tooltip title={t("panorama.aspect")}>
              <Button type="text" size="middle" style={{ padding: 8 }} icon={<AspectRatioIcon />} disabled={loading} />
            </Tooltip>
          }
          content={
            <>
              <MenuItem selected={aspect === "original"} onClick={() => setAspect("original")}>
                {t("panorama.aspectOriginal")}
              </MenuItem>
              <MenuDivider />
              <MenuItem selected={aspect === "16:9"} onClick={() => setAspect("16:9")}>16:9</MenuItem>
              <MenuItem selected={aspect === "9:16"} onClick={() => setAspect("9:16")}>9:16</MenuItem>
              <MenuItem selected={aspect === "21:9"} onClick={() => setAspect("21:9")}>21:9</MenuItem>
            </>
          }
        />

        {/* 三分构图线开关 */}
        <Tooltip title={t("panorama.toggleGrid")}>
          <Button
            type="text"
            size="middle"
            style={{ padding: 8, ...(showGrid ? { background: "var(--canvas-bg-hover)", color: "#fff" } : {}) }}
            icon={<BorderInnerOutlined />}
            onClick={() => setShowGrid((v) => !v)}
          />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 重置视角，单独一组 */}
        <Tooltip title={t("panorama.reset")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<ReloadOutlined />} onClick={handleReset} />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

        {/* 退出全景（等价于裁剪的取消按钮） */}
        <Tooltip title={t("panorama.exit")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      </WheelGuard>

      {/* 全景画布：覆盖原图，z-30 蒙版 */}
      <div
        ref={mountRef}
        className="nodrag absolute inset-0 z-30 pointer-events-auto rounded-lg overflow-hidden"
        style={{ touchAction: "none" }}
      >
        {/* 取景框：按所选比例显示截图范围，非原始比例时叠加 */}
        {frame && (
          <div
            className="pointer-events-none absolute"
            style={{
              left: frame.left,
              top: frame.top,
              width: frame.width,
              height: frame.height,
              border: "1.5px dashed rgba(255,255,255,0.9)",
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.35)",
              zIndex: 5,
            }}
          />
        )}
        {/* 三分构图线：全屏覆盖，受开关控制（全景原始比例下也显示） */}
        {showGrid && (
          <div className="pointer-events-none absolute inset-0" style={{ zIndex: 6 }}>
            <div
              style={{
                position: "absolute",
                left: `${(1 / 3) * 100}%`,
                top: 0,
                width: 0,
                height: "100%",
                borderLeft: "1px solid rgba(255,255,255,0.45)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: `${(2 / 3) * 100}%`,
                top: 0,
                width: 0,
                height: "100%",
                borderLeft: "1px solid rgba(255,255,255,0.45)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: `${(1 / 3) * 100}%`,
                width: "100%",
                height: 0,
                borderTop: "1px solid rgba(255,255,255,0.45)",
              }}
            />
            <div
              style={{
                position: "absolute",
                left: 0,
                top: `${(2 / 3) * 100}%`,
                width: "100%",
                height: 0,
                borderTop: "1px solid rgba(255,255,255,0.45)",
              }}
            />
          </div>
        )}
      </div>
    </>
  );
}
