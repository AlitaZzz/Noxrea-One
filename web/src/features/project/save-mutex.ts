/**
 * 项目写通道互斥锁。
 * 画布保存与项目重命名是仅有的两个服务端写入口（均携带 baseRevision 并推高版本），
 * 同一标签页内必须严格串行——否则两条通道并发会造成同页 409，
 * 使「409 即其他窗口」的会话过期判定失效。
 */
class SaveMutex {
  private tail: Promise<void> = Promise.resolve();

  /** 串行执行 fn：排队到当前写请求之后，执行期间独占写通道；前序失败不阻塞后序。 */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

export const saveMutex = new SaveMutex();
