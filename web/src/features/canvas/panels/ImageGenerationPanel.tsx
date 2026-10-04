/**
 * 图片生成面板，挂在图片节点下方。
 * 负责提示词输入（支持 @ 引用其他节点）、模型与画质 / 分辨率 / 比例 / 张数等参数配置，
 * 提交生成任务并把参数持久化到节点数据，生成结果回填当前节点或派生新节点。
 */

"use client";

import { Fragment, memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { PlusOutlined } from "@/components/ui/AppIcon";
import { ParamsIcon } from "@/components/ui/AppIcon";
import { PresetIcon } from "@/components/ui/AppIcon";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import IconActionButton from "@/components/ui/IconActionButton";
import ParamFields, { ParamSummary } from "@/components/ui/ParamFields";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppFeedback } from "@/components/ui/use-app-feedback";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import { createImageNode } from "@/features/canvas/node-defaults";
import { markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import type { ImageGenSettings, MediaGenFields } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import { ModelIcon } from "@/features/model/ModelIcon";
import { fieldDefaults, hasField, toParamFieldViews } from "@/features/model/param-fields";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import { useModelStore } from "@/lib/model-store";

import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import PresetMenuContent from "../shared/PresetMenuContent";
import {
  expandPresetTokens,
  localizeText,
  presetTokenOf,
  replacePresetToken,
  usePromptTemplateCatalog,
} from "../shared/prompt-presets";
import { applyRatioToNode } from "../shared/ratio-size";
import { EMPTY_ORDER, mergeOrder, useGenSettings, writeGenSettings, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import TextRefChip from "../shared/TextRefChip";
import { spawnPromptDerivedNode } from "../upload/derived-node";
import { useGenerationSubmit } from "./use-generation-submit";

interface Props { nodeId: string; }

const ImageGenerationPanel = memo(function ImageGenerationPanel({ nodeId }: Props) {
  const { t, i18n } = useTranslation();
  const providers = useModelStore((s) => s.providers);
  const findModelParams = useModelStore((s) => s.findModelParams);
  const modelParamsCache = useModelStore((s) => s.modelParamsCache);
  const allModels = useMemo(() => providers.flatMap((c) =>
    c.models.filter((m) => m.capabilities?.includes("image")).map((m) => ({ value: `${c.id}/${m.name}`, providerId: c.id, modelId: m.id, name: m.name, providerName: c.name }))
  ).filter((m, i, arr) => arr.findIndex((x) => x.value === m.value) === i), [providers]);

  // ── 受控模式：genSettings 是唯一数据源 ──
  // useGenSettings 反应式读取，外部写入（画布 Agent update_node 等）即时可见；
  // 编辑经 writeGenSettings 立即写回（skipHistory：连续编辑不压 undo 栈，保存由 SaveManager 合并）。
  // 未持久化的字段回退到当前模型的默认值。
  const genSettings = useGenSettings(nodeId) as Partial<ImageGenSettings> | undefined;
  const prompt = genSettings?.prompt ?? "";
  const modelKey = resolveModelKey(genSettings?.modelKey, "image", allModels);

  // 查找当前模型的参数配置（params + defaults + constraints）
  // 订阅 modelParamsCache：缓存晚于挂载到达时能触发重算
  const modelParams = useMemo(() => {
    const entry = allModels.find((m) => m.value === modelKey);
    return entry ? findModelParams(entry.providerId, entry.name, "image") : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey, allModels, findModelParams, modelParamsCache]);

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

  const [modelOpen, setModelOpen] = useState(false);
  const [presetOpen, setPresetOpen] = useState(false);
  // 参考区是否有任意参考正在拖拽：拖拽期间抑制所有卡片的放大预览浮层
  const [isRefDragging, setIsRefDragging] = useState(false);
  /**
   * 任务创建请求在途：taskBinding 要等拿到真实 taskId 才写入（杜绝空 taskId
   * 中间态被持久化），提交期间的按钮取消态由该本地状态驱动。
   */
  const [submitting, setSubmitting] = useState(false);

  // 悬空模型键纠偏：持久化的 modelKey 已不存在（模型被移除 / 换渠道 ID 变化）时，
  // 按「上次使用的模型 → 第一个可用」写回（resolveModelKey(undefined, …) 即该回退链）；
  // 未持久化（modelKey 为空）时不写：展示层由 resolveModelKey 回退，
  // 一旦写回会把「记住上次使用的模型」永久固化到节点数据。
  useEffect(() => {
    if (allModels.length === 0) return;
    const persisted = genSettings?.modelKey;
    if (!persisted || allModels.some((m) => m.value === persisted)) return;
    writeGenSettings(nodeId, { modelKey: resolveModelKey(undefined, "image", allModels) });
  }, [allModels, genSettings?.modelKey, nodeId]);

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

  // 模型切换时：重置不在新模型 options 中的参数
  useEffect(() => {
    if (!Array.isArray(modelParams?.fields)) return;
    // 空节点占位框按当前模型默认比例落位（ratio 未设置时），与建节点工厂同一规则；
    // 覆盖建节点时参数配置尚未就绪、占位框暂落结构默认尺寸的场景
    const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
    const gs = (node?.data as MediaGenFields | undefined)?.genSettings as ImageGenSettings | undefined;
    if (node && !(node.data as { src?: string }).src && !gs?.ratio && typeof defaults.ratio === "string") {
      applyRatioToNode(nodeId, defaults.ratio);
    }
    for (const f of modelParams.fields) {
      const cur = fieldValues[f.name] as string | number | undefined;
      if (f.options && f.options.length && cur !== undefined && !f.options.includes(cur)) {
        setField(f.name, f.default);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelParams]);

  // Upstream reference images - derived live from current edges.
  const canvasNodes = useCanvasStore((s) => s.nodes);
  const canvasEdges = useCanvasStore((s) => s.edges);
  const refImages = useMemo(() => {
    const upstreamIds = new Set(canvasEdges.filter((e) => e.target === nodeId).map((e) => e.source));
    return canvasNodes
      .filter((n) => upstreamIds.has(n.id) && n.type === NODE_TYPE.IMAGE)
      .map((n) => (n.data as { src?: string }).src)
      .filter(Boolean) as string[];
  }, [nodeId, canvasNodes, canvasEdges]);

  // 上游 Text 节点（按连接顺序，去重），仅保留 content 非空的
  const upstreamTexts = useMemo(() => {
    const seen = new Set<string>();
    return canvasEdges
      .filter((e) => e.target === nodeId)
      .map((e) => canvasNodes.find((n) => n.id === e.source))
      .filter((n): n is NonNullable<typeof n> => !!n && n.type === NODE_TYPE.TEXT)
      .map((n) => ({ id: n.id, content: ((n.data as { plainText?: string }).plainText || "").trim() }))
      .filter((t) => t.content !== "" && !seen.has(t.id) && seen.add(t.id));
  }, [nodeId, canvasNodes, canvasEdges]);

  // 参考显示顺序：排序偏好（genSettings，唯一写者 = 拖拽排序事件）+ 连线实时列表，纯派生合并。
  // 图片节点上游只有文本与图片；排序只在同类型内生效（文本参考不可拖动）。
  const orderPref = genSettings?.refOrder ?? EMPTY_ORDER;
  const refOrder = useMemo(() => mergeOrder(orderPref, refImages), [orderPref, refImages]);

  // 最终 prompt = 上游文本内容（按连线顺序）+ 面板输入
  const finalPrompt = useMemo(() => {
    return [...upstreamTexts.map((t) => t.content), prompt.trim()].filter(Boolean).join("\n");
  }, [upstreamTexts, prompt]);

  // 同类内拖拽排序（图↔图）：事件驱动写入排序偏好并即时持久化
  const handleImageReorder = useCallback((dragged: string, target: string) => {
    const list = [...refOrder];
    const fromIdx = list.indexOf(dragged);
    const toIdx = list.indexOf(target);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = list.splice(fromIdx, 1);
    list.splice(toIdx, 0, moved);
    writeOrderPref(nodeId, { refOrder: list });
  }, [refOrder, nodeId]);

  // 构建 @ 提及的参考图列表（基于 refOrder，保证图1图2编号稳定）
  const references = useMemo<ReferenceItem[]>(() => {
    return refOrder.map((src, i) => ({
      src,
      thumbnail: src.includes("/api/files/") ? `${src}?w=64` : src,
      index: i,
      kind: "image" as const,
    }));
  }, [refOrder]);

  // Button disabled state derived from persistent node.data.task_status
  const isGenerating = useMemo(() => {
    const node = canvasNodes.find((n) => n.id === nodeId);
    return isGeneratingBinding((node?.data as MediaGenFields)?.taskBinding);
  }, [canvasNodes, nodeId]);

  // ── 生成提交：ownership fencing 收口在 useGenerationSubmit（GEN-01）──
  // owner = 画布项目 + 目标节点 + 提交世代；owner 失效（取消 / 新一轮 / 卸载 /
  // 切项目 / 节点已删）时迟到的 taskId 会被静默取消，绝不写绑定
  const { notification } = useAppFeedback();
  const { beginRun, isCurrent, invalidate, submitWithOwner, dropPendingHistory } = useGenerationSubmit();

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
      }
      useCanvasStore.getState().updateNodeData(nodeId, {
        taskBinding: undefined,
      }, undefined, { skipHistory: true });
      markDirtyImmediate();
      dropPendingHistory();
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
      // 单选切到派生节点：RfNodeToolbar 跟随单选，面板随之挂到新节点
      store.setNodes(store.getNodes().map((n) => ({ ...n, selected: n.id === created.id })));
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
      <WheelGuard
        className="ui-select-none nodrag nopan flex w-[640px] flex-col gap-2 rounded-lg border border-border bg-card px-4 py-3 text-card-foreground shadow-xl"
      >
        <div
          className="flex gap-2 flex-wrap"
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.dataTransfer.types.includes('application/x-ref-image') || e.dataTransfer.types.includes('application/x-ref-video') || e.dataTransfer.types.includes('application/x-ref-audio') || e.dataTransfer.types.includes('application/x-ref-text')) {
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
          placeholder={t("generation.promptPlaceholder")}
          style={{ minHeight: 100, outline: "none", boxShadow: "none" }}
        />
        <div className="flex items-center gap-2">
          <DropdownMenu open={modelOpen} onOpenChange={setModelOpen}>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="max-w-[180px] gap-1.5">
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
                  onSelect={() => { setModelKey(model.value); recordLastModel("image", model.value); }}
                >
                  <ModelIcon model={model.name} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{model.name}</span>
                  {model.providerName && <span className="ml-auto max-w-24 truncate text-xs opacity-50">{model.providerName}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Separator orientation="vertical" className="h-7 self-center" />
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" className="shrink-0 gap-1">
                <ParamsIcon className="size-4 shrink-0" />
                <ParamSummary fields={fieldViews} values={fieldValues} />
              </Button>
            </PopoverTrigger>
            <PopoverContent side="bottom" align="start" className="w-[360px] max-w-[calc(100vw-2rem)] p-3">
              <ParamFields fields={fieldViews} values={fieldValues} onChange={setField} />
            </PopoverContent>
          </Popover>
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
      </WheelGuard>
    </>
  );
});

export default ImageGenerationPanel;
