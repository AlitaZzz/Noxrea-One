/**
 * 3D 导演台的三维视口与运行时宿主。
 * 负责初始化 Three.js 舞台、相机装置、选择与变换控件、导航小方块，
 * 管理角色 / 群组 / 道具 / 相机等实体的增删与场景状态的存取，
 * 并把渲染结果出图后回传画布生成图片节点。是本模块的核心，体量最大。
 */
"use client";

import { App } from "antd";
import { useEffect, useRef } from "react";
import * as THREE from "three";

import type { CameraPresetCtx } from "@/features/director/core/camera-presets";
import { CAMERA_PRESETS } from "@/features/director/core/camera-presets";
import { CameraRig } from "@/features/director/core/camera-rig";
import { NavGizmo } from "@/features/director/core/nav-gizmo";
import { Selection } from "@/features/director/core/selection";
import { Stage } from "@/features/director/core/stage";
import { TransformGizmo } from "@/features/director/core/transform-gizmo";
import { DirectorRuntime, useDirectorStore } from "@/features/director/director-store";
import { CameraEntity } from "@/features/director/entities/camera";
import { Character } from "@/features/director/entities/character";
import { Crowd } from "@/features/director/entities/crowd";
import { Prop } from "@/features/director/entities/prop";
import { NavSvg } from "@/components/ui/icons/director/NavSvg";
import type { DirectorEntity, DirectorEntityMeta } from "@/features/director/types";
import { worldBox } from "@/features/director/util/measure";
import { createNodeFromUrl,uploadBlob } from "@/lib/utils/image-utils";
import type { DirectorEntityState, DirectorStateData } from "@/features/canvas/types";
import { useCanvasStore } from "@/features/canvas/stores/canvas-store";

type _SceneSnapshot = {
  scale?: number;
  pos?: { x: number; y: number; z: number };
  rot?: { x: number; y: number; z: number };
  sky?: string;
  labels?: boolean;
  ground?: { visible?: boolean; opacity?: number; height?: number };
};
const XBOT = "/assets/Xbot.glb";
const BODY_TYPES: Record<string, { url: string; label: string; height: number; girth: number }> = {
  standard: { url: XBOT, label: "标准素体", height: 1.75, girth: 1.0 },
  tall: { url: XBOT, label: "高大素体", height: 2.05, girth: 1.06 },
  small: { url: XBOT, label: "矮小素体", height: 1.25, girth: 0.94 },
  broad: { url: XBOT, label: "宽厚素体", height: 1.7, girth: 1.3 },
  slim: { url: XBOT, label: "纤细素体", height: 1.78, girth: 0.8 },
};
const PROP_LABEL: Record<string, string> = { box: "方块", cylinder: "圆柱", sphere: "球体", mannequin: "人体素模" };

let _propCount: Record<string, number> = {};
let _camCount = 0;
let _cameraAttrChangeCb: (() => void) | null = null;
let _syncInspectorCb: (() => void) | null = null;

function getBodyType(ent: DirectorEntity): string {
  if (!(ent instanceof Character)) return "standard";
  const h = ent._opts?.height, g = ent._opts?.girth;
  if (h === 2.05 && g === 1.06) return "tall";
  if (h === 1.25 && g === 0.94) return "small";
  if (h === 1.7 && g === 1.3) return "broad";
  if (h === 1.78 && g === 0.8) return "slim";
  return "standard";
}

function setTransform(root: THREE.Object3D, pos: [number, number, number], rot: [number, number, number, number], scale: [number, number, number]) {
  root.position.set(...pos);
  root.quaternion.set(...rot);
  root.scale.set(...scale);
}

const D2R = Math.PI / 180;

export default function DirectorViewport() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const { notification } = App.useApp();

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // ---- Three.js core ----
    const stage = new Stage(viewport);
    const rig = new CameraRig(stage.camera, stage.renderer.domElement, viewport, frameRef.current);

    const entities: DirectorEntity[] = [];
    let _selectedId: string | null = null;
    let _activeCamId: string | null = null;
    let _cameraView = false;
    let _cancelled = false;
    const _labelEls: Map<string, HTMLElement> = new Map();
    const _labelTmp = new THREE.Vector3();
    let _labelsVisible = true;

    const _makeLabel = (ent: DirectorEntity) => {
      const d = document.createElement("div");
      d.className = ent.type === "camera" ? "label3d cam" : "label3d";
      d.textContent = ent.name;
      d.style.cssText = `position:absolute;transform:translate(-50%,${ent.type === "camera" ? "-160%" : "-135%"});background:${ent.type === "camera" ? "#ff8a3d" : "#fff"};color:${ent.type === "camera" ? "#1a0d00" : "#000"};font-size:${ent.type === "camera" ? "12px" : "15px"};font-weight:${ent.type === "camera" ? "600" : "700"};padding:${ent.type === "camera" ? "2px 9px" : "3px 11px"};border-radius:8px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.5);`;
      const layer = document.getElementById("dirLabelLayer");
      if (layer) layer.appendChild(d);
      _labelEls.set(ent.id, d);
    };

    // 确保实体有标签（已存在则跳过，避免重复创建残留 DOM）
    const _ensureLabel = (ent: DirectorEntity) => {
      if (_labelEls.has(ent.id)) return;
      _makeLabel(ent);
    };

    const _updateLabels = () => {
      const layer = document.getElementById("dirLabelLayer");
      if (!layer || !_labelsVisible) return;
      const cam = stage.activeCamera || stage.camera;
      const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
      const update = (ent: DirectorEntity) => {
        const el = _labelEls.get(ent.id);
        if (!el || !ent.visible) { if (el) el.style.display = "none"; return; }
        // 相机视角下隐藏相机名牌
        if (ent.type === "camera" && _cameraView) { el.style.display = "none"; return; }
        const ws = stage.world.scale.y;
        // 角色标签跟随 Head 骨(身体组旋转/躺地后仍贴脑袋);其他实体用脚底+高度
        if (ent instanceof Character && typeof ent.getLabelAnchor === "function") {
          ent.getLabelAnchor(_labelTmp);
          _labelTmp.y += 0.2 * ws;
        } else {
          ent.root.getWorldPosition(_labelTmp);
          const h = (ent as { height?: number }).height ?? 0;
          _labelTmp.y += (ent.type === "camera" ? 0.2 : h + 0.16) * ws;
        }
        _labelTmp.project(cam);
        if (_labelTmp.z > 1) { el.style.display = "none"; return; }
        el.style.display = "block";
        el.style.left = (_labelTmp.x * 0.5 + 0.5) * W + "px";
        el.style.top = (-_labelTmp.y * 0.5 + 0.5) * H + "px";
      };
      for (const ent of entities) {
        if (ent instanceof Crowd) { ent.members.forEach((m: Character) => update(m)); continue; }
        if (ent.type === "character" || ent.type === "camera") update(ent);
      }
    };

    // helpers
    const _registerEntity = (ent: DirectorEntity) => {
      _makeLabel(ent);
    };

    // 遍历所有实体（含 crowd 成员）
    const _forEachEntity = (fn: (e: DirectorEntity) => void) => {
      for (const ent of entities) {
        fn(ent);
        if (ent instanceof Crowd) ent.members.forEach(fn);
      }
    };

    // 推算下一个可用角色名（角色A..角色Z），跳过现有角色名与本次已分配字母
    const _nextCharName = (reserved: Set<string> = new Set()) => {
      _forEachEntity((e: DirectorEntity) => {
        if (e.type === "character" && typeof e.name === "string" && e.name.startsWith("角色")) {
          const letter = e.name.slice(2);
          if (letter.length === 1 && letter >= "A" && letter <= "Z") reserved.add(letter);
        }
      });
      for (let i = 0; i < 26; i++) {
        const ch = String.fromCharCode(65 + i);
        if (!reserved.has(ch)) { reserved.add(ch); return "角色" + ch; }
      }
      return "角色" + (reserved.size + 1);
    };

    // 序列化实体（顶层与 crowd 成员共用）
    const _serializeEntity = (ent: DirectorEntity): DirectorEntityState => {
      const base: DirectorEntityState = {
        id: ent.id, type: ent.type as DirectorEntityState["type"], name: ent.name, visible: ent.visible,
        pos: ent.root.position.toArray() as [number, number, number],
        rot: ent.root.quaternion.toArray() as [number, number, number, number],
        scale: ent.root.scale.toArray() as [number, number, number],
      };
      if (ent instanceof Character) return { ...base, type: "character", bodyType: getBodyType(ent), color: "#" + ent.color.toString(16).padStart(6, "0"), srcUrl: ent._srcUrl, pose: { mode: ent.poseMode, preset: ent.currentPreset, values: ent.poseMode === "manual" ? { ...ent.values } : undefined } };
      if (ent instanceof Prop) return { ...base, type: "prop", kind: ent.kind, color: "#" + ent.color.toString(16).padStart(6, "0") };
      if (ent instanceof CameraEntity) return { ...base, type: "camera", fov: ent.fov, roll: ent._roll || 0 };
      return base;
    };

    // 反序列化实体（顶层与 crowd 成员共用，返回实体不 add/push）
    const _deserializeEntity = async (e: DirectorEntityState): Promise<DirectorEntity | null> => {
      if (e.type === "character") {
        const bodyType = e.bodyType || "standard";
        const b = BODY_TYPES[bodyType] || BODY_TYPES.standard;
        const ch = await Character.load(e.name, e.srcUrl || b.url, { height: b.height, girth: b.girth });
        if (_cancelled) { ch.dispose(); return null; }
        ch._srcUrl = e.srcUrl || b.url; ch._opts = { height: b.height, girth: b.girth };
        ch.id = e.id;
        if (e.color) ch.setColor(parseInt(e.color.slice(1), 16));
        setTransform(ch.root, e.pos, e.rot, e.scale);
        ch.setVisible(e.visible);
        if (e.pose?.mode === "manual" && e.pose.values) {
          Object.assign(ch.values, e.pose.values); ch.enterManual(); ch.applyPose(); ch.currentPreset = null;
        } else if (e.pose?.preset) {
          ch.applyPosePreset(e.pose.preset);
        } else {
          ch.applyPosePreset("stand");
        }
        return ch;
      }
      if (e.type === "prop") {
        const p = new Prop(e.kind as "box"|"cylinder"|"sphere"|"mannequin" ?? "box", e.name);
        p.id = e.id;
        if (e.color) p.setColor(parseInt(e.color.slice(1), 16));
        setTransform(p.root, e.pos, e.rot, e.scale);
        p.setVisible(e.visible);
        return p;
      }
      if (e.type === "camera") {
        const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
        const cam = new CameraEntity(e.name, { fov: e.fov || 40, aspect: W / Math.max(1, H), scene: stage.scene });
        cam.id = e.id;
        setTransform(cam.root, e.pos, e.rot, e.scale);
        if (e.roll) cam._roll = e.roll;
        cam.setVisible(e.visible);
        return cam;
      }
      return null;
    };

    const _placeNew = (root: THREE.Object3D) => {
      const n = entities.length;
      root.position.set(Math.cos(n * 0.95) * Math.min(0.9 + n * 0.4, 3.2), 0,
        Math.sin(n * 0.95) * Math.min(0.9 + n * 0.4, 3.2));
    };
    const _sync = () => useDirectorStore.getState().setEntities(
      entities.map((e: DirectorEntity) => ({
        id: e.id, type: e.type, name: e.name, visible: e.visible,
        ...(e instanceof Crowd ? { _members: e.members.map((m: Character) => ({ id: m.id, name: m.name, type: m.type, visible: m.visible })) } : {}),
      })) as DirectorEntityMeta[]
    );

    // 搜索任意实体(含群众成员)
    const _findById = (id: string | null) => {
      if (!id) return null;
      const ent = entities.find((e: DirectorEntity) => e.id === id);
      if (ent) return ent;
      for (const e of entities) {
        if (e instanceof Crowd) {
          const m = e.members.find((x: Character) => x.id === id);
          if (m) return m;
        }
      }
      return null;
    };

    // ---- Interaction ----
    const gizmo = new TransformGizmo(stage.camera, stage.renderer.domElement, stage.scene, rig.controls, () => !_cameraView);
    const selection = new Selection(stage.renderer, stage.camera, stage.scene, () => entities, (id) => {
      _selectedId = id;
      useDirectorStore.getState().setSelectedId(id);
      const ent = _findById(id);
      if (ent && !_cameraView) { gizmo.attach(ent.root); }
      else { gizmo.detach(); }
      selection.highlight(_cameraView ? null : ent);
    });
    selection.setSkipPredicate(() => gizmo.dragging || gizmo.overAxis);
    gizmo.onObjectChange(() => { _syncInspectorCb?.(); _cameraAttrChangeCb?.(); });

    // Nav gizmo
    const navSvg = viewport.parentElement?.querySelector<SVGElement>("#navsvg");
    const navGizmo = navSvg ? new NavGizmo(navSvg, stage.camera, () => rig.resetView()) : null;

    // 搜索角色(含群众成员)
    const _findChar = (id: string) => {
      const ent = _findById(id);
      return ent?.type === "character" ? ent : null;
    };

    // ---- Runtime API ----
    const runtime: DirectorRuntime = {
      addCharacter: async (bodyType = "standard") => {
        const b = BODY_TYPES[bodyType] || BODY_TYPES.standard;
        const name = _nextCharName();
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
        const pk = kind as "box"|"cylinder"|"sphere"|"mannequin";
        _propCount[kind] = (_propCount[kind] || 0) + 1;
        const name = (PROP_LABEL[kind] || "道具") + _propCount[kind];
        const prop = new Prop(pk, name);
        _placeNew(prop.root); stage.add(prop.root); entities.push(prop);
        _sync(); selection.onSelect(prop.id);
        return prop;
      },
      addCamera: (presetKey = "front_mid") => {
        const name = "机位" + ++_camCount;
        const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
        const preset = CAMERA_PRESETS.find((p) => p.key === presetKey) || CAMERA_PRESETS[1]; // 默认正面中景

        // 构建上下文：以选中角色为 subject，否则用场景中心
        const selEnt = _findById(_selectedId);
        let subjectCenter = new THREE.Vector3(0, 0.95, 0);
        let subjectHeight = 1.7;
        if (selEnt && (selEnt.type === "character" || selEnt.type === "prop")) {
          const box = worldBox(selEnt.root, { useBones: selEnt.type === "character" });
          subjectCenter = box.isEmpty() ? selEnt.root.getWorldPosition(new THREE.Vector3()) : box.getCenter(new THREE.Vector3());
          subjectHeight = (selEnt as { height?: number }).height ?? (box.isEmpty() ? 1.7 : Math.max(0.1, box.max.y - box.min.y));
        }

        const ctx: CameraPresetCtx = {
          subjectCenter,
          subjectHeight,
          directorCamera: stage.camera,
          directorTarget: rig.controls.target.clone(),
          sceneCenter: new THREE.Vector3(0, 0, 0),
        };

        const result = preset.build(ctx);
        const fov = result.fov ?? preset.fov ?? 40;
        const cam = new CameraEntity(name, { fov, aspect: W / Math.max(1, H), scene: stage.scene });
        cam.root.position.copy(result.position);
        cam.aimAt(result.target);
        if (result.roll) cam._roll = result.roll;

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
        const members: Character[] = [];
        const usedLetters = new Set<string>();
        const w = (cols - 1) * spacing, d = (rows - 1) * spacing;
        let idx = 0;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++, idx++) {
            let ch: Character;
            try {
              ch = await Character.load(_nextCharName(usedLetters), b.url, b);
            } catch (err) { console.error("addCrowd char", err); continue; }
            if (_cancelled) { ch.dispose(); return null; }
            ch.setColor(PALETTE[idx % PALETTE.length]);
            ch.root.position.set(c * spacing - w / 2, 0, r * spacing - d / 2);
            ch.applyPosePreset("stand");
            group.add(ch.root);
            _ensureLabel(ch);
            members.push(ch);
          }
        }
        if (!members.length) return null;
        const crowd = new Crowd(`群众 (${rows}x${cols})`, group, members, { rows, cols, spacing });
        for (const m of members) m.root.userData.entityId = crowd.id;
        stage.add(group);
        entities.push(crowd);
        _placeNew(crowd.root); // 放在空白区
        _sync(); selection.onSelect(crowd.id);
        return crowd;
      },
      remove: (id: string) => {
        const idx = entities.findIndex((e: DirectorEntity) => e.id === id);
        if (idx < 0) return;
        const ent = entities[idx];
        const lbl = _labelEls.get(id); if (lbl) { lbl.remove(); _labelEls.delete(id); }
        // 删除打组(Crowd)时，一并清理所有成员的标签，避免残留
        if (ent instanceof Crowd) {
          for (const m of ent.members) {
            const mlbl = _labelEls.get(m.id);
            if (mlbl) { mlbl.remove(); _labelEls.delete(m.id); }
          }
        }
        stage.remove(ent.root); ent.dispose?.(); entities.splice(idx, 1); _sync();
        if (_selectedId === id) { gizmo.detach(); selection.highlight(null); useDirectorStore.getState().setSelectedId(null); }
      },
      select: (id: string | null) => {
        _selectedId = id;
        useDirectorStore.getState().setSelectedId(id);
        const ent = id ? _findById(id) : null;
        if (ent && !_cameraView) { gizmo.attach(ent.root); }
        else { gizmo.detach(); }
        selection.highlight(_cameraView ? null : ent);
      },
      toggleSelect: (id: string) => {
        useDirectorStore.getState().toggleSelectedId(id);
        _selectedId = useDirectorStore.getState().selectedId;
        const ent = _findById(_selectedId);
        if (ent && !_cameraView) { gizmo.attach(ent.root); selection.highlight(ent); }
        else { gizmo.detach(); selection.highlight(null); }
      },
      setTransformMode: (mode: string) => {
        const m = mode as "translate"|"rotate"|"scale"; gizmo.setMode(m); useDirectorStore.getState().setTransformMode(m);
      },
      setCameraView: (on: boolean) => {
        if (on) {
          // 选定 active：当前选中相机 > 上次 active > 第一个相机（含组内成员）
          const sel = _selectedId ? _findById(_selectedId) : null;
          const prev = _activeCamId ? _findById(_activeCamId) : null;
          let activeCam: CameraEntity | null = sel && sel.type === "camera" ? (sel as CameraEntity) : null;
          if (!activeCam && prev && prev.type === "camera") activeCam = prev as CameraEntity;
          if (!activeCam) _forEachEntity((ent) => { if (!activeCam && ent.type === "camera") activeCam = ent as CameraEntity; });
          if (!activeCam) return;
          _activeCamId = activeCam.id;
          _cameraView = true;
          selection._filterInvisible = true;
          activeCam.cam.aspect = stage.viewport.clientWidth / Math.max(1, stage.viewport.clientHeight);
          activeCam.cam.updateProjectionMatrix();
          stage.activeCamera = activeCam.cam;
          rig.controls.enabled = false;
          const curRatio = useDirectorStore.getState().ratio;
          rig.setRatio(curRatio === "auto" ? "free" : curRatio);
          useDirectorStore.getState().setCameraView(true);
          // select 会触发 gizmo.attach/ring(由 _cameraView 检查屏蔽)
          selection.onSelect(activeCam.id);
          _forEachEntity((ent) => {
            if (ent.type === "camera") { (ent as CameraEntity).body.visible = false; (ent as CameraEntity).helper.visible = false; }
          });
          selection.ring.visible = false;
        } else {
          _activeCamId = _selectedId;
          _cameraView = false;
          selection._filterInvisible = false;
          stage.activeCamera = null;
          rig.controls.enabled = true;
          const curRatio = useDirectorStore.getState().ratio;
          rig.setRatio(curRatio === "auto" ? "free" : curRatio);
          _forEachEntity((ent) => {
            if (ent.type === "camera") { (ent as CameraEntity).body.visible = true; (ent as CameraEntity).helper.visible = true; }
          });
          if (selection.selectedEntity) { gizmo.attach(selection.selectedEntity.root); selection.ring.visible = true; }
          useDirectorStore.getState().setCameraView(false);
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
        const ent = _findChar(characterId);
        if (ent instanceof Character) ent.applyPosePreset(presetKey);
      },
      setJointValue: (characterId: string, jointKey: string, value: number) => {
        const ent = _findChar(characterId);
        if (ent instanceof Character) { ent.values[jointKey] = value; ent.enterManual(); ent.applyPose(); ent.currentPreset = null; }
      },
      // ---- Screenshot helpers (对齐参考项目 ShotManager) ----
      _resolveShotCamera: () => {
        // 1) 机位视角 + 活跃相机
        if (_cameraView && _activeCamId) {
          const a = _findById(_activeCamId);
          if (a?.type === "camera") return a;
        }
        // 2) 选中实体是相机
        const sel = _findById(_selectedId);
        if (sel?.type === "camera") return sel;
        // 3) 无机位上下文：按当前视角克隆新建
        return runtime.addCamera("current");
      },
      captureShot: () => {
        return new Promise(async (resolve) => {
          const camEnt = runtime._resolveShotCamera() as CameraEntity | null;
          if (!camEnt?.cam) { resolve(null); return; }

          // 设置相机 aspect 匹配视口
          const W = stage.viewport.clientWidth || 1920;
          const H = stage.viewport.clientHeight || 1080;
          camEnt.cam.aspect = W / Math.max(1, H);
          camEnt.cam.updateProjectionMatrix();

          // Clean render（隐藏辅助物）→ 提取数据 → 恢复
          runtime._beginCleanRender();
          let dataURL: string;
          try {
            stage.renderer.render(stage.scene, camEnt.cam);

            const cv = stage.renderer.domElement;
            const frameRect = rig.frameRect;

            if (frameRect && frameRect.w > 0 && frameRect.h > 0) {
              const px = cv.width / W;
              const py = cv.height / H;
              const cw = Math.max(1, Math.round(frameRect.w * px));
              const ch = Math.max(1, Math.round(frameRect.h * py));
              const ox = Math.round(frameRect.x * px);
              const oy = Math.round(frameRect.y * py);
              const tmp = document.createElement("canvas");
              tmp.width = cw; tmp.height = ch;
              tmp.getContext("2d")!.drawImage(cv, ox, oy, cw, ch, 0, 0, cw, ch);
              dataURL = tmp.toDataURL("image/png");
            } else {
              dataURL = cv.toDataURL("image/png");
            }
          } finally {
            runtime._endCleanRender();
          }

          // 上传
          const blob = await (await fetch(dataURL)).blob();
          uploadBlob(blob, `shot_${Date.now()}.png`).then((url) => {
            if (!url) { console.error("[captureShot] uploadBlob returned null"); resolve(null); return; }
            const n = (runtime._shotSeq = runtime._shotSeq || {});
            n[camEnt.id] = (n[camEnt.id] || 0) + 1;
            resolve({
              url,
              name: `${camEnt.name}-截图${String(n[camEnt.id]).padStart(2, "0")}`,
              cameraId: camEnt.id,
            });
          }).catch((err: unknown) => {
            console.error("[captureShot] uploadBlob error:", err);
            resolve(null);
          });
        });
      },
      sendShotToCanvas: async (shotId: string) => {
        const ds = useDirectorStore.getState();
        const shot = ds.shots.find((s) => s.id === shotId);
        if (!shot) return;
        const cs = useCanvasStore.getState();
        const nodeId = ds.openingNodeId;
        if (!nodeId || !cs.nodes.find((n) => n.id === nodeId)) return;

        try {
          const img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const i = new window.Image();
            i.crossOrigin = "anonymous";
            i.onload = () => resolve(i);
            i.onerror = () => reject(new Error("Failed to load shot image"));
            i.src = shot.url;
          });
          await createNodeFromUrl(nodeId, shot.url, img.naturalWidth, img.naturalHeight, shot.name, useCanvasStore.getState());
          notification.success({ title: `已发送到画布：${shot.name}`, placement: "bottomRight" });
        } catch {
          notification.error({ title: "发送到画布失败", placement: "bottomRight" });
        }
      },
      resetView: () => rig.resetView(),
      toggleVisible: (id: string) => {
        const ent = entities.find((e: DirectorEntity) => e.id === id);
        if (!ent) return;
        ent.setVisible(!ent.visible);
        // 机位视角下相机 body/helper 由视角逻辑统一隐藏，toggleVisible 不得重新点亮
        if (ent.type === "camera" && _cameraView) {
          _forEachEntity((e) => {
            if (e.type === "camera") { (e as CameraEntity).body.visible = false; (e as CameraEntity).helper.visible = false; }
          });
        }
        _sync();
      },
      setEntityColor: (id: string, hex: string) => {
        const ent = entities.find((e: DirectorEntity) => e.id === id);
        if (ent instanceof Character || ent instanceof Prop) ent.setColor(parseInt(hex.replace("#", ""), 16));
      },
      _getEntity: (id: string) => {
        const ent = entities.find((e: DirectorEntity) => e.id === id);
        if (ent) return ent;
        for (const e of entities) {
          if (e instanceof Crowd) {
            const m = e.members.find((x: Character) => x.id === id);
            if (m) return m;
          }
        }
        return null;
      },
      _getStage: () => stage,
      _beginCleanRender: () => {
        gizmo.setVisible(false);
        selection.ring.visible = false;
        _forEachEntity((ent) => {
          if (ent.type === "camera") { (ent as CameraEntity).body.visible = false; (ent as CameraEntity).helper.visible = false; }
        });
        const ll = document.getElementById("dirLabelLayer");
        if (ll) ll.style.display = "none";
      },
      _endCleanRender: () => {
        if (!_cameraView) {
          if (selection.selectedEntity) { gizmo.attach(selection.selectedEntity.root); selection.ring.visible = true; }
          _forEachEntity((ent) => {
            if (ent.type === "camera") { (ent as CameraEntity).body.visible = true; (ent as CameraEntity).helper.visible = true; }
          });
        }
        const ll = document.getElementById("dirLabelLayer");
        if (ll) ll.style.display = _labelsVisible ? "block" : "none";
      },
      _getPoseValues: (id: string) => {
        const ent = entities.find((e: DirectorEntity) => e.id === id);
        return ent instanceof Character ? { ...ent.values } : {};
      },
      _setSyncInspector: (cb: (() => void) | null) => { _syncInspectorCb = cb; },
      _setCameraAttrChange: (cb: (() => void) | null) => { _cameraAttrChangeCb = cb; },
      rename: (id: string, name: string) => {
        const ent = entities.find((e: DirectorEntity) => e.id === id || (e instanceof Crowd && e.members.some((m: Character) => m.id === id)));
        if (!ent) return;
        // Check if it's a crowd member
        if (ent instanceof Crowd) {
          const m = ent.members.find((m: Character) => m.id === id);
          if (m) { m.name = name.trim() || m.name; }
        } else {
          ent.name = name.trim() || ent.name;
        }
        _sync();
      },
      ungroupCrowd: (id: string) => {
        const idx = entities.findIndex((e: DirectorEntity) => e.id === id);
        if (idx < 0) return;
        const crowd = entities[idx];
        if (!(crowd instanceof Crowd)) return;
        crowd.root.updateMatrixWorld(true);
        const members = crowd.members.slice();
        for (const m of members) {
          const mat = new THREE.Matrix4().multiplyMatrices(crowd.root.matrix, m.root.matrix);
          stage.add(m.root);
          mat.decompose(m.root.position, m.root.quaternion, m.root.scale);
          m.root.userData.entityId = m.id;
          _ensureLabel(m);
          entities.push(m);
        }
        stage.remove(crowd.root);
        entities.splice(idx, 1);
        _sync();
        gizmo.detach(); selection.highlight(null);
        useDirectorStore.getState().setSelectedId(null);
      },
      _broadcastPosePreset: (crowdId: string, presetKey: string) => {
        const crowd = entities.find((e: DirectorEntity) => e.id === crowdId);
        if (!(crowd instanceof Crowd)) return;
        crowd.members.forEach((m: Character) => { if (m.type === "character") m.applyPosePreset(presetKey); });
      },
      _broadcastResetPose: (crowdId: string) => {
        const crowd = entities.find((e: DirectorEntity) => e.id === crowdId);
        if (!(crowd instanceof Crowd)) return;
        crowd.members.forEach((m: Character) => { if (m.type === "character") { m.resetPose(); m.currentPreset = null; } });
      },
      groupCharacters: (ids: string[]) => {
        const members = ids.map((id) => entities.find((e: DirectorEntity) => e.id === id))
          .filter((e): e is DirectorEntity => !!e && (e.type === "character" || e.type === "camera" || e.type === "prop"));
        if (members.length < 2) return null;
        const centroid = new THREE.Vector3();
        for (const m of members) { m.root.updateMatrixWorld(true); centroid.add(m.root.getWorldPosition(new THREE.Vector3())); }
        centroid.divideScalar(members.length);
        const group = new THREE.Group(); group.position.copy(centroid);
        stage.add(group); group.updateMatrixWorld(true);
        for (const m of members) group.attach(m.root);
        const crowd = new Crowd("组" + (Math.random() * 100 | 0), group, members as Character[]);
        for (const m of members) m.root.userData.entityId = crowd.id;
        // Remove members from top-level, add crowd
        for (const m of members) {
          const idx = entities.indexOf(m);
          if (idx >= 0) entities.splice(idx, 1);
        }
        entities.push(crowd);
        _sync(); selection.onSelect(crowd.id);
        return crowd;
      },
      duplicateMany: async (ids: string[]) => {
        const list = ids.map((id) => _findById(id)).filter(Boolean) as DirectorEntity[];
        const OFF = new THREE.Vector3(0.6, 0, 0.6);
        let last: DirectorEntity | null = null;
        for (const ent of list) {
          if (ent instanceof Character) {
            if (!ent._srcUrl) continue;
            let c: Character;
            try { c = await Character.load(ent.name + "副本", ent._srcUrl, ent._opts || {}); }
            catch { continue; }
            if (_cancelled) { c.dispose(); return; }
            c._srcUrl = ent._srcUrl; c._opts = ent._opts;
            c.root.position.copy(ent.root.position).add(OFF);
            c.root.quaternion.copy(ent.root.quaternion);
            c.root.scale.copy(ent.root.scale);
            c.setColor(ent.color);
            Object.assign(c.values, ent.values);
            c.poseMode = ent.poseMode;
            c.currentPreset = ent.currentPreset;
            c.applyPose();
            stage.add(c.root); _makeLabel(c); entities.push(c); last = c;
          } else if (ent instanceof Prop) {
            const p = new Prop(ent.kind as "box"|"cylinder"|"sphere"|"mannequin", ent.name + "副本");
            p.root.position.copy(ent.root.position).add(OFF);
            p.root.quaternion.copy(ent.root.quaternion);
            p.root.scale.copy(ent.root.scale);
            p.setColor(ent.color);
            stage.add(p.root); entities.push(p); last = p;
          } else if (ent instanceof CameraEntity) {
            const W = stage.viewport.clientWidth, H = stage.viewport.clientHeight;
            const cam = new CameraEntity(ent.name + "副本", { fov: ent.fov, aspect: W / Math.max(1, H), scene: stage.scene });
            cam.root.position.copy(ent.root.position).add(OFF);
            cam.root.quaternion.copy(ent.root.quaternion);
            cam.lookTarget.copy(ent.lookTarget);
            if (ent._roll) cam._roll = ent._roll;
            stage.add(cam.root); _makeLabel(cam); entities.push(cam); last = cam;
          }
        }
        _sync();
        if (last) selection.onSelect(last.id);
      },
      toggleVisibleMany: (ids: string[]) => {
        const list = ids.map((id) => entities.find((e: DirectorEntity) => e.id === id)).filter(Boolean) as DirectorEntity[];
        if (!list.length) return;
        const target = !list.some((e: DirectorEntity) => e.visible);
        for (const e of list) { if (e.visible !== target) e.setVisible(target); }
        _sync();
      },
      captureState: (): DirectorStateData => {
        const store = useDirectorStore.getState();
        return {
          entities: entities.map((ent: DirectorEntity) => {
            if (ent instanceof Crowd) return { ..._serializeEntity(ent), rows: ent.rows, cols: ent.cols, members: ent.members.map((m: Character) => _serializeEntity(m)) };
            return _serializeEntity(ent);
          }),
          sceneState: { ...store.sceneState },
          ratio: store.ratio,
          cameraView: store.cameraView,
          transformMode: store.transformMode,
          shots: store.shots.map((s) => ({ ...s })),
        };
      },
      restoreState: async (data: DirectorStateData) => {
        // 先恢复世界变换，再恢复实体（实体位置依赖 world scale/pos/rot）
        if (data.sceneState) {
          const ss = data.sceneState as unknown as _SceneSnapshot;
          if (ss.scale != null) stage.setWorldScale(ss.scale);
          if (ss.pos) stage.setWorldPos(ss.pos.x, ss.pos.y, ss.pos.z);
          if (ss.rot) stage.setWorldRot(ss.rot.x * D2R, ss.rot.y * D2R, ss.rot.z * D2R);
        }
        for (const e of data.entities) {
          if (_cancelled) return;
          if (e.type === "crowd") {
            const rows = e.rows || 3, cols = e.cols || 3;
            const group = new THREE.Group();
            const members: Character[] = [];
            for (const mdata of (e.members || [])) {
              if (_cancelled) return;
              const m = await _deserializeEntity(mdata);
              if (!m) return;
              m.root.userData.entityId = m.id;
              _ensureLabel(m);
              group.add(m.root); members.push(m as Character);
            }
            if (!members.length) continue;
            const crowd = new Crowd(e.name, group, members, { rows, cols });
            crowd.id = e.id; crowd.root.userData.entityId = e.id; // 保持原始 ID
            setTransform(crowd.root, e.pos, e.rot, e.scale);
            for (const m of members) m.root.userData.entityId = crowd.id;
            stage.add(group); entities.push(crowd);
            crowd.setVisible(e.visible);
          } else {
            const ent = await _deserializeEntity(e);
            if (!ent) return;
            ent.root.userData.entityId = ent.id;
            stage.add(ent.root); entities.push(ent);
            _registerEntity(ent);
          }
        }
        _sync();
        if (data.sceneState) {
          const ss = data.sceneState as unknown as _SceneSnapshot;
          if (ss.sky) stage.setSkyColor(ss.sky);
          if (ss.ground) {
            if (ss.ground.visible != null) stage.setGroundVisible(ss.ground.visible);
            if (ss.ground.opacity != null) stage.setGroundOpacity(ss.ground.opacity);
            if (ss.ground.height != null) stage.setGroundHeight(ss.ground.height);
          }
          if (ss.labels != null) {
            const layer = document.getElementById("dirLabelLayer");
            if (layer) layer.style.display = ss.labels ? "block" : "none";
          }
          useDirectorStore.getState().setSceneState(ss as unknown as Partial<import("@/features/director/types").SceneState>);
        }
        if (data.ratio) { rig.setRatio(data.ratio); useDirectorStore.getState().setRatio(data.ratio); }
        if (data.shots) {
          let firstCam: CameraEntity | null = null; _forEachEntity((e: DirectorEntity) => { if (!firstCam && e.type === "camera") firstCam = e as CameraEntity; });
          data.shots.forEach((s) => {
            const shot = { ...s };
            // 修正 orphan cameraId：restore 后实体 ID 可能变化
            if (!_findById(shot.cameraId) && firstCam) {
              shot.cameraId = firstCam.id;
            }
            useDirectorStore.getState().addShot(shot);
          });
        }
        rig.frameAll(entities);
      },
    };
    useDirectorStore.getState().setRuntime(runtime);

    // ---- Loop ----
    const tick = (dt: number) => {
      for (const ent of entities) {
        if (ent instanceof Character) ent.update(dt);
        else if (ent instanceof CameraEntity) ent.update();
        else if (ent instanceof Crowd) ent.members.forEach((m: Character) => m.update(dt));
      }
      rig.update(); selection.update(); navGizmo?.update();
      _updateLabels();
    };
    stage.startLoop(tick);

    // ---- Seed or Restore ----
    const restore = useDirectorStore.getState().restoreState;
    if (restore) {
      (async () => {
        await runtime.restoreState(restore);
      })();
    } else {
      (async () => {
        const c = await Character.load("角色A", XBOT, { height: 1.75, girth: 1.0 });
        if (_cancelled) { c.dispose(); return; }
        c._srcUrl = XBOT; c._opts = { height: 1.75, girth: 1.0 };
        c.applyPosePreset("stand"); stage.add(c.root); entities.push(c); _registerEntity(c);
        rig.frameAll(entities); _sync();
      })();
    }

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
      // 重置模块级计数器，避免跨会话泄露
      _propCount = {}; _camCount = 0;
    };
  }, []);

  return (
    <div className="relative w-full h-full">
      <div ref={viewportRef} className="absolute inset-0" />
      <div ref={frameRef} className="absolute pointer-events-none border-2 border-white/40" style={{ display: "none" }} />
      <div id="dirLabelLayer" className="absolute inset-0 pointer-events-none overflow-hidden" />
      <div className="absolute z-[5] text-center cursor-pointer" style={{ top: 18, right: 18, width: 74 }} title="重置视角">
        <NavSvg>
          <circle cx="37" cy="37" r="3" fill="var(--dir-dim2)" />
        </NavSvg>
        <div className="text-[11.5px] mt-1.5" style={{ color: "var(--dir-dim)" }}>重置视角</div>
      </div>
    </div>
  );
}
