/**
 * 生成面板提示词的字形预热（悬停触发）。
 *
 * 背景：面板首次显示时，提示词里的每个唯一汉字都要在当前渲染进程内完成
 * 首次 shaping，≈0.1ms/字；400+ 字会形成 18–20ms 的首次 layout。成本按
 * （字面、字号、字符集）在渲染进程内计费，与选中逻辑无关。canvas 的
 * `measureText` 与 DOM 排版共用同一字形缓存（实测预热后同文本 layout
 * 0.4ms），因此可以在悬停节点时提前触发，把成本移出点击路径。
 *
 * 实现约束：
 * - 字体从真实编辑器样式（`.mention-editable`）解析，不硬编码字号 / 字体栈；
 * - 分片执行，每个任务最多 4ms，避免悬停自身变成可感知长任务；
 * - 只预热当前悬停目标：悬停目标一旦变化（含非生成节点、空提示词、已缓存文本），
 *   先取消上一段未完成的预热；
 * - 已完成文本做有界缓存，重复悬停直接跳过。
 */

import type { AnyNode } from "@/features/canvas/types";

import { genKindOfNode, genSettingsOf } from "./gen-settings-node";
import { PROMPT_EDITOR_CLASS } from "./prompt-editor";
import { fontStringOf, getTextMeasureContext } from "./text-measure";

/** 单个分片的最大码点数：48 个汉字约 4ms，与下面的时间预算配合切片 */
const CHUNK_CODE_POINTS = 48;
/** 单个任务的时间预算：超过后让出主线程，下一个任务继续 */
const CHUNK_BUDGET_MS = 4;
/** 已完成文本的缓存上限（FIFO 淘汰），避免长期会话无限增长 */
const MAX_WARMED_TEXTS = 256;

let editorFont: string | undefined;
let activeRun = 0;
let activeText: string | null = null;
const warmedTexts = new Set<string>();

/**
 * 从与编辑器同 class 的隐藏探针读取计算字体：`.mention-editable` 决定字号，
 * 字体栈继承自 body。探针 `display:none` 不参与布局，只解析样式。
 */
function resolveEditorFont(): string | null {
  // 编辑器字号在会话内固定（`.mention-editable` 为静态样式），成功后缓存；
  // 样式尚未就绪时返回 null，下次悬停重试，避免一次失败永久关闭预热
  if (editorFont !== undefined) return editorFont;
  if (typeof document === "undefined" || !document.body) return null;
  const probe = document.createElement("div");
  probe.className = PROMPT_EDITOR_CLASS;
  probe.setAttribute("aria-hidden", "true");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const font = fontStringOf(style);
  // 计算样式必须在移除探针前读取，否则部分浏览器会返回空值
  const readable = Boolean(style.fontSize && style.fontFamily);
  probe.remove();
  if (!readable) return null;
  editorFont = font;
  return editorFont;
}

function splitIntoChunks(text: string): string[] {
  const points = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < points.length; index += CHUNK_CODE_POINTS) {
    chunks.push(points.slice(index, index + CHUNK_CODE_POINTS).join(""));
  }
  return chunks;
}

function rememberWarmed(text: string) {
  if (warmedTexts.size >= MAX_WARMED_TEXTS) {
    const oldest = warmedTexts.values().next().value;
    if (oldest !== undefined) warmedTexts.delete(oldest);
  }
  warmedTexts.add(text);
}

/** 取消在途预热：递增令牌后，已排队的 step 在下一次执行时退出。 */
function cancelActiveRun(): void {
  activeRun += 1;
  activeText = null;
}

/**
 * 预热一段提示词的排版。空文本、样式未就绪或环境不支持 canvas 时静默跳过，
 * 但调用本身仍会取消上一段预热——悬停目标已经变化。
 */
function prewarmPromptShaping(text: string): void {
  const normalized = text.trim();
  // 同一目标仍在预热：保持当前任务，不取消也不重启
  if (normalized && activeText === normalized) return;
  cancelActiveRun();
  if (!normalized || warmedTexts.has(normalized)) return;

  const font = resolveEditorFont();
  const context = getTextMeasureContext();
  if (!font || !context) return;

  const run = activeRun;
  activeText = normalized;
  const chunks = splitIntoChunks(normalized);
  let index = 0;

  const step = () => {
    if (run !== activeRun) return;
    context.font = font;
    const started = performance.now();
    while (index < chunks.length && performance.now() - started < CHUNK_BUDGET_MS) {
      context.measureText(chunks[index]);
      index += 1;
    }
    if (index >= chunks.length) {
      rememberWarmed(normalized);
      activeText = null;
      return;
    }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

/** 悬停节点入口：生成节点预热提示词；其他节点同样会取消上一段预热。 */
export function prewarmPromptForNode(node: AnyNode): void {
  if (!genKindOfNode(node)) {
    cancelActiveRun();
    return;
  }
  prewarmPromptShaping(genSettingsOf(node)?.prompt ?? "");
}
