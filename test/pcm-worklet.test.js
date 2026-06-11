import { describe, it, expect, vi, beforeAll } from "vitest";

// AudioWorklet のグローバルをシムして PCMProcessor クラスを取り出す
let PCMProcessor;
beforeAll(async () => {
  globalThis.AudioWorkletProcessor = class {
    constructor() {
      this.port = { postMessage: () => {} };
    }
  };
  globalThis.registerProcessor = (name, cls) => {
    PCMProcessor = cls;
  };
  globalThis.sampleRate = 16000;
  await import("../js/pcm-worklet.js");
});

function makeProcessor(rate) {
  globalThis.sampleRate = rate;
  const proc = new PCMProcessor();
  const messages = [];
  proc.port.postMessage = (buf) => messages.push(buf);
  return { proc, messages };
}

const CHUNK_SAMPLES = 1600; // 100ms @16kHz

describe("PCMProcessor（16kHz/16bit PCM 変換）", () => {
  it("コンテキストが 16kHz ならサンプルを 1:1 で変換し、1600 サンプルごとに送出", () => {
    const { proc, messages } = makeProcessor(16000);
    proc.process([[new Float32Array(CHUNK_SAMPLES).fill(0.5)]]);
    expect(messages.length).toBe(1);
    const pcm = new Int16Array(messages[0]);
    expect(pcm.length).toBe(CHUNK_SAMPLES);
    expect(pcm[0]).toBe(Math.trunc(0.5 * 0x7fff)); // 16383
  });

  it("フルスケールは飽和せず正しく変換される", () => {
    const { proc, messages } = makeProcessor(16000);
    const input = new Float32Array(CHUNK_SAMPLES);
    input[0] = 1.0;
    input[1] = -1.0;
    input[2] = 2.0;  // 範囲外はクリップ
    input[3] = -2.0;
    proc.process([[input]]);
    const pcm = new Int16Array(messages[0]);
    expect(pcm[0]).toBe(32767);
    expect(pcm[1]).toBe(-32768);
    expect(pcm[2]).toBe(32767);
    expect(pcm[3]).toBe(-32768);
  });

  it("48kHz 入力は 1/3 に間引かれる", () => {
    const { proc, messages } = makeProcessor(48000);
    // 3の倍数番目だけ 0.5、それ以外は 0 → 出力が全て 16383 なら正しく間引けている
    const input = new Float32Array(CHUNK_SAMPLES * 3);
    for (let i = 0; i < input.length; i += 3) input[i] = 0.5;
    proc.process([[input]]);
    expect(messages.length).toBe(1);
    const pcm = new Int16Array(messages[0]);
    expect(pcm.length).toBe(CHUNK_SAMPLES);
    expect(pcm.every((v) => v === Math.trunc(0.5 * 0x7fff))).toBe(true);
  });

  it("複数ブロックにまたがって 1600 サンプル単位で送出する", () => {
    const { proc, messages } = makeProcessor(16000);
    proc.process([[new Float32Array(1000)]]);
    expect(messages.length).toBe(0); // まだ溜め中
    proc.process([[new Float32Array(1000)]]);
    expect(messages.length).toBe(1); // 1600 到達で送出、残り400は次へ
    proc.process([[new Float32Array(1200)]]);
    expect(messages.length).toBe(2);
  });

  it("リサンプリング位置はブロックをまたいで持ち越される（48kHz）", () => {
    const { proc, messages } = makeProcessor(48000);
    // 4800 サンプルを半分ずつ渡しても、合計で正確に 1600 サンプル出力される
    proc.process([[new Float32Array(2400)]]);
    proc.process([[new Float32Array(2400)]]);
    expect(messages.length).toBe(1);
    expect(new Int16Array(messages[0]).length).toBe(CHUNK_SAMPLES);
  });

  it("入力が無いフレームでも true を返して処理を継続する", () => {
    const { proc } = makeProcessor(16000);
    expect(proc.process([])).toBe(true);
    expect(proc.process([[]])).toBe(true);
  });
});
