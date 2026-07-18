/**
 * 画布自定义事件名集中定义。
 *
 * 组件间通过 window.dispatchEvent / addEventListener 使用这些事件通信，
 * 统一管理避免字符串字面量散落各处。
 */
export const EventNames = {
  /** 节点数据更新（data / style / 标记 dirty） */
  NODE_UPDATE_DATA: "node:update-data",
  /** 节点操作（来自 NodeToolbar，由节点组件处理） */
  CANVAS_NODE_ACTION: "canvas:node-action",
  /** 复制选中节点 */
  CANVAS_COPY_NODE: "canvas:copy-node",
  /** 删除节点 */
  CANVAS_DELETE_NODES: "canvas:delete-nodes",
  /** 删除边 */
  CANVAS_DELETE_EDGES: "canvas:delete-edges",
  /** 编组 */
  CANVAS_GROUP_NODES: "canvas:group-nodes",
  /** 取消编组 */
  CANVAS_UNGROUP_NODES: "canvas:ungroup-nodes",
} as const;

export type EventName = (typeof EventNames)[keyof typeof EventNames];
