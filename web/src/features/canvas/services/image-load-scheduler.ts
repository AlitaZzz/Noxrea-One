import type { MediaLoadPriority } from "@/features/canvas/shared/media-visibility";

export type ImageLoadResult =
  | { status: "pending" }
  | { status: "ready"; url: string; width: number; height: number }
  | { status: "failed" };
/** 预热完成、可上屏的图片资源：url 即待渲染的 src（HTTP URL / blob: 预览透传），字节由浏览器 HTTP 缓存或上传管道持有 */
export type PreparedImage = { url: string; width: number; height: number };
type ImageLoader = (src: string, signal: AbortSignal) => Promise<PreparedImage>;
type Consumer = { priority: MediaLoadPriority; notify: (result: ImageLoadResult) => void };
type Job = {
  src: string;
  consumers: Map<symbol, Consumer>;
  status: "idle" | "queued" | "loading" | "settled";
  result?: ImageLoadResult;
  controller?: AbortController;
};

export type ImageLoadLease = {
  setPriority: (priority: MediaLoadPriority) => void;
  release: () => void;
  retry: () => void;
};

const IMAGE_LOAD_TIMEOUT_MS = 60_000;

/**
 * 预热一张图片：探测 <img> 加载 HTTP URL 并解码出宽高，结果直接携带原 URL。
 * ready 不代表字节在应用侧——字节交给浏览器 HTTP 缓存（服务端 immutable 长缓存），
 * 渲染 <img src={同一 URL}> 命中缓存，不发第二次网络请求。
 * 探测挂外部 signal：外部 abort 或 60s 超时都会摘除 handler 并 removeAttribute("src")
 * 取消在途请求。
 */
export function prepareImage(src: string, signal: AbortSignal): Promise<PreparedImage> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Image load cancelled", "AbortError"));
      return;
    }
    let settled = false;
    let probe: HTMLImageElement | null = null;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (probe) {
        probe.onload = null;
        probe.onerror = null;
      }
      if (error) {
        // 失败即取消任何残余传输（加载阶段被超时或错误打断时不再空跑）
        probe?.removeAttribute("src");
        reject(error);
      } else {
        resolve({ url: src, width: probe!.naturalWidth, height: probe!.naturalHeight });
      }
    };
    const abort = () => finish(new DOMException("Image load cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => finish(new Error("Image load timed out")), IMAGE_LOAD_TIMEOUT_MS);

    probe = new Image();
    probe.decoding = "async";
    probe.onload = () => { void probe!.decode().then(() => finish(), finish); };
    probe.onerror = () => finish(new Error("Image load failed"));
    probe.src = src;
  });
}

/** One canvas owns its queue. URL sharing lasts only as long as its consumers. */
export class ImageLoadScheduler {
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  private scheduled = false;

  constructor(private readonly load: ImageLoader = prepareImage, private readonly limit = 4) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid image concurrency limit");
  }

  acquire(src: string, notify: Consumer["notify"]): ImageLoadLease {
    let job = this.jobs.get(src);
    if (!job) {
      job = { src, consumers: new Map(), status: "idle" };
      this.jobs.set(src, job);
    }
    const target = job;
    const id = Symbol(src);
    const consumer: Consumer = { priority: null, notify };
    target.consumers.set(id, consumer);
    if (target.result) {
      const result = target.result;
      queueMicrotask(() => { if (target.consumers.has(id) && target.result === result) notify(result); });
    }
    return {
      setPriority: (priority) => {
        if (!target.consumers.has(id)) return;
        consumer.priority = priority;
        this.update(target);
      },
      release: () => {
        target.consumers.delete(id);
        this.update(target);
        // Effect replacement can reacquire the same URL in this turn.
        queueMicrotask(() => {
          if (!target.consumers.size && this.jobs.get(src) === target) {
            this.jobs.delete(src);
          }
        });
      },
      retry: () => {
        if (!target.consumers.has(id) || target.status !== "settled" || target.result?.status !== "failed") return;
        target.status = "idle";
        target.result = { status: "pending" };
        for (const subscriber of target.consumers.values()) subscriber.notify(target.result);
        this.update(target);
      },
    };
  }

  clear() {
    for (const job of this.jobs.values()) {
      job.consumers.clear();
      job.controller?.abort();
    }
    this.jobs.clear();
  }

  private priority(job: Job): MediaLoadPriority {
    let best: MediaLoadPriority = null;
    for (const consumer of job.consumers.values()) {
      if (consumer.priority !== null && (best === null || consumer.priority < best)) best = consumer.priority;
    }
    return best;
  }

  private update(job: Job) {
    if (job.status === "settled") return;
    if (this.priority(job) === null) {
      job.controller?.abort();
      job.controller = undefined;
      job.status = "idle";
    } else if (job.status === "idle") {
      job.status = "queued";
    }
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // Batch demand changes before choosing visible work over prefetch work.
    queueMicrotask(() => {
      this.scheduled = false;
      while (this.active < this.limit) {
        let next: Job | undefined;
        for (const job of this.jobs.values()) {
          if (job.status !== "queued" || this.priority(job) === null) continue;
          if (!next || this.priority(job)! < this.priority(next)!) next = job;
        }
        if (!next) break;
        this.start(next);
      }
    });
  }

  private start(job: Job) {
    const controller = new AbortController();
    job.controller = controller;
    job.status = "loading";
    this.active += 1;
    void Promise.resolve().then(() => this.load(job.src, controller.signal)).then(
      (image) => this.complete(job, controller, { status: "ready", ...image }),
      () => this.complete(job, controller, { status: "failed" }),
    ).finally(() => {
      this.active -= 1;
      this.schedule();
    });
  }

  private complete(job: Job, controller: AbortController, result: ImageLoadResult) {
    if (controller.signal.aborted || job.controller !== controller || this.jobs.get(job.src) !== job) {
      // 结果被守卫丢弃（job 已被替换/删除/中止）时直接放弃通知，结果本身不含需回收的资源
      return;
    }
    job.controller = undefined;
    job.status = "settled";
    job.result = result;
    for (const consumer of job.consumers.values()) consumer.notify(result);
  }
}
