import type { MediaLoadPriority } from "@/features/canvas/shared/media-visibility";

export type ImageLoadResult =
  | { status: "pending" }
  | { status: "ready"; url: string; width: number; height: number }
  | { status: "failed" };
/** 预热完成、可上屏的图片资源：url 即待渲染的 src（HTTP URL / blob: 预览透传），字节由浏览器 HTTP 缓存或上传管道持有 */
export type PreparedImage = { url: string; width: number; height: number };
type ImageLoader = (src: string, signal: AbortSignal) => Promise<PreparedImage>;
type Consumer = { priority: MediaLoadPriority; weight: number; notify: (result: ImageLoadResult) => void };
/** 一次已启动的加载：重量随 consumer 变重只升不降，结算时按该次运行自身的重量释放 */
type RunningLoad = { controller: AbortController; weight: number };
type Job = {
  src: string;
  consumers: Map<symbol, Consumer>;
  status: "idle" | "queued" | "loading" | "settled";
  result?: ImageLoadResult;
  running?: RunningLoad;
};

export type ImageLoadLease = {
  setPriority: (priority: MediaLoadPriority) => void;
  /** 认领/更新该 URL 的任务重量（同一 job 取 consumer 最大值） */
  setWeight: (weight: number) => void;
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

/**
 * One canvas owns its queue. URL sharing lasts only as long as its consumers.
 *
 * 并发按「重量单位」计费（specs/canvas-media-resolution-lod.md 规则 7）：
 * 低档位/外链 1、大档位 2（下界见 `HEAVY_RESIZE_WIDTH`）、原图 3，容量 4。调度循环只启动「优先级最高且
 * 装得下」的 job，因此活跃 3 时重量 1 的 job 仍能启动，不会被重量 2 的排队
 * job 阻塞；运行中 job 因新 consumer 变重时只更新计费重量、不重启解码，
 * 活跃重量允许暂时超过容量但不再启动新 job。
 */
export class ImageLoadScheduler {
  private readonly jobs = new Map<string, Job>();
  /** 活跃重量（不是任务数） */
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
    const consumer: Consumer = { priority: null, weight: 1, notify };
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
      setWeight: (weight) => {
        if (!target.consumers.has(id)) return;
        const next = Number.isFinite(weight) && weight > 0 ? Math.ceil(weight) : 1;
        if (consumer.weight === next) return;
        consumer.weight = next;
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
      job.running?.controller.abort();
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

  /** 共享 job 的重量 = 全部 consumer 的最大值（原图 consumer 会把整次解码按重量 3 计费） */
  private weight(job: Job): number {
    let best = 1;
    for (const consumer of job.consumers.values()) {
      if (consumer.weight > best) best = consumer.weight;
    }
    return best;
  }

  private update(job: Job) {
    if (job.status === "settled") return;
    // 运行中的 job 重量只升不降：已开始的解码不能因 consumer 变化重启。
    // 升重立即计入活跃重量（允许暂时超容量，但 schedule 会因此停止启动新 job）；
    // 降重不回吐——该次运行在结算时按它自己的重量释放，计费口径不会前后漂移。
    if (job.running) {
      const next = this.weight(job);
      if (next > job.running.weight) {
        this.active += next - job.running.weight;
        job.running.weight = next;
      }
    }
    if (this.priority(job) === null) {
      job.running?.controller.abort();
      job.running = undefined;
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
      for (;;) {
        let next: Job | undefined;
        for (const job of this.jobs.values()) {
          if (job.status !== "queued" || this.priority(job) === null) continue;
          // 装不下就跳过，继续找更轻的 job：活跃 3 时重量 1 仍可启动
          if (this.active + this.weight(job) > this.limit) continue;
          if (!next || this.priority(job)! < this.priority(next)!) next = job;
        }
        if (!next) break;
        this.start(next);
      }
    });
  }

  private start(job: Job) {
    const running: RunningLoad = { controller: new AbortController(), weight: this.weight(job) };
    job.running = running;
    job.status = "loading";
    this.active += running.weight;
    void Promise.resolve().then(() => this.load(job.src, running.controller.signal)).then(
      (image) => this.complete(job, running, { status: "ready", ...image }),
      () => this.complete(job, running, { status: "failed" }),
    ).finally(() => {
      // 按该次运行自身的重量释放（运行中升重的增量已在 update 计入）
      this.active -= running.weight;
      this.schedule();
    });
  }

  private complete(job: Job, running: RunningLoad, result: ImageLoadResult) {
    if (running.controller.signal.aborted || job.running !== running || this.jobs.get(job.src) !== job) {
      return;
    }
    job.running = undefined;
    job.status = "settled";
    job.result = result;
    for (const consumer of job.consumers.values()) consumer.notify(result);
  }
}
