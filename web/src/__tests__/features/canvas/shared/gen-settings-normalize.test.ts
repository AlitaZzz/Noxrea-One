/**
 * 生成设置归一化纯函数测试（specs/canvas-selection-chrome-scheduling.md 4.2）：
 * 只纠正已持久化的非法值；未持久化字段不物化默认值；空节点占位比例仅在
 * 目录变化 / 生效模型变化时校正，且尺寸确有差异才返回。
 */
import { describe, expect, it } from "vitest";

import { type GenSettingsContext, normalizeGenSettings } from "@/features/canvas/shared/gen-settings-normalize";
import { ratioToNodeSize } from "@/features/canvas/shared/ratio-size";
import type { AnyNode } from "@/features/canvas/types";
import { NODE_TYPE } from "@/lib/constants";
import type { ModelOption, ModelParamConfig } from "@/lib/types/models";

const models: ModelOption[] = [
  { value: "p/a", providerId: "p", modelId: "ma", name: "a", providerName: "P" },
  { value: "p/b", providerId: "p", modelId: "mb", name: "b", providerName: "P" },
];

const params: Record<string, ModelParamConfig> = {
  "a/image": {
    fields: [
      { name: "quality", type: "select", order: 1, options: ["standard", "high"], default: "standard" },
      { name: "ratio", type: "select", order: 2, options: ["16:9", "9:16"], default: "16:9" },
    ],
  },
  "b/image": {
    fields: [{ name: "ratio", type: "select", order: 1, options: ["1:1"], default: "1:1" }],
  },
  "a/video": {
    fields: [{ name: "ratio", type: "select", order: 1, options: ["16:9"], default: "16:9" }],
    capabilities: { refMode: { options: ["text", "image", "first-last", "full"] } },
  },
};

function makeCtx(
  nodes: AnyNode[] = [],
  edges: { source: string; target: string }[] = [],
): GenSettingsContext {
  return {
    models,
    findModelParams: (_providerId, modelName, capability) =>
      params[`${modelName}/${capability}`] ?? null,
    nodes,
    edges,
  };
}

function imageNode(options: { src?: string; style?: Record<string, number> } = {}): AnyNode {
  return {
    id: "img-node",
    type: NODE_TYPE.IMAGE,
    position: { x: 0, y: 0 },
    style: options.style,
    data: {
      label: "",
      src: options.src ?? "",
      lockAspectRatio: false,
      naturalWidth: 0,
      naturalHeight: 0,
    },
  } as unknown as AnyNode;
}

function videoNode(): AnyNode {
  return {
    id: "vid-node",
    type: NODE_TYPE.VIDEO,
    position: { x: 0, y: 0 },
    data: { label: "", src: "", naturalWidth: 0, naturalHeight: 0 },
  } as unknown as AnyNode;
}

function imageSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "image", prompt: "", modelKey: "p/a", refOrder: [], ...over };
}

function videoSettings(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "video",
    prompt: "",
    modelKey: "p/a",
    refOrder: [],
    refAudioOrder: [],
    refVideoOrder: [],
    ...over,
  };
}

describe("normalizeGenSettings", () => {
  it("非生成节点不处理", () => {
    const audio = {
      id: "aud-node",
      type: NODE_TYPE.AUDIO,
      position: { x: 0, y: 0 },
      data: { label: "", src: "" },
    } as unknown as AnyNode;
    expect(normalizeGenSettings(audio, imageSettings(), makeCtx())).toBeNull();
  });

  it("模型目录未就绪时保持现状", () => {
    expect(
      normalizeGenSettings(
        imageNode(),
        imageSettings({ modelKey: "gone/model" }),
        { ...makeCtx(), models: [] },
      ),
    ).toBeNull();
  });

  it("悬空 modelKey 回退到第一个可用模型", () => {
    const result = normalizeGenSettings(
      imageNode(),
      imageSettings({ modelKey: "gone/model" }),
      makeCtx(),
    );
    expect(result?.genSettings?.modelKey).toBe("p/a");
  });

  it("未持久化的 modelKey 不物化默认值", () => {
    expect(
      normalizeGenSettings(imageNode(), imageSettings({ modelKey: undefined }), makeCtx()),
    ).toBeNull();
  });

  it("字段值越界纠偏到默认值，且二次归一化幂等", () => {
    const first = normalizeGenSettings(imageNode(), imageSettings({ quality: "ultra" }), makeCtx());
    expect(first?.genSettings).toMatchObject({ quality: "standard" });

    const second = normalizeGenSettings(imageNode(), first!.genSettings!, makeCtx());
    expect(second).toBeNull();
  });

  it("合法字段值不写回", () => {
    expect(
      normalizeGenSettings(imageNode(), imageSettings({ quality: "high" }), makeCtx()),
    ).toBeNull();
  });

  it("比例值越界纠偏时同步空节点占位框", () => {
    const result = normalizeGenSettings(
      imageNode({ style: { width: 10, height: 10 } }),
      imageSettings({ ratio: "4:3" }),
      makeCtx(),
    );
    expect(result?.genSettings?.ratio).toBe("16:9");
    expect(result?.applyRatio).toBe("16:9");
  });

  it("视频已持久化的非法 refMode 收敛到合法值", () => {
    const node = videoNode();
    const result = normalizeGenSettings(node, videoSettings({ refMode: "first-last" }), makeCtx([node]));
    expect(result?.genSettings?.refMode).toBe("text");
  });

  it("视频 refMode 随上游参考变化收敛，合法值保持不写", () => {
    const node = videoNode();
    const upstream = imageNode({ src: "https://cdn.example/a.png" });
    const edges = [{ source: upstream.id, target: node.id }];
    const ctx = makeCtx([node, upstream], edges);

    // 1 张图：full 合法 → 不写回
    expect(normalizeGenSettings(node, videoSettings({ refMode: "full" }), ctx)).toBeNull();
    // 1 张图时文生视频不合法 → 收敛到 full
    expect(normalizeGenSettings(node, videoSettings({ refMode: "text" }), ctx)?.genSettings?.refMode)
      .toBe("full");
  });

  it("视频未持久化 refMode 不物化默认值", () => {
    const node = videoNode();
    expect(
      normalizeGenSettings(node, videoSettings({ refMode: undefined }), makeCtx([node])),
    ).toBeNull();
  });

  it("目录变化时空节点占位框跟随模型默认比例（尺寸确有差异）", () => {
    const size = ratioToNodeSize("16:9")!;
    const node = imageNode({ style: { width: size.width + 100, height: size.height } });
    const result = normalizeGenSettings(node, imageSettings(), makeCtx(), { placeholder: true });
    expect(result?.applyRatio).toBe("16:9");
    expect(result?.genSettings).toBeUndefined();
  });

  it("尺寸已经一致时不产生写入", () => {
    const size = ratioToNodeSize("16:9")!;
    const node = imageNode({ style: { width: size.width, height: size.height } });
    expect(normalizeGenSettings(node, imageSettings(), makeCtx(), { placeholder: true })).toBeNull();
  });

  it("连线变化不重排用户调整过的占位框", () => {
    expect(
      normalizeGenSettings(
        imageNode({ style: { width: 10, height: 10 } }),
        imageSettings(),
        makeCtx(),
        { placeholder: false },
      ),
    ).toBeNull();
  });

  it("有内容节点不校正占位框", () => {
    const node = imageNode({ src: "https://cdn.example/a.png", style: { width: 10, height: 10 } });
    expect(normalizeGenSettings(node, imageSettings(), makeCtx(), { placeholder: true })).toBeNull();
  });

  it("写入入口仅在生效模型变化时校正占位框", () => {
    const node = imageNode({ style: { width: 10, height: 10 } });
    const previous = imageSettings({ modelKey: "p/a" });

    // 改提示词：生效模型不变 → 不动占位框
    expect(
      normalizeGenSettings(node, imageSettings({ prompt: "hi" }), makeCtx(), { previous }),
    ).toBeNull();

    // 切换模型：新模型默认比例落位
    const switched = normalizeGenSettings(node, imageSettings({ modelKey: "p/b" }), makeCtx(), {
      previous,
    });
    expect(switched?.applyRatio).toBe("1:1");
  });
});
