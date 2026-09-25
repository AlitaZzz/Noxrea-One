/**
 * readSseStream 帧解析测试。
 * 锁定公共解析器的行为契约：帧切分、事件名消费时机（成功帧与失败帧均消费）、
 * 心跳/未知行忽略、跨 chunk 半行分帧。接入新 SSE 消费方时的回归防线。
 */
import { describe, expect, it } from "vitest";

import { readSseStream } from "@/lib/sse";

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

interface Received {
  event: string;
  data: Record<string, unknown>;
}

async function collect(chunks: string[]): Promise<Received[]> {
  const received: Received[] = [];
  await readSseStream(streamOf(...chunks), (event, data) => {
    received.push({ event, data });
  });
  return received;
}

describe("readSseStream", () => {
  it("解析 event + data 帧", async () => {
    const received = await collect(['event: evict\ndata: {"revision":5}\n\n']);
    expect(received).toEqual([{ event: "evict", data: { revision: 5 } }]);
  });

  it("缺省事件名派发为 message", async () => {
    const received = await collect(['data: {"ok":true}\n\n']);
    expect(received).toEqual([{ event: "message", data: { ok: true } }]);
  });

  it("事件名随帧消费：不泄漏到后续帧", async () => {
    const received = await collect(['event: evict\ndata: {"a":1}\n\n', 'data: {"b":2}\n\n']);
    expect(received).toEqual([
      { event: "evict", data: { a: 1 } },
      { event: "message", data: { b: 2 } },
    ]);
  });

  it("解析失败的帧整体丢弃，事件名一并丢弃不误伤下一帧", async () => {
    // event 行后紧跟非法 JSON：该帧丢弃，下一帧不得继承 evict 事件名
    const received = await collect(['event: evict\ndata: not-json\n\n', 'data: {"c":3}\n\n']);
    expect(received).toEqual([{ event: "message", data: { c: 3 } }]);
  });

  it("跨 chunk 半行分帧：缓冲区拼接后再解析", async () => {
    const received = await collect(['event: sync\ndata: {"rev', 'ision":9}\n\n']);
    expect(received).toEqual([{ event: "sync", data: { revision: 9 } }]);
  });

  it("心跳注释行与 id / retry 等未知字段行忽略", async () => {
    const received = await collect([': ping\n\n', 'id: 42\nretry: 1000\n\n', 'data: {"d":4}\n\n']);
    expect(received).toEqual([{ event: "message", data: { d: 4 } }]);
  });

  it("CRLF 行分隔兼容（JSON 尾部 \\r 为合法空白）", async () => {
    const received = await collect(['event: sync\r\ndata: {"e":5}\r\n\r\n']);
    expect(received).toEqual([{ event: "sync", data: { e: 5 } }]);
  });
});
