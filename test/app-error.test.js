import { describe, it, expect } from "vitest";
import { formatMinutesError } from "../js/gemini.js";

describe("formatMinutesError", () => {
  it("トークン超過 / 会話が長すぎるエラーを判別する", () => {
    const err = new Error("Context too long / token limit exceeded (400): Request payload size exceeds the limit");
    const { short, full } = formatMinutesError(err);
    expect(short).toBe("Minutes: Context too long — will retry");
    expect(full).toContain("Transcript is very long");
  });

  it("出力トークン上限超過エラーを判別する", () => {
    const err = new Error("Output token limit reached (MAX_TOKENS) — response truncated");
    const { short } = formatMinutesError(err);
    expect(short).toBe("Minutes: Output limit reached — will retry");
  });

  it("429 クォータ・レートリミットエラーを判別する", () => {
    const err = new Error("Quota / rate limit exceeded (429): Resource has been exhausted");
    const { short, full } = formatMinutesError(err);
    expect(short).toBe("Minutes: Quota exceeded (429) — will retry");
    expect(full).toContain("Please wait a minute");
  });

  it("403 / 401 API キー・認証エラーを判別する（再試行サフィックスなし）", () => {
    const err = new Error("API key invalid or unauthorized (403): API key not valid");
    const { short, full } = formatMinutesError(err);
    expect(short).toBe("Minutes: API key invalid or unauthorized");
    expect(full).toContain("Check your Gemini API key");
  });

  it("404 モデル不明エラーを判別する", () => {
    const err = new Error("Model not found (404)");
    const { short, full } = formatMinutesError(err);
    expect(short).toBe("Minutes: Model not found (404)");
    expect(full).toContain("Pick another model");
  });

  it("セーフティフィルターエラーを判別する", () => {
    const err = new Error("Response blocked by safety filter (SAFETY)");
    const { short } = formatMinutesError(err);
    expect(short).toBe("Minutes: Blocked by filter");
  });

  it("500 サーバーエラーを判別する", () => {
    const err = new Error("Gemini server error (503): Backend error");
    const { short } = formatMinutesError(err);
    expect(short).toBe("Minutes: Server error (503) — will retry");
  });

  it("isFinal=true の時は Final minutes プレフィックスと対処アクションを出す", () => {
    const err = new Error("Context too long / token limit exceeded (400)");
    const { short } = formatMinutesError(err, { isRetryable: false, isFinal: true });
    expect(short).toBe("Final minutes: Context too long (try changing model)");
  });

  it("isFinal=true かつ 429 の時に対処アクションを出す", () => {
    const err = new Error("Quota / rate limit exceeded (429)");
    const { short } = formatMinutesError(err, { isRetryable: false, isFinal: true });
    expect(short).toBe("Final minutes: Quota exceeded (429) (wait 1 min and retry)");
  });
});
