// ── S3 存储后端（预留，不接线） ──

import type { StorageBackend } from "@server/services/storage/backend";

export class S3StorageBackend implements StorageBackend {
  async save(_key: string, _source: string | Buffer | ReadableStream): Promise<void> {
    throw new Error("S3 backend not implemented");
  }

  async read(_key: string): Promise<NodeJS.ReadableStream> {
    throw new Error("S3 backend not implemented");
  }

  async stat(_key: string): Promise<{ size: number; mtimeMs: number } | null> {
    throw new Error("S3 backend not implemented");
  }

  async delete(_key: string): Promise<void> {
    throw new Error("S3 backend not implemented");
  }

  publicUrl(_key: string): string {
    throw new Error("S3 backend not implemented");
  }
}
