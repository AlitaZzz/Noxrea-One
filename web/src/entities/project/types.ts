/**
 * 项目摘要类型。
 * 列表页与 revision 账本的最小单元；画布内容与文档类型归 `features/canvas`。
 */
export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  updatedAt: number;
  /** 列表卡片缩略图：自定义封面优先，否则首个图片节点 src（服务端投影；存储 key 或外部 URL） */
  thumbnail?: string;
  /** 用户自定义封面（存储 key；未设置为 undefined） */
  coverKey?: string;
  /** 节点总数（服务端投影） */
  nodeCount: number;
}
