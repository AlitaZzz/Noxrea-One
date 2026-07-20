"use client";

import dynamic from "next/dynamic";
import { CloseOutlined } from "@ant-design/icons";
import { useDirectorStore } from "@/stores/director-store";
import { useCanvasStore } from "@/stores/canvas-store";
import Outliner from "@/components/director/Outliner";
import Inspector from "@/components/director/Inspector";
import ScenePanel from "@/components/director/ScenePanel";
import Dock from "@/components/director/Dock";

const DirectorViewport = dynamic(() => import("@/components/director/DirectorViewport"), {
  ssr: false,
  loading: () => <div className="flex items-center justify-center h-full text-white/50 text-sm">加载 3D 视口...</div>,
});

interface Props {
  onClose: () => void;
}

export default function DirectorOverlay({ onClose }: Props) {
  const runtime = useDirectorStore((s) => s.runtime);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const transformMode = useDirectorStore((s) => s.transformMode);
  const cameraView = useDirectorStore((s) => s.cameraView);
  const entities = useDirectorStore((s) => s.entities);
  const entityName = entities.find((e) => e.id === selectedId)?.name || "";

  const tfLabel = { translate: "V移动", rotate: "R旋转", scale: "S缩放" }[transformMode] || "";

  return (
    <div id="director-page" className="fixed inset-0 z-[100] flex flex-col bg-[var(--dir-bg)] text-white overflow-hidden"
      style={{ fontFamily: "-apple-system,BlinkMacSystemFont,PingFang SC,Microsoft YaHei,sans-serif", fontSize: 13 }}>
      {/* Header — 56px, panel bg */}
      <header className="flex items-center shrink-0 px-5 border-b border-[var(--dir-line)] relative z-20"
        style={{ height: 56, background: "var(--dir-panel)" }}>
        {/* Logo + info */}
        <div className="flex items-center gap-3">
          <span className="font-semibold text-[17px] tracking-wide">3D 导演台</span>
          <span className="text-[13px] text-white/30">
            {entities.length} 项{selectedId ? ` · 选中: ${entityName}` : ""} {tfLabel && `· ${tfLabel}`}
          </span>
        </div>

        {/* 视角切换标签(居中) */}
        <div className="absolute left-1/2 -translate-x-1/2 flex rounded-[10px] p-[3px]" style={{ background: "var(--dir-panel2)" }}>
          <button onClick={() => runtime?.setCameraView(false)} className="dir-viewtab" data-active={!cameraView}>
            导演视角
          </button>
          <button onClick={() => runtime?.setCameraView(true)} className="dir-viewtab" data-active={cameraView}>
            机位视角
          </button>
        </div>

        {/* 关闭按钮 */}
        <div className="ml-auto flex items-center">
          <button onClick={() => {
            const ds = useDirectorStore.getState();
            const nodeId = ds.openingNodeId;
            if (ds.runtime && nodeId) {
              const state = ds.runtime.captureState();
              if (state) {
                useCanvasStore.getState().updateNodeData(nodeId, { directorState: state } as any);
              }
            }
            ds.reset();
            onClose();
          }} className="cursor-pointer flex items-center justify-center w-8 h-8 rounded-lg text-white/45 hover:text-white hover:bg-white/10 transition-colors">
            <CloseOutlined style={{ fontSize: 16 }} />
          </button>
        </div>
      </header>

      {/* 主体 */}
      <main className="flex flex-1 min-h-0">
        {/* 左:场景清单 — 232px, panel bg */}
        <aside className="w-[232px] shrink-0 border-r border-[var(--dir-line)] overflow-hidden"
          style={{ background: "var(--dir-panel)", padding: "18px 14px" }}>
          <h3 className="text-sm font-semibold text-white mb-[14px]">场景</h3>
          <Outliner />
        </aside>

        {/* 中:3D 视口 */}
        <div className="flex-1 relative min-w-0 bg-black">
          <DirectorViewport />
        </div>

        {/* 右:面板 — 290px, panel bg, no padding(由内部组件自行处理) */}
        <aside className="w-[290px] shrink-0 border-l border-[var(--dir-line)] overflow-auto relative z-10"
          style={{ background: "var(--dir-panel)" }}>
          {selectedId ? <Inspector /> : <ScenePanel />}
        </aside>
      </main>

      {/* 底部工具坞(绝对定位浮在视口底部) */}
      <Dock />
    </div>
  );
}
