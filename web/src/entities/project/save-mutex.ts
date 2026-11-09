/**
 * 项目域写通道互斥。
 * 画布保存与项目改名/封面是仅有的服务端写入口：同一标签页内必须严格串行，
 * 否则同页并发写会让「409 即其他窗口」的会话过期判定失效。
 * 全应用只允许这一把锁；canvas 保存与项目元数据命令都经此排队。
 */
class ProjectWriteQueue {
  private tail: Promise<void> = Promise.resolve();

  /** 串行执行 fn：排队到当前写请求之后，执行期间独占写通道；前序失败不阻塞后序。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

const queue = new ProjectWriteQueue();

/** 项目域写请求的全局串行入口。 */
export function runProjectWrite<T>(fn: () => Promise<T>): Promise<T> {
  return queue.runExclusive(fn);
}
