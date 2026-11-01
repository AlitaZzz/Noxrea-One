/**
 * 图片生成面板，挂在图片节点下方。
 * 负责提示词输入（支持 @ 引用其他节点）、模型与画质 / 分辨率 / 比例 / 张数等参数配置，
 * 提交生成任务并把参数持久化到节点数据，生成结果回填当前节点或派生新节点。
 */

"use client";

import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ParamsIcon } from "@/components/ui/AppIcon";
import { PresetIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import IconActionButton from "@/components/ui/IconActionButton";
import { ParamSummary } from "@/components/ui/ParamFields";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { useNodeGenerating } from "@/features/canvas/hooks/use-node-generating";
import { useNodeUpstreamRefs } from "@/features/canvas/hooks/use-node-upstream-refs";
import { createImageNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { ImageGenSettings, MediaGenFields } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import ModelParamFields from "@/features/model/components/ModelParamFields";
import { ModelSelector } from "@/features/model/components/ModelSelector";
import { fieldDefaults, hasField, toParamFieldViews } from "@/features/model/param-fields";
import { useModelStore } from "@/lib/model-store";

import { useGenSettings, writeGenSettings } from "../shared/gen-settings";
import GenerationRefChrome from "../shared/GenerationRefChrome";
import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import { modelsForCapability } from "../shared/model-catalog";
import PresetMenuContent from "../shared/PresetMenuContent";
import {
  expandPresetTokens,
  localizeText,
  presetTokenOf,
  replacePresetToken,
  usePromptTemplateCatalog,
} from "../shared/prompt-presets";
import { applyRatioToNode } from "../shared/ratio-size";
import { EMPTY_ORDER, mergeOrder, swapOrderItems, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import { applySelection } from "../shared/selection";
import TextRefChip from "../shared/TextRefChip";
import { spawnPromptDerivedNode } from "../upload/derived-node";
import { useGenerationPanelState } from "./use-generation-panel-state";
import { popPreGenSnapshot, useGenerationSubmit } from "./use-generation-submit";

interface Props {
  nodeId: string;
  /** 面板当前是否可见：隐藏时停止订阅、复位本地交互态，仅保留编辑器实例与内容 */
  active: boolean;
}

const ImageGenerationPanel = memo(function ImageGenerationPanel({ nodeId, active }: Props) {
  const { t, i18n } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const allModels = useMemo(() => modelsForCapability(providers, "image"), [providers]);

  // ── 受控模式：genSettings 是唯一数据源 ──
  // useGenSettings 反应式读取，外部写入（画布 Agent update_node 等）即时可见；
  // 编辑经 writeGenSettings 立即写回（skipHistory：连续编辑不压 undo 栈，保存由 SaveManager 合并）。
  // 未持久化的字段回退到当前模型的默认值。
  const genSettings = useGenSettings(nodeId, active) as Partial<ImageGenSettings> | undefined;
  const prompt = genSettings?.prompt ?? "";
  const modelKey = resolveModelKey(genSettings?.modelKey, "image", allModels);

  // 查找当前模型的参数配置（params + defaults + constraints）
  // 直接从 store selector 读取，模型参数缓存更新时会重新计算并触发面板重渲染。
  const modelParams = useModelStore((state) => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? state.findModelParams(entry.providerId, entry.name, "image") : null;
  });

  const defaults = useMemo(
    () => (Array.isArray(modelParams?.fields) ? fieldDefaults(modelParams.fields) : {}),
    [modelParams]
  );
  // 未就绪不落值：params 缓存未到达时字段保持 undefined（fields 为空、参数区不渲染），
  // 等缓存到达后由 defaults 物化——不硬编码兜底值，杜绝错误兜底值的渲染闪烁与误持久化
  const quality = genSettings?.quality ?? (defaults.quality as string | undefined);
  const resolution = genSettings?.resolution ?? (defaults.resolution as string | undefined);
  const ratio = genSettings?.ratio ?? (defaults.ratio as string | undefined);
  const n = genSettings?.n ?? (defaults.n as number | undefined);

  // write-through setters：保持旧签名，编辑立即落 store
  const setPrompt = useCallback((v: string) => writeGenSettings(nodeId, { prompt: v }), [nodeId]);
  const setModelKey = useCallback((v: string) => writeGenSettings(nodeId, { modelKey: v }), [nodeId]);

  // 预设目录来自后端（与创作菜单同一份数据源），按 target 取图片预设
  const { data: promptTemplateCatalog } = usePromptTemplateCatalog("image");
  const presets = useMemo(() => promptTemplateCatalog?.entries ?? [], [promptTemplateCatalog]);

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = Array.isArray(modelParams?.fields) ? modelParams.fields : [];
  const fieldViews = toParamFieldViews(fields, t);
  const fieldValues: Record<string, unknown> = { quality, resolution, ratio, n };
  const setField = (name: string, value: unknown) => {
    if (name === "quality") writeGenSettings(nodeId, { quality: value });
    else if (name === "resolution") writeGenSettings(nodeId, { resolution: value });
    else if (name === "ratio") {
      writeGenSettings(nodeId, { ratio: value });
      // 空节点占位框跟随所选比例（已有内容 / adaptive 跳过）
      applyRatioToNode(nodeId, value as string);
    }
    else if (name === "n") writeGenSettings(nodeId, { n: value });
  };

  // 模型切换 / 字段越界的纠偏与空节点占位比例统一在数据层完成
  // （writeGenSettings 写入口 + 画布级归一化），挂载面板不再写回节点数据。

  // 上游引用（图片 / 文本）：按内容订阅，位置变化（拖动提交、整理动画）不重渲染。
  const { images: refImages, texts: upstreamTexts } = useNodeUpstreamRefs(nodeId, active);

  // 参考显示顺序：排序偏好（genSettings，唯一写者 = 拖拽排序事件）+ 连线实时列表，纯派生合并。
  // 图片节点上游只有文本与图片；排序只在同类型内生效（文本参考不可拖动）。
  const orderPref = genSettings?.refOrder ?? EMPTY_ORDER;
  const refOrder = useMemo(() => mergeOrder(orderPref, refImages), [orderPref, refImages]);

  // 最终 prompt = 上游文本内容（按连线顺序）+ 面板输入
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // 同类内拖放交换（图↔图）：事件驱动写入排序偏好并即时持久化
  const handleImageReorder = useCallback((dragged: string, target: string) => {
    const next = swapOrderItems(refOrder, dragged, target);
    if (next) writeOrderPref(nodeId, { refOrder: next });
  }, [refOrder, nodeId]);

  // 构建 @ 提及的参考图列表（基于 refOrder，保证图1图2编号稳定）
  const references = useMemo<ReferenceItem[]>(() => {
    return refOrder.map((src, i) => ({
      src,
      index: i,
      kind: "image" as const,
    }));
  }, [refOrder]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useNodeGenerating(nodeId, active);

  // ── 生成提交：ownership fencing 收口在 useGenerationSubmit（GEN-01）──
  // owner = 画布项目 + 目标节点 + 提交世代；owner 失效（取消 / 新一轮 / 卸载 /
  // 切项目 / 节点已删）时迟到的 taskId 会被静默取消，绝不写绑定
  const { notification } = useAppFeedback();
  const { beginRun, isCurrent, invalidate, submitWithOwner } = useGenerationSubmit();
  const { submitting, setSubmitting, isRefDragging, setIsRefDragging, menuOpen, setMenuOpen } =
    useGenerationPanelState(nodeId, active, invalidate);

  /** 参考区添加：上传图片 -> 新建参考节点并自动连到当前生成节点 */
  const handleRefUpload = useRefUpload(nodeId);

  const handleGenerate = async () => {
    if (isGenerating || submitting) return;
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const provider = providers.find((c) => c.id === entry.providerId);
    if (!provider) return;

    // 任务创建前置：拿到真实 taskId 之前不写 taskBinding，杜绝空 taskId 中间态
    // 被自动保存落库（刷新后监控扫描按 taskId 过滤会跳过该节点，遮罩永久卡死）。
    // 提交期间按钮取消态由 submitting 驱动；owner 失效时 submitWithOwner 会
    // 主动取消已创建的后端任务，不产生孤儿任务。
    const runId = beginRun();
    setSubmitting(true);
    // preset 令牌在提交前展开为模板全文（任务记录保存可读全文；模板热更新每次生效）
    try {
      const submittedPrompt = await expandPresetTokens(finalPrompt);
      if (!isCurrent(runId)) return;
      const outcome = await submitWithOwner({
        runId,
        nodeId,
        request: () => generationApi.submitGenerationTask({
          type: "image",
          prompt: submittedPrompt.trim(),
          model: entry.name,
          providerId: entry.providerId,
          quality: hasField(fields, "quality") ? quality : undefined,
          resolution: hasField(fields, "resolution") ? resolution : undefined,
          ratio: hasField(fields, "ratio") ? ratio : undefined,
          n: hasField(fields, "n") ? n : undefined,
          refImages: refOrder.length > 0 ? refOrder : undefined,
          nodeId,
        }),
      });

      if (!isCurrent(runId)) return;
      if (outcome.status === "failed") {
        notification.error({
          title: i18n.t("generation.failed"),
          description: outcome.error,
          placement: "bottomRight",
          duration: 15,
          key: `generation-failed-${nodeId}`,
        });
      }
      // stale：owner 已失效，任务已被静默取消，不提示不写状态
    } catch (error: unknown) {
      if (!isCurrent(runId)) return;
      notification.error({
        title: i18n.t("generation.failed"),
        description: error instanceof Error ? error.message : "",
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
      const tid = (node?.data as MediaGenFields)?.taskBinding?.taskId;
      if (tid) {
        generationApi.cancelGenerationTask(tid).catch(() => {});
        popPreGenSnapshot(tid);
      }
      useCanvasStore.getState().updateNodeData(nodeId, {
        taskBinding: undefined,
      }, undefined, { skipHistory: true });
      markDirtyImmediate();
    }
    setSubmitting(false);
  };

  // ── 预设：空节点改写本节点提示词；有图节点派生子节点承载（源图只读），选中态跟随 ──
  const handleApplyPreset = useCallback((presetId: string) => {
    const store = useCanvasStore.getState();
    const node = store.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    if ((node.data as { src?: string }).src) {
      const preset = presets.find((p) => p.id === presetId);
      const created = spawnPromptDerivedNode(nodeId, presetTokenOf(presetId), createImageNode, store, {
        label: preset ? localizeText(preset.label, i18n.language) : presetId,
      });
      if (!created) return;
      markDirtyImmediate();
      // 单选切到派生节点：派生节点不挂生成面板（genTarget 只认非 upload/derived），
      // 面板随目标失效隐藏，编辑器内容仍留在源节点上
      applySelection(store.getNodes(), (n) => n.id === created.id, store.setNodes);
    } else {
      setPrompt(replacePresetToken(prompt, presetId));
    }
  }, [nodeId, prompt, setPrompt, i18n, presets]);

  // 参考区分组（文本 → 音频 → 图片 → 视频）：只收集非空组，渲染时组间插竖线分隔。
  // 图片节点上游只有文本与图片，故最多两组。
  const refGroups: { key: string; content: React.ReactNode }[] = [];
  if (upstreamTexts.length > 0) {
    refGroups.push({
      key: "text",
      content: upstreamTexts.map((txt) => (
        <TextRefChip key={`text-${txt.id}`} id={txt.id} content={txt.content} nodeId={nodeId} />
      )),
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

  return (
    <>
      <WheelGuard asChild>
        <Card className="ui-select-none nodrag nopan w-[640px] gap-2 px-4 py-3">
        {/* 参考区与操作区随面板显隐：隐藏时整组卸载（Radix 浮层随之关闭、
            参考卡片停止媒体订阅）；编辑器实例与内容常驻，重新可见时只挂这层 chrome */}
        <GenerationRefChrome active={active} groups={refGroups} onUpload={handleRefUpload} />
        <MentionPrompt
          nodeId={nodeId}
          active={active}
          references={references}
          value={prompt}
          onChange={setPrompt}
          placeholder={t("generation.promptPlaceholder")}
        />
        {active && (
        <div className="flex items-center gap-2">
          <ModelSelector
            models={allModels}
            value={modelKey}
            onValueChange={(value) => { setModelKey(value); recordLastModel("image", value); }}
            placeholder={t("modelConfig.selectModel")}
          />
          <Separator orientation="vertical" className="h-7 self-center" />
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="shrink-0 gap-1">
                <ParamsIcon className="size-4 shrink-0" />
                <ParamSummary fields={fieldViews} values={fieldValues} />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="start" className="w-[360px] max-w-[calc(100vw-2rem)] p-3">
              <ModelParamFields hasModel={Boolean(modelKey)} fields={modelParams ? fieldViews : null} values={fieldValues} onChange={setField} />
            </PopoverContent>
          </Popover>
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

export default ImageGenerationPanel;
