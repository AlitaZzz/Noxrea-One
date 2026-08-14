import { CameraOutlined, CloseOutlined, ReloadOutlined } from "@ant-design/icons";
import { useViewport } from "@xyflow/react";
import { Button, Tooltip } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";
import { Viewer } from "@photo-sphere-viewer/core";
import "@photo-sphere-viewer/core/index.css";

import WheelGuard from "@/components/ui/WheelGuard";
import { uploadAndAddNode } from "@/lib/utils/image-utils";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

interface Props {
  src: string;
  sourceId: string;
  onClose: () => void;
}

export default function PanoramaPanel({ src, sourceId, onClose }: Props) {
  const { t } = useTranslation();
  const { zoom } = useViewport();

  const mountRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const [loading, setLoading] = useState(false);

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

      // 以原始分辨率渲染（带上限），保证截图清晰
      const scale = Math.min(1, MAX_SCREENSHOT_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
      const targetW = Math.round(img.naturalWidth * scale);
      const targetH = Math.round(img.naturalHeight * scale);

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
  }, [loading, sourceId, src]);

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
          bottom: "calc(100% + 8px)",
          transform: `translateX(-50%) scale(${1 / zoom})`,
          transformOrigin: "center bottom",
        }}
      >
        {/* 重置视角 */}
        <Tooltip title={t("panorama.reset")}>
          <Button type="text" size="middle" style={{ padding: 8 }} icon={<ReloadOutlined />} onClick={handleReset} />
        </Tooltip>

        <div className="w-px h-5 mx-1" style={{ background: "var(--canvas-border)" }} />

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
      />
    </>
  );
}
