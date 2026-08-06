/**
 * 图片打光参数面板。
 * 通过三维球体控件设定光源方位角 / 仰角，并调节强度与色温色值（含六向快捷预设），
 * 输出的是打光描述参数而非像素结果，交由生成链路使用。
 */
"use client";

import { ArrowUpOutlined } from "@ant-design/icons";
import { Button, ColorPicker, Slider, Switch } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import AppModal from "@/components/ui/AppModal";
import { LightingIcon } from "@/components/ui/icons/canvas/LightingIcon";
import WheelGuard from "@/components/ui/WheelGuard";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useI18nStore } from "@/lib/i18n/store";

interface LightingState {
  intensity: number;
  color: string;
  azimuth: number;
  elevation: number;
}

const DIRECTIONS: Record<string, { azimuth: number; elevation: number; labelKey: string; icon: string }> = {
  left:   { azimuth: 270, elevation: 0,   labelKey: "lighting.dir.left",   icon: "\u2190" },
  top:    { azimuth: 0,   elevation: 90,  labelKey: "lighting.dir.top",    icon: "\u2191" },
  right:  { azimuth: 90,  elevation: 0,   labelKey: "lighting.dir.right",  icon: "\u2192" },
  front:  { azimuth: 0,   elevation: 0,   labelKey: "lighting.dir.front",  icon: "\u25CF" },
  bottom: { azimuth: 0,   elevation: -90, labelKey: "lighting.dir.bottom", icon: "\u2193" },
  back:   { azimuth: 180, elevation: 0,   labelKey: "lighting.dir.back",   icon: "\u25C7" },
};

const DIRECTION_ORDER = ["left", "top", "right", "front", "bottom", "back"] as const;

const DEFAULT_STATE: LightingState = {
  intensity: 50,
  color: "#FFFFFF",
  azimuth: 0,
  elevation: 0,
};

const ORBIT_RADIUS = 120;
const LATITUDES = [-75, -60, -45, -30, -15, 0, 15, 30, 45, 60, 75];
const CONE_HEIGHT = 90;

interface Props {
  src: string;
  onClose: () => void;
}

export default function LightingPanel({ src, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);

  const [state, setState] = useState<LightingState>(DEFAULT_STATE);

  // Drag state
  const dragRef = useRef({ on: false, lastX: 0, lastY: 0 });
  const azRef = useRef(state.azimuth);
  const elRef = useRef(state.elevation);
  azRef.current = state.azimuth;
  elRef.current = state.elevation;

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [setModalOpen]);

  // Global pointer handlers for dragging the light source
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current.on) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;

      let az = (azRef.current + dx * 0.8) % 360;
      if (az < 0) az += 360;
      let el = elRef.current - dy * 0.8;
      el = Math.max(-90, Math.min(90, el));
      setState((prev) => ({ ...prev, azimuth: Math.round(az), elevation: Math.round(el) }));
    };
    const onUp = () => {
      dragRef.current.on = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { on: true, lastX: e.clientX, lastY: e.clientY };
  }, []);

  const update = <K extends keyof LightingState>(key: K, value: LightingState[K]) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };
  const handleReset = () => setState(DEFAULT_STATE);

  // ── Compute light position in 3D ──
  const azRad = (state.azimuth * Math.PI) / 180;
  const elRad = (state.elevation * Math.PI) / 180;
  const r = ORBIT_RADIUS;
  const lx = r * Math.cos(elRad) * Math.sin(azRad);
  const ly = -r * Math.sin(elRad);
  const lz = r * Math.cos(elRad) * Math.cos(azRad);

  // Light source transform: position on sphere + face center
  const lightTransform = `translate3d(${lx}px, ${ly}px, ${lz}px)`;

  // CORRECT rotation: CSS applies right-to-left, so rotateZ first (tilt), then rotateY (azimuth)
  // rotateY(az-90): az=0 -> point toward +Z (front), az=90 -> +X (right)
  // rotateZ(-el): tilt up by elevation in XY plane
  const rayRotation = `rotateY(${state.azimuth - 90}deg) rotateZ(${-state.elevation}deg)`;

  // Brightness
  const brightness = 0.3 + (state.intensity / 100) * 0.7;
  const lightHex = state.color;

  // Directional lighting gradient on image (2D projection of light dir)
  const projX = Math.cos(elRad) * Math.sin(azRad);
  const projY = -Math.sin(elRad);
  // gradient direction: from dark side to light side
  const gradientAngle = (Math.atan2(projY, projX) * 180) / Math.PI + 90;
  const lightAlpha = Math.floor((state.intensity / 100) * 90).toString(16).padStart(2, "0");
  const shadowAlpha = Math.floor((1 - state.intensity / 100) * 80).toString(16).padStart(2, "0");

  // Is light in front?
  const lightInFront = lz >= 0;

  // Active preset
  const activeDir = DIRECTION_ORDER.find(
    (d) =>
      Math.abs(DIRECTIONS[d].azimuth - state.azimuth) < 3 &&
      Math.abs(DIRECTIONS[d].elevation - state.elevation) < 3,
  );

  // Pre-compute latitude rings
  const rings = LATITUDES.map((lat) => {
    const phi = ((90 - lat) * Math.PI) / 180;
    const ringR = ORBIT_RADIUS * Math.sin(phi);
    const yOffset = -ORBIT_RADIUS * Math.cos(phi);
    return { lat, ringR, yOffset };
  });

  return (
    <AppModal
      title={
        <span className="inline-flex items-center gap-2">
          <LightingIcon className="h-4 w-4" />
          {t("lighting.title")}
        </span>
      }
      open
      onCancel={onClose}
      width={780}
      footer={null}
    >
      <WheelGuard>
        <div className="flex flex-col gap-3" style={{ minHeight: 400 }}>
          <div className="flex gap-4" style={{ minHeight: 360 }}>
            {/* Left: 3D Light visualization */}
            <div
              className="relative flex-1 rounded-lg overflow-hidden"
              style={{
                background: "var(--canvas-bg)",
                minWidth: 280,
                minHeight: 360,
                perspective: "700px",
                cursor: "grab",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
              }}
              onPointerDown={startDrag}
            >
              {/* 3D World */}
              <div
                className="absolute"
                style={{
                  left: "50%",
                  top: "50%",
                  transformStyle: "preserve-3d",
                }}
              >
                {/* Sphere fill (semi-transparent) */}
                <div
                  style={{
                    position: "absolute",
                    left: -ORBIT_RADIUS + "px",
                    top: -ORBIT_RADIUS + "px",
                    width: ORBIT_RADIUS * 2 + "px",
                    height: ORBIT_RADIUS * 2 + "px",
                    borderRadius: "50%",
                    background: "radial-gradient(circle, rgba(26,36,51,0.25) 0%, rgba(26,36,51,0.08) 70%, transparent 100%)",
                    transformStyle: "preserve-3d",
                  }}
                />

                {/* Latitude rings */}
                {rings.map(({ lat, ringR, yOffset }) => (
                  <div
                    key={lat}
                    style={{
                      position: "absolute",
                      left: -ringR + "px",
                      top: yOffset - ringR + "px",
                      width: ringR * 2 + "px",
                      height: ringR * 2 + "px",
                      borderRadius: "50%",
                      border:
                        lat === 0
                          ? "1px solid rgba(255,255,255,0.7)"
                          : "1px solid rgba(255,255,255,0.3)",
                      transform: "rotateX(90deg)",
                      pointerEvents: "none",
                    }}
                  />
                ))}

                {/* Meridian lines */}
                {[0, 30, 60, 90, 120, 150].map((meridian) => (
                  <div
                    key={meridian}
                    style={{
                      position: "absolute",
                      left: -ORBIT_RADIUS + "px",
                      top: -ORBIT_RADIUS + "px",
                      width: ORBIT_RADIUS * 2 + "px",
                      height: ORBIT_RADIUS * 2 + "px",
                      borderRadius: "50%",
                      border: "1px solid rgba(255,255,255,0.2)",
                      transform: `rotateY(${meridian}deg)`,
                      pointerEvents: "none",
                    }}
                  />
                ))}

                {/* Light cone (from light source projecting onto image) */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: -CONE_HEIGHT / 2 + "px",
                    width: r + "px",
                    height: CONE_HEIGHT + "px",
                    transformOrigin: "0 50%",
                    // Position at light source, rotate to point back toward center (image)
                    // Reversed direction: azimuth + 180, elevation negated
                    transform: `${lightTransform} rotateY(${state.azimuth + 90}deg) rotateZ(${state.elevation}deg)`,
                    // Opaque at light source (left), transparent at image (right)
                    background: `linear-gradient(to right, ${lightHex}${lightAlpha} 0%, ${lightHex}${lightAlpha} 30%, ${lightHex}00 100%)`,
                    // Narrow at light source (left), wide at image (right)
                    clipPath: "polygon(0 45%, 100% 0%, 100% 100%, 0 55%)",
                    opacity: lightInFront ? 0.3 : 0.1,
                    pointerEvents: "none",
                    transition: "opacity 0.3s ease",
                  }}
                />

                {/* Light ray line from center to light source */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: r + "px",
                    height: "1.5px",
                    background: `linear-gradient(to right, ${lightHex}00, ${lightHex}80, ${lightHex})`,
                    transformOrigin: "0 50%",
                    transform: rayRotation,
                    pointerEvents: "none",
                    opacity: lightInFront ? 0.6 : 0.3,
                  }}
                />

                {/* Center image - inside 3D world so sphere wraps around it (like MultiAngleEditor) */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    transformStyle: "preserve-3d",
                    pointerEvents: "none",
                  }}
                >
                  <img
                    src={src}
                    alt=""
                    draggable={false}
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      transform: "translate(-50%, -50%)",
                      display: "block",
                      maxWidth: "130px",
                      maxHeight: "130px",
                      borderRadius: "6px",
                      boxShadow: `0 4px 20px rgba(0,0,0,0.5), 0 0 ${brightness * 20}px ${lightHex}${lightAlpha}`,
                      filter: `brightness(${0.5 + brightness * 0.5})`,
                      transition: "box-shadow 0.3s ease, filter 0.3s ease",
                    }}
                  />
                  {/* Directional lighting gradient overlay */}
                  <div
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      width: "130px",
                      height: "130px",
                      maxWidth: "130px",
                      maxHeight: "130px",
                      transform: "translate(-50%, -50%)",
                      borderRadius: "6px",
                      background: `linear-gradient(${gradientAngle + 180}deg, ${lightHex}${lightAlpha} 0%, transparent 40%, rgba(0,0,0,${(1 - brightness) * 0.6}) 100%)`,
                      mixBlendMode: "soft-light",
                      pointerEvents: "none",
                      transition: "background 0.3s ease",
                    }}
                  />
                </div>

                {/* Light source point */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    transformStyle: "preserve-3d",
                    transform: lightTransform,
                    pointerEvents: "none",
                  }}
                >
                  {/* Glow halo */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-20px",
                      top: "-20px",
                      width: "40px",
                      height: "40px",
                      borderRadius: "50%",
                      background: `radial-gradient(circle, ${lightHex}60 0%, transparent 70%)`,
                      filter: "blur(3px)",
                      opacity: lightInFront ? 1 : 0.4,
                      transition: "opacity 0.3s ease",
                    }}
                  />
                  {/* Light core */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-8px",
                      top: "-8px",
                      width: "16px",
                      height: "16px",
                      borderRadius: "50%",
                      background: `radial-gradient(circle, ${lightHex} 0%, ${lightHex}cc 60%, ${lightHex}40 100%)`,
                      boxShadow: `0 0 ${10 + state.intensity * 0.15}px ${lightHex}`,
                      opacity: lightInFront ? 1 : 0.5,
                      transition: "box-shadow 0.3s ease, opacity 0.3s ease",
                    }}
                  />
                  {/* Inner white dot */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-3px",
                      top: "-3px",
                      width: "6px",
                      height: "6px",
                      borderRadius: "50%",
                      background: "#fff",
                      opacity: lightInFront ? 0.9 : 0.4,
                    }}
                  />
                </div>
              </div>

              {/* Overlay: direction label */}
              <div
                className="absolute top-2 right-2 text-[10px] pointer-events-none px-2 py-0.5 rounded"
                style={{
                  color: "var(--canvas-text-dim)",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
              >
                {activeDir ? t(DIRECTIONS[activeDir].labelKey) : `${state.azimuth}\u00B0 / ${state.elevation}\u00B0`}
              </div>

              {/* Overlay: intensity */}
              <div
                className="absolute bottom-2 left-2 text-[10px] pointer-events-none px-2 py-0.5 rounded"
                style={{
                  color: "var(--canvas-text-dim)",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
              >
                {t("lighting.intensity")}: {state.intensity}%
              </div>

              {/* Hint */}
              <div
                className="absolute bottom-2 right-2 text-[10px] pointer-events-none px-2 py-0.5 rounded"
                style={{
                  color: "var(--canvas-text-muted)",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
              >
                {t("lighting.dragHint")}
              </div>
            </div>

            {/* Right: Parameters */}
            <div className="flex flex-col gap-4" style={{ width: 240 }}>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.intensity")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{state.intensity}</span>
                </div>
                <Slider min={0} max={100} value={state.intensity} tooltip={{ open: false }} onChange={(v) => update("intensity", v as number)} />
              </div>

              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.color")}</span>
                </div>
                <ColorPicker
                  value={state.color}
                  onChangeComplete={(c) => update("color", c.toHexString())}
                  size="small"
                  showText
                  format="hex"
                />
              </div>

              {/* Azimuth slider */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.azimuth")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{state.azimuth}°</span>
                </div>
                <Slider min={0} max={359} value={state.azimuth} tooltip={{ open: false }} onChange={(v) => update("azimuth", v as number)} />
              </div>

              {/* Elevation slider */}
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.elevation")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{state.elevation}°</span>
                </div>
                <Slider min={-90} max={90} value={state.elevation} tooltip={{ open: false }} onChange={(v) => update("elevation", v as number)} />
              </div>

              <div>
                <div className="text-xs mb-2" style={{ color: "var(--canvas-text-dim)" }}>{t("lighting.mainDirection")}</div>
                <div className="grid grid-cols-3 gap-1.5">
                  {DIRECTION_ORDER.map((dir) => {
                    const d = DIRECTIONS[dir];
                    const active = activeDir === dir;
                    return (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => setState((prev) => ({ ...prev, azimuth: d.azimuth, elevation: d.elevation }))}
                        className="flex flex-col items-center justify-center gap-0.5 py-2 rounded-md text-xs transition-all"
                        style={{
                          border: "1px solid var(--canvas-border)",
                          background: active ? "var(--canvas-text)" : "transparent",
                          color: active ? "var(--canvas-bg)" : "var(--canvas-text-dim)",
                          cursor: "pointer",
                        }}
                      >
                        <span style={{ fontSize: 14, lineHeight: 1 }}>{d.icon}</span>
                        <span>{t(d.labelKey)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Bottom bar */}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleReset}
              className="panel-reset-btn px-4 py-1.5 rounded text-xs transition-all"
              style={{ border: "1px solid var(--canvas-border)", cursor: "pointer" }}
            >
              {t("lighting.reset")}
            </button>
            <Button size="small" type="text"
              className="flex items-center justify-center rounded-full flex-shrink-0 transition-all"
              style={{
                width: 36, height: 36,
                background: "var(--canvas-text)",
                color: "var(--canvas-bg)",
                border: "none", cursor: "pointer",
              }}
            >
              <ArrowUpOutlined style={{ fontSize: 16 }} />
            </Button>
          </div>
        </div>
      </WheelGuard>
    </AppModal>
  );
}
