/**
 * Agent 工具执行器纯函数回归测试。
 * 锁定 fillNodeData 的分类型写入语义（prompt 预填 / 文本 HTML 化 / 音频节点
 * 无生成面板不写 genSettings——T3 删除半成品后的回归防线）与比例串解析。
 */
import { describe, expect, it } from "vitest";

import { fillNodeData, parseRatioValue } from "@/features/canvas/agent/tools/executors";
import { createImageNode, createTextNode, createVideoNode } from "@/features/canvas/node-defaults";
import { NODE_TYPE } from "@/lib/constants";

const at = { x: 0, y: 0 };

describe("fillNodeData", () => {
  it("文本节点：content 走 Tiptap HTML 化并保留 plainText，prompt 预填 genSettings", () => {
    const node = createTextNode(at);
    const out = fillNodeData(node, {
      kind: NODE_TYPE.TEXT,
      content: "标题\n正文",
      prompt: "画一只猫",
      title: "我的节点",
    });
    const data = out.data as { label?: string; content?: string; plainText?: string; genSettings?: { prompt?: string } };

    expect(data.label).toBe("我的节点");
    expect(data.content).toBe("<p>标题<br>正文</p>");
    expect(data.plainText).toBe("标题\n正文");
    expect(data.genSettings?.prompt).toBe("画一只猫");
  });

  it("图片节点：prompt 预填 genSettings，保留既有 genSettings 其余字段", () => {
    const node = createImageNode(at);
    (node.data as { genSettings?: Record<string, unknown> }).genSettings = {
      kind: "image", prompt: "", modelKey: "keep-me", refOrder: [],
    };
    const out = fillNodeData(node, { kind: NODE_TYPE.IMAGE, prompt: "风景照" });
    const data = out.data as { genSettings?: { prompt?: string; modelKey?: string } };

    expect(data.genSettings?.prompt).toBe("风景照");
    expect(data.genSettings?.modelKey).toBe("keep-me");
  });

  it("视频节点：prompt 预填 genSettings", () => {
    const node = createVideoNode(at);
    const out = fillNodeData(node, { kind: NODE_TYPE.VIDEO, prompt: "城市延时" });
    const data = out.data as { genSettings?: { prompt?: string } };

    expect(data.genSettings?.prompt).toBe("城市延时");
  });

  it("音频节点无生成面板：prompt 不写入 genSettings（T3 回归防线）", () => {
    const node = fillNodeData(
      { id: "a1", position: at, data: {} } as never,
      { kind: NODE_TYPE.AUDIO, prompt: "不该被写入" },
    );
    const data = node.data as { genSettings?: unknown; label?: string };

    expect(data.genSettings).toBeUndefined();
  });

  it("title 为空串不覆盖既有 label（避免空标题冲掉默认值）", () => {
    const node = fillNodeData(createTextNode(at), { kind: NODE_TYPE.TEXT, title: "" });
    // createTextNode 出厂 label 为空串：空 title 不写入任何非空覆盖
    expect((node.data as { label?: string }).label).toBe("");
    const titled = fillNodeData(createTextNode(at), { kind: NODE_TYPE.TEXT, title: "T" });
    expect((titled.data as { label?: string }).label).toBe("T");
  });
});

describe("parseRatioValue", () => {
  it("W:H 数值串解析为比值", () => {
    expect(parseRatioValue("16:9")).toBeCloseTo(16 / 9);
    expect(parseRatioValue("1:1")).toBe(1);
  });

  it("adaptive / 非法串返回 null", () => {
    expect(parseRatioValue("adaptive")).toBeNull();
    expect(parseRatioValue("auto")).toBeNull();
    expect(parseRatioValue("a:b")).toBeNull();
  });
});
