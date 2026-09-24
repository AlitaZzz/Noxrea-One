/**
 * 多视角（相机机位）编辑器（悬浮于节点下方，布局与打光面板同构）。
 * 左列 3D 轨道球（共享 OrbitScene3D，相机标记 + 景别缩放），右列方位角 / 俯仰 / 景别 + 预设机位。
 * 点生成后参数交由后端 angle 模板插值成提示词，派生图片节点预填（链路同打光面板）。
 */
"use client";

import { App, Button, Slider } from "antd";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { MultiAngleIcon } from "@/components/ui/icons/canvas/MultiAngleIcon";
import { getPromptTemplate } from "@/features/canvas/api/canvas-api";
import { createImageNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { spawnPromptDerivedNode } from "@/features/canvas/upload";

import OrbitScene3D, { type OrbitViewMode } from "./OrbitScene3D";
import PrimaryActionButton from "./PrimaryActionButton";
import useEscapeToClose from "./use-escape-to-close";

interface Props {
  src: string;
  nodeId: string;
  onClose: () => void;
}

interface Preset {
  key: string;
  labelKey: string;
  azimuth: number;
  elevation: number;
  zoom: number;
}

const PRESETS: Preset[] = [
  { key: "fisheye", labelKey: "angle.fisheye", azimuth: 0, elevation: 0, zoom: 0 },
  { key: "tilt", labelKey: "angle.tilt", azimuth: 45, elevation: 35, zoom: 1 },
  { key: "frontTop", labelKey: "angle.frontTop", azimuth: 0, elevation: 55, zoom: 1 },
  { key: "frontBottom", labelKey: "angle.frontBottom", azimuth: 0, elevation: -55, zoom: 1 },
  { key: "panoTop", labelKey: "angle.panoTop", azimuth: 180, elevation: 85, zoom: 2 },
  { key: "back", labelKey: "angle.back", azimuth: 180, elevation: 0, zoom: 1 },
];

const ZOOM_LABELS = ["angle.zoomNear", "angle.zoomMid", "angle.zoomFar"];

const VIEW_OPTIONS: { key: OrbitViewMode; labelKey: string }[] = [
  { key: "perspective", labelKey: "angle.view.perspective" },
  { key: "front", labelKey: "angle.view.front" },
];

const DEFAULT_AZIMUTH = 0;
const DEFAULT_ELEVATION = 0;
const DEFAULT_ZOOM = 1;

export default function MultiAngleEditor({ src, nodeId, onClose }: Props) {
  const { t } = useTranslation();
  const { notification } = App.useApp();

  const [azimuth, setAzimuth] = useState(DEFAULT_AZIMUTH);
  const [elevation, setElevation] = useState(DEFAULT_ELEVATION);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [viewMode, setViewMode] = useState<OrbitViewMode>("perspective");
  const [submitting, setSubmitting] = useState(false);

  // Esc 关闭：与打光面板同一退出路径（输入框焦点 / 弹窗层守卫由钩子统一处理）
  useEscapeToClose(onClose);

  // ── Handlers ──
  // 拖拽球体改方位/仰角（数值取整，与滑杆/输入框回写保持同一精度）
  const handleSceneDrag = useCallback((dAzimuth: number, dElevation: number) => {
    setAzimuth((prev) => {
      let az = (Math.round(prev) + Math.round(dAzimuth)) % 360;
      if (az < 0) az += 360;
      return az;
    });
    setElevation((prev) => Math.max(-90, Math.min(90, Math.round(prev) + Math.round(dElevation))));
  }, []);

  const handlePreset = (p: Preset) => {
    setAzimuth(p.azimuth);
    setElevation(p.elevation);
    setZoom(p.zoom);
  };
  const handleReset = () => {
    setAzimuth(DEFAULT_AZIMUTH);
    setElevation(DEFAULT_ELEVATION);
    setZoom(DEFAULT_ZOOM);
  };

  // 生成：参数交由后端 angle 模板插值成提示词，派生图片节点预填（链路同打光面板）
  const handleGenerate = useCallback(async () => {
    if (!src || submitting) return;
    setSubmitting(true);
    try {
      const template = await getPromptTemplate("angle", { azimuth, elevation, zoom });
      if (!template) {
        notification.error({ title: t("angle.generateFailed"), placement: "bottomRight" });
        return;
      }
      const node = spawnPromptDerivedNode(nodeId, template, createImageNode, useCanvasStore.getState());
      if (!node) return;
      markDirtyImmediate();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [src, nodeId, azimuth, elevation, zoom, submitting, notification, t, onClose]);

  // 预设高亮按当前数值反查（同打光面板的 activeDir）：手动改参一旦偏离即自动熄灭
  const activePreset = PRESETS.find(
    (p) => p.azimuth === azimuth && p.elevation === elevation && p.zoom === zoom,
  )?.key ?? null;

  // Zoom scales the center image
  const zoomScale = [1.6, 1.0, 0.65][zoom];

  // Elevation handle position in % of track（-90→0%、0→50%、90→100%），供中点填充段定位
  const elevationPct = ((elevation + 90) / 180) * 100;

  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto select-none flex flex-col gap-3 rounded-2xl p-3" style={{ width: 460 }}>
      {/* 标题栏（与打光面板同款） */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[13px]" style={{ color: "var(--canvas-text)" }}>
          <MultiAngleIcon className="h-4 w-4" />
          {t("angle.editorTitle")}
        </span>
        <Button
          type="text"
          aria-label="close"
          onClick={onClose}
          style={{ width: 24, height: 24, minWidth: 24, padding: 0 }}
          icon={<span style={{ color: "var(--canvas-text-dim)", fontSize: 12, lineHeight: 1 }}>✕</span>}
        />
      </div>
      <div className="h-px w-full" style={{ background: "var(--canvas-border)" }} />

      <div className="flex gap-3">
        {/* 左列：3D 轨道球（与打光面板同款：视角切换 + 场景铺满剩余高度） */}
        <div className="flex h-full w-[200px] shrink-0 flex-col gap-2">
          <div className="light-panel-view-toggle">
            {VIEW_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`light-panel-view-opt${viewMode === opt.key ? " active" : ""}`}
                onClick={() => setViewMode(opt.key)}
              >
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            <OrbitScene3D
              variant="camera"
              src={src}
              azimuth={azimuth}
              elevation={elevation}
              mode={viewMode}
              onDrag={handleSceneDrag}
              zoomScale={zoomScale}
            />
          </div>
        </div>

        {/* 右列：参数（控件与打光面板同款 h-9 组合框 / 分段切换 / 网格预设） */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* 方位角：滑杆 + 数值框联动 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.azimuth")}</span>
            <div className="flex h-9 w-full items-center gap-1.5 rounded-xl px-2" style={{ background: "var(--canvas-bg-hover)" }}>
              <Slider
                min={0}
                max={359}
                step={1}
                value={azimuth}
                onChange={(v) => setAzimuth(Number(v))}
                className="min-w-0 flex-1"
                style={{ margin: 0 }}
                tooltip={{ open: false }}
              />
              <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
              <input
                type="number"
                min={0}
                max={359}
                step={1}
                value={azimuth}
                className="light-panel-pct-input shrink-0"
                // 输入中间态不钳位（与打光面板同款策略），失焦统一归一回写；
                // 空串必须跳过——Number("") 为 0，恰在合法区间内，会立即提交 0 锁死输入
                onChange={(e) => {
                  if (e.target.value.trim() === "") return;
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0 && v <= 359) setAzimuth(Math.round(v));
                }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v) ? Math.max(0, Math.min(359, Math.round(v))) : azimuth;
                  e.target.value = String(clamped);
                  setAzimuth(clamped);
                }}
              />
              <span className="shrink-0 text-xs" style={{ color: "var(--canvas-text-dim)" }}>°</span>
            </div>
          </div>

          {/* 俯仰角 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.elevation")}</span>
            <div className="flex h-9 w-full items-center gap-1.5 rounded-xl px-2" style={{ background: "var(--canvas-bg-hover)" }}>
              <div className="relative min-w-0 flex-1">
                {/* 双向轴：填充从中间 0° 出发指向手柄。antd 只会从最小值填充，
                    隐藏原生轨道填充，自绘一段 0 点→手柄的白条（层级在轨道上、手柄下） */}
                <div
                  className="pointer-events-none absolute h-1 -translate-y-1/2 rounded-full"
                  style={{
                    top: "50%",
                    left: `${Math.min(50, elevationPct)}%`,
                    width: `${Math.abs(elevationPct - 50)}%`,
                    background: "#fff",
                    zIndex: 1,
                  }}
                />
                <Slider
                  min={-90}
                  max={90}
                  step={1}
                  value={elevation}
                  onChange={(v) => setElevation(Number(v))}
                  className="relative"
                  style={{ margin: 0, width: "100%" }}
                  tooltip={{ open: false }}
                  styles={{ track: { background: "transparent" }, handle: { zIndex: 2 } }}
                />
              </div>
              <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
              <input
                type="number"
                min={-90}
                max={90}
                step={1}
                value={elevation}
                className="light-panel-pct-input shrink-0"
                onChange={(e) => {
                  if (e.target.value.trim() === "") return;
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= -90 && v <= 90) setElevation(Math.round(v));
                }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v) ? Math.max(-90, Math.min(90, Math.round(v))) : elevation;
                  e.target.value = String(clamped);
                  setElevation(clamped);
                }}
              />
              <span className="shrink-0 text-xs" style={{ color: "var(--canvas-text-dim)" }}>°</span>
            </div>
          </div>

          {/* 景别：三档分段切换（与打光面板的视角切换同款控件） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.zoom")}</span>
            <div className="light-panel-view-toggle w-full">
              {ZOOM_LABELS.map((labelKey, z) => (
                <button
                  key={labelKey}
                  type="button"
                  className={`light-panel-view-opt${zoom === z ? " active" : ""}`}
                  onClick={() => setZoom(z)}
                >
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* 预设机位（与打光面板的主光源网格同款，手动改参即取消高亮） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.presets")}</span>
            <div className="grid grid-cols-3 gap-1 rounded-xl p-1" style={{ background: "var(--canvas-bg-hover)" }}>
              {PRESETS.map((p) => {
                const active = activePreset === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => handlePreset(p)}
                    className={`light-panel-dir-btn${active ? " active" : ""}`}
                  >
                    {t(p.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 底部：重置 + 确认（确认即按当前机位派生图片节点，链路同打光） */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleReset}
          className="panel-reset-btn flex cursor-pointer items-center gap-1.5 rounded px-3 py-1.5 text-xs transition-all"
          style={{ border: "1px solid var(--canvas-border)", color: "var(--canvas-text-dim)" }}
        >
          {t("angle.reset")}
        </button>
        <PrimaryActionButton onClick={handleGenerate} disabled={!src} loading={submitting} />
      </div>
    </div>
  );
}
