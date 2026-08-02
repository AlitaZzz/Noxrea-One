// ── 存储后端抽象（对应 backend/app/services/storage/service.py 的存储后端接口） ──

export interface StorageBackend {
  /** 保存文件 */
  save(key: string, source: string | Buffer | ReadableStream): Promise<void>;
  /** 读取文件流 */
  read(key: string): Promise<NodeJS.ReadableStream>;
  /** 获取文件信息 */
  stat(key: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** 删除文件 */
  delete(key: string): Promise<void>;
  /** 公开访问 URL */
  publicUrl(key: string): string;
}
