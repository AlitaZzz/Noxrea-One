/**
 * 3D 导演台全屏浮层的布局外壳。
 * 组合顶部信息栏、左侧大纲、中部三维视口（动态导入禁用 SSR）、
 * 右侧检视器 / 场景面板与底部工具坞，自身不含三维逻辑。
 */
"use client";

import dynamic from "next/dynamic";
import { useTranslation } from "react-i18next";

import { CloseOutlined } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { LayerContext } from "@/components/ui/modal/layer-context";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import Dock from "@/features/director/components/Dock";
import Inspector from "@/features/director/components/Inspector";
import Outliner from "@/features/director/components/Outliner";
import ScenePanel from "@/features/director/components/ScenePanel";
import { useDirectorStore } from "@/features/director/director-store";

function ViewportLoading() {
  const { t } = useTranslation();
  return <div className="flex items-center justify-center h-full text-white/50 text-sm">{t("director.loadingViewport")}</div>;
}

const DirectorViewport = dynamic(() => import("@/features/director/components/DirectorViewport"), {
  ssr: false,
  loading: () => <ViewportLoading />,
});

interface Props {
  onClose: () => void;
}

const DIRECTOR_LAYER_Z_INDEX = 100;

export default function DirectorOverlay({ onClose }: Props) {
  const { t } = useTranslation();
  const runtime = useDirectorStore((s) => s.runtime);
  const selectedId = useDirectorStore((s) => s.selectedId);
  const transformMode = useDirectorStore((s) => s.transformMode);
  const cameraView = useDirectorStore((s) => s.cameraView);
  const entities = useDirectorStore((s) => s.entities);
  const entityName = entities.find((e) => e.id === selectedId)?.name || "";

  const tfLabel = { translate: t("director.tf.move"), rotate: t("director.tf.rotate"), scale: t("director.tf.scale") }[transformMode] || "";

  return (
    <LayerContext.Provider value={{ overlayRoot: null, depth: 1, zIndex: DIRECTOR_LAYER_Z_INDEX }}>
      <div id="director-page" className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground text-[13px]" style={{ zIndex: DIRECTOR_LAYER_Z_INDEX }}>
        {/* Header — 56px, panel bg */}
        <header className="relative z-20 flex h-14 shrink-0 items-center border-b border-border bg-card px-5">
          {/* Logo + info */}
          <div className="flex items-center gap-3">
            <span className="font-semibold text-[17px] tracking-wide">{t("director.title")}</span>
            <span className="text-[13px] text-muted-foreground">
              {t("director.itemCount", { count: entities.length })}{selectedId ? ` · ${t("director.selectedLabel", { name: entityName })}` : ""} {tfLabel && `· ${tfLabel}`}
            </span>
          </div>

          {/* 视角切换标签(居中) */}
          <div className="absolute left-1/2 -translate-x-1/2">
            <Tabs
              value={cameraView ? "camera" : "director"}
              onValueChange={(value) => runtime?.setCameraView(value === "camera")}
            >
              <TabsList>
                <TabsTrigger
                  value="director"
                  className="px-5"
                >
                  {t("director.directorView")}
                </TabsTrigger>
                <TabsTrigger
                  value="camera"
                  className="px-5"
                >
                  {t("director.cameraView")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {/* 关闭按钮 */}
          <div className="ml-auto flex items-center">
            <Button variant="ghost" size="icon-sm" aria-label={t("common.close")} onClick={() => {
              const ds = useDirectorStore.getState();
              const nodeId = ds.openingNodeId;
              if (ds.runtime && nodeId) {
                const state = ds.runtime.captureState();
                if (state) {
                  useCanvasStore.getState().updateNodeData(nodeId, { directorState: state });
                }
              }
              ds.reset();
              onClose();
            }} className="text-muted-foreground hover:bg-muted hover:text-foreground">
              <CloseOutlined style={{ fontSize: 16 }} />
            </Button>
          </div>
        </header>

        {/* 主体 */}
        <main className="flex flex-1 min-h-0">
          {/* 左:场景清单 — 232px, panel bg */}
          <aside className="w-[232px] shrink-0 overflow-hidden border-r border-border bg-card px-3.5 py-[18px]">
            <h3 className="mb-[14px] text-sm font-semibold text-foreground">{t("director.scene")}</h3>
            <Outliner />
          </aside>

          {/* 中:3D 视口 */}
          <div className="flex-1 relative min-w-0 bg-black">
            <DirectorViewport />
          </div>

          {/* 右:面板 — 290px, panel bg, no padding(由内部组件自行处理) */}
          <aside className="relative z-10 w-[290px] shrink-0 overflow-auto border-l border-border bg-card">
            {selectedId ? <Inspector /> : <ScenePanel />}
          </aside>
        </main>

        {/* 底部工具坞(绝对定位浮在视口底部) */}
        <Dock />
      </div>
    </LayerContext.Provider>
  );
}
