import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AudioPipeline } from "../js/audio.js";

// start() はストリーム取得と AudioContext/worklet 準備を並列に走らせるため、
// 片方だけ成功したときに成功した側（特にマイク）が解放されることをロックする。

let ctxInstances;

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.closed = false;
    this.audioWorklet = { addModule: FakeAudioContext.addModule };
    ctxInstances.push(this);
  }
  async close() {
    this.closed = true;
  }
}

function fakeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return {
    track,
    getTracks: () => [track],
    getAudioTracks: () => [track],
    getVideoTracks: () => [],
  };
}

beforeEach(() => {
  ctxInstances = [];
  FakeAudioContext.addModule = vi.fn(async () => {});
  vi.stubGlobal("AudioContext", FakeAudioContext);
});
afterEach(() => vi.unstubAllGlobals());

describe("AudioPipeline.start の部分失敗の後始末", () => {
  it("worklet 初期化に失敗したら取得済みトラックを止めてから投げ直す", async () => {
    const stream = fakeStream();
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => stream) },
    });
    FakeAudioContext.addModule = vi.fn(async () => {
      throw new Error("worklet 404");
    });

    const pipeline = new AudioPipeline({ onChunk: () => {} });
    await expect(pipeline.start("mic")).rejects.toThrow("worklet 404");
    expect(stream.track.stop).toHaveBeenCalled(); // マイクが掴まれたまま残らない
    expect(ctxInstances[0].closed).toBe(true);
  });

  it("ストリーム取得に失敗したらそのエラーを優先して投げる（app.js の文言出し分け用）", async () => {
    const denied = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn(async () => { throw denied; }) },
    });

    const pipeline = new AudioPipeline({ onChunk: () => {} });
    await expect(pipeline.start("mic")).rejects.toBe(denied);
    expect(ctxInstances[0].closed).toBe(true); // 成功した側の ctx は閉じる
  });
});
