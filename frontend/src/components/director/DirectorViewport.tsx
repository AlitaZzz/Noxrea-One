"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { Stage } from "@/director/core/Stage";
import { CameraRig } from "@/director/core/CameraRig";
import { TransformGizmo } from "@/director/core/TransformGizmo";
import { Selection } from "@/director/core/Selection";
import { NavGizmo } from "@/director/core/NavGizmo";
import { Character } from "@/director/entities/Character";
import { Prop } from "@/director/entities/Prop";
import { Crowd } from "@/director/entities/Crowd";
import { CameraEntity } from "@/director/entities/Camera";
import { useDirectorStore } from "@/stores/director-store";

const XBOT = "/assets/Xbot.glb";
const BODY_TYPES: Record<string, { url: string; label: string; height: number; girth: number }> = {
  standard: { url: XBOT, label: "标准素体", height: 1.75, girth: 1.0 },
  tall: { url: XBOT, label: "高大素体", height: 2.05, girth: 1.06 },
  small: { url: XBOT, label: "矮小素体", height: 1.25, girth: 0.94 },
  broad: { url: XBOT, label: "宽厚素体", height: 1.7, girth: 1.3 },
  slim: { url: XBOT, label: "纤细素体", height: 1.78, girth: 0.8 },
};
const PROP_LABEL: Record<string, string> = { box: "方块", cylinder: "圆柱", sphere: "球体", mannequin: "人体素模" };

let _charLetter = 0;
let _propCount: Record<string, number> = {};
let _camCount = 0;

const D2R = Math.PI / 180;

export default function DirectorViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // ---- Three.js core ----
    const stage = new Stage(viewport);
    const rig = new CameraRig(stage.camera, stage.renderer.domElement, viewport, frameRef.current);

    const entities: any[] = [];
    let _selectedId: string | null = null;
    let _cancelled = false;
    const _labelEls: Map<string, HTMLElement> = new Map();
    const _labelTmp = new THREE.Vector3();
    let _labelsVisible = true;

    const _makeLabel = (ent: any) => {
      const d = document.createElement("div");
      d.className = ent.type === "camera" ? "label3d cam" : "label3d";
      d.textContent = ent.name;
      d.style.cssText = `position:absolute;transform:translate(-50%,${ent.type === "camera" ? "-160%" : "-135%"});background:${ent.type === "camera" ? "#ff8a3d" : "#fff"};color:${ent.type === "camera" ? "#1a0d00" : "#000"};font-size:${ent.type === "camera" ? "12px" : "15px"};font-weight:${ent.type === "camera" ? "600" : "700"};padding:${ent.type === "camera" ? "2px 9px" : "3px 11px"};border-radius:8px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.5);`;
      const layer = document.getElementById("dirLabelLayer");
      if (layer) layer.appendChild(d);
      _labelEls.set(ent.id, d);
    };

    const _updateLabels = () => {
      const layer = document.getElementById("dirLabelLayer");
      if (!layer || !_labelsVisible) return;
      const cam = stage.activeCamera || stage.camera;
      const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
      const update = (ent: any) => {
        const el = _labelEls.get(ent.id);
        if (!el || !ent.visible) { if (el) el.style.display = "none"; return; }
        ent.root.getWorldPosition(_labelTmp);
        _labelTmp.y += (ent.type === "camera" ? 0.2 : ent.height + 0.16);
        _labelTmp.project(cam);
        if (_labelTmp.z > 1) { el.style.display = "none"; return; }
        el.style.display = "block";
        el.style.left = (_labelTmp.x * 0.5 + 0.5) * W + "px";
        el.style.top = (-_labelTmp.y * 0.5 + 0.5) * H + "px";
      };
      for (const ent of entities) {
        if (ent.type === "crowd") { ent.members?.forEach((m: any) => update(m)); continue; }
        if (ent.type === "character" || ent.type === "camera") update(ent);
      }
    };

    // helpers
    const _registerEntity = (ent: any) => {
      _makeLabel(ent);
    };

    const _placeNew = (root: THREE.Object3D) => {
      const n = entities.length;
      root.position.set(Math.cos(n * 0.95) * Math.min(0.9 + n * 0.4, 3.2), 0,
        Math.sin(n * 0.95) * Math.min(0.9 + n * 0.4, 3.2));
    };
    const _sync = () => useDirectorStore.getState().setEntities(
      entities.map((e: any) => ({
        id: e.id, type: e.type, name: e.name, visible: e.visible,
        ...(e.type === "crowd" ? { _members: e.members.map((m: any) => ({ id: m.id, name: m.name, type: "character" as const, visible: m.visible })) } : {}),
      })) as any
    );

    // ---- Interaction ----
    const gizmo = new TransformGizmo(stage.camera, stage.renderer.domElement, stage.scene, rig.controls);
    const selection = new Selection(stage.renderer, stage.camera, stage.scene, () => entities, (id) => {
      _selectedId = id;
      useDirectorStore.getState().setSelectedId(id);
      if (id) {
        const ent = entities.find((e: any) => e.id === id) || null;
        if (ent) gizmo.attach(ent.root);
        selection.highlight(ent);
      } else { gizmo.detach(); selection.highlight(null); }
    });
    selection.setSkipPredicate(() => gizmo.dragging || gizmo.overAxis);
    gizmo.onObjectChange(() => { runtime._syncInspector?.(); });

    // Nav gizmo
    const navSvg = viewport.parentElement?.querySelector<SVGElement>("#navsvg");
    const navGizmo = navSvg ? new NavGizmo(navSvg, stage.camera, () => rig.resetView()) : null;

    // ---- Runtime API ----
    const runtime = {
      addCharacter: async (bodyType = "standard") => {
        const b = BODY_TYPES[bodyType] || BODY_TYPES.standard;
        const name = "角色" + String.fromCharCode(65 + _charLetter++);
        try {
          const c = await Character.load(name, b.url, { height: b.height, girth: b.girth });
          if (_cancelled) { c.dispose(); return null; }
          c._srcUrl = b.url; c._opts = { height: b.height, girth: b.girth };
          _placeNew(c.root); stage.add(c.root); entities.push(c);
          c.applyPosePreset("stand"); _sync(); _registerEntity(c);
          selection.onSelect(c.id); rig.focus(c);
          return c;
        } catch (err) { console.error("addCharacter", err); return null; }
      },
      addProp: (kind = "box") => {
        _propCount[kind] = (_propCount[kind] || 0) + 1;
        const name = (PROP_LABEL[kind] || "道具") + _propCount[kind];
        const prop = new Prop(kind as any, name);
        _placeNew(prop.root); stage.add(prop.root); entities.push(prop);
        _sync(); selection.onSelect(prop.id);
        return prop;
      },
      addCamera: () => {
        const name = "机位" + ++_camCount;
        const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
        const cam = new CameraEntity(name, { fov: 40, aspect: W / Math.max(1, H), scene: stage.scene });
        cam.root.position.set(0, 1.7, 4); cam.aimAt(new THREE.Vector3(0, 1.0, 0));
        stage.add(cam.root); entities.push(cam); _registerEntity(cam);
        _sync(); selection.onSelect(cam.id);
        return cam;
      },
      addCrowd: async (rows = 3, cols = 3, spacing = 1.2) => {
        rows = Math.max(1, Math.min(6, Math.round(rows)));
        cols = Math.max(1, Math.min(6, Math.round(cols)));
        spacing = Math.max(0.5, Math.min(5, spacing));
        const b = BODY_TYPES.standard;
        const PALETTE = [0x4f8ef7, 0xff9f43, 0xee5253, 0x10ac84, 0xfeca57, 0xa55eea, 0x00d2d3, 0xff6b9d, 0x9b59b6];
        const group = new THREE.Group();
        const members: any[] = [];
        const w = (cols - 1) * spacing, d = (rows - 1) * spacing;
        let idx = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++, idx++) {
            let ch: any;
            try {
              ch = await Character.load("角色" + String.fromCharCode(65 + _charLetter++), b.url, b);
            } catch (err) { console.error("addCrowd char", err); continue; }
            if (_cancelled) { ch.dispose(); return null; }
            ch.setColor(PALETTE[idx % PALETTE.length]);
            ch.root.position.set(c * spacing - w / 2, 0, r * spacing - d / 2);
            ch.applyPosePreset("stand");
            group.add(ch.root);
            members.push(ch);
          }
        }
        if (!members.length) return null;
        const crowd = new Crowd(`群众 (${rows}x${cols})`, group, members, { rows, cols, spacing });
        for (const m of members) m.root.userData.entityId = crowd.id;
        stage.add(group);
        entities.push(crowd as any);
        _placeNew(crowd.root); // 放在空白区
        _sync(); selection.onSelect(crowd.id);
        return crowd;
      },
      remove: (id: string) => {
        const idx = entities.findIndex((e: any) => e.id === id);
        if (idx < 0) return;
        const ent = entities[idx];
        const lbl = _labelEls.get(id); if (lbl) { lbl.remove(); _labelEls.delete(id); }
        stage.remove(ent.root); ent.dispose?.(); entities.splice(idx, 1); _sync();
        if (_selectedId === id) { gizmo.detach(); selection.highlight(null); useDirectorStore.getState().setSelectedId(null); }
      },
      select: (id: string | null) => {
        _selectedId = id;
        useDirectorStore.getState().setSelectedId(id);
        if (id) {
          const ent = entities.find((e: any) => e.id === id) || null;
          if (ent) gizmo.attach(ent.root);
          selection.highlight(ent);
        } else { gizmo.detach(); selection.highlight(null); }
      },
      setTransformMode: (mode: string) => {
        gizmo.setMode(mode); useDirectorStore.getState().setTransformMode(mode as any);
      },
      setCameraView: (on: boolean) => {
        useDirectorStore.getState().setCameraView(on);
        if (on) {
          const selEnt = entities.find((e: any) => e.id === _selectedId);
          if (selEnt?.type === "camera") {
            stage.activeCamera = selEnt.cam;
            rig.controls.enabled = false;
          }
        } else {
          stage.activeCamera = null;
          rig.controls.enabled = true;
        }
      },
      setRatio: (r: string) => {
        rig.setRatio(r);
        useDirectorStore.getState().setRatio(r);
      },
      setSceneScale: (s: number) => {
        stage.setWorldScale(s);
        useDirectorStore.getState().setSceneState({ scale: s });
      },
      setSkyColor: (hex: string) => {
        stage.setSkyColor(hex);
        useDirectorStore.getState().setSceneState({ sky: hex });
      },
      setLabelsVisible: (v: boolean) => {
        _labelsVisible = v;
        const layer = document.getElementById("dirLabelLayer");
        if (layer) layer.style.display = v ? "block" : "none";
        useDirectorStore.getState().setSceneState({ labels: v });
      },
      setGroundVisible: (v: boolean) => {
        stage.setGroundVisible(v);
        useDirectorStore.getState().setSceneState({ ground: { ...useDirectorStore.getState().sceneState.ground, visible: v } });
      },
      setGroundOpacity: (v: number) => {
        stage.setGroundOpacity(v);
        useDirectorStore.getState().setSceneState({ ground: { ...useDirectorStore.getState().sceneState.ground, opacity: v } });
      },
      setGroundHeight: (y: number) => {
        stage.setGroundHeight(y);
        useDirectorStore.getState().setSceneState({ ground: { ...useDirectorStore.getState().sceneState.ground, height: y } });
      },
      setScenePos: (axis: string, v: number) => {
        const st = useDirectorStore.getState().sceneState;
        st.pos[axis as "x"|"y"|"z"] = v;
        stage.setWorldPos(st.pos.x, st.pos.y, st.pos.z);
        useDirectorStore.getState().setSceneState({ pos: { ...st.pos } });
      },
      setSceneRot: (axis: string, deg: number) => {
        const st = useDirectorStore.getState().sceneState;
        st.rot[axis as "x"|"y"|"z"] = deg;
        stage.setWorldRot(st.rot.x * D2R, st.rot.y * D2R, st.rot.z * D2R);
        useDirectorStore.getState().setSceneState({ rot: { ...st.rot } });
      },
      applyPosePreset: (characterId: string, presetKey: string) => {
        const ent = entities.find((e: any) => e.id === characterId);
        if (ent?.type === "character") ent.applyPosePreset(presetKey);
      },
      setJointValue: (characterId: string, jointKey: string, value: number) => {
        const ent = entities.find((e: any) => e.id === characterId);
        if (ent?.type === "character") { ent.values[jointKey] = value; ent.enterManual(); ent.applyPose(); ent.currentPreset = null; }
      },
      captureShot: () => {
        stage.render();
        return { dataURL: stage.renderer.domElement.toDataURL("image/png"), label: `截图 ${new Date().toLocaleTimeString()}` };
      },
      sendShotToCanvas: async () => {},
      resetView: () => rig.resetView(),
      toggleVisible: (id: string) => {
        const ent = entities.find((e: any) => e.id === id);
        if (ent) { ent.setVisible(!ent.visible); _sync(); }
      },
      setEntityColor: (id: string, hex: string) => {
        const ent = entities.find((e: any) => e.id === id);
        if (ent?.setColor) ent.setColor(hex);
      },
      _getEntity: (id: string) => entities.find((e: any) => e.id === id) || null,
      _getStage: () => stage,
      _getPoseValues: (id: string) => {
        const ent = entities.find((e: any) => e.id === id);
        return ent?.type === "character" ? { ...ent.values } : {};
      },
      _syncInspector: null as (() => void) | null,
      rename: (id: string, name: string) => {
        const ent = entities.find((e: any) => e.id === id || e.members?.some((m: any) => m.id === id));
        if (!ent) return;
        // Check if it's a crowd member
        if (ent.type === "crowd") {
          const m = ent.members.find((m: any) => m.id === id);
          if (m) { m.name = name.trim() || m.name; }
        } else {
          ent.name = name.trim() || ent.name;
        }
        _sync();
      },
      ungroupCrowd: (id: string) => {
        const idx = entities.findIndex((e: any) => e.id === id);
        if (idx < 0) return;
        const crowd = entities[idx];
        if (crowd.type !== "crowd") return;
        crowd.root.updateMatrixWorld(true);
        const members = crowd.members.slice();
        for (const m of members) {
          const mat = new THREE.Matrix4().multiplyMatrices(crowd.root.matrix, m.root.matrix);
          stage.add(m.root);
          mat.decompose(m.root.position as any, m.root.quaternion as any, m.root.scale as any);
          m.root.userData.entityId = m.id;
          entities.push(m);
        }
        stage.remove(crowd.root);
        entities.splice(idx, 1);
        _sync();
        gizmo.detach(); selection.highlight(null);
        useDirectorStore.getState().setSelectedId(null);
      },
      _broadcastPosePreset: (crowdId: string, presetKey: string) => {
        const crowd = entities.find((e: any) => e.id === crowdId);
        if (crowd?.type !== "crowd") return;
        crowd.members.forEach((m: any) => m.applyPosePreset(presetKey));
      },
      _broadcastResetPose: (crowdId: string) => {
        const crowd = entities.find((e: any) => e.id === crowdId);
        if (crowd?.type !== "crowd") return;
        crowd.members.forEach((m: any) => { m.resetPose(); m.currentPreset = null; });
      },
      groupCharacters: (ids: string[]) => {
        const members = ids.map((id) => entities.find((e: any) => e.id === id))
          .filter((e: any) => e && e.type === "character");
        if (members.length < 2) return null;
        const centroid = new THREE.Vector3();
        for (const m of members) { m.root.updateMatrixWorld(true); centroid.add(m.root.getWorldPosition(new THREE.Vector3())); }
        centroid.divideScalar(members.length);
        const group = new THREE.Group(); group.position.copy(centroid);
        stage.add(group); group.updateMatrixWorld(true);
        for (const m of members) group.attach(m.root);
        const crowd = new Crowd("组" + (Math.random() * 100 | 0), group, members as any);
        for (const m of members) m.root.userData.entityId = crowd.id;
        // Remove members from top-level, add crowd
        for (const m of members) {
          const idx = entities.indexOf(m as any);
          if (idx >= 0) entities.splice(idx, 1);
        }
        entities.push(crowd as any);
        _sync(); selection.onSelect(crowd.id);
        return crowd;
      },
      duplicateMany: (ids: string[]) => {
        const list = ids.map((id) => entities.find((e: any) => e.id === id)).filter(Boolean);
        const OFF = new THREE.Vector3(0.6, 0, 0.6);
        let last: any = null;
        for (const ent of list) {
          if (ent.type === "character") {
            const srcUrl = ent._srcUrl || XBOT;
            Character.load("角色" + String.fromCharCode(65 + _charLetter++), srcUrl, ent._opts || {})
              .then((c: Character) => {
                if (_cancelled) { c.dispose(); return; }
                c._srcUrl = srcUrl; c._opts = ent._opts;
                c.root.position.copy(ent.root.position).add(OFF);
                c.root.quaternion.copy(ent.root.quaternion);
                c.root.scale.copy(ent.root.scale);
                c.setColor(ent.color);
                Object.assign(c.values, ent.values); c.applyPose();
                stage.add(c.root); entities.push(c); last = c; _sync();
              }).catch(() => {});
          } else if (ent.type === "prop") {
            const p = new Prop(ent.kind, ent.name + "副本");
            p.root.position.copy(ent.root.position).add(OFF);
            p.root.quaternion.copy(ent.root.quaternion);
            p.root.scale.copy(ent.root.scale);
            p.setColor(ent.color);
            stage.add(p.root); entities.push(p); last = p; _sync();
          }
        }
        if (last) selection.onSelect(last.id);
      },
      toggleVisibleMany: (ids: string[]) => {
        const list = ids.map((id) => entities.find((e: any) => e.id === id)).filter(Boolean);
        if (!list.length) return;
        const target = !list.some((e: any) => e.visible);
        for (const e of list) { if (e.visible !== target) e.setVisible(target); }
        _sync();
      },
    };
    useDirectorStore.getState().setRuntime(runtime as any);

    // ---- Loop ----
    const tick = (dt: number) => {
      for (const ent of entities) {
        if (ent.type === "character") ent.update(dt);
        else if (ent.type === "camera") ent.update();
        else if (ent.type === "crowd") ent.members?.forEach((m: any) => m.update(dt));
      }
      rig.update(); selection.update(); navGizmo?.update();
      _updateLabels();
    };
    stage.startLoop(tick);

    // ---- Seed ----
    (async () => {
      const c = await Character.load("角色A", XBOT, { height: 1.75, girth: 1.0 });
      if (_cancelled) { c.dispose(); return; }
      c.applyPosePreset("stand"); stage.add(c.root); entities.push(c); _registerEntity(c);
      rig.frameAll(entities); _sync();
    })();

    // ---- Resize + keyboard ----
    const onResize = () => { stage.onResize(); rig.onResize(); };
    window.addEventListener("resize", onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.target && (e.target as HTMLElement).tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      if (k === "v") runtime.setTransformMode("translate");
      else if (k === "r") runtime.setTransformMode("rotate");
      else if (k === "s") runtime.setTransformMode("scale");
      else if (e.key === "Delete" || e.key === "Backspace") { if (_selectedId) runtime.remove(_selectedId); }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      _cancelled = true;
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKey);
      for (const ent of entities) ent.dispose?.();
      stage.dispose(); useDirectorStore.getState().setRuntime(null);
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={viewportRef} className="absolute inset-0" />
      <div ref={frameRef} className="absolute pointer-events-none border-2 border-white/40" style={{ display: "none" }} />
      <div id="dirLabelLayer" className="absolute inset-0 pointer-events-none overflow-hidden" />
      <div className="absolute z-[5] text-center cursor-pointer" style={{ top: 18, right: 18, width: 74 }} title="重置视角">
        <svg width="74" height="74" viewBox="0 0 74 74" id="navsvg" style={{ display: "block", background: "rgba(20,20,24,.66)", border: "1px solid var(--dir-line2)", borderRadius: "50%" }}>
          <circle cx="37" cy="37" r="3" fill="#3a3a40" />
        </svg>
        <div className="text-[11.5px] mt-1.5" style={{ color: "var(--dir-dim)" }}>重置视角</div>
      </div>
    </div>
  );
}
