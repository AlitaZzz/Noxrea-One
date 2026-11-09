/**
 * 文本生成面板，挂在文本节点下方。
 * 参考区接入四类上游，按类型分组展示：文本（拼进 prompt）→ 音频 → 图片 → 视频，
 * 组间竖线分隔；排序只在同类型内生效（跨类型拖放禁止），多模态参考可 @ 引用。
 * 负责提示词输入（含文本预设令牌）与文本模型选择，以流式方式接收生成结果并写回节点内容。
 */

"use client";

import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ModelSelector } from "@/components/model/ModelSelector";
import { PresetIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import IconActionButton from "@/components/ui/IconActionButton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { useNodeGenerating } from "@/features/canvas/hooks/use-node-generating";
import { useNodeUpstreamRefs } from "@/features/canvas/hooks/use-node-upstream-refs";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { TextGenSettings, TextNodeData } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import { useModelStore } from "@/lib/model-store";

import AudioRefCard from "../shared/AudioRefCard";
import { useGenSettings, writeGenSettings } from "../shared/gen-settings";
import GenerationRefChrome from "../shared/GenerationRefChrome";
import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import { modelsForCapability } from "../shared/model-catalog";
import PresetMenuContent from "../shared/PresetMenuContent";
import { expandPresetTokens, replacePresetToken, usePromptTemplateCatalog } from "../shared/prompt-presets";
import { EMPTY_ORDER, mergeOrder, swapOrderItems, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import TextRefChip from "../shared/TextRefChip";
import VideoRefCard from "../shared/VideoRefCard";
import { useGenerationPanelState } from "./use-generation-panel-state";
import { popPreGenSnapshot, useGenerationSubmit } from "./use-generation-submit";

interface Props {
  nodeId: string;
  /** 面板当前是否可见：隐藏时停止订阅、复位本地交互态，仅保留编辑器实例与内容 */
  active: boolean;
}

const TextGenerationPanel = memo(function TextGenerationPanel({ nodeId, active }: Props) {
  const { t } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const { notification } = useAppFeedback();

  const allModels = useMemo(() => modelsForCapability(providers, "text"), [providers]);

  // ── 受控模式：genSettings 是唯一数据源 ──
  // useGenSettings 反应式读取，外部写入（画布 Agent update_node 等）即时可见；
  // 编辑经 writeGenSettings 立即写回（skipHistory，保存由 SaveManager 合并）。
  const genSettings = useGenSettings(nodeId, active) as Partial<TextGenSettings> | undefined;
  const prompt = genSettings?.prompt ?? "";
  const modelKey = resolveModelKey(genSettings?.modelKey, "text", allModels);
  const setPrompt = useCallback((v: string) => writeGenSettings(nodeId, { prompt: v }), [nodeId]);
  const setModelKey = useCallback((v: string) => writeGenSettings(nodeId, { modelKey: v }), [nodeId]);

  // 预设目录（与图片面板同机制）：按 target 取文本预设（反推 / 扩写），
  // 选中后以令牌 chip 形式插入提示词，提交前统一展开为模板全文
  const { data: promptTemplateCatalog } = usePromptTemplateCatalog("text");
  const handleApplyPreset = useCallback((presetId: string) => {
    setPrompt(replacePresetToken(prompt, presetId));
  }, [prompt, setPrompt]);

  // 悬空模型键纠偏统一在数据层完成（writeGenSettings 写入口 + 画布级归一化），
  // 挂载面板不再写回节点数据；展示层仍由 resolveModelKey 回退。

  // 上游引用（图片 / 文本 / 音频 / 视频）：按内容订阅，位置变化（拖动提交、整理动画）不重渲染。
  const {
    images: refImages,
    texts: upstreamTexts,
    audios: upstreamAudio,
    videos: upstreamVideos,
  } = useNodeUpstreamRefs(nodeId, active);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useNodeGenerating(nodeId, active);

  // ── 生成提交：ownership fencing 收口在 useGenerationSubmit（GEN-01）──
  // owner = 画布项目 + 目标节点 + 提交世代；owner 失效（取消 / 新一轮 / 卸载 /
  // 切项目 / 节点已删）时迟到的 taskId 会被静默取消，绝不写绑定
  const { beginRun, isCurrent, invalidate, submitWithOwner } = useGenerationSubmit();
  const { submitting, setSubmitting, isRefDragging, setIsRefDragging, menuOpen, setMenuOpen } =
    useGenerationPanelState(nodeId, active, invalidate);

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

  // 同类内拖放交换（图↔图 / 音↔音 / 视频↔视频）：事件驱动写入排序偏好并即时持久化
  const handleAudioReorder = useCallback((dragged: string, target: string) => {
    const next = swapOrderItems(audioOrder, dragged, target);
    if (next) writeOrderPref(nodeId, { refAudioOrder: next });
  }, [audioOrder, nodeId]);

  const handleImageReorder = useCallback((dragged: string, target: string) => {
    const next = swapOrderItems(refOrder, dragged, target);
    if (next) writeOrderPref(nodeId, { refOrder: next });
  }, [refOrder, nodeId]);

  const handleVideoReorder = useCallback((dragged: string, target: string) => {
    const next = swapOrderItems(refVideoOrder, dragged, target);
    if (next) writeOrderPref(nodeId, { refVideoOrder: next });
  }, [refVideoOrder, nodeId]);

  // 构建 @ 提及的参考列表：顺序与参考区一致（音频 → 图片 → 视频），编号按各自 order
  const references = useMemo<ReferenceItem[]>(() => {
    const audios: ReferenceItem[] = audioOrder.map((src, i) => ({
      src,
      index: i,
      kind: "audio",
      label: upstreamAudio.find((a) => a.src === src)?.label || "",
    }));
    const images: ReferenceItem[] = refOrder.map((src, i) => ({
      src,
      index: i,
      kind: "image",
    }));
    const videos: ReferenceItem[] = refVideoOrder.map((src, i) => ({
      src,
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

  const handleGenerate = async () => {
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey || isGenerating || submitting) return;
    const entry = allModels.find((m) => m.value === modelKey);
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
        popPreGenSnapshot(tid);
      }
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
    }
    setSubmitting(false);
  };

  return (
    <>
      <WheelGuard asChild>
        <Card className="ui-select-none nodrag nopan w-[580px] gap-2 px-4 py-3">
        {/* 参考区与操作区随面板显隐：隐藏时整组卸载（Radix 浮层随之关闭、
            参考卡片停止媒体订阅）；编辑器实例与内容常驻，重新可见时只挂这层 chrome */}
        <GenerationRefChrome active={active} groups={refGroups} onUpload={handleRefUpload} />
        <MentionPrompt
          nodeId={nodeId}
          active={active}
          references={references}
          value={prompt}
          onChange={setPrompt}
          placeholder={t("generation.promptPlaceholderText")}
        />
        {active && (
        <div className="flex items-center gap-2">
          <ModelSelector
            models={allModels}
            value={modelKey}
            onValueChange={(value) => { setModelKey(value); recordLastModel("text", value); }}
            placeholder={t("modelConfig.selectModel")}
          />
          <Separator orientation="vertical" className="h-7 self-center" />
          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <Button size="icon-sm" variant="ghost" className="shrink-0">
                    <PresetIcon />
                  </Button>
                </PopoverTrigger>
              </TooltipTrigger>
              {!menuOpen && <TooltipContent>{t("node.creationPreset")}</TooltipContent>}
            </Tooltip>
            <PopoverContent side="bottom" align="start" className="w-auto max-w-[min(90vw,48rem)] p-1">
              <PresetMenuContent
                catalog={promptTemplateCatalog}
                onSelect={(presetId) => { setMenuOpen(false); handleApplyPreset(presetId); }}
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
        )}
        </Card>
      </WheelGuard>
    </>
  );
});

export default TextGenerationPanel;
