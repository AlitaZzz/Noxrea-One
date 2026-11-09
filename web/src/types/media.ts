/**
 * 媒体类别（shared 类型）。
 *
 * 资产、画布节点与共享媒体渲染层共同消费；不含业务状态，也不依赖任何
 * feature/entity。资产实体只引用本类型，不重复定义、不转发。
 */
export type MediaType = "image" | "video" | "audio" | "";
