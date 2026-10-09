import type { MediaLoadPriority } from "@/features/canvas/shared/media-visibility";

export const VIDEO_INTERACTION_PRIORITY = -1;
type VideoLoadPriority = typeof VIDEO_INTERACTION_PRIORITY | MediaLoadPriority;
export type VideoLoadStatus = "idle" | "loading" | "metadata" | "ready" | "failed" | "stalled";
export type VideoLoadLease = {
  setPriority: (priority: VideoLoadPriority) => void;
  release: () => void;
  retry: () => void;
};
type Job = {
  video: HTMLVideoElement;
  src: string;
  priority: VideoLoadPriority;
  started: boolean;
  active: boolean;
  failed: boolean;
  stalled: boolean;
  timeout?: ReturnType<typeof setTimeout>;
  notify: (status: VideoLoadStatus) => void;
  cleanup: () => void;
};

const VIDEO_LOAD_TIMEOUT_MS = 60_000;

/** Prepare the actual player, so loading does not create a second decoder or overwrite proxies. */
export class VideoLoadScheduler {
  private readonly jobs = new Set<Job>();
  private scheduled = false;

  constructor(private readonly limit = 2) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Invalid video concurrency limit");
  }

  acquire(video: HTMLVideoElement, src: string, notify: Job["notify"]): VideoLoadLease {
    const job: Job = { video, src, priority: null, started: false, active: false, failed: false, stalled: false, notify, cleanup: () => {} };
    const update = () => this.update(job);
    const progress = () => {
      if (video.getAttribute("src") === src) {
        job.failed = false;
        if (video.readyState >= this.target(job)) job.stalled = false;
      }
      update();
    };
    const loadStart = () => {
      if (video.getAttribute("src") === src) {
        job.failed = false;
        job.stalled = false;
      }
      update();
    };
    const fail = () => {
      if (video.getAttribute("src") !== src) return;
      job.failed = true;
      this.update(job);
    };
    video.preload = "none";
    video.addEventListener("loadedmetadata", progress);
    video.addEventListener("loadeddata", progress);
    video.addEventListener("loadstart", loadStart);
    video.addEventListener("error", fail);
    job.cleanup = () => {
      video.removeEventListener("loadedmetadata", progress);
      video.removeEventListener("loadeddata", progress);
      video.removeEventListener("loadstart", loadStart);
      video.removeEventListener("error", fail);
    };
    this.jobs.add(job);
    return {
      setPriority: (priority) => {
        if (!this.jobs.has(job)) return;
        job.priority = priority;
        // User actions must assign the source before play() or an editor's proxy swap.
        if (priority === VIDEO_INTERACTION_PRIORITY && this.needsPreparation(job)) this.start(job);
        this.update(job);
      },
      release: () => this.release(job),
      retry: () => {
        if (!this.jobs.has(job) || (!job.failed && !job.stalled) || video.getAttribute("src") !== src) return;
        this.finish(job);
        job.failed = false;
        job.stalled = false;
        video.load();
        if (job.priority === VIDEO_INTERACTION_PRIORITY && this.needsPreparation(job)) this.start(job);
        this.update(job);
      },
    };
  }

  clear() {
    for (const job of this.jobs) this.release(job);
  }

  private target(job: Job) {
    return job.priority === VIDEO_INTERACTION_PRIORITY || job.priority === 0 ? 2 : 1;
  }

  private needsPreparation(job: Job) {
    if (job.started && job.video.getAttribute("src") !== job.src) return false;
    return !job.failed && !job.stalled && (!job.started || job.video.readyState < this.target(job));
  }

  private finish(job: Job) {
    job.active = false;
    clearTimeout(job.timeout);
    job.timeout = undefined;
  }

  private update(job: Job) {
    if (!this.jobs.has(job)) return;
    if (job.active && (job.priority === null || !this.needsPreparation(job))) this.finish(job);
    // Editors temporarily own the element's source and preload behavior.
    if (job.started && job.video.getAttribute("src") !== job.src) {
      job.notify("loading");
      this.schedule();
      return;
    }
    if (job.started) {
      // Downgrade the hint after first-frame preparation; never reload on viewport changes.
      job.video.preload = job.failed || job.priority === null ? "none" : job.priority === VIDEO_INTERACTION_PRIORITY || (job.active && this.target(job) === 2) ? "auto" : "metadata";
    }
    const status: VideoLoadStatus = job.failed ? "failed" : job.stalled ? "stalled" : !job.started ? "idle" : job.video.readyState >= 2 ? "ready" : job.video.readyState >= 1 ? "metadata" : "loading";
    job.notify(status);
    this.schedule();
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      for (;;) {
        let active = 0;
        let next: Job | undefined;
        for (const job of this.jobs) {
          if (job.active) { active += 1; continue; }
          if (job.priority === null || !this.needsPreparation(job)) continue;
          if (!next || job.priority < next.priority!) next = job;
        }
        if (active >= this.limit || !next) break;
        this.start(next);
      }
    });
  }

  private start(job: Job) {
    if (!job.active) {
      job.active = true;
      job.timeout = setTimeout(() => {
        // Release the preparation slot; the browser's ongoing request may still succeed.
        job.stalled = true;
        this.update(job);
      }, VIDEO_LOAD_TIMEOUT_MS);
    }
    job.video.preload = this.target(job) === 2 ? "auto" : "metadata";
    if (!job.started) {
      job.started = true;
      job.video.src = job.src;
    }
    this.update(job);
  }

  private release(job: Job) {
    if (!this.jobs.delete(job)) return;
    this.finish(job);
    job.cleanup();
    if (job.started) {
      job.video.pause();
      job.video.removeAttribute("src");
      job.video.load();
    }
    this.schedule();
  }
}
