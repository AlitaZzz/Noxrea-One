/**
 * 图片生成面板，挂在图片节点下方。
 * 负责提示词输入（支持 @ 引用其他节点）、模型与画质 / 分辨率 / 比例 / 张数等参数配置，
 * 提交生成任务并把参数持久化到节点数据，生成结果回填当前节点或派生新节点。
 */
"use client";

import { PlusOutlined } from "@ant-design/icons";
import { Button, Popover, Tooltip } from "antd";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ParamsIcon } from "@/components/ui/icons/canvas/ParamsIcon";
import { MenuItem, MenuPopover } from "@/components/ui/MenuPopover";
import { ModelIcon } from "@/components/ui/ModelIcon";
import WheelGuard from "@/components/ui/WheelGuard";
import { generationApi } from "@/features/canvas/api/generation-api";
import PrimaryActionButton from "@/features/canvas/editing/PrimaryActionButton";
import ParamFields, { fieldDefaults, hasField, ParamSummary } from "@/features/canvas/panels/ParamFields";
import { flushAndWait, markDirtyImmediate, useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { ImageGenSettings, MediaGenFields } from "@/features/canvas/types";
import { useRefUpload } from "@/features/canvas/upload";
import type { HistorySnapshot } from "@/features/project/types";
import { parseErrorBody, resolveApiError } from "@/lib/api/error-message";
import { isGenerating as isGeneratingBinding, NODE_TYPE } from "@/lib/constants";
import i18n from "@/lib/i18n/config";
import { useModelStore } from "@/lib/model-store";
import type { ModelProvider } from "@/lib/types/models";
import { type ModelOption } from "@/lib/types/models";

import ImageRefCard from "../shared/ImageRefCard";
import { recordLastModel, resolveModelKey } from "../shared/last-model";
import MentionPrompt from "../shared/MentionPrompt";
import { applyRatioToNode } from "../shared/ratio-size";
import { EMPTY_ORDER, mergeOrder, useGenSettings, writeGenSettings, writeOrderPref } from "../shared/ref-order";
import type { ReferenceItem } from "../shared/reference";
import RefGroupDivider from "../shared/RefGroupDivider";
import TextRefChip from "../shared/TextRefChip";

interface Props { nodeId: string; }

const ImageGenerationPanel = memo(function ImageGenerationPanel({ nodeId }: Props) {
  const { t } = useTranslation();
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

  const [modelOpen, setModelOpen] = useState(false);
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
    writeGenSettings(nodeId, { modelKey: resolveModelKey(undefined, "image", allModels) });
  }, [allModels, genSettings?.modelKey, nodeId]);

  // fields 为唯一数据源：渲染控件 + 默认值
  const fields = Array.isArray(modelParams?.fields) ? modelParams.fields : [];
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

  // 参数值在 params 缓存未就绪时为 undefined，由 submitTask 的 hasField 守卫决定是否上报
  const retryRef = useRef<{ count: number; prompt: string; modelKey: string; quality?: string; resolution?: string; ratio?: string; refImages: string[]; n?: number; entry: ModelOption | null; provider: ModelProvider | null }>({ count: 0, prompt: "", modelKey: "", refImages: [] as string[], entry: null, provider: null });

  /** handleGenerate 压入的「预生成快照」，供失败 / 取消时精确回滚 */
  const pushedSnapshotRef = useRef<HistorySnapshot | null>(null);

  /**
   * 回滚 handleGenerate 压入的预生成快照。
   * 按引用比对、只在它仍是栈顶时弹出：提交期间若有别的操作入栈，
   * 说明它已不是栈顶，此时放弃弹出，避免误删无关快照导致撤销行为错乱。
   */
  const dropPendingHistory = useCallback(() => {
    const pushed = pushedSnapshotRef.current;
    pushedSnapshotRef.current = null;
    if (pushed) useHistoryStore.getState().popIfTop(pushed);
  }, []);

  // ── Submit generation task (SSE handled by InfiniteCanvas) ──
  const submitTask = async (): Promise<string | null> => {
    const { entry, provider, prompt: p, quality: q, resolution, ratio: r, refImages: refs, n: num } = retryRef.current;
    if (!entry || !provider) return i18n.t("error.generate.missing_model_config");
    try {
      const res = await generationApi.submitGenerationTask({
        type: "image",
        prompt: p.trim(),
        model: entry.name,
        providerId: entry.providerId,
        quality: hasField(fields, "quality") ? q : undefined,
        resolution: hasField(fields, "resolution") ? resolution : undefined,
        ratio: hasField(fields, "ratio") ? r : undefined,
        n: hasField(fields, "n") ? num : undefined,
        refImages: refs.length > 0 ? refs : undefined,
        nodeId,
      });
      if (!res.ok) {
        const body = parseErrorBody(await res.json().catch(() => null));
        return resolveApiError(body, res.status, "generate.submit_failed");
      }
      const json = await res.json();
      const taskId = json.data?.id;
      if (!taskId) return i18n.t("error.generate.no_task_id");

      // 异步回调时检查：取消后 taskBinding 被清空，丢弃过期结果
      const cur = useCanvasStore.getState().nodes.find(n => n.id === nodeId);
      const curBinding = cur ? (cur.data as MediaGenFields).taskBinding : undefined;
      if (!isGeneratingBinding(curBinding)) return null;
      // Save task_id to node data immediately (SSE handled by InfiniteCanvas)
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId, status: "pending", startedAt: Date.now() } }, undefined, { skipHistory: true });
      await flushAndWait();
      return null;
    } catch (e: unknown) {
      return e instanceof Error ? e.message : "Failed to submit task";
    }
  };

  /** 参考区添加：上传图片 -> 新建参考节点并自动连到当前生成节点 */
  const handleRefUpload = useRefUpload(nodeId);

  const handleGenerate = async () => {
    if ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey) return;
    const entry = allModels.find((m) => m.value === modelKey);
    if (!entry) return;
    const provider = providers.find((c) => c.id === entry.providerId);
    if (!provider) return;

    // forceHistory 先捕获不含 taskBinding 的干净状态，再写入处理中标记。
    // 记录被压入的快照引用，失败 / 取消时按引用精确回滚（见 dropPendingHistory）。
    const depthBefore = useHistoryStore.getState().undoStack.length;
    useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: { taskId: "", status: "processing", startedAt: Date.now() } }, undefined, { forceHistory: true });
    const stack = useHistoryStore.getState().undoStack;
    pushedSnapshotRef.current = stack.length > depthBefore ? stack[stack.length - 1] : null;
    markDirtyImmediate();
    retryRef.current = { count: 0, prompt: finalPrompt, modelKey, quality, resolution, ratio, refImages: refOrder, n, entry, provider };

    const errMsg = await submitTask();

    if (errMsg === null) {
      // 生成成功
    } else {
      useCanvasStore.getState().updateNodeData(nodeId, { taskBinding: undefined }, undefined, { skipHistory: true });
      markDirtyImmediate();
      dropPendingHistory();
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
  };

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
      className="ui-select-none nodrag nopan flex flex-col gap-2 px-4 py-3 rounded-lg shadow-xl"
      style={{
        background: "var(--canvas-bg, #262626)",
        border: "1px solid var(--canvas-border, #3a3a3a)",
        width: 640,
      }}
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
        placeholder={t("generation.promptPlaceholder")}
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
            <MenuItem key={m.value} onClick={() => { setModelKey(m.value); recordLastModel("image", m.value); setModelOpen(false); }} selected={modelKey === m.value}>
              <span className="flex items-center gap-1.5">
                <ModelIcon model={m.name} className="size-4 shrink-0" />
                <span className="truncate">{m.name}</span>
                {m.providerName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{m.providerName}</span> : null}
              </span>
            </MenuItem>
          ))}
        />
        <div className="w-px h-7 flex-shrink-0" style={{ background: "var(--canvas-border)" }} />
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
          disabled={!isGenerating && ((!prompt.trim() && upstreamTexts.length === 0) || !modelKey)}
          onClick={isGenerating ? handleCancel : handleGenerate}
        />
      </div>
    </WheelGuard>
    </>
  );
});

export default ImageGenerationPanel;
