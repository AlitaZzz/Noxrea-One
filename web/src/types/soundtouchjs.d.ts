/**
 * soundtouchjs 的最小类型声明（该包无自带类型，仅声明本项目用到的面）。
 * 帧数据约定：交错双声道 Float32（mono 源由调用方上混后喂入）。
 * SimpleFilter / WebAudioBufferSource 刻意绕开（离线全量处理直接驱动
 * SoundTouch 的 FIFO 管线，见 client-video.ts 变速管线），不声明。
 */
declare module "soundtouchjs" {
  /** 时间拉伸 / 变速处理器（WSOLA，保持音调）。tempo 取 0.25–4。 */
  export class SoundTouch {
    constructor();
    tempo: number;
    /** WSOLA 时间拉伸器：窗口参数按采样率换算，构造默认按 44100——须用
        setParameters 按源采样率重设（0 的 sequence / seek / overlap 参数保持库内自动档） */
    readonly stretch: {
      setParameters(sampleRate: number, sequenceMs: number, seekWindowMs: number, overlapMs: number): void;
    };
    /** 交错双声道输入 FIFO */
    readonly inputBuffer: FifoSampleBuffer;
    /** 交错双声道输出 FIFO */
    readonly outputBuffer: FifoSampleBuffer;
    /** 消费输入 FIFO，产出写入输出 FIFO */
    process(): void;
  }

  /** 交错双声道样本 FIFO（frameCount / putSamples / receiveSamples 均以帧计） */
  export class FifoSampleBuffer {
    readonly frameCount: number;
    putSamples(samples: Float32Array, position?: number, numFrames?: number): void;
    receiveSamples(output: Float32Array, numFrames?: number): void;
  }
}
