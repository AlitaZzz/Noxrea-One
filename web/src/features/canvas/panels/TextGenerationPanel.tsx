/**
 * 文本生成面板，挂在文本节点下方。
 * 参考区接入四类上游，按类型分组展示：文本（拼进 prompt）→ 音频 → 图片 → 视频，
 * 组间竖线分隔；排序只在同类型内生效（跨类型拖放禁止），多模态参考可 @ 引用。
 * 负责提示词输入与文本模型选择，以流式方式接收生成结果并写回节点内容。
 */
"use client";

import { PlusOutlined } from "@ant-design/icons";
import { App, Button, Tooltip } from "antd";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { ModelIcon } from "@/components/ui/ModelIcon";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import PrimaryActionButton from "@/features/canvas/editing/PrimaryActionButton";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { TextGenSettings, TextNodeData } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import type { HistorySnapshot } from "@/features/project/types";
import { parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import i18n from "@/lib/i18n/config";
import { useModelStore } from "@/lib/model-store";

import AudioRefCard from "../shared/AudioRefCard";
import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import { EMPTY_ORDER, mergeOrder, useGenSettings, writeGenSettings, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import RefGroupDivider from "../shared/RefGroupDivider";
import TextRefChip from "../shared/TextRefChip";
import VideoRefCard from "../shared/VideoRefCard";

interface Props {
  nodeId: string;
}

interface ModelOption {
  value: string;
  providerId: string;
  modelId: string;
  name: string;
  providerName: string;
}

const TextGenerationPanel = memo(function TextGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const { notification } = App.useApp();

  const allModels = useMemo(() => providers
    .flatMap((c) =>
      c.models
        .filter((m) => m.capabilities?.includes("text"))
        .map((m) => ({ value: `${c.id}/${m.name}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name })),
    )
    .filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i), [providers]);

  // ── 受控模式：genSettings 是唯一数据源 ──
  // useGenSettings 反应式读取，外部写入（画布 Agent update_node 等）即时可见；
  // 编辑经 writeGenSettings 立即写回（skipHistory，保存由 SaveManager 合并）。
  const genSettings = useGenSettings(nodeId) as Partial<TextGenSettings> | undefined;
  const prompt = genSettings?.prompt ?? "";
  const modelKey = resolveModelKey(genSettings?.modelKey, "text", allModels);
  const setPrompt = useCallback((v: string) => writeGenSettings(nodeId, { prompt: v }), [nodeId]);
  const setModelKey = useCallback((v: string) => writeGenSettings(nodeId, { modelKey: v }), [nodeId]);

  const [modelOpen, setModelOpen] = useState(false);
  // 参考区是否有任意参考正在拖拽：拖拽期间抑制所有卡片的放大预览浮层
  const [isRefDragging, setIsRefDragging] = useState(false);

  // 悬空模型键纠偏（同 ImageGenerationPanel）：持久化的 modelKey 已不存在时，
  // 按「上次使用的模型 → 第一个可用」写回（resolveModelKey(undefined, …) 即该回退链）；
  // 未持久化时不写：展示层由 resolveModelKey 回退，避免固化「记住上次使用的模型」。
  useEffect(() => {
    if (allModels.length === 0) return;
    const persisted = genSettings?.modelKey;
    if (!persisted || allModels.some((m) => m.value === persisted)) return;
    writeGenSettings(nodeId, { modelKey: resolveModelKey(undefined, "text", allModels) });
  }, [allModels, genSettings?.modelKey, nodeId]);

  // Upstream reference images - derived live from current edges
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);

  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    return isGeneratingBinding((node?.data as TextNodeData)?.taskBinding);
  }, [canvasNodes, nodeId]);
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((n) => upstreamIds.has(n.id) && n.type === NODE_TYPE.IMAGE)
      .map((n) => (n.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 Text 节点（按连接顺序），仅保留 content 非空的
  const upstreamTexts = useMemo(() => {
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.TEXT)
      .map((n) => ({ id: n.id, content: ((n.data as { plainText?: string }).plainText || "").trim() }))
      .filter((t) => t.content !== "");
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 AUDIO 节点（参考音频，按连接顺序，按节点 id 与 src 双重去重）
  const upstreamAudio = useMemo(() => {
    const seenIds = new Set<string>();
    const seenSrcs = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.AUDIO)
      .map((n) => ({
        id: n.id,
        src: ((n.data as { src?: string }).src || "").trim(),
        label: ((n.data as { label?: string }).label || "").trim(),
      }))
      .filter(
        (a) =>
          a.src !== "" &&
          !seenIds.has(a.id) &&
          !seenSrcs.has(a.src) &&
          (seenIds.add(a.id), seenSrcs.add(a.src), true),
      );
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 VIDEO 节点（参考视频，按连接顺序，按节点 id 与 src 双重去重）
  const upstreamVideos = useMemo(() => {
    const seenIds = new Set<string>();
    const seenSrcs = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.VIDEO)
      .map((n) => ({
        id: n.id,
        src: ((n.data as { src?: string }).src || "").trim(),
        label: ((n.data as { label?: string }).label || "").trim(),
      }))
      .filter(
        (v) =>
          v.src !== "" &&
          !seenIds.has(v.id) &&
          !seenSrcs.has(v.src) &&
          (seenIds.add(v.id), seenSrcs.add(v.src), true),
      );
  }, [nodeId, canvasNodes, canvasEdges]);

  // 参考显示顺序：排序偏好（genSettings，唯一写者 = 拖拽排序事件）+ 连线实时列表，纯派生合并。
  // 参考区按类型分组（文本 → 音频 → 图片 → 视频），排序只在同类型内生效，跨类型拖放被禁止。
  const prefs = genSettings;
  const orderPref = prefs?.refOrder ?? EMPTY_ORDER;
  const audioOrderPref = prefs?.refAudioOrder ?? EMPTY_ORDER;
  const refVideoOrderPref = prefs?.refVideoOrder ?? EMPTY_ORDER;

  const audioSrcs = useMemo(() => upstreamAudio.map((a) => a.src), [upstreamAudio]);
  const videoSrcs = useMemo(() => upstreamVideos.map((v) => v.src), [upstreamVideos]);

  const refOrder = useMemo(() => mergeOrder(orderPref, refImages), [orderPref, refImages]);
  const audioOrder = useMemo(() => mergeOrder(audioOrderPref, audioSrcs), [audioOrderPref, audioSrcs]);
  const refVideoOrder = useMemo(() => mergeOrder(refVideoOrderPref, videoSrcs), [refVideoOrderPref, videoSrcs]);

  // 最终 prompt = 上游文本内容（按连线顺序）+ 面板输入
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

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

  // 构建 @ 提及的参考列表：顺序与参考区一致（音频 → 图片 → 视频），编号按各自 order
  const references = useMemo<ReferenceItem[]>(() => {
    const audios: ReferenceItem[] = audioOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "audio",
      label: upstreamAudio.find((a) => a.src === src)?.label || "",
    }));
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=64` : src,
      index: i,
      kind: "image",
    }));
    const videos: ReferenceItem[] = refVideoOrder.map((src, i) => ({
      src,
      thumbnail: src,
      index: i,
      kind: "video",
      label: upstreamVideos.find((v) => v.src === src)?.label || "",
    }));
    return [...audios, ...images, ...videos];
  }, [audioOrder, refOrder, refVideoOrder, upstreamAudio, upstreamVideos]);

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

  /** 参考区添加：上传图片 / 音频 / 视频 -> 新建对应参考节点并自动连到当前生成节点 */
  const handleRefUpload = useRefUpload(nodeId, { accept: "image/*,video/*,audio/*" });

  /** handleGenerate 压入的「预生成快照」，供失败 / 取消时精确回滚 */
  const pushedSnapshotRef = useRef<HistorySnapshot | null>(null);
  /** 使取消或新一轮生成中的旧异步流程失效 */
  const generationRunRef = useRef(0);
  /**
   * 任务创建请求在途：taskBinding 要等拿到真实 taskId 才写入（杜绝空 taskId
   * 中间态被持久化），提交期间的按钮取消态由该本地状态驱动。
   */
  const [submitting, setSubmitting] = useState(false);

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
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey || isGenerating || submitting) return;
    const entry: ModelOption | undefined = allModels.find((m) => m.value === modelKey);
    if (!entry) return;

    // 任务创建前置：拿到真实 taskId 之前不写 taskBinding，杜绝空 taskId 中间态
    // 被自动保存落库（刷新后监控扫描按 taskId 过滤会跳过该节点，遮罩永久卡死）。
    // 提交期间按钮取消态由 submitting 驱动；取消（runId 失效）时主动取消已创建的后端任务。
    const generationRunId = ++generationRunRef.current;
    setSubmitting(true);
    try {
      // 与 image/video 链路完全同构：prompt 落任务级文本列、参考图落 ref_images 列。
      // messages 的构造（含多模态组装与 base64 转换）由后端 llm service 归一化完成
      const res = await generationApi.submitGenerationTask({
        type: "llm",
        prompt: finalPrompt,
        model: entry.name,
        providerId: entry.providerId,
        nodeId,
        refImages: refOrder.length > 0 ? refOrder : undefined,
        refAudios: audioOrder.length > 0 ? audioOrder : undefined,
        refVideos: refVideoOrder.length > 0 ? refVideoOrder : undefined,
      });
      const json = await res.json();

      // 取消可能发生在请求返回前：主动取消已经创建的后端任务，避免留下孤儿任务
      if (generationRunId !== generationRunRef.current) {
        const taskId = json?.data?.id;
        if (taskId) await generationApi.cancelGenerationTask(taskId).catch(() => {});
        return;
      }

      if (json.code !== 200) {
        throw new Error(
          resolveApiError(parseErrorBody(json), res.status, "generate.submit_failed")
        );
      }

      const taskId: string | undefined = json.data?.id;
      if (!taskId) throw new Error(i18n.t("error.generate.no_task_id"));

      // 拿到 taskId 才写绑定：taskId 与状态同步落地，不存在「空 taskId 落库」中间态。
      // forceHistory 先压入不含绑定的干净快照，取消 / 失败时按引用精确回滚（见 dropPendingHistory）。
      const depthBefore = useHistoryStore.getState().undoStack.length;
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending", startedAt: Date.now() } }, undefined, { forceHistory: true });
      const stack = useHistoryStore.getState().undoStack;
      pushedSnapshotRef.current = stack.length > depthBefore ? stack[stack.length - 1] : null;
      await flushAndWait();
    } catch (err: unknown) {
      // 取消引发的失败不提示；全程未写 taskBinding，无需清理状态
      if (generationRunId !== generationRunRef.current) return;
      notification.error({
        title: t("generation.failed"),
        description: err instanceof Error ? err.message : "",
        placement: "bottomRight",
        duration: 15,
      });
    } finally {
      // 仅当自己仍是最新一轮时复位：被取消的轮次由 handleCancel 复位，
      // 避免旧流程收尾误关新一轮提交的取消态
      if (generationRunId === generationRunRef.current) setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    // 取消分两种：生成中（binding 处于进行中态）才取消后端任务并回滚本轮快照；
    // 提交在途（本轮 binding 尚未写入，节点上至多是上一轮已结束任务的遗留绑定）
    // 只需失效提交流程——误清会删掉上一轮 succeeded 绑定、误弹上一轮的快照
    // 丢一步撤销历史。孤儿任务由 submitTask 检测 runId 失效后主动取消
    ++generationRunRef.current;
    if (isGenerating) {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      const tid = (node?.data as TextNodeData)?.taskBinding?.taskId;
      if (tid) {
        generationApi.cancelGenerationTask(tid).catch(() => {});
      }
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      dropPendingHistory();
    }
    setSubmitting(false);
  };

  return (
    <>
      <WheelGuard
        className="ui-select-none nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
        style={{ background: "var(--canvas-bg, #262626)", border: "1px solid var(--canvas-border, #3a3a3a)", width: 580 }}
      >
        <div
          className="flex gap-2 flex-wrap"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.types.includes("application/x-ref-image") || e.dataTransfer.types.includes("application/x-ref-video") || e.dataTransfer.types.includes("application/x-ref-audio") || e.dataTransfer.types.includes("application/x-ref-text")) {
              e.dataTransfer.dropEffect = "none"; // 排序仅限同类缩略图上，加号/空白一律禁止
              return;
            }
            e.dataTransfer.dropEffect = "move";
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
          placeholder={t("generation.promptPlaceholderText")}
          style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
        />
        <div className="flex items-center gap-2">
          <MenuPopover
            open={modelOpen}
            onOpenChange={setModelOpen}
            placement="bottomLeft"
            trigger={
              <Button
                size="small"
                type="text"
                className="gen-panel-btn flex items-center gap-1.5 rounded text-sm max-w-[180px]"
                style={{ border: "none", cursor: "pointer" }}
              >
                <ModelIcon model={allModels.find((m) => m.value === modelKey)?.name ?? modelKey} style={{ fontSize: 14, flexShrink: 0 }} />
                <span className="truncate">
                  {allModels.find((m) => m.value === modelKey)?.name ?? t("modelConfig.selectModel")}
                </span>
              </Button>
            }
            content={allModels.map((m) => (
              <MenuItem
                key={m.value}
                onClick={() => {
                  setModelKey(m.value);
                  recordLastModel("text", m.value);
                  setModelOpen(false);
                }}
                selected={modelKey === m.value}
              >
                <span className="flex items-center gap-1.5">
                  <ModelIcon model={m.name} className="size-4 shrink-0" />
                  <span className="truncate">{m.name}</span>
                  {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
                </span>
              </MenuItem>
            ))}
          />
          <div className="flex-1" />
          <PrimaryActionButton
            cancel={isGenerating || submitting}
            disabled={!isGenerating && !submitting && ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey)}
            onClick={isGenerating || submitting ? handleCancel : handleGenerate}
          />
        </div>
      </WheelGuard>
    </>
  );
});

export default TextGenerationPanel;
