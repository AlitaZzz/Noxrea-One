/**
 * 撤销/重做历史行为测试。
 *
 * 约定（与 canvas-store 的自动压栈一致）："改动前压栈"——所有改动之前
 * 把当前状态快照 push 进 undoStack。因此栈顶 = 最近一次改动前的状态
 * = undo 要恢复的目标。
 *
 * - undo(current)：弹出并返回栈顶（弹出即应用）；current 是撤销瞬间的
 *   现场快照，存入 redoStack，redo 用它回到撤销前。
 * - redo(current)：弹出并返回 redoStack 栈顶；current 存回 undoStack，
 *   保证 redo 之后还能再 undo。
 * - 不变量：undoStack ++ [现场] ++ reverse(redoStack) 构成完整时间线。
 *
 * 注：真实代码中 useAddNode → addNodes 走自动压栈（改动前），拖拽只在
 * onNodeDragStart 压一次。测试里为避免 300ms throttle 的时间不确定性，
 * 历史压栈全部显式调用 store.push，canvas-store 的写操作用 skipHistory。
 */

import { beforeEach,describe, expect, it } from "vitest";

import { takeCanvasSnapshot,useCanvasStore } from "@/features/canvas/stores/canvas-store";
import { useHistoryStore } from "@/features/canvas/stores/history-store";
import type { AnyNode, ImageNodeData } from "@/features/canvas/types";
import type { HistorySnapshot } from "@/features/project/types";

function makeSnapshot(nodesCount: number, label = "", edges: Record<string, unknown>[] = []): HistorySnapshot {
  const nodes = Array.from({ length: nodesCount }, (_, i) => ({
    id: `n${i}`, position: { x: i * 100, y: i * 50 },
    data: { label: `${label || "node"} ${i}` },
  }));
  return {
    nodes,
    edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    background: "dots" as const,
    theme: "dark" as const,
    minimapVisible: true,
    snapToGrid: false,
  } as HistorySnapshot;
}

beforeEach(() => {
  useHistoryStore.getState().clear();
  useCanvasStore.setState({ nodes: [], edges: [] });
});

describe("undo：弹出即应用（栈顶 = 最近一次改动前的状态）", () => {
  it("undo 返回的正是压入的栈顶对象本身", () => {
    const store = useHistoryStore.getState();
    const before = makeSnapshot(0, "before_change");
    store.push(before);                    // 改动前压栈
    const live = makeSnapshot(1, "live"); // 改动后的现场

    const restored = store.undo(live);
    expect(restored).toBe(before);         // 引用相等：弹出的就是应用的
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
    // 现场快照进了 redoStack（不是被弹出的旧快照）
    const redo = useHistoryStore.getState().redoStack;
    expect(redo.length).toBe(1);
    expect(redo[0]).toBe(live);
  });

  it("空栈 undo 返回 null，且不向 redoStack 写入任何东西", () => {
    const store = useHistoryStore.getState();
    expect(store.undo(makeSnapshot(1, "live"))).toBeNull();
    expect(useHistoryStore.getState().redoStack.length).toBe(0);
  });

  it("空栈 redo 返回 null，且不向 undoStack 写入任何东西", () => {
    const store = useHistoryStore.getState();
    expect(store.redo(makeSnapshot(1, "live"))).toBeNull();
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
  });

  it("新改动（push）清空 redoStack", () => {
    const store = useHistoryStore.getState();
    store.push(makeSnapshot(0));
    store.undo(makeSnapshot(1));
    expect(useHistoryStore.getState().redoStack.length).toBe(1);
    store.push(makeSnapshot(2));
    expect(useHistoryStore.getState().redoStack.length).toBe(0);
  });
});

describe("回归锁定：历史上的两个偏移症状", () => {
  it("连线 → 删边 → 一次 Ctrl+Z 恢复这条边（本次修复的核心场景）", () => {
    const store = useHistoryStore.getState();
    const edge = { id: "e1", source: "n0", target: "n1" };

    const beforeConnect = makeSnapshot(2, "no_edge");          // 连线前：无边
    store.push(beforeConnect);                                  // handleConnect → setEdges 自动压栈
    const beforeDelete = makeSnapshot(2, "with_edge", [edge]);  // 删除前：有边
    store.push(beforeDelete);                                   // removeEdges 自动压栈
    const liveAfterDelete = makeSnapshot(2, "deleted");         // 现场：边已删

    // 一次撤销必须恢复这条边
    const step1 = store.undo(liveAfterDelete);
    expect(step1).toBe(beforeDelete);
    expect(step1!.edges.length).toBe(1);
    expect(step1!.edges[0].id).toBe("e1");

    // 重做回到"边已删"的现场
    const redone = store.redo(step1!);
    expect(redone).toBe(liveAfterDelete);
    expect(redone!.edges.length).toBe(0);
  });

  it("创建 → 拖拽 → 第一次撤销只回退拖拽（节点在原位置），第二次才回退创建", () => {
    const store = useHistoryStore.getState();

    const beforeAdd = makeSnapshot(0, "empty");     // 创建前压栈（addNodes 自动）
    store.push(beforeAdd);
    const beforeDrag: HistorySnapshot = {            // 拖拽开始压栈（onNodeDragStart，只压一次）
      ...makeSnapshot(1, "at_origin"),
      nodes: [{ id: "n0", position: { x: 100, y: 200 }, data: { label: "a" } }],
    } as HistorySnapshot;
    store.push(beforeDrag);
    const liveAfterDrag: HistorySnapshot = {         // 现场：已拖到新位置
      ...makeSnapshot(1, "moved"),
      nodes: [{ id: "n0", position: { x: 500, y: 200 }, data: { label: "a" } }],
    } as HistorySnapshot;

    // 第一次撤销：节点还在，位置回到拖拽前 —— 不允许"整个节点消失"
    const step1 = store.undo(liveAfterDrag);
    expect(step1).toBe(beforeDrag);
    expect(step1!.nodes.length).toBe(1);
    expect(step1!.nodes[0].position.x).toBe(100);

    // 第二次撤销：回退创建，画布为空
    const step2 = store.undo(step1!);
    expect(step2).toBe(beforeAdd);
    expect(step2!.nodes.length).toBe(0);

    // 两次重做完整回到最新状态
    expect(store.redo(step2!)).toBe(beforeDrag);
    expect(store.redo(beforeDrag)).toBe(liveAfterDrag);
    expect(useHistoryStore.getState().redoStack.length).toBe(0);
  });
});

describe("撤销 ↔ 重做完整回环（不丢数据、不错位）", () => {
  it("多步撤销后逐步重做，每一步都精确复原，最终回到撤销前现场", () => {
    const store = useHistoryStore.getState();
    // 时间线：S0 → S1 → S2 → live(S3)，每次改动前压栈
    const s0 = makeSnapshot(0, "s0");
    const s1 = makeSnapshot(1, "s1");
    const s2 = makeSnapshot(2, "s2");
    const s3 = makeSnapshot(3, "s3-live");
    store.push(s0);
    store.push(s1);
    store.push(s2);

    // 连续撤销到底
    expect(store.undo(s3)).toBe(s2);
    expect(store.undo(s2)).toBe(s1);
    expect(store.undo(s1)).toBe(s0);
    expect(useHistoryStore.getState().undoStack.length).toBe(0);
    expect(useHistoryStore.getState().redoStack.length).toBe(3);

    // 连续重做到底：逐步回放，最终 = 撤销前现场 s3
    expect(store.redo(s0)).toBe(s1);
    expect(store.redo(s1)).toBe(s2);
    expect(store.redo(s2)).toBe(s3);
    expect(useHistoryStore.getState().redoStack.length).toBe(0);
    // undoStack 完整复原，还能继续撤销
    expect(useHistoryStore.getState().undoStack.length).toBe(3);
    expect(store.undo(s3)).toBe(s2);
  });

  it("集成：上传图片改 data.src → 撤销回旧值 → 重做回新值（走真实快照与应用流程）", () => {
    const historyStore = useHistoryStore.getState();
    const canvasStore = useCanvasStore.getState();

    const node = {
      id: "img1", type: "image-node",
      position: { x: 100, y: 200 },
      data: { src: "old_url", label: "test", alt: "test" },
      style: { width: 480, height: 360 },
    };
    useCanvasStore.setState({ nodes: [node as unknown as AnyNode] });

    // 上传写入 src 前：改动前压栈（生产中由 updateNodeData 自动完成）
    historyStore.push(takeCanvasSnapshot());
    canvasStore.updateNodeData("img1", { src: "new_url" }, undefined, { skipHistory: true });
    expect((useCanvasStore.getState().nodes[0].data as ImageNodeData).src).toBe("new_url");

    // Ctrl+Z：捕获现场 → 弹出目标 → 按键盘 handler 的方式应用
    const liveBeforeUndo = takeCanvasSnapshot();
    const snapshot = historyStore.undo(liveBeforeUndo);
    expect(snapshot).not.toBeNull();
    const s = useCanvasStore.getState();
    s.setNodes(snapshot!.nodes.map((n) => ({ ...n, selected: false })));
    s.setEdges(snapshot!.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });

    const restored = useCanvasStore.getState().nodes[0];
    expect((restored.data as ImageNodeData).src).toBe("old_url");   // src 彻底回退
    expect(restored.data.label).toBe("test");
    expect(restored.position.x).toBe(100);

    // Ctrl+Y：回到撤销前的现场（src = new_url）
    const next = historyStore.redo(takeCanvasSnapshot());
    expect(next).toBe(liveBeforeUndo);
    const st = useCanvasStore.getState();
    st.setNodes(next!.nodes.map((n) => ({ ...n, selected: false })));
    st.setEdges(next!.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
    expect((useCanvasStore.getState().nodes[0].data as ImageNodeData).src).toBe("new_url");
  });
});

describe("异步上传竞态", () => {
  it("版本标记机制阻止过期回调覆盖撤销结果", async () => {
    const historyStore = useHistoryStore.getState();
    const canvasStore = useCanvasStore.getState();

    // 节点已存在（src 为空、无版本标记），此前的创建操作压过一条"节点干净"快照
    const cleanNode = {
      id: "img1", type: "image-node",
      position: { x: 100, y: 200 },
      data: { src: "", label: "test", alt: "test" },
      style: { width: 480, height: 360 },
    };
    useCanvasStore.setState({ nodes: [cleanNode as unknown as AnyNode] });
    historyStore.push(takeCanvasSnapshot()); // 模拟"下一次改动前"的压栈（快照里节点是干净的）

    // 上传开始：写入版本标记（内部状态，skipHistory，与生产一致）
    const uploadVersion = 1001;
    canvasStore.updateNodeData("img1", { upload: { uploading: false, progress: undefined, version: uploadVersion } }, undefined, { skipHistory: true });
    expect((useCanvasStore.getState().nodes[0].data as ImageNodeData).upload?.version).toBe(1001);

    // 构造飞行中的上传
    let resolveUpload: (value: string) => void;
    const uploadPromise = new Promise<string>((r) => { resolveUpload = r; });
    const uploadTask = (async () => {
      const imgUrl = await uploadPromise;
      // === 模拟 img.onload 回调 ===
      const store = useCanvasStore.getState();
      const currentNode = store.nodes.find((n) => n.id === "img1");
      if (!currentNode) return;                                       // 节点不存在则丢弃
      if ((currentNode.data as ImageNodeData).upload?.version !== uploadVersion) return;  // 版本不匹配则丢弃
      canvasStore.updateNodeData("img1",
        { ...currentNode.data, src: imgUrl, label: "uploaded", alt: "uploaded" },
        { width: 300, height: 200 },
      );
    })();

    // 上传完成前用户按了 Ctrl+Z：恢复到干净快照（无 _uploadVersion）
    const snap = historyStore.undo(takeCanvasSnapshot());
    const st = useCanvasStore.getState();
    st.setNodes(snap!.nodes.map((n) => ({ ...n, selected: false })));
    st.setEdges(snap!.edges.map((e) => ({ ...e, selected: false })), { skipHistory: true });
    expect((useCanvasStore.getState().nodes[0].data as ImageNodeData).src).toBe("");
    expect((useCanvasStore.getState().nodes[0].data as ImageNodeData).upload?.version).toBeUndefined();

    // 网络响应到达：回调应被版本标记阻挡
    resolveUpload!("http://example.com/new_uploaded.png");
    await uploadTask;

    const final = useCanvasStore.getState().nodes[0];
    expect((final.data as ImageNodeData).src).toBe("");
    expect(final.data.label).toBe("test");
    expect((final.data as ImageNodeData).upload?.version).toBeUndefined();
  });
});

describe("节点组件本地 state 同步", () => {
  it("撤销后 data.src 从非空变空字符串时本地 state 应同步清空", () => {
    // 模拟 ImageNode/VideoNode 中 useEffect 的条件：
    // 修复前：if (data.src && data.src !== src) setSrc(data.src);
    // 修复后：if (data.src !== src) setSrc(data.src || "");
    const oldSrc: string = "new_url";  // 当前的本地 state
    const newDataSrc: string = "";     // 撤销后 store 中的 data.src
    let syncedSrc = oldSrc;

    // 修复前的条件：不同步，src 卡在旧值
    if (newDataSrc && newDataSrc !== oldSrc) syncedSrc = newDataSrc;
    expect(syncedSrc).toBe("new_url");

    syncedSrc = oldSrc;

    // 修复后的条件：正确同步为空
    if (newDataSrc !== oldSrc) syncedSrc = newDataSrc || "";
    expect(syncedSrc).toBe("");
  });
});
