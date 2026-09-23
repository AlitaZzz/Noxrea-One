/**
 * 视频生成面板，挂在视频节点下方。
 * 负责提示词输入（支持 @ 引用与首尾帧图片）、模型与分辨率 / 比例 / 时长 / 音频等参数配置，
 * 提交异步生成任务并把参数持久化到节点数据。
 */
"use client";

import { DownOutlined, PlusOutlined } from "@ant-design/icons";
import { App, Button, Popover, Tooltip } from "antd";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ParamsIcon } from "@/components/ui/icons/canvas/ParamsIcon";
import { TextToVideoIcon } from "@/components/ui/icons/media/TextToVideoIcon";
import { VideoCameraIcon } from "@/components/ui/icons/media/VideoCameraIcon";
import { VideoFrameIcon } from "@/components/ui/icons/media/VideoFrameIcon";
import { VideoRefIcon } from "@/components/ui/icons/media/VideoRefIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { ModelIcon } from "@/components/ui/ModelIcon";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import PrimaryActionButton from "@/features/canvas/editing/PrimaryActionButton";
import ParamFields, { fieldDefaults, hasField, ParamSummary } from "@/features/canvas/panels/ParamFields";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { MediaGenFields, VideoGenSettings } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import type { HistorySnapshot } from "@/features/project/types";
import { parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import { isGenerating as isGeneratingBinding } from "@/lib/constants";
import i18n from "@/lib/i18n/config";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider } from "@/lib/types/models";
import { type ModelOption } from "@/lib/types/models";

import AudioRefCard from "../shared/AudioRefCard";
import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import { applyRatioToNode } from "../shared/ratio-size";
import { deriveAllowedRefModes, resolveRefMode } from "../shared/ref-modes";
import { useGenSettings, writeGenSettings, writeOrderPref } from "../shared/ref-order";
import RefGroupDivider from "../shared/RefGroupDivider";
import TextRefChip from "../shared/TextRefChip";
import VideoRefCard from "../shared/VideoRefCard";
import { useVideoGenPanel } from "./use-video-gen-panel";

interface Props { nodeId: string; }

const VideoGenerationPanel = memo(function VideoGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const allModels = useMemo(() => providers.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("video")).map((m) => ({ value: `${c.id}/${m.name}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i), [providers]);

  // ── 受控模式：genSettings 是唯一数据源 ──
  // useGenSettings 反应式读取，外部写入（画布 Agent update_node 等）即时可见；
  // 编辑经 writeGenSettings 立即写回（skipHistory：连续编辑不压 undo 栈，保存由 SaveManager 合并）。
  // 未持久化的字段回退到当前模型的默认值。
  const genSettings = useGenSettings(nodeId) as Partial<VideoGenSettings> | undefined;
  const modelKey = resolveModelKey(genSettings?.modelKey, "video", allModels);

  // 查找当前模型的参数配置（params + defaults + constraints）
  const modelParamsCache = useModelStore((s) => s.modelParamsCache);
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.providerId, entry.name, "video") : null;
  }, [modelKey, allModels, findModelParams, modelParamsCache]);

  const defaults = useMemo(
    () => (Array.isArray(modelParams?.fields) ? fieldDefaults(modelParams.fields) : {}),
    [modelParams]
  );
  const prompt = genSettings?.prompt ?? "";
  // 未就绪不落值：params 缓存未到达时 defaults 为空、fields 为空（参数区本就不渲染），
  // 字段保持 undefined，等缓存到达后由 defaults 物化——不硬编码兜底值，杜绝
  // 「错误兜底值被渲染一瞬再被纠偏 effect 改写」的双写与闪烁
  const resolution = genSettings?.resolution ?? (defaults.resolution as string | undefined);
  const ratio = genSettings?.ratio ?? (defaults.ratio as string | undefined);
  const seconds = genSettings?.seconds ?? (defaults.seconds as number | undefined);
  const generateAudio = genSettings?.generateAudio ?? (defaults.generateAudio as boolean | undefined);
  const n = genSettings?.n ?? (defaults.n as number | undefined);

  // write-through setters：保持旧签名，编辑立即落 store
  const setPrompt = useCallback((v: string) => writeGenSettings(nodeId, { prompt: v }), [nodeId]);
  const setModelKey = useCallback((v: string) => writeGenSettings(nodeId, { modelKey: v }), [nodeId]);

  const [modelOpen, setModelOpen] = useState(false);
  const [refModeOpen, setRefModeOpen] = useState(false);
  // 参考区是否有任意参考正在拖拽：拖拽期间抑制所有卡片的放大预览浮层
  const [isRefDragging, setIsRefDragging] = useState(false);

  // 悬空模型键纠偏：持久化的 modelKey 已不存在（模型被移除 / 换渠道 ID 变化）时，
  // 按「上次使用的模型 → 第一个可用」写回（resolveModelKey(undefined, …) 即该回退链）；
  // 未持久化（modelKey 为空）时不写：展示层由 resolveModelKey 回退，
  // 一旦写回会把「记住上次使用的模型」永久固化到节点数据。
  useEffect(() => {
    if (allModels.length === 0) return;
    const persisted = genSettings?.modelKey;
    if (!persisted || allModels.some((m) => m.value === persisted)) return;
    writeGenSettings(nodeId, { modelKey: resolveModelKey(undefined, "video", allModels) });
  }, [allModels, genSettings?.modelKey, nodeId]);

  // capabilities 能力声明：refMode 选项由模型声明，未声明则不渲染（不支持参考）
  const refModeOptions = modelParams?.capabilities?.refMode?.options ?? [];

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = modelParams?.fields ?? [];
  const fieldValues: Record<string, unknown> = { resolution, ratio, seconds, generateAudio, n };
  const setField = (name: string, value: unknown) => {
    if (name === "resolution") writeGenSettings(nodeId, { resolution: value });
    else if (name === "ratio") {
      writeGenSettings(nodeId, { ratio: value });
      // 空节点占位框跟随所选比例（已有内容 / adaptive 跳过）
      applyRatioToNode(nodeId, value as string);
    }
    else if (name === "seconds") writeGenSettings(nodeId, { seconds: value });
    else if (name === "generateAudio") writeGenSettings(nodeId, { generateAudio: value });
    else if (name === "n") writeGenSettings(nodeId, { n: value });
  };

  // 模型切换 / 持久化值不属于当前模型 options 时：纠偏到字段默认值。
  // 缓存未就绪时字段值为 undefined，由 cur !== undefined 守卫跳过，不落任何兜底值。
  // correctedFor 守卫保证同一份 fields 只纠偏一次；受控模式下经 writeGenSettings 写回 store。
  const correctedForRef = useRef<unknown>(null);
  useEffect(() => {
    const currentFields = Array.isArray(modelParams?.fields) ? modelParams.fields : null;
    if (!currentFields || currentFields === correctedForRef.current) return;
    correctedForRef.current = currentFields;
    for (const f of currentFields) {
      const cur = fieldValues[f.name] as string | number | undefined;
      if (f.options && f.options.length && cur !== undefined && !f.options.includes(cur)) {
        setField(f.name, f.default);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParams]);

  const selectModel = (value: string) => {
    // 字段纠偏由上方 modelParams effect 统一处理：切换模型必然更换 fields 引用，
    // effect 会把不属于新模型 options 的持久化值重置为默认值，这里不再重复一份
    setModelKey(value);
    recordLastModel("video", value);
    setModelOpen(false);
  };

  // 参考方式（text = 文生视频）：同样受控于 genSettings。可用范围由 hook 派生的参考列表决定（见下）。
  const refMode = genSettings?.refMode || "full";
  const setRefMode = useCallback((v: string) => writeGenSettings(nodeId, { refMode: v }), [nodeId]);

  // ── 派生数据与持久化副作用（抽到 useVideoGenPanel） ──
  // 参考存在性与显示顺序均为纯派生：存在性来自连线，顺序 = 排序偏好(genSettings) + 连线合并，
  // 无本地同步状态、首帧即正确；排序偏好由拖拽排序事件（writeOrderPref）即时持久化。
  const {
    refOrder, audioOrder, refVideoOrder,
    upstreamTexts, upstreamAudio, references, finalPrompt, isGenerating,
    elapsed, error, setElapsed, setError, timerRef,
  } = useVideoGenPanel({ nodeId, prompt });

  // 同类内拖拽排序（图↔图 / 音↔音 / 视频↔视频）：事件驱动写入排序偏好并即时持久化
  const handleAudioReorder = useCallback((dragged: string, target: string) => {
    const list = [...audioOrder];
    const fromIdx = list.indexOf(dragged);
    const toIdx = list.indexOf(target);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    writeOrderPref(nodeId, { refAudioOrder: list });
  }, [audioOrder, nodeId]);

  const handleImageReorder = useCallback((dragged: string, target: string) => {
    const list = [...refOrder];
    const fromIdx = list.indexOf(dragged);
    const toIdx = list.indexOf(target);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    writeOrderPref(nodeId, { refOrder: list });
  }, [refOrder, nodeId]);

  const handleVideoReorder = useCallback((dragged: string, target: string) => {
    const list = [...refVideoOrder];
    const fromIdx = list.indexOf(dragged);
    const toIdx = list.indexOf(target);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    writeOrderPref(nodeId, { refVideoOrder: list });
  }, [refVideoOrder, nodeId]);

  // 参考模式可用范围（与画布 Agent 参数校验共用 shared/ref-modes 的推导规则）：
  //   视频或音频 → 仅全能参考；1 张图 → 图生/全能；2 张图 → 首尾帧/全能；≥3 张图 → 仅全能参考；无图/视频/音频（仅文本或空）→ 只能文生视频
  const allowedRefModes = useMemo(
    () => deriveAllowedRefModes({ refOrder, refAudioOrder: audioOrder, refVideoOrder }),
    [refOrder, audioOrder, refVideoOrder],
  );

  // 当前模式不在合法范围（上游参考推导 ∩ 模型能力声明）时按共享规则回退：
  // 回退值幂等可收敛，不会死循环；受控模式下经 setRefMode 写回 store。
  useEffect(() => {
    const { value } = resolveRefMode(refMode, refModeOptions, allowedRefModes);
    if (value !== refMode) setRefMode(value);
  }, [allowedRefModes, refMode, refModeOptions, setRefMode]);

  /** 模式不可用时的禁用原因（挂菜单项 Tooltip）：按模式本身的要求给静态文案。
      refModeOptions 来自模型能力声明，可能出现四个标准模式之外的自定义值——
      无对应文案时返回 undefined，不显示 Tooltip（而不是把 i18n key 串暴露给用户） */
  const refModeDisabledReason = (m: string): string | undefined => {
    const key = `video.refModeDisabled.${m}`;
    return i18n.exists(key) ? i18n.t(key) : undefined;
  };

  // 参数值在 params 缓存未就绪时为 undefined，由 submitTask 的 hasField 守卫决定是否上报
  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; resolution?: string; ratio?: string; seconds?: number; generateAudio?: boolean; refImages: string[]; refAudios: string[]; refVideos: string[]; refMode: string; n?: number; entry: ModelOption | null; provider: ModelProvider | null }>({ count: 0, prompt: "", modelKey: "", refImages: [] as string[], refAudios: [] as string[], refVideos: [] as string[], refMode: "", entry: null, provider: null });
  const { notification } = App.useApp();

  // 参考区分组（文本 → 音频 → 图片 → 视频）：只收集非空组，渲染时组间插竖线分隔。
  // 组内顺序即该类参考的排序偏好，排序只在同类型内生效（跨类型拖放由卡片拒绝）。
  const refGroups: { key: string; content: React.ReactNode }[] = [];
  if (upstreamTexts.length > 0) {
    refGroups.push({
      key: "text",
      content: upstreamTexts.map((txt) => (
        <TextRefChip key={`text-${txt.id}`} id={txt.id} content={txt.content} nodeId={nodeId} />
      )),
    });
  }
  if (audioOrder.length > 0) {
    refGroups.push({
      key: "audio",
      content: audioOrder.map((src, i) => {
        const aud = upstreamAudio.find((a) => a.src === src);
        if (!aud) return null;
        return (
          <AudioRefCard
            key={`audio-${aud.id}`}
            audio={aud}
            nodeId={nodeId}
            index={i}
            onReorder={handleAudioReorder}
            onDragStateChange={setIsRefDragging}
          />
        );
      }),
    });
  }
  if (refOrder.length > 0) {
    refGroups.push({
      key: "image",
      content: refOrder.map((img, i) => (
        <ImageRefCard
          key={img}
          src={img}
          nodeId={nodeId}
          index={i}
          onReorder={handleImageReorder}
          onDragStateChange={setIsRefDragging}
          dragActive={isRefDragging}
        />
      )),
    });
  }
  if (refVideoOrder.length > 0) {
    refGroups.push({
      key: "video",
      content: refVideoOrder.map((vid, i) => (
        <VideoRefCard
          key={`video-${vid}`}
          src={vid}
          nodeId={nodeId}
          index={i}
          onReorder={handleVideoReorder}
          onDragStateChange={setIsRefDragging}
          dragActive={isRefDragging}
        />
      )),
    });
  }

  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, provider, prompt: p, resolution: res, ratio: r, seconds: sec, generateAudio: audio, refImages: refs, refAudios: auds, refVideos: vids, refMode: rm, n: num } = retryRef.current;
    if (!entry || !provider) return i18n.t("error.generate.missing_model_config");
    try {
      const res2 = await generationApi.submitGenerationTask({
        type: "video",
        prompt: p.trim(),
        model: entry.name,
        providerId: entry.providerId,
        resolution: hasField(fields, "resolution") ? res : undefined,
        ratio: hasField(fields, "ratio") ? r : undefined,
        seconds: hasField(fields, "seconds") ? sec : undefined,
        generateAudio: hasField(fields, "generateAudio") ? audio : undefined,
        n: hasField(fields, "n") ? num : undefined,
        refImages: refs.length > 0 ? refs : undefined,
        refAudios: auds.length > 0 ? auds : undefined,
        refVideos: vids.length > 0 ? vids : undefined,
        refMode: rm || undefined,
        nodeId,
      });
      if (!res2.ok) {
        const body = parseErrorBody(await res2.json().catch(() => null));
        return resolveApiError(body, res2.status, "generate.submit_failed");
      }
      const json = await res2.json();
      const taskId = json.data?.id;
      if (!taskId) return i18n.t("error.generate.no_task_id");

      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return null;
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending", startedAt: Date.now() } }, undefined, { skipHistory: true });
      await flushAndWait();
      return null;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : "Failed to submit task";
    }
  };

  /**
   * 参考区添加：上传图片 -> 新建参考节点并自动连到当前生成节点。
   * 参考连上后 allowedRefModes 会包含 full，下面的参考方式纠偏会自动切出「文生视频」。
   */
  const handleRefUpload = useRefUpload(nodeId);

  /** handleGenerate 压入的「预生成快照」，供失败 / 取消时精确回滚 */
  const pushedSnapshotRef = useRef<HistorySnapshot | null>(null);

  /**
   * 回滚 handleGenerate 压入的预生成快照。
   * 按引用比对、只在它仍是栈顶时弹出：提交期间若有别的操作入栈，说明它已不是栈顶，
   * 此时放弃弹出，避免误删无关快照导致撤销行为错乱。
   */
  const dropPendingHistory = useCallback(() => {
    const pushed = pushedSnapshotRef.current;
    pushedSnapshotRef.current = null;
    if (pushed) useHistoryStore.getState().popIfTop(pushed);
  }, []);

  const handleGenerate = async () => {
    if (!prompt.trim() || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const provider = providers.find((c) => c.id === entry.providerId);
    if (!provider) return;

    setError("");
    // 记录被 forceHistory 压入的快照引用，失败 / 取消时按引用精确回滚（见 dropPendingHistory）
    const depthBefore = useHistoryStore.getState().undoStack.length;
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing", startedAt: Date.now() } }, undefined, { forceHistory: true });
    const stack = useHistoryStore.getState().undoStack;
    pushedSnapshotRef.current = stack.length > depthBefore ? stack[stack.length - 1] : null;
    markDirtyImmediate();
    setElapsed(0);
    const isTextToVideo = refMode === "text";
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, resolution, ratio, seconds, generateAudio, refImages: isTextToVideo ? [] : refOrder, refAudios: isTextToVideo ? [] : audioOrder, refVideos: isTextToVideo ? [] : refVideoOrder, refMode, n, entry, provider };
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);

    const errMsg = await submitTask();

    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    if (errMsg === null) {
      setError("");
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      dropPendingHistory();
      setError(errMsg);
    }
  };

  const handleCancel = () => {
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const tid = (node?.data as MediaGenFields)?.taskBinding?.taskId;
    if (tid) {
      generationApi.cancelGenerationTask(tid).catch(() => {});
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      taskBinding: undefined,
    }, undefined, { skipHistory: true });
    markDirtyImmediate();
    dropPendingHistory();
    setError("");
  };

  return (
    <>
    <WheelGuard
      className="nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
      style={{
        background: "var(--canvas-bg, #262626)",
        border: "1px solid var(--canvas-border, #3a3a3a)",
        width: 640,
      }}
    >
      {/* 参考区常驻显示：文生视频（无参考）时也要能看到素材并上传，否则没有入口加参考。
          文本参考不可拖动，按连线顺序排在首位 */}
      <div
        className="flex gap-2 flex-wrap"
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer.types.includes('application/x-ref-video') || e.dataTransfer.types.includes('application/x-ref-image') || e.dataTransfer.types.includes('application/x-ref-audio') || e.dataTransfer.types.includes('application/x-ref-text')) {
            e.dataTransfer.dropEffect = 'none'; // 排序仅限同类缩略图上，加号/空白一律禁止
            return;
          }
          e.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
          {/* 参考区按类型分组：文本 → 音频 → 图片 → 视频，组间以竖线分隔 */}
          {refGroups.map((group, i) => (
            <Fragment key={group.key}>
              {i > 0 && <RefGroupDivider />}
              {group.content}
            </Fragment>
          ))}
          {/* 添加参考：方形加号占位，与参考缩略图同行 */}
          <Tooltip title={t("common.reference")}>
            <Button size="small" type="text"
              className="flex items-center justify-center rounded transition-colors flex-shrink-0"
              style={{ width: 56, height: 56, background: "var(--canvas-bg-hover)", border: "1px dashed var(--canvas-border)", cursor: "pointer" }}
              onMouseEnter={(e) => { const el = e.currentTarget as HTMLElement; el.style.borderColor = "var(--canvas-text-dim)"; el.style.background = "rgba(255,255,255,0.08)"; }}
              onMouseLeave={(e) => { const el = e.currentTarget as HTMLElement; el.style.borderColor = "var(--canvas-border)"; el.style.background = "var(--canvas-bg-hover)"; }}
              onClick={handleRefUpload}>
              <PlusOutlined style={{ fontSize: 18, color: "var(--canvas-text-muted)" }} />
            </Button>
          </Tooltip>
        </div>
      <MentionPrompt
        references={references}
        value={prompt}
        onChange={setPrompt}
        placeholder={t("generation.promptPlaceholderVideo")}
        style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
      />
      <div className="flex items-center gap-2">
        <MenuPopover
          open={modelOpen} onOpenChange={setModelOpen} placement="bottomLeft"
          trigger={
            <Button size="small" type="text" className="gen-panel-btn flex items-center gap-1.5 rounded text-sm max-w-[180px]"
              style={{ border: "none", cursor: "pointer" }}>
              <ModelIcon model={allModels.find((m) => m.value === modelKey)?.name ?? modelKey} style={{ fontSize: 14, flexShrink: 0 }} />
              <span className="truncate">
                {allModels.find((m) => m.value === modelKey)?.name ?? t("modelConfig.selectModel")}
              </span>
            </Button>
          }
          content={allModels.map((m) => (
            <MenuItem key={m.value} onClick={() => selectModel(m.value)} selected={modelKey === m.value}>
              <span className="flex items-center gap-1.5">
                <ModelIcon model={m.name} className="size-4 shrink-0" />
                <span className="truncate">{m.name}</span>
                {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
              </span>
            </MenuItem>
          ))}
        />
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        {refModeOptions.length > 0 && (
          <MenuPopover
            open={refModeOpen}
            onOpenChange={setRefModeOpen}
            placement="bottomLeft"
            trigger={
              <Button size="small" type="text"
                className="gen-panel-btn flex items-center justify-between gap-1.5 rounded text-sm"
                style={{ border: "none", cursor: "pointer", width: 120 }}>
                <span className="truncate" style={{ display: "inline-flex", alignItems: "center", gap: 6, justifyContent: "flex-start" }}>
                  {refMode === "full" && <VideoRefIcon style={{ fontSize: 14 }} />}
                  {refMode === "first-last" && <VideoFrameIcon style={{ fontSize: 14 }} />}
                  {refMode === "image" && <VideoCameraIcon style={{ fontSize: 14 }} />}
                  {refMode === "text" && <TextToVideoIcon style={{ fontSize: 14 }} />}
                  {t(`video.refMode.${refMode}`)}
                </span>
                <DownOutlined style={{ fontSize: 11, color: "var(--canvas-text-dim)", flexShrink: 0 }} />
              </Button>
            }
            content={
              <>
                <div style={{ padding: "2px 4px 0", fontSize: 12, color: "var(--canvas-text-muted)" }}>{t("video.refModeTitle")}</div>
                {refModeOptions.map((m: string) => {
                  const allowed = allowedRefModes.includes(m);
                  return (
                  <MenuItem key={m} selected={refMode === m} disabled={!allowed}
                    tooltip={allowed ? undefined : refModeDisabledReason(m)}
                    onClick={() => { if (allowed) { setRefMode(m); setRefModeOpen(false); } }}>
                    {m === "full" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoRefIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "first-last" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoFrameIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "image" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <VideoCameraIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m === "text" && (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <TextToVideoIcon style={{ fontSize: 14 }} />
                        {t(`video.refMode.${m}`)}
                      </span>
                    )}
                    {m !== "full" && m !== "first-last" && m !== "image" && m !== "text" && t(`video.refMode.${m}`)}
                  </MenuItem>
                  );
                })}
              </>
            }
          />
        )}
        {refModeOptions.length > 0 && (
          <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
        )}
        <Popover
          content={
            <div className="menu-popover" style={{ width: 360, padding: 6 }}>
              <ParamFields fields={fields} values={fieldValues} onChange={setField} />
            </div>
          }
          trigger="click" placement="bottomLeft"
          styles={{ container: { padding: 0, background: "transparent" } }}
        >
          <button type="button" className="gen-panel-btn flex items-center gap-1 rounded flex-shrink-0 text-sm"
            style={{ border: "none", cursor: "pointer", color: "var(--canvas-text)", justifyContent: "center" }}>
            <ParamsIcon style={{ color: "#ffffff" }} />
            <ParamSummary fields={fields} values={fieldValues} />
          </button>
        </Popover>
        <div className="flex-1" />
        <PrimaryActionButton
          cancel={isGenerating}
          disabled={!isGenerating && (!prompt.trim() || !modelKey)}
          onClick={isGenerating ? handleCancel : handleGenerate}
        />
      </div>
    </WheelGuard>
    </>
  );
});

export default VideoGenerationPanel;

