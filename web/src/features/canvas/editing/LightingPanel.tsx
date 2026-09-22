/**
 * 图片打光参数面板（悬浮于节点下方，不随画布缩放）。
 * 左侧 three.js 三维预览（透视/正面双视角，拖拽调光源方位/仰角），
 * 右侧亮度（滑杆 + 数值框联动，10-100）、颜色、主光源六向预设。
 * 点生成后参数交由后端 lighting 模板插值成提示词，派生图片节点预填（链路同「创作」）。
 */
"use client";

import { App, Button, ColorPicker, Slider } from "antd";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { ResetIcon } from "@/components/ui/icons/canvas/ResetIcon";
import { SunIcon } from "@/components/ui/icons/canvas/SunIcon";
import { ThermometerIcon } from "@/components/ui/icons/canvas/ThermometerIcon";
import { getPromptTemplate } from "@/features/canvas/api/canvas-api";
import { createImageNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { spawnPromptDerivedNode } from "@/features/canvas/upload";

import OrbitScene3D, { type OrbitViewMode } from "./OrbitScene3D";
import PrimaryActionButton from "./PrimaryActionButton";
import useEscapeToClose from "./use-escape-to-close";

interface LightingState {
  intensity: number; // 10-100
  color: string;
  azimuth: number; // 0-359
  elevation: number; // -90~90
}

const DIRECTIONS: Record<string, { azimuth: number; elevation: number; labelKey: string }> = {
  left:   { azimuth: 270, elevation: 0,   labelKey: "lighting.dir.left" },
  top:    { azimuth: 0,   elevation: 90,  labelKey: "lighting.dir.top" },
  right:  { azimuth: 90,  elevation: 0,   labelKey: "lighting.dir.right" },
  front:  { azimuth: 0,   elevation: 0,   labelKey: "lighting.dir.front" },
  bottom: { azimuth: 0,   elevation: -90, labelKey: "lighting.dir.bottom" },
  back:   { azimuth: 180, elevation: 0,   labelKey: "lighting.dir.back" },
};

const DIRECTION_ORDER = ["left", "top", "right", "front", "bottom", "back"] as const;

const DEFAULT_STATE: LightingState = {
  intensity: 50,
  color: "#FFFFFF",
  azimuth: 0,
  elevation: 0,
};

// 色温(K) → RGB hex：Tanner Helland 近似公式，2000K 暖橙 → 10000K 冷蓝
function kelvinToHex(kelvin: number): string {
  const t = kelvin / 100;
  let r: number, g: number, b: number;
  if (t <= 66) {
    r = 255;
    g = 99.47 * Math.log(t) - 161.12;
  } else {
    r = 329.7 * Math.pow(t - 60, -0.1332);
    g = 288.12 * Math.pow(t - 60, -0.0755);
  }
  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.52 * Math.log(t - 10) - 305.04;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const KELVIN_MIN = 1500;
const KELVIN_MAX = 10000;

interface Props {
  src: string;
  /** 源图片节点 id：点生成时据此定位派生位置并建立连线（连线即参考图来源） */
  nodeId: string;
  onClose: () => void;
}

export default function LightingPanel({ src, nodeId, onClose }: Props) {
  const { t } = useTranslation();
  const { notification } = App.useApp();

  const [state, setState] = useState<LightingState>(DEFAULT_STATE);
  const [viewMode, setViewMode] = useState<OrbitViewMode>("perspective");
  const [colorTab, setColorTab] = useState<"temp" | "custom">("temp");
  const [kelvin, setKelvin] = useState(6500);
  const [submitting, setSubmitting] = useState(false);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径。
  // 共用钩子带输入框焦点与弹窗层守卫：面板内的 number input 持有焦点时
  // Esc 只退出输入，modal / 导演浮层打开时一层 Esc 不拆两层
  useEscapeToClose(onClose);

  const update = <K extends keyof LightingState>(key: K, value: LightingState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };
  const handleReset = () => {
    setState(DEFAULT_STATE);
    setColorTab("temp");
    setKelvin(6500);
  };

  // 色温 ↔ 自定义切换：回到色温时把当前色温值写回 color
  const switchColorTab = (tab: "temp" | "custom") => {
    setColorTab(tab);
    if (tab === "temp") update("color", kelvinToHex(kelvin));
  };
  const handleKelvin = (k: number) => {
    setKelvin(k);
    update("color", kelvinToHex(k));
  };

  // 3D 预览拖拽回调：delta 已由场景组件换算为角度增量
  const handleSceneDrag = useCallback((dAz: number, dEl: number) => {
    setState((prev) => {
      let az = (prev.azimuth + dAz) % 360;
      if (az < 0) az += 360;
      const el = Math.max(-90, Math.min(90, prev.elevation + dEl));
      return { ...prev, azimuth: Math.round(az), elevation: Math.round(el) };
    });
  }, []);

  // 生成：参数交由后台提示词模板（type=lighting）插值成稿，派生图片节点预填 prompt，
  // 链路与图片节点「创作」一致（spawnPromptDerivedNode，连线即参考图来源）。
  // 前端不做语义翻译，只传原始参数：intensity/azimuth/elevation + kelvin（色温）或 color（自定义色）。
  const handleGenerate = useCallback(async () => {
    if (!src || submitting) return;
    setSubmitting(true);
    try {
      const template = await getPromptTemplate("lighting", {
        intensity: state.intensity,
        azimuth: state.azimuth,
        elevation: state.elevation,
        ...(colorTab === "temp" ? { kelvin } : { color: state.color }),
      });
      if (!template) {
        notification.error({ title: t("lighting.generateFailed"), placement: "bottomRight" });
        return;
      }
      const node = spawnPromptDerivedNode(nodeId, template, createImageNode, useCanvasStore.getState());
      if (!node) return;
      markDirtyImmediate();
      onClose();
    } finally {
      setSubmitting(false);
    }
  }, [src, nodeId, state, colorTab, kelvin, submitting, notification, t, onClose]);

  const activeDir = DIRECTION_ORDER.find(
    (d) =>
      Math.abs(DIRECTIONS[d].azimuth - state.azimuth) < 3 &&
      Math.abs(DIRECTIONS[d].elevation - state.elevation) < 3,
  );

  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto select-none flex flex-col gap-3 rounded-2xl p-3" style={{ width: 460 }}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-[13px]" style={{ color: "var(--canvas-text)" }}>
          <SunIcon className="h-4 w-4" />
          {t("lighting.title")}
        </span>
        {/* 与资产弹窗关闭按钮同款：✕ 字形 + 次级文字色，悬停底色走 canvas-toolbar 按钮规则 */}
        <Button
          type="text"
          aria-label="close"
          onClick={onClose}
          style={{ width: 24, height: 24, minWidth: 24, padding: 0 }}
          icon={<span style={{ color: "var(--canvas-text-secondary)", fontSize: 12, lineHeight: 1 }}>✕</span>}
        />
      </div>
      <div className="h-px w-full" style={{ background: "var(--canvas-border)" }} />

      <div className="flex gap-3">
        {/* 左列：视角切换 + 3D 预览（高度撑满与右列对齐，画布填充剩余空间） */}
        <div className="flex h-full w-[200px] shrink-0 flex-col gap-2">
          <div className="light-panel-view-toggle">
            <button
              type="button"
              className={`light-panel-view-opt${viewMode === "perspective" ? " active" : ""}`}
              onClick={() => setViewMode("perspective")}
            >
              {t("lighting.view.perspective")}
            </button>
            <button
              type="button"
              className={`light-panel-view-opt${viewMode === "front" ? " active" : ""}`}
              onClick={() => setViewMode("front")}
            >
              {t("lighting.view.front")}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <OrbitScene3D
              variant="light"
              src={src}
              color={state.color}
              intensity={state.intensity}
              azimuth={state.azimuth}
              elevation={state.elevation}
              mode={viewMode}
              onDrag={handleSceneDrag}
            />
          </div>
        </div>

        {/* 右列：参数 */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.global")}</div>

          {/* 亮度：档位滑杆 + 数值框联动（与色温同款 h-9 组合框，保证三行控件等高） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.intensity")}</span>
            <div className="flex h-9 w-full items-center gap-1.5 rounded-xl px-2" style={{ background: "var(--canvas-bg-hover)" }}>
              <Slider
                min={10}
                max={100}
                step={1}
                value={state.intensity}
                onChange={(v) => update("intensity", Number(v))}
                className="min-w-0 flex-1"
                style={{ margin: 0 }}
                tooltip={{ open: false }}
              />
              <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
              <SunIcon className="shrink-0" style={{ width: 13, height: 13, color: "var(--canvas-text-dim)" }} />
              <input
                type="number"
                min={10}
                max={100}
                step={1}
                value={state.intensity}
                className="light-panel-pct-input shrink-0"
                // 输入中间态（如打 "55" 时的 "5"）不能立即钳位，否则每次按键都被夹成 10/100；
                // 只在值合法时提交，非法中间态留在 DOM，失焦时统一钳位回写
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 10 && v <= 100) update("intensity", Math.round(v));
                }}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  const clamped = Number.isFinite(v) ? Math.max(10, Math.min(100, Math.round(v))) : state.intensity;
                  e.target.value = String(clamped);
                  update("intensity", clamped);
                }}
              />
              <span className="shrink-0 text-xs" style={{ color: "var(--canvas-text-dim)" }}>%</span>
            </div>
          </div>

          {/* 颜色：色温 / 颜色 双选项卡，共享同一个 color 参数；
              控件行固定高度，两种模式切换不引起下方布局跳动 */}
          <div className="flex flex-col gap-1.5">
            <div className="light-panel-mini-tabs">
              <button
                type="button"
                className={`light-panel-mini-tab${colorTab === "temp" ? " active" : ""}`}
                onClick={() => switchColorTab("temp")}
              >
                {t("lighting.colorTemp")}
              </button>
              <button
                type="button"
                className={`light-panel-mini-tab${colorTab === "custom" ? " active" : ""}`}
                onClick={() => switchColorTab("custom")}
              >
                {t("lighting.color")}
              </button>
            </div>
            <div className="flex h-9 items-center">
              {colorTab === "temp" ? (
                <div className="flex h-9 w-full items-center gap-1 rounded-xl px-2" style={{ background: "var(--canvas-bg-hover)" }}>
                  <Slider
                    min={KELVIN_MIN}
                    max={KELVIN_MAX}
                    step={100}
                    value={kelvin}
                    onChange={(v) => handleKelvin(Number(v))}
                    className="min-w-0 flex-1"
                    style={{ margin: 0 }}
                    tooltip={{ open: false }}
                    // 色温带：渐变铺满整条轨道（rail），已填充段透明保持色带完整可见
                    styles={{ rail: { background: "linear-gradient(to right, #FFB253, #3499FF)" }, track: { background: "transparent" } }}
                  />
                  <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
                  <ThermometerIcon className="size-4 shrink-0" style={{ color: "var(--canvas-text-dim)" }} />
                  <input
                    type="number"
                    min={KELVIN_MIN}
                    max={KELVIN_MAX}
                    value={kelvin}
                    className="light-panel-temp-input shrink-0"
                    // 同亮度输入：中间态不钳位，失焦统一归一并回写
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v >= KELVIN_MIN && v <= KELVIN_MAX) handleKelvin(Math.round(v));
                    }}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      const clamped = Number.isFinite(v)
                        ? Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(v)))
                        : kelvin;
                      e.target.value = String(clamped);
                      handleKelvin(clamped);
                    }}
                  />
                  <span className="shrink-0 text-[13px]" style={{ color: "var(--canvas-text-muted)" }}>K</span>
                </div>
              ) : (
                <div className="flex h-9 w-full items-center gap-2 rounded-xl px-2" style={{ background: "var(--canvas-bg-hover)" }}>
                  <ColorPicker
                    value={state.color}
                    onChangeComplete={(c) => update("color", c.toHexString())}
                    size="small"
                    format="hex"
                  />
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{state.color}</span>
                </div>
              )}
            </div>
          </div>

          {/* 主光源六向预设（收进同底色圆角容器，与上方组合框形成一致的分组感） */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.mainDirection")}</span>
            <div className="grid grid-cols-3 gap-1 rounded-xl p-1" style={{ background: "var(--canvas-bg-hover)" }}>
              {DIRECTION_ORDER.map((dir) => {
                const d = DIRECTIONS[dir];
                const active = activeDir === dir;
                return (
                  <button
                    key={dir}
                    type="button"
                    onClick={() => setState((prev) => ({ ...prev, azimuth: d.azimuth, elevation: d.elevation }))}
                    className={`light-panel-dir-btn${active ? " active" : ""}`}
                  >
                    {t(d.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 底部：重置 + 确认（参数暂未接生成链路，与现有行为一致保持展示） */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={handleReset}
          className="panel-reset-btn flex cursor-pointer items-center gap-1.5 rounded px-3 py-1.5 text-xs transition-all"
          style={{ border: "1px solid var(--canvas-border)", color: "var(--canvas-text-dim)" }}
        >
          <ResetIcon style={{ width: 13, height: 13 }} />
          {t("lighting.reset")}
        </button>
        <PrimaryActionButton onClick={handleGenerate} disabled={!src} loading={submitting} />
      </div>
    </div>
  );
}
