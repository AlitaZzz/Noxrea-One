/**
 * 图片打光参数面板（悬浮于节点下方，不随画布缩放）。
 * 左侧 three.js 三维预览（透视/正面双视角，拖拽调光源方位/仰角），
 * 右侧亮度（档位滑杆 + 数值框联动）、颜色、主光源六向预设。
 * 输出的是打光描述参数而非像素结果，交由生成链路使用。
 */
"use client";

import { Button, ColorPicker } from "antd";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ResetIcon } from "@/components/ui/icons/canvas/ResetIcon";
import { SunIcon } from "@/components/ui/icons/canvas/SunIcon";
import { ThermometerIcon } from "@/components/ui/icons/canvas/ThermometerIcon";

import LightingScene3D, { type LightViewMode } from "./LightingScene3D";
import PrimaryActionButton from "./PrimaryActionButton";

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

// 档位(0-4) ↔ 亮度百分比(10-100) 双向映射：10/33/55/78/100
const levelToPct = (level: number) => Math.round(10 + level * 22.5);
const pctToLevel = (pct: number) => Math.max(0, Math.min(4, Math.round(((pct - 10) / 90) * 4)));

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
  onClose: () => void;
}

export default function LightingPanel({ src, onClose }: Props) {
  const { t } = useTranslation();

  const [state, setState] = useState<LightingState>(DEFAULT_STATE);
  const [viewMode, setViewMode] = useState<LightViewMode>("perspective");
  const [colorTab, setColorTab] = useState<"temp" | "custom">("temp");
  const [kelvin, setKelvin] = useState(6500);

  // Esc 关闭：与点击画布空白（取消选中后面板自动卸载）形成一致的退出路径
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  const level = pctToLevel(state.intensity);
  const activeDir = DIRECTION_ORDER.find(
    (d) =>
      Math.abs(DIRECTIONS[d].azimuth - state.azimuth) < 3 &&
      Math.abs(DIRECTIONS[d].elevation - state.elevation) < 3,
  );

  return (
    <div className="canvas-toolbar nodrag nopan nowheel pointer-events-auto select-none flex flex-col gap-3 rounded-2xl p-3" style={{ width: 460 }}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <span className="text-[13px]" style={{ color: "var(--canvas-text)" }}>{t("lighting.title")}</span>
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
            <LightingScene3D
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
              <input
                type="range"
                min={0}
                max={4}
                step={1}
                value={level}
                className="light-panel-slider min-w-0 flex-1"
                style={{
                  background: `linear-gradient(to right, var(--canvas-text) 0%, var(--canvas-text) ${(level / 4) * 100}%, var(--canvas-bg) ${(level / 4) * 100}%)`,
                }}
                onChange={(e) => update("intensity", levelToPct(Number(e.target.value)))}
              />
              <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
              <SunIcon className="shrink-0" style={{ width: 13, height: 13, color: "var(--canvas-text-dim)" }} />
              <input
                type="number"
                min={10}
                max={100}
                value={state.intensity}
                className="light-panel-pct-input shrink-0"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) update("intensity", Math.max(10, Math.min(100, Math.round(v))));
                }}
              />
              <span className="shrink-0 text-[11px]" style={{ color: "var(--canvas-text-dim)" }}>%</span>
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
                  <input
                    type="range"
                    min={KELVIN_MIN}
                    max={KELVIN_MAX}
                    step={100}
                    value={kelvin}
                    className="light-panel-slider min-w-0 flex-1"
                    style={{ background: "linear-gradient(to right, #FFB253, #3499FF)" }}
                    onChange={(e) => handleKelvin(Number(e.target.value))}
                  />
                  <div className="h-4 w-px shrink-0" style={{ background: "var(--canvas-border)" }} />
                  <ThermometerIcon className="size-4 shrink-0" style={{ color: "var(--canvas-text-dim)" }} />
                  <input
                    type="number"
                    min={KELVIN_MIN}
                    max={KELVIN_MAX}
                    value={kelvin}
                    className="light-panel-temp-input shrink-0"
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v)) handleKelvin(Math.max(KELVIN_MIN, Math.min(KELVIN_MAX, Math.round(v))));
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
        <PrimaryActionButton />
      </div>
    </div>
  );
}
