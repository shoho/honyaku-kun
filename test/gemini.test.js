import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { updateMinutes, finalizeMinutes, sanitizeSections } from "../js/gemini.js";

const API_KEY = "test-key";

function geminiResponse(payload) {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }],
    }),
    { status: 200 }
  );
}

let fetchMock;
beforeEach(() => {
  fetchMock = vi.fn(async () => geminiResponse({ sections: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("updateMinutes", () => {
  it("API キー未設定なら上流を呼ばず例外", async () => {
    await expect(updateMinutes({ transcript: "x" })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transcript が空なら上流を呼ばず既存セクションを返す", async () => {
    const sections = [{ topic: "T", points: ["p"] }];
    const out = await updateMinutes({ apiKey: API_KEY, transcript: "  ", sections });
    expect(out).toEqual(sections);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("正常系: キーはヘッダーで送り、推論レベルと出力スキーマを指定し、sections を返す", async () => {
    const out = [{ topic: "Topic", points: ["point 1"] }];
    fetchMock.mockResolvedValueOnce(geminiResponse({ sections: out }));

    const result = await updateMinutes({
      apiKey: API_KEY,
      targetName: "Japanese",
      transcript: "こんにちは、世界。",
      source: "Hello, world.",
      sections: [{ topic: "Prev", points: ["old point"] }],
    });
    expect(result).toEqual(out);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/models/gemini-3.5-flash:generateContent");
    expect(url).not.toContain("key="); // キーはクエリに載せない
    expect(init.headers["x-goog-api-key"]).toBe(API_KEY);

    const body = JSON.parse(init.body);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("medium");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toEqual(["sections"]);

    const prompt = body.contents[0].parts[0].text;
    expect(prompt).toContain("こんにちは、世界。");
    expect(prompt).toContain("Hello, world.");
    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("■ Prev"); // 現在の要約を引き継ぐ
    expect(prompt).toContain("・old point");
  });

  it("上流エラーなら例外（ステータス入り）", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 429 }));
    await expect(updateMinutes({ apiKey: API_KEY, transcript: "x" })).rejects.toThrow("429");
  });

  it("モデルが不正 JSON を返したら例外", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "not json" }] } }] }),
        { status: 200 }
      )
    );
    await expect(updateMinutes({ apiKey: API_KEY, transcript: "x" })).rejects.toThrow();
  });

  it("モデル出力もサニタイズして返す", async () => {
    fetchMock.mockResolvedValueOnce(
      geminiResponse({ sections: [{ topic: 123, points: ["a", "", null] }] })
    );
    const out = await updateMinutes({ apiKey: API_KEY, transcript: "x" });
    expect(out).toEqual([{ topic: "123", points: ["a"] }]);
  });
});

describe("finalizeMinutes", () => {
  it("transcript が空なら例外", async () => {
    await expect(finalizeMinutes({ apiKey: API_KEY, transcript: " " })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("最終版は推論レベル high・ライブ議事録をヒントとして渡す", async () => {
    await finalizeMinutes({
      apiKey: API_KEY,
      targetName: "Japanese",
      transcript: "full transcript",
      source: "原文",
      sections: [{ topic: "Live", points: ["hint"] }],
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");
    expect(body.generationConfig.maxOutputTokens).toBe(16384);
    const prompt = body.contents[0].parts[0].text;
    expect(prompt).toContain("FINAL");
    expect(prompt).toContain("full transcript");
    expect(prompt).toContain("■ Live");
  });
});

describe("共通プロンプトルール", () => {
  it("非ネイティブ話者・不明瞭マーカーのルールは両プロンプトに含まれる", async () => {
    await updateMinutes({ apiKey: API_KEY, targetName: "Japanese", transcript: "x" });
    await finalizeMinutes({ apiKey: API_KEY, targetName: "Japanese", transcript: "x" });
    for (const call of fetchMock.mock.calls) {
      const prompt = JSON.parse(call[1].body).contents[0].parts[0].text;
      expect(prompt).toContain("non-native speaker");
      expect(prompt).toContain("（不明瞭）");
      expect(prompt).toContain("Everything must be written in Japanese.");
    }
  });
});

describe("sanitizeSections", () => {
  it("非配列は空配列に", () => {
    expect(sanitizeSections(null)).toEqual([]);
    expect(sanitizeSections("x")).toEqual([]);
  });

  it("型を強制し、空のセクションを除去する", () => {
    const out = sanitizeSections([
      { topic: 123, points: ["a", "", 42, null] },
      { topic: "", points: [] },
    ]);
    expect(out).toEqual([{ topic: "123", points: ["a", "42"] }]);
  });

  it("セクション数・ポイント数・文字数をクランプする（既定 40/20）", () => {
    const huge = Array.from({ length: 80 }, () => ({
      topic: "t".repeat(500),
      points: Array.from({ length: 40 }, () => "p".repeat(500)),
    }));
    const out = sanitizeSections(huge);
    expect(out.length).toBe(40);
    expect(out[0].topic.length).toBe(120);
    expect(out[0].points.length).toBe(20);
    expect(out[0].points[0].length).toBe(300);
  });

  it("上限はオプションで上書きできる（最終版は 60/30）", () => {
    const huge = Array.from({ length: 80 }, () => ({
      topic: "t",
      points: Array.from({ length: 40 }, () => "p"),
    }));
    const out = sanitizeSections(huge, { maxSections: 60, maxPoints: 30 });
    expect(out.length).toBe(60);
    expect(out[0].points.length).toBe(30);
  });
});
