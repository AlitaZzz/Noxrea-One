/**
 * 多视角（相机机位）编辑器（悬浮于节点下方，布局与打光面板同构）。
 * 左列 3D 轨道球（共享 OrbitScene3D，相机标记 + 景别缩放），右列方位角 / 俯仰 / 景别 + 预设机位。
 * 点生成后参数交由后端 angle 模板插值成提示词，派生图片节点预填（链路同打光面板）。
 */

"use client";

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { CloseOutlined, MultiAngleIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import IconActionButton from "@/components/ui/IconActionButton";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import { getPromptTemplate } from "@/features/canvas/api/canvas-api";
import { createImageNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { spawnPromptDerivedNode } from "@/features/canvas/upload";

import OrbitScene3D, { type OrbitViewMode } from "./OrbitScene3D";
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
  const { notification } = useAppFeedback();

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
        notification.error({ title: t("angle.generateFailed"), placement: "bottomRight", duration: 6, key: `angle-failed-${nodeId}` });
        return;
      }
      const node = spawnPromptDerivedNode(nodeId, template, createImageNode, useCanvasStore.getState(), {
        label: t("angle.editor"),
      });
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

  // Use the official two-thumb range to show the signed distance from neutral (0°).
  const elevationRange: [number, number] = elevation < 0 ? [elevation, 0] : [0, elevation];

  // Zoom scales the center image
  const zoomScale = [1.6, 1.0, 0.65][zoom];

  return (
    <Card className="nodrag nopan nowheel pointer-events-auto w-[460px] select-none gap-3 p-3">
      {/* 标题栏（与打光面板同款） */}
      <CardHeader className="flex items-center justify-between gap-0 px-0 py-0">
        <span className="inline-flex items-center gap-2 text-[13px] text-foreground">
          <MultiAngleIcon className="h-4 w-4" />
          {t("angle.editorTitle")}
        </span>
        <Button
          variant="ghost"
          aria-label="close"
          onClick={onClose}
          size="icon-xs"
        >
          <CloseOutlined aria-hidden="true" />
        </Button>
      </CardHeader>
      <Separator />

      <CardContent className="flex gap-3 px-0 py-0">
        {/* 左列：3D 轨道球（与打光面板同款：视角切换 + 场景铺满剩余高度） */}
        <div className="flex h-full w-[200px] shrink-0 flex-col gap-2">
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => { if (value) setViewMode(value as OrbitViewMode); }}
            variant="outline"
            size="sm"
            spacing={2}
            className="w-full"
            aria-label={t("angle.editorTitle")}
          >
            {VIEW_OPTIONS.map((opt) => (
              <ToggleGroupItem
                key={opt.key}
                value={opt.key}
                className="h-7 flex-1 px-2 text-xs font-normal"
              >
                {t(opt.labelKey)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
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
            <span className="text-xs text-muted-foreground">{t("angle.azimuth")}</span>
            <div className="flex h-9 w-full items-center gap-1.5 rounded-xl px-2">
              <Slider
                min={0}
                max={359}
                step={1}
                value={[azimuth]}
                onValueChange={([next]) => setAzimuth(next)}
                className="min-w-0 flex-1"
              />
              <Separator orientation="vertical" className="h-4 shrink-0" />
              <Input
                type="number"
                min={0}
                max={359}
                step={1}
                value={azimuth}
                className="h-7 w-9 shrink-0 border-0 bg-transparent p-0 text-right text-xs shadow-none focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
              <span className="shrink-0 text-xs text-muted-foreground">°</span>
            </div>
          </div>

          {/* 俯仰角：官方 range slider，以 0° 为中性端点 */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{t("angle.elevation")}</span>
            <div className="flex h-9 w-full items-center gap-1.5 rounded-xl px-2">
              <Slider
                min={-90}
                max={90}
                step={1}
                value={elevationRange}
                onValueChange={(values) => {
                  const [start, end] = values;
                  setElevation(Math.abs(start) >= Math.abs(end) ? start : end);
                }}
                className="min-w-0 flex-1"
              />
              <Separator orientation="vertical" className="h-4 shrink-0" />
              <Input
                type="number"
                min={-90}
                max={90}
                step={1}
                value={elevation}
                className="h-7 w-9 shrink-0 border-0 bg-transparent p-0 text-right text-xs shadow-none focus-visible:ring-0 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
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
              <span className="shrink-0 text-xs text-muted-foreground">°</span>
            </div>
          </div>

          {/* 景别：三档分段切换（与打光面板的视角切换同款控件） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{t("angle.zoom")}</span>
            <ToggleGroup
              type="single"
              value={String(zoom)}
              onValueChange={(value) => { if (value) setZoom(Number(value)); }}
              variant="outline"
              size="sm"
              spacing={2}
              className="w-full"
              aria-label={t("angle.zoom")}
            >
              {ZOOM_LABELS.map((labelKey, z) => (
                <ToggleGroupItem
                  key={labelKey}
                  value={String(z)}
                  className="h-7 flex-1 px-2 text-xs font-normal"
                >
                  {t(labelKey)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          {/* 预设机位（与打光面板的主光源网格同款，手动改参即取消高亮） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">{t("angle.presets")}</span>
            <ToggleGroup
              type="single"
              value={activePreset ?? ""}
              onValueChange={(value) => {
                if (!value) return;
                const preset = PRESETS.find((item) => item.key === value);
                if (preset) handlePreset(preset);
              }}
              variant="outline"
              size="sm"
              spacing={2}
              className="grid h-auto w-full grid-cols-3"
              aria-label={t("angle.presets")}
            >
              {PRESETS.map((p) => {
                return (
                  <ToggleGroupItem
                    key={p.key}
                    value={p.key}
                    className="h-7 px-2 text-xs font-normal"
                  >
                    {t(p.labelKey)}
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>
        </div>
      </CardContent>

      {/* 底部：重置 + 确认（确认即按当前机位派生图片节点，链路同打光） */}
      <CardFooter className="flex items-center justify-between px-0 py-0">
        <Button
          type="button"
          onClick={handleReset}
          variant="outline"
          size="xs"
        >
          {t("angle.reset")}
        </Button>
        <IconActionButton onClick={handleGenerate} disabled={!src} loading={submitting} />
      </CardFooter>
    </Card>
  );
}
