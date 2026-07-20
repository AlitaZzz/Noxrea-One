"use client";

import { useState } from "react";
import { Tooltip, Popover, InputNumber, message } from "antd";
import { useDirectorStore } from "@/stores/director-store";
import { groupedPresets } from "@/director/core/cameraPresets";

const IC: Record<string, string> = {
  pointer: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 3l15 8-6 1.6L11 19z"/></svg>`,
  move: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3v18M3 12h18"/><path d="M12 3l-2.4 2.6M12 3l2.4 2.6M12 21l-2.4-2.6M12 21l2.4-2.6M3 12l2.6-2.4M3 12l2.6-2.4M21 12l-2.6-2.4M21 12l-2.6-2.4"/></svg>`,
  rotate: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/></svg>`,
  scale: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 3h-6M21 3v6M21 3l-7 7"/><path d="M3 21h6M3 21v-6M3 21l7-7"/></svg>`,
  person: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="5.5" r="2.4"/><path d="M12 8.4c-2.4 0-4 1.6-4 4v3M12 8.4c2.4 0 4 1.6 4 4v3M9 21v-5M15 21v-5"/></svg>`,
  cube: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 3v18M4 7.5l8 4.5 8-4.5"/></svg>`,
  video: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="12" height="12" rx="2"/><path d="M15 10l6-3v10l-6-3"/></svg>`,
  shot: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8h3l1.5-2h7L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.2"/></svg>`,
  expand: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 9V4h5M20 15v5h-5M4 4l6 6M20 20l-6-6"/></svg>`,
  frame: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 16V5M8 9l4-4 4 4M5 19h14"/></svg>`,
  image: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6"/><path d="M21 16l-5-5-4 4-2-2-7 7"/></svg>`,
  group: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="7" cy="7" r="2.1"/><circle cx="17" cy="7" r="2.1"/><circle cx="7" cy="17" r="2.1"/><circle cx="17" cy="17" r="2.1"/></svg>`,
};
const S = (n: string) => IC[n] || "";
const BODY = [["standard","标准素体"],["tall","高大素体"],["small","矮小素体"],["broad","宽厚素体"],["slim","纤细素体"]];
const GEO = [["box","方块"],["cylinder","圆柱"],["sphere","球体"],["mannequin","人体素模"]];
const RATIOS = [["auto","Auto"],["21:9","21:9"],["16:9","16:9"],["4:3","4:3"],["1:1","1:1"],["3:4","3:4"],["9:16","9:16"]];
const TF_ICON: Record<string,string> = {translate:"move",rotate:"rotate",scale:"scale"};
const cameraPresets = groupedPresets();

// 群众阵列表单
function CrowdForm({ runtime }: { runtime: any }) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [spacing, setSpacing] = useState(1.2);
  const MAX = 6;

  return (
    <div style={{ padding: 12, background: "var(--dir-panel)", borderRadius: 12, border: "1px solid var(--dir-line2)" }}>
      <div style={{ fontSize: 11, color: "var(--dir-dim2)", marginBottom: 8 }}>
        群众阵列 · 共{rows * cols}人
      </div>
      <div className="flex items-center gap-2 mb-2" style={{ fontSize: 12 }}>
        <span style={{ color: "var(--dir-dim)" }}>间距</span>
        <InputNumber size="small" min={0.5} max={5} step={0.1} value={spacing}
          style={{ flex: 1, background: "var(--dir-panel2)", border: "1px solid transparent", borderRadius: 8, color: "var(--dir-txt)" }}
          onChange={(v) => { if (v != null) setSpacing(v); }} />
      </div>
      <div className="flex justify-center">
        <div className="inline-grid gap-px" style={{
          gridTemplateColumns: `repeat(${MAX}, 16px)`,
          background: "var(--dir-line2)",
          borderRadius: 3, overflow: "hidden",
        }}>
          {Array.from({ length: MAX * MAX }).map((_, i) => {
            const r = Math.floor(i / MAX) + 1;
            const c = (i % MAX) + 1;
            const active = r <= rows && c <= cols;
            return (
              <div key={i} style={{ width: 16, height: 16, background: active ? "var(--dir-txt)" : "var(--dir-panel2)", cursor: "pointer" }}
                onMouseEnter={() => { setRows(r); setCols(c); }}
                onClick={() => runtime?.addCrowd?.(r, c, spacing)} />
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Dock() {
  const runtime = useDirectorStore((s) => s.runtime);
  const transformMode = useDirectorStore((s) => s.transformMode);
  const ratio = useDirectorStore((s) => s.ratio);

  // 菜单 open 状态（click trigger）
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [panoMenuOpen, setPanoMenuOpen] = useState(false);
  const [camMenuOpen, setCamMenuOpen] = useState(false);
  const [ratioMenuOpen, setRatioMenuOpen] = useState(false);

  const dockBtn = (icon: string, title: string, onClick: () => void, active = false, hideTooltip = false) => (
    <Tooltip title={title} key={title} mouseEnterDelay={0.5} open={hideTooltip ? false : undefined}>
      <button onClick={onClick}
        style={{
          width: 40, height: 38, borderRadius: 9, border: "none", background: active ? "var(--toolbar-btn-active)" : "none",
          color: active ? "var(--dir-txt)" : "var(--toolbar-btn-color)", cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "center", transition: ".12s",
        }}
        onMouseEnter={(e) => { if (!active) { (e.target as HTMLElement).style.background = "var(--toolbar-btn-hover)"; (e.target as HTMLElement).style.color = "var(--dir-txt)"; } }}
        onMouseLeave={(e) => { if (!active) { (e.target as HTMLElement).style.background = "none"; (e.target as HTMLElement).style.color = "var(--toolbar-btn-color)"; } }}
        dangerouslySetInnerHTML={{ __html: S(icon) }} />
    </Tooltip>
  );

  const menuItem = (icon: string, label: string, onClick: () => void, checked = false, hasSub = false) => (
    <button key={label} onClick={onClick}
      className="flex items-center gap-[11px] w-full text-left rounded-lg text-[13px] cursor-pointer border-0 bg-transparent hover:bg-[var(--menu-item-hover)]"
      style={{ padding: "9px 12px", color: "var(--dir-txt)" }}>
      {icon ? <span className="w-[20px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }} dangerouslySetInnerHTML={{ __html: S(icon) }} /> : <span className="w-[20px]" />}
      <span className="flex-1">{label}</span>
      {hasSub && <span className="ml-auto" style={{ color: "var(--dir-dim)" }} dangerouslySetInnerHTML={{ __html: S("chevron") }} />}
      {checked && <span className="text-blue-500 text-xs ml-auto">✓</span>}
    </button>
  );

  const menuContent = (children: React.ReactNode, minWidth = 200) => (
    <div className="flex flex-col gap-0.5" style={{ padding: 6, minWidth, background: "var(--menu-bg)", borderRadius: 12, border: "1px solid var(--dir-line2)" }}>
      {children}
    </div>
  );

  const closeAddMenu = () => setAddMenuOpen(false);

  return (
    <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-2xl z-10"
      style={{ background: "var(--toolbar-bg)", border: "1px solid var(--dir-line2)", boxShadow: "0 10px 34px rgba(0,0,0,.55)", bottom: 24, padding: "8px 12px" }}>
      {/* 变换模式 */}
      {dockBtn(TF_ICON.translate, "移动 (V)", () => runtime?.setTransformMode("translate"), transformMode === "translate")}
      {dockBtn(TF_ICON.rotate, "旋转 (R)", () => runtime?.setTransformMode("rotate"), transformMode === "rotate")}
      {dockBtn(TF_ICON.scale, "缩放 (S)", () => runtime?.setTransformMode("scale"), transformMode === "scale")}

      {/* 分隔 */}
      <span style={{ width: 1, height: 22, background: "var(--dir-line2)", margin: "0 4px" }} />

      {/* 添加角色/模型 */}
      <Popover trigger="click" zIndex={1050} placement="top"
        open={addMenuOpen} onOpenChange={setAddMenuOpen}
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={menuContent(
          <>
            {BODY.map(([k, l]) => menuItem("person", l, () => { runtime?.addCharacter(k); closeAddMenu(); }))}
            <div className="h-px mx-1 my-1.5" style={{ background: "var(--dir-line2)" }} />
            <Popover trigger="hover" zIndex={1050} placement="rightTop"
              styles={{ container: { padding: 0, background: "transparent" } }}
              content={<CrowdForm runtime={runtime} />}>
              <div>{menuItem("group", "群众 (3x3)", () => {}, false, true)}</div>
            </Popover>
            <div className="h-px mx-1 my-1.5" style={{ background: "var(--dir-line2)" }} />
            <Popover trigger="hover" zIndex={1050} placement="rightTop"
              styles={{ container: { padding: 0, background: "transparent" } }}
              content={menuContent(
                <>{GEO.map(([k, l]) => menuItem("cube", l, () => { runtime?.addProp(k); closeAddMenu(); }))}</>, 150
              )}>
              <div>{menuItem("cube", "几何模型", () => {}, false, true)}</div>
            </Popover>
          </>
        )}>
        <div>{dockBtn("person", "添加角色/模型", () => {}, false, addMenuOpen)}</div>
      </Popover>

      {/* 全景图 */}
      <Popover trigger="click" zIndex={1050} placement="top"
        open={panoMenuOpen} onOpenChange={setPanoMenuOpen}
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={menuContent(
        <label className="flex items-center gap-[11px] px-3 py-[9px] rounded-lg text-[13px] cursor-pointer hover:bg-[var(--menu-item-hover)]"
          style={{ color: "var(--dir-txt)" }}>
          <span className="w-[20px] flex items-center justify-center" style={{ color: "var(--dir-dim)" }} dangerouslySetInnerHTML={{ __html: S("upload") }} />
          <span className="flex-1">本地上传</span>
          <input type="file" accept="image/*" className="hidden" />
        </label>, 160
      )}>
        <div>{dockBtn("image", "全景图", () => {}, false, panoMenuOpen)}</div>
      </Popover>

      {/* 添加机位 */}
      <Popover trigger="click" zIndex={1050} placement="top"
        open={camMenuOpen} onOpenChange={setCamMenuOpen}
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={menuContent(
        cameraPresets.map((g) => (
          <div key={g.name}>
            <div style={{ fontSize: 11, color: "var(--dir-dim2)", padding: "8px 12px 4px", letterSpacing: ".4px" }}>{g.name}</div>
            {g.items.map((p) => menuItem("video", p.label, () => { runtime?.addCamera?.(p.key); setCamMenuOpen(false); }, false))}
          </div>
        )), 184
      )}>
        <div>{dockBtn("video", "添加机位(预设)", () => {}, false, camMenuOpen)}</div>
      </Popover>

      {/* 分隔 */}
      <span style={{ width: 1, height: 22, background: "var(--dir-line2)", margin: "0 4px" }} />

      {/* 取景比例 */}
      <Popover trigger="click" zIndex={1050} placement="top"
        open={ratioMenuOpen} onOpenChange={setRatioMenuOpen}
        styles={{ container: { padding: 0, background: "transparent" } }}
        content={menuContent(
        RATIOS.map(([v, l]) => menuItem("", l, () => { runtime?.setRatio(v); setRatioMenuOpen(false); }, ratio === v))
      , 150)}>
        <div>{dockBtn("frame", "取景比例", () => {}, false, ratioMenuOpen)}</div>
      </Popover>

      {/* 截图 */}
      {dockBtn("shot", "截图", async () => {
        const shot = await runtime?.captureShot();
        if (shot) {
          useDirectorStore.getState().addShot({
            id: "s"+Date.now(), url: shot.url, name: shot.name, cameraId: shot.cameraId, createdAt: Date.now(),
          });
          message.success(shot.name);
        }
      })}

    </div>
  );
}
