import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveClient } from "../js/live-client.js";

function makeClient(overrides = {}) {
  const calls = { original: [], translation: [], status: [], errors: [] };
  const lc = new LiveClient({
    apiKey: "test-key",
    model: "test-model",
    targetCode: "ja",
    onOriginal: (t) => calls.original.push(t),
    onTranslation: (t) => calls.translation.push(t),
    onStatus: (kind, text) => calls.status.push([kind, text]),
    onError: (e) => calls.errors.push(e),
    ...overrides,
  });
  return { lc, calls };
}

// _sendSetup が送る setup ペイロードを取り出す
function setupPayload(lc) {
  const send = vi.fn();
  lc.ws = { send };
  lc._sendSetup();
  return JSON.parse(send.mock.calls[0][0]).setup;
}

describe("LiveClient の setup（モード別）", () => {
  it("translate（既定）: translationConfig + AUDIO + 出力書き起こし", () => {
    const { lc } = makeClient();
    const setup = setupPayload(lc);
    expect(setup.model).toBe("models/test-model");
    expect(setup.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(setup.generationConfig.translationConfig.targetLanguageCode).toBe("ja");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.systemInstruction).toBeUndefined();
    // live-translate はモデル側が長時間セッションに対応するため圧縮は送らない
    expect(setup.contextWindowCompression).toBeUndefined();
  });

  it("translate-text: TEXT + 翻訳指示の systemInstruction + 圧縮。translationConfig は送らない", () => {
    const { lc } = makeClient({ mode: "translate-text", targetName: "Japanese" });
    const setup = setupPayload(lc);
    expect(setup.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(setup.generationConfig.translationConfig).toBeUndefined();
    const instruction = setup.systemInstruction.parts[0].text;
    expect(instruction).toContain("Japanese");
    expect(instruction).toContain("filler");
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toBeUndefined();
    // 通常モデルは音声セッションが既定15分で切れるため圧縮が必須
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it("transcribe: TEXT + 沈黙指示 + 圧縮", () => {
    const { lc } = makeClient({ mode: "transcribe" });
    const setup = setupPayload(lc);
    expect(setup.generationConfig.responseModalities).toEqual(["TEXT"]);
    expect(setup.systemInstruction.parts[0].text).toContain("silent");
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
  });

  it("再開ハンドルは全モードで setup に載る", () => {
    for (const mode of ["translate", "translate-text", "transcribe"]) {
      const { lc } = makeClient({ mode });
      lc.resumeHandle = "handle-9";
      expect(setupPayload(lc).sessionResumption).toEqual({ handle: "handle-9" });
    }
  });
});

describe("LiveClient の接続先", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("apiVersion が WebSocket URL に反映される（既定 v1alpha）", () => {
    const urls = [];
    vi.stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        constructor(url) { urls.push(url); }
        close() {}
      }
    );
    const { lc } = makeClient();
    lc.connect();
    expect(urls[0]).toContain(".v1alpha.");

    const { lc: lc2 } = makeClient({ apiVersion: "v1beta" });
    lc2.connect();
    expect(urls[1]).toContain(".v1beta.");
    lc.close();
    lc2.close();
  });
});

describe("LiveClient のメッセージ処理", () => {
  it("setupComplete で ready になり live を通知する", () => {
    const { lc, calls } = makeClient();
    lc.reconnectAttempts = 3;
    lc._onMessage({ data: JSON.stringify({ setupComplete: {} }) });
    expect(lc.ready).toBe(true);
    expect(lc.everReady).toBe(true);
    expect(lc.reconnectAttempts).toBe(0); // 接続成功でリセット
    expect(calls.status.at(-1)[0]).toBe("live");
  });

  it("inputTranscription は原文へ、outputTranscription は翻訳へ", () => {
    const { lc, calls } = makeClient();
    lc._onMessage({
      data: JSON.stringify({ serverContent: { inputTranscription: { text: "Hello" } } }),
    });
    lc._onMessage({
      data: JSON.stringify({ serverContent: { outputTranscription: { text: "こんにちは" } } }),
    });
    expect(calls.original).toEqual(["Hello"]);
    expect(calls.translation).toEqual(["こんにちは"]);
  });

  it("バイナリフレーム（ArrayBuffer）の JSON も処理する", () => {
    const { lc, calls } = makeClient();
    const buf = new TextEncoder().encode(
      JSON.stringify({ serverContent: { outputTranscription: { text: "訳" } } })
    ).buffer;
    lc._onMessage({ data: buf });
    expect(calls.translation).toEqual(["訳"]);
  });

  it("セッション再開ハンドルを保持する", () => {
    const { lc } = makeClient();
    lc._onMessage({
      data: JSON.stringify({
        sessionResumptionUpdate: { resumable: true, newHandle: "handle-1" },
      }),
    });
    expect(lc.resumeHandle).toBe("handle-1");
  });

  it("壊れたJSONや未知のメッセージは無視する", () => {
    const { lc, calls } = makeClient();
    lc._onMessage({ data: "garbage" });
    lc._onMessage({ data: JSON.stringify({ unknownField: 1 }) });
    expect(calls.errors).toEqual([]);
    expect(calls.original).toEqual([]);
  });

  it("未接続時の sendAudio は何もしない（例外なし）", () => {
    const { lc } = makeClient();
    expect(() => lc.sendAudio("AAAA")).not.toThrow();
  });

  it("translate-text: modelTurn のテキストが翻訳として届き、ターンの切れ目で改行する", () => {
    const { lc, calls } = makeClient({ mode: "translate-text" });
    lc._onMessage({
      data: JSON.stringify({
        serverContent: { modelTurn: { parts: [{ text: "こんに" }, { text: "ちは" }] } },
      }),
    });
    lc._onMessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    expect(calls.translation).toEqual(["こんに", "ちは", "\n"]);
  });

  it("translate-text: テキストの無いターンでは改行を挿入しない", () => {
    const { lc, calls } = makeClient({ mode: "translate-text" });
    lc._onMessage({ data: JSON.stringify({ serverContent: { turnComplete: true } }) });
    expect(calls.translation).toEqual([]);
  });

  it("transcribe: 応答抑制をすり抜けた modelTurn は捨て、書き起こしだけ流す", () => {
    const { lc, calls } = makeClient({ mode: "transcribe" });
    lc._onMessage({
      data: JSON.stringify({
        serverContent: { modelTurn: { parts: [{ text: "はい、了解です" }] }, turnComplete: true },
      }),
    });
    lc._onMessage({
      data: JSON.stringify({ serverContent: { inputTranscription: { text: "会議を始めます" } } }),
    });
    expect(calls.translation).toEqual([]);
    expect(calls.original).toEqual(["会議を始めます"]);
  });

  it("translate: modelTurn（翻訳音声のメタ）は翻訳として流さない", () => {
    const { lc, calls } = makeClient();
    lc._onMessage({
      data: JSON.stringify({ serverContent: { modelTurn: { parts: [{ text: "x" }] } } }),
    });
    expect(calls.translation).toEqual([]);
  });
});

describe("LiveClient の再接続", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("サーバーから msg.error が届いたら即座に onError を呼ぶ", () => {
    const { lc, calls } = makeClient();
    lc._onMessage({
      data: JSON.stringify({ error: { code: 400, message: "Invalid model name" } }),
    });
    expect(calls.errors[0].message).toContain("Invalid model name");
  });

  it("サーバーから msg.goAway が届いたら onError を呼ぶ", () => {
    const { lc, calls } = makeClient();
    lc._onMessage({
      data: JSON.stringify({ goAway: { reason: "Session limit exceeded" } }),
    });
    expect(calls.errors[0].message).toContain("Session limit exceeded");
  });

  it("未接続切断時に e.reason があればエラーメッセージに反映する", () => {
    const { lc, calls } = makeClient();
    lc._onClose({ code: 1007, reason: "API key not valid. Please pass a valid API key." });
    expect(calls.errors[0].message).toContain("API key not valid");
  });

  it("一度も接続が成立していなければ即エラーにして再接続しない（キー不正の典型）", () => {
    const { lc, calls } = makeClient();
    lc.connect = vi.fn();
    lc._onClose({ code: 1006 });
    expect(calls.errors[0].message).toContain("API key");
    vi.advanceTimersByTime(60000);
    expect(lc.connect).not.toHaveBeenCalled();
    // エラー表示を上書きしないよう idle は流さない
    expect(calls.status.map(([k]) => k)).not.toContain("idle");
  });

  it("接続成立後の異常切断は指数バックオフで再接続する", () => {
    const { lc, calls } = makeClient();
    lc.everReady = true;
    lc.connect = vi.fn();

    lc._onClose({ code: 1006 });
    expect(lc.reconnectAttempts).toBe(1);
    expect(calls.status.at(-1)).toEqual(["connecting", "Reconnecting… (1)"]);
    vi.advanceTimersByTime(499);
    expect(lc.connect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(lc.connect).toHaveBeenCalledOnce(); // 1回目: 500ms

    lc._onClose({ code: 1006 });
    vi.advanceTimersByTime(1000); // 2回目: 1000ms
    expect(lc.connect).toHaveBeenCalledTimes(2);
  });

  it("ユーザーによる停止では再接続しない", () => {
    const { lc, calls } = makeClient();
    lc.connect = vi.fn();
    lc.closedByUser = true;
    lc._onClose({ code: 1006 });
    vi.advanceTimersByTime(60000);
    expect(lc.connect).not.toHaveBeenCalled();
    expect(calls.status.at(-1)[0]).toBe("idle");
  });

  it("正常クローズ (1000) では再接続しない", () => {
    const { lc } = makeClient();
    lc.connect = vi.fn();
    lc._onClose({ code: 1000 });
    vi.advanceTimersByTime(60000);
    expect(lc.connect).not.toHaveBeenCalled();
  });

  it("上限を超えたらエラー通知して諦める（エラー表示は idle で上書きしない）", () => {
    const { lc, calls } = makeClient();
    lc.everReady = true;
    lc.connect = vi.fn();
    lc.reconnectAttempts = 5; // MAX_RECONNECT_ATTEMPTS
    lc._onClose({ code: 1011 });
    expect(calls.errors[0].message).toContain("1011");
    expect(calls.status.map(([k]) => k)).not.toContain("idle");
    vi.advanceTimersByTime(60000);
    expect(lc.connect).not.toHaveBeenCalled();
  });

  it("close() は再接続タイマーも止める", () => {
    const { lc } = makeClient();
    lc.everReady = true;
    lc.connect = vi.fn();
    lc._onClose({ code: 1006 }); // タイマー予約
    lc.close();
    vi.advanceTimersByTime(60000);
    expect(lc.connect).not.toHaveBeenCalled();
  });
});
