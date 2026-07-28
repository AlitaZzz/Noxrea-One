"use client";

import { ArrowUpOutlined } from "@ant-design/icons";
import { Button, Slider } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import WheelGuard from "@/components/common/WheelGuard";
import AppModal from "@/lib/app-modal";
import { useCanvasStore } from "@/stores/canvas-store";
import { useI18nStore } from "@/stores/i18n-store";

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

const ZOOM_LABELS = ["angle.zoom.near", "angle.zoom.mid", "angle.zoom.far"];

const DEFAULT_AZIMUTH = 0;
const DEFAULT_ELEVATION = 0;
const DEFAULT_ZOOM = 1;

/** Orbit radius in px (matches the CSS variable --orbit-r) */
const ORBIT_RADIUS = 120;

// Latitude rings to draw (degrees)
const LATITUDES = [-80, -60, -40, -20, 0, 20, 40, 60, 80];

export default function MultiAngleEditor({ src, sourceId, onClose }: Props) {
  const t = useI18nStore((s) => s.t);
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
          <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="h-4 w-4" viewBox="0 0 21.6 21.8">
            <path d="M10.9 0c1.35 0 2.5.77 3.36 1.87.79.99 1.41 2.31 1.84 3.82q.8.23 1.51.52c1.82.75 3.33 1.88 3.92 3.35a.9.9 0 0 1-1.66.68c-.33-.81-1.3-1.69-2.95-2.36a18 18 0 0 0-9.75-.7 18 18 0 0 0-.37 3.72 18 18 0 0 0 .38 3.72 18 18 0 0 0 8.47-.25l-1.95-.95a.9.9 0 1 1 .79-1.62l3.81 1.86a.9.9 0 0 1 .42 1.2l-1.86 3.82a.9.9 0 1 1-1.62-.8l.87-1.77a20 20 0 0 1-8.38.45q.2.55.44 1C9.03 19.29 10.04 20 10.9 20q.33 0 .66-.13a.9.9 0 0 1 .68 1.66q-.64.27-1.34.27c-1.9 0-3.39-1.52-4.34-3.43a13 13 0 0 1-.87-2.26 13 13 0 0 1-2.26-.87C1.53 14.3 0 12.81 0 10.9s1.52-3.39 3.43-4.34a13 13 0 0 1 2.26-.87q.36-1.24.87-2.26C7.51 1.53 9 0 10.9 0M5.25 7.73q-.55.2-1.02.44c-1.71.86-2.43 1.87-2.43 2.73s.72 1.87 2.43 2.73q.47.23 1.02.44a20 20 0 0 1 0-6.34M10.9 1.8c-.86 0-1.87.72-2.73 2.43q-.24.47-.44 1.02a20 20 0 0 1 6.33 0 8 8 0 0 0-1.2-2.26c-.68-.85-1.36-1.19-1.96-1.19" fill="currentColor" />
          </svg>
          {t("angle.editor.title")}
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
                {t("angle.camera.pos")}: {azimuth}&#176; / {elevation}&#176;
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
              className="px-4 py-1.5 rounded text-xs transition-all"
              style={{ border: "1px solid var(--canvas-border)", background: "transparent", color: "var(--canvas-text-dim)", cursor: "pointer" }}
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
