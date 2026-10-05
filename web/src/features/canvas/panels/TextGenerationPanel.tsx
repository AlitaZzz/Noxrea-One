/**
 * 文本生成面板，挂在文本节点下方。
 * 参考区接入四类上游，按类型分组展示：文本（拼进 prompt）→ 音频 → 图片 → 视频，
 * 组间竖线分隔；排序只在同类型内生效（跨类型拖放禁止），多模态参考可 @ 引用。
 * 负责提示词输入（含文本预设令牌）与文本模型选择，以流式方式接收生成结果并写回节点内容。
 */

"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PlusOutlined } from "@/components/ui/AppIcon";
import { PresetIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import IconActionButton from "@/components/ui/IconActionButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { TextGenSettings, TextNodeData } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import { ModelIcon } from "@/features/model/ModelIcon";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import { useModelStore } from "@/lib/model-store";

import AudioRefCard from "../shared/AudioRefCard";
import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import PresetMenuContent from "../shared/PresetMenuContent";
import { expandPresetTokens, replacePresetToken, usePromptTemplateCatalog } from "../shared/prompt-presets";
import { EMPTY_ORDER, mergeOrder, useGenSettings, writeGenSettings, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import TextRefChip from "../shared/TextRefChip";
import VideoRefCard from "../shared/VideoRefCard";
import { useGenerationSubmit } from "./use-generation-submit";

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
  const { notification } = useAppFeedback();

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

  // 预设目录（与图片面板同机制）：按 target 取文本预设（反推 / 扩写），
  // 选中后以令牌 chip 形式插入提示词，提交前统一展开为模板全文
  const { data: promptTemplateCatalog } = usePromptTemplateCatalog("text");
  const [presetOpen, setPresetOpen] = useState(false);
  const handleApplyPreset = useCallback((presetId: string) => {
    setPrompt(replacePresetToken(prompt, presetId));
  }, [prompt, setPrompt]);

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

  /**
   * 任务创建请求在途：taskBinding 要等拿到真实 taskId 才写入（杜绝空 taskId
   * 中间态被持久化），提交期间的按钮取消态由该本地状态驱动。
   */
  const [submitting, setSubmitting] = useState(false);
  // ── 生成提交：ownership fencing 收口在 useGenerationSubmit（GEN-01）──
  // owner = 画布项目 + 目标节点 + 提交世代；owner 失效（取消 / 新一轮 / 卸载 /
  // 切项目 / 节点已删）时迟到的 taskId 会被静默取消，绝不写绑定
  const { beginRun, isCurrent, invalidate, submitWithOwner, dropPendingHistory } = useGenerationSubmit();

  const handleGenerate = async () => {
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey || isGenerating || submitting) return;
    const entry: ModelOption | undefined = allModels.find((m) => m.value === modelKey);
    if (!entry) return;

    // 任务创建前置：拿到真实 taskId 之前不写 taskBinding，杜绝空 taskId 中间态
    // 被自动保存落库（刷新后监控扫描按 taskId 过滤会跳过该节点，遮罩永久卡死）。
    // 提交期间按钮取消态由 submitting 驱动；owner 失效时 submitWithOwner 会
    // 主动取消已创建的后端任务，不产生孤儿任务。
    const runId = beginRun();
    setSubmitting(true);
    try {
      // preset 令牌在提交前展开为模板全文（任务记录保存可读全文；模板热更新每次生效）
      const submittedPrompt = await expandPresetTokens(finalPrompt);
      if (!isCurrent(runId)) return;
      // 与 image/video 链路完全同构：prompt 落任务级文本列、参考图落 ref_images 列。
      // messages 的构造（含多模态组装与 base64 转换）由后端 llm service 归一化完成
      const outcome = await submitWithOwner({
        runId,
        nodeId,
        request: () => generationApi.submitGenerationTask({
          type: "llm",
          prompt: submittedPrompt,
          model: entry.name,
          providerId: entry.providerId,
          nodeId,
          refImages: refOrder.length > 0 ? refOrder : undefined,
          refAudios: audioOrder.length > 0 ? audioOrder : undefined,
          refVideos: refVideoOrder.length > 0 ? refVideoOrder : undefined,
        }),
      });

      if (!isCurrent(runId)) return;
      if (outcome.status === "failed") {
        notification.error({
          title: t("generation.failed"),
          description: outcome.error,
          placement: "bottomRight",
          duration: 15,
          key: `generation-failed-${nodeId}`,
        });
      }
      // stale：owner 已失效，任务已被静默取消，不提示不写状态
    } catch (err: unknown) {
      if (!isCurrent(runId)) return;
      notification.error({
        title: t("generation.failed"),
        description: err instanceof Error ? err.message : "",
        placement: "bottomRight",
        duration: 15,
        key: `generation-failed-${nodeId}`,
      });
    } finally {
      // 仅当自己仍是最新一轮时复位：被取消的轮次由 handleCancel 复位，
      // 避免旧流程收尾误关新一轮提交的取消态
      if (isCurrent(runId)) setSubmitting(false);
    }
  };

  const handleCancel = () => {
    // 取消分两种：生成中（binding 处于进行中态）才取消后端任务并回滚本轮快照；
    // 提交在途（本轮 binding 尚未写入，节点上至多是上一轮已结束任务的遗留绑定）
    // 只需失效提交流程——误清会删掉上一轮 succeeded 绑定、误弹上一轮的快照
    // 丢一步撤销历史。孤儿任务由 submitWithOwner 检测 owner 失效后主动取消
    invalidate();
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
      <WheelGuard asChild>
        <Card className="ui-select-none nodrag nopan w-[580px] gap-2 px-4 py-3">
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
                {i > 0 && <Separator orientation="vertical" className="mx-1 h-14 self-center" />}
                {group.content}
              </Fragment>
            ))}
            {/* 添加参考：方形加号占位，与参考缩略图同行 */}
            <Tooltip><TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-14 shrink-0 rounded-md border-dashed p-0"
                  onClick={handleRefUpload}>
                  <PlusOutlined className="size-5" />
                </Button>
              </TooltipTrigger><TooltipContent>{t("common.reference")}</TooltipContent></Tooltip>
          </div>
        <MentionPrompt
          references={references}
          value={prompt}
          onChange={setPrompt}
          placeholder={t("generation.promptPlaceholderText")}
          style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
        />
        <div className="flex items-center gap-2">
          <DropdownMenu open={modelOpen} onOpenChange={setModelOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="max-w-[180px] gap-1.5"
              >
                <ModelIcon model={allModels.find((m) => m.value === modelKey)?.name ?? modelKey} className="size-3.5 shrink-0" />
                <span className="truncate">
                  {allModels.find((m) => m.value === modelKey)?.name ?? t("modelConfig.selectModel")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="bottom" align="start">
              {allModels.map((model) => (
                <DropdownMenuItem
                  key={model.value}
                  className={model.value === modelKey ? "bg-accent text-accent-foreground" : undefined}
                  onSelect={() => { setModelKey(model.value); recordLastModel("text", model.value); }}
                >
                  <ModelIcon model={model.name} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  {model.providerName && <span className="ml-auto max-w-24 truncate text-xs opacity-50">{model.providerName}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-7 self-center" />
          <Popover open={presetOpen} onOpenChange={setPresetOpen}>
            <Tooltip open={presetOpen ? false : undefined}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button size="icon-sm" variant="ghost" className="shrink-0">
                    <PresetIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent>{t("node.creationPreset")}</TooltipContent>
            </Tooltip>
            <PopoverContent side="bottom" align="start" className="w-auto max-w-[min(90vw,48rem)] p-1">
              <PresetMenuContent
                catalog={promptTemplateCatalog}
                onSelect={(presetId) => { setPresetOpen(false); handleApplyPreset(presetId); }}
              />
            </PopoverContent>
          </Popover>
          <div className="flex-1" />
          <IconActionButton
            cancel={isGenerating || submitting}
            disabled={!isGenerating && !submitting && ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey)}
            onClick={isGenerating || submitting ? handleCancel : handleGenerate}
          />
        </div>
        </Card>
      </WheelGuard>
    </>
  );
});

export default TextGenerationPanel;
