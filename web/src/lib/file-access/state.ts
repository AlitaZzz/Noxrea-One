/**
 * 解析层的会话状态：作用域序号、stream 形态学习与请求序号。
 *
 * 三者都按会话重置（`beginNewScope`），并被协议层之外的不同模块共享——
 * 单独成模块是为了让「会话切换只改变这三个值 + 清空各模块状态」这条不变量
 * 有唯一的读入口，避免循环依赖。
 */

/** 账号作用域：会话切换即 +1，旧作用域的缓存与在途结果一律作废 */
let scope = 0;

/** stream 形态学习（规则 3.4）：首次拿到 stream 后，托管 URL 不再请求描述接口 */
let streamLearned = false;

/** 请求序号（单调递增）：结果入缓存与落盘的定序依据，越新的请求越后写入 */
let requestSeq = 0;

export function currentScope(): number {
  return scope;
}

export function isStreamLearned(): boolean {
  return streamLearned;
}

export function learnStreamDelivery(): void {
  streamLearned = true;
}

export function nextRequestSeq(): number {
  return ++requestSeq;
}

/** 会话切换：作用域 +1 并重新学习形态（学习结果与缓存同属会话作用域） */
export function beginNewScope(): void {
  scope += 1;
  streamLearned = false;
}
