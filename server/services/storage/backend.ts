/**
 * 存储后端抽象。
 * 定义文件保存、读取、状态查询、删除与公开访问 URL 的统一存储接口。
 */

export interface StorageBackend {
  /** 保存文件（内部走临时文件 + 原子替换，目标被短暂占用时自动重试） */
  save(key: string, source: string | Buffer | ReadableStream): Promise<void>;
  /**
   * 读取文件流。
   * 传入 signal 后，请求中断（客户端断开、seek 取消）会立即销毁流释放句柄，
   * 避免 Windows 上文件被残留句柄长期占用。
   */
  read(key: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream>;
  /** 获取文件信息 */
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** 删除文件 */
  delete(key: string): Promise<void>;
  /** 公开访问 URL */
  publicUrl(key: string): string;
}
