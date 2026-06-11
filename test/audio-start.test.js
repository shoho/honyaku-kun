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
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

// 単一ファイルビルド（build.mjs）では __PCM_WORKLET_SOURCE__ が定数注入され、
// 相対 URL ではなく Blob / data URL 経由で worklet を読む分岐に入る。
describe("_loadWorklet の埋め込みソース分岐", () => {
  const SOURCE = 'registerProcessor("pcm", class {});';

  function pipelineWithCtx(addModule) {
    const pipeline = new AudioPipeline({ onChunk: () => {} });
    pipeline.ctx = { audioWorklet: { addModule } };
    return pipeline;
  }

  beforeEach(() => {
    vi.stubGlobal("__PCM_WORKLET_SOURCE__", SOURCE);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  it("埋め込みソースを blob: URL で読み込み、後始末に revoke する", async () => {
    const addModule = vi.fn(async () => {});
    await pipelineWithCtx(addModule)._loadWorklet();

    expect(addModule).toHaveBeenCalledTimes(1);
    expect(addModule).toHaveBeenCalledWith("blob:fake");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("blob: が拒否されたら data: URL にフォールバックし、それでも revoke する", async () => {
    const addModule = vi.fn(async (url) => {
      if (url === "blob:fake") throw new Error("blob rejected");
    });
    await pipelineWithCtx(addModule)._loadWorklet();

    expect(addModule).toHaveBeenCalledTimes(2);
    expect(addModule).toHaveBeenLastCalledWith(
      "data:text/javascript;charset=utf-8," + encodeURIComponent(SOURCE)
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });

  it("data: まで失敗したらエラーが伝播する（start 側の後始末が走れる）", async () => {
    const addModule = vi.fn(async () => {
      throw new Error("worklet blocked");
    });
    await expect(pipelineWithCtx(addModule)._loadWorklet()).rejects.toThrow("worklet blocked");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake");
  });
});
