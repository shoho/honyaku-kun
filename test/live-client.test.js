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
});

describe("LiveClient の再接続", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
