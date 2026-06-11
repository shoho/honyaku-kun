import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Summarizer } from "../js/summarizer.js";

// summarizer.js の定数と対応（変更したらここも追従）
const CHECK_MS = 10000;
const UPDATE_MS = 60000;
const FIRST_MIN_CHARS = 120;
const PENDING_MAX = 24000;

// gemini.js は generateContent を fetch するので、その応答形でスタブする
function geminiOk(sections = [{ topic: "T", points: ["p"] }]) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ sections }) }] } }],
    }),
    { status: 200 }
  );
}

function promptOf(call) {
  return JSON.parse(call[1].body).contents[0].parts[0].text;
}

let fetchMock, onSummary, onError, s;
beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => geminiOk());
  vi.stubGlobal("fetch", fetchMock);
  onSummary = vi.fn();
  onError = vi.fn();
  s = new Summarizer({ apiKey: "test-key", targetName: "Japanese", onSummary, onError });
});
afterEach(() => {
  s.stop();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Summarizer のスケジューリング", () => {
  it("初回は1分待たず、十分な量が溜まった時点の確認周期で発火する", async () => {
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onSummary).toHaveBeenCalledWith([{ topic: "T", points: ["p"] }]);
    expect(s.pending).toBe(""); // 消費済み
  });

  it("初回でも量が足りなければ待つ", async () => {
    s.feed("x".repeat(FIRST_MIN_CHARS - 1));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("2回目以降は約1分間隔。間隔未満では発火しない", async () => {
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS); // 初回
    expect(fetchMock).toHaveBeenCalledTimes(1);

    s.feed("more content arrives.");
    await vi.advanceTimersByTimeAsync(UPDATE_MS - CHECK_MS - 1000); // まだ1分未満
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(CHECK_MS + 1000); // 1分経過後の確認周期
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("新しい入力がなければ発火しない", async () => {
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS); // 初回で消費
    await vi.advanceTimersByTimeAsync(UPDATE_MS * 3); // 以降入力なし
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("前回の sections と新規分をプロンプトに載せて送る", async () => {
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);

    s.feed("second chunk");
    await vi.advanceTimersByTimeAsync(UPDATE_MS);
    const prompt = promptOf(fetchMock.mock.calls[1]);
    expect(prompt).toContain("■ T"); // 前回の要約を引き継ぐ
    expect(prompt).toContain("・p");
    expect(prompt).toContain("second chunk");
  });
});

describe("Summarizer の入力管理とエラー処理", () => {
  it("pending は上限でキャップされる", () => {
    s.feed("a".repeat(PENDING_MAX + 5000));
    expect(s.pending.length).toBe(PENDING_MAX);
  });

  it("失敗したら消費分を戻して onError、次の周期で再試行する", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.pending.length).toBe(FIRST_MIN_CHARS); // 復元済み
    expect(onSummary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(CHECK_MS); // 再試行（lastUpdate=0 のまま）
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onSummary).toHaveBeenCalledOnce();
  });

  it("HTTP エラーも失敗として扱う", async () => {
    fetchMock.mockResolvedValueOnce(new Response("err", { status: 502 }));
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onError).toHaveBeenCalledOnce();
    expect(s.pending.length).toBe(FIRST_MIN_CHARS);
  });

  it("flush は残りの pending を即時に要約する", async () => {
    s.feed("tail content");
    await s.flush();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(promptOf(fetchMock.mock.calls[0])).toContain("tail content");
  });

  it("flush は pending が空なら何もしない", async () => {
    await s.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空の sections 応答では表示を消さない", async () => {
    fetchMock.mockResolvedValueOnce(geminiOk([]));
    s.feed("x".repeat(FIRST_MIN_CHARS));
    s.start();
    await vi.advanceTimersByTimeAsync(CHECK_MS);
    expect(onSummary).not.toHaveBeenCalled();
  });
});
