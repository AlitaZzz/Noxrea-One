/**
 * 多视角（相机机位）编辑器。
 * 以三维轨道球控件设定观察方位角、仰角与远近，并提供俯拍 / 仰拍 / 鱼眼等预设机位，
 * 生成对应视角的图片节点。
 */
"use client";

import { ArrowUpOutlined } from "@ant-design/icons";
import { Button, Slider } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import AppModal from "@/components/ui/AppModal";
import { MultiAngleIcon } from "@/components/ui/icons/canvas/MultiAngleIcon";
import WheelGuard from "@/components/ui/WheelGuard";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useTranslation } from "react-i18next";

interface Props {
  src: string;
  sourceId: string;
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
  { key: "custom", labelKey: "angle.custom", azimuth: 0, elevation: 0, zoom: 1 },
  { key: "fisheye", labelKey: "angle.fisheye", azimuth: 0, elevation: 0, zoom: 0 },
  { key: "tilt", labelKey: "angle.tilt", azimuth: 45, elevation: 35, zoom: 1 },
  { key: "frontTop", labelKey: "angle.frontTop", azimuth: 0, elevation: 55, zoom: 1 },
  { key: "frontBottom", labelKey: "angle.frontBottom", azimuth: 0, elevation: -55, zoom: 1 },
  { key: "panoTop", labelKey: "angle.panoTop", azimuth: 180, elevation: 85, zoom: 2 },
  { key: "back", labelKey: "angle.back", azimuth: 180, elevation: 0, zoom: 1 },
];

const ZOOM_LABELS = ["angle.zoomNear", "angle.zoomMid", "angle.zoomFar"];

const DEFAULT_AZIMUTH = 0;
const DEFAULT_ELEVATION = 0;
const DEFAULT_ZOOM = 1;

/** Orbit radius in px (matches the CSS variable --orbit-r) */
const ORBIT_RADIUS = 120;

// Latitude rings to draw (degrees)
const LATITUDES = [-80, -60, -40, -20, 0, 20, 40, 60, 80];

export default function MultiAngleEditor({ src, sourceId, onClose }: Props) {
  const { t } = useTranslation();
  const setModalOpen = useCanvasStore((s) => s.setModalOpen);

  const [azimuth, setAzimuth] = useState(DEFAULT_AZIMUTH);
  const [elevation, setElevation] = useState(DEFAULT_ELEVATION);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [activePreset, setActivePreset] = useState("custom");

  // Drag state
  const dragRef = useRef({ on: false, lastX: 0, lastY: 0 });
  const azimuthRef = useRef(azimuth);
  const elevationRef = useRef(elevation);
  azimuthRef.current = azimuth;
  elevationRef.current = elevation;

  const dragModeRef = useRef<"marker" | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setModalOpen(true);
    return () => setModalOpen(false);
  }, [setModalOpen]);

  // ── spherical -> screen position (for the camera marker) ──
  // We place the marker on the sphere surface.
  // In CSS 3D the world is rotated as a whole, so we compute the
  // marker position in "world space" and let the parent transforms
  // handle the rest.
  const getMarkerTransform = useCallback((az: number, el: number) => {
    const azRad = (az * Math.PI) / 180;
    const elRad = (el * Math.PI) / 180;
    const r = ORBIT_RADIUS;
    const x = r * Math.cos(elRad) * Math.sin(azRad);
    const y = -r * Math.sin(elRad); // CSS Y is down
    const z = r * Math.cos(elRad) * Math.cos(azRad); // positive Z = toward viewer at az=0
    // The marker should face the center (0,0,0). The lens is at +Z by
    // default, so we flip 180° (az-180) to point it inward, then tilt
    // for elevation with -el.
    return {
      position: `translate3d(${x}px, ${y}px, ${z}px)`,
      rotation: `rotateY(${az - 180}deg) rotateX(${-el}deg)`,
    };
  }, []);

  // ── Global pointer handlers (drag marker or scene) ──
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current.on) return;
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;

      if (dragModeRef.current === "marker") {
        let az = (azimuthRef.current + dx * 0.5) % 360;
        if (az < 0) az += 360;
        let el = elevationRef.current - dy * 0.5;
        el = Math.max(-90, Math.min(90, el));
        setAzimuth(Math.round(az));
        setElevation(Math.round(el));
        setActivePreset("custom");
      }
    };
    const onUp = () => {
      dragRef.current.on = false;
      dragModeRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  const startDragMarker = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { on: true, lastX: e.clientX, lastY: e.clientY };
    dragModeRef.current = "marker";
  }, []);

  const startDragScene = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { on: true, lastX: e.clientX, lastY: e.clientY };
    dragModeRef.current = "marker";
  }, []);

  // ── Handlers ──
  const handlePreset = (p: Preset) => {
    setAzimuth(p.azimuth);
    setElevation(p.elevation);
    setZoom(p.zoom);
    setActivePreset(p.key);
  };
  const handleReset = () => {
    setAzimuth(DEFAULT_AZIMUTH);
    setElevation(DEFAULT_ELEVATION);
    setZoom(DEFAULT_ZOOM);
    setActivePreset("custom");
  };

  const marker = getMarkerTransform(azimuth, elevation);

  // Pre-compute latitude ring sizes
  // Each latitude ring is a circle of radius r*sin(phi) at height r*cos(phi)
  // where phi = 90 - lat. In CSS: a flat circle rotated by `lat` around X.
  const rings = LATITUDES.map((lat) => {
    const phi = ((90 - lat) * Math.PI) / 180;
    const ringR = ORBIT_RADIUS * Math.sin(phi);
    const yOffset = -ORBIT_RADIUS * Math.cos(phi); // CSS Y down
    return { lat, ringR, yOffset };
  });

  // Zoom scales the center image
  const zoomScale = [1.6, 1.0, 0.65][zoom];

  return (
    <AppModal
      title={
        <span className="inline-flex items-center gap-2">
          <MultiAngleIcon className="h-4 w-4" />
          {t("angle.editorTitle")}
        </span>
      }
      open
      onCancel={onClose}
      width={780}
      footer={null}
    >
      <WheelGuard>
        <div className="flex flex-col gap-3" style={{ minHeight: 400 }}>
          {/* Presets */}
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => handlePreset(p)}
                className="px-3 py-1 rounded-full text-xs transition-all"
                style={{
                  border: "1px solid var(--canvas-border)",
                  background: activePreset === p.key ? "var(--canvas-text)" : "transparent",
                  color: activePreset === p.key ? "var(--canvas-bg)" : "var(--canvas-text-dim)",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>

          {/* Preview + sliders */}
          <div className="flex gap-4" style={{ minHeight: 320 }}>
            <div
              ref={stageRef}
              onPointerDown={startDragScene}
              className="relative flex-1 rounded-lg overflow-hidden"
              style={{
                background: "var(--canvas-bg)",
                minWidth: 280,
                minHeight: 320,
                cursor: "grab",
                perspective: "700px",
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
              }}
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
                {/* Sphere fill (subtle) */}
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
                      border: lat === 0
                        ? "1px solid rgba(255,255,255,0.7)"
                        : "1px solid rgba(255,255,255,0.3)",
                      transform: "rotateX(90deg)",
                      pointerEvents: "none",
                    }}
                  />
                ))}

                {/* Meridian lines (vertical rings) - 6 lines every 30° */}
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

                {/* Center image (billboard - counter-rotates to always face viewer) */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    transformStyle: "preserve-3d",
                    transform: `scale(${zoomScale})`,
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
                      maxWidth: "140px",
                      maxHeight: "140px",
                      borderRadius: "6px",
                      boxShadow: "0 4px 20px rgba(0,0,0,0.5)",
                      pointerEvents: "none",
                    }}
                  />
                </div>

                {/* Connection line from marker to center */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: ORBIT_RADIUS + "px",
                    height: "1px",
                    background: "rgba(34,153,221,0.4)",
                    transformOrigin: "0 0",
                    transform: `${marker.rotation} rotateY(90deg)`,
                    pointerEvents: "none",
                  }}
                />

                {/* Camera marker */}
                <div
                  onPointerDown={startDragMarker}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    transformStyle: "preserve-3d",
                    transform: `${marker.position} ${marker.rotation}`,
                    cursor: "grab",
                    touchAction: "none",
                  }}
                >
                  {/* Camera body */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-14px",
                      top: "-10px",
                      width: "28px",
                      height: "20px",
                      borderRadius: "4px",
                      background: "linear-gradient(135deg, #3a3a3a, #1a1a1a)",
                      border: "1px solid #555",
                      boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
                      transform: "translateZ(-8px)",
                    }}
                  />
                  {/* Lens barrel */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-7px",
                      top: "-7px",
                      width: "14px",
                      height: "14px",
                      borderRadius: "50%",
                      background: "linear-gradient(135deg, #555, #333)",
                      border: "1px solid #666",
                      transform: "translateZ(2px)",
                    }}
                  />
                  {/* Lens glass */}
                  <div
                    style={{
                      position: "absolute",
                      left: "-5px",
                      top: "-5px",
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      background: "radial-gradient(circle, #44aaff 0%, #2299dd 50%, #114466 100%)",
                      boxShadow: "0 0 8px rgba(34,153,221,0.8)",
                      transform: "translateZ(5px)",
                    }}
                  />
                </div>
              </div>

              {/* Overlay UI */}
              <div
                className="absolute top-2 right-2 text-[10px] pointer-events-none px-2 py-0.5 rounded"
                style={{
                  color: "var(--canvas-text-dim)",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(4px)",
                }}
              >
                {t("angle.cameraPos")}: {azimuth}&#176; / {elevation}&#176;
              </div>
            </div>

            {/* Sliders */}
            <div className="flex flex-col gap-5" style={{ width: 210 }}>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.azimuth")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{azimuth}&#176;</span>
                </div>
                <Slider min={0} max={359} value={azimuth} tooltip={{ open: false }} onChange={(v) => { setAzimuth(v as number); setActivePreset("custom"); }} />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.elevation")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{elevation}&#176;</span>
                </div>
                <Slider min={-90} max={90} value={elevation} tooltip={{ open: false }} onChange={(v) => { setElevation(v as number); setActivePreset("custom"); }} />
              </div>
              <div>
                <div className="flex justify-between items-center mb-1">
                  <span className="text-xs" style={{ color: "var(--canvas-text-dim)" }}>{t("angle.zoom")}</span>
                  <span className="text-xs font-medium" style={{ color: "var(--canvas-text)" }}>{t(ZOOM_LABELS[zoom])}</span>
                </div>
                <Slider min={0} max={2} step={1} value={zoom} tooltip={{ open: false }} onChange={(v) => { setZoom(v as number); setActivePreset("custom"); }} />
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
              {t("angle.reset")}
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
