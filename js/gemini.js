// Gemini REST API クライアント。要約・最終版議事録のプロンプト構築、
// responseSchema による出力強制、形の正規化を担当する。
// API キーはユーザーが UI で入力したものを使い、Google へ直接送る
// （x-goog-api-key ヘッダー。URL クエリには載せない）。

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const SUMMARY_MODEL = "gemini-3.5-flash";

const MAX_TOPIC_CHARS = 120;
const MAX_POINT_CHARS = 300;

// モデル出力は信頼せず、形の正規化を必ず通す
export function sanitizeSections(value, { maxSections = 40, maxPoints = 20 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxSections)
    .map((s) => ({
      topic: String(s?.topic ?? "").slice(0, MAX_TOPIC_CHARS),
      points: (Array.isArray(s?.points) ? s.points : [])
        .slice(0, maxPoints)
        .map((p) => String(p ?? "").slice(0, MAX_POINT_CHARS))
        .filter((p) => p.trim()),
    }))
    .filter((s) => s.topic.trim() || s.points.length);
}

function formatMinutes(sections) {
  return sections
    .map((s) => `■ ${s.topic}\n${s.points.map((p) => `・${p}`).join("\n")}`)
    .join("\n");
}

// ライブ議事録の更新（約1分ごと）。現在の要約全体＋新規分を渡して全文再生成する。
export async function updateMinutes({ apiKey, targetName, sections, transcript, source }) {
  const target = String(targetName ?? "the target language").slice(0, 60);
  const clean = sanitizeSections(sections);
  const newText = String(transcript ?? "").slice(-16000);
  const sourceText = String(source ?? "").slice(-16000);
  if (!newText.trim()) return clean;

  const current = clean.length ? formatMinutes(clean) : "(まだ要約はない — これが最初の更新)";

  const prompt =
    `You are keeping live, structured minutes of an ongoing talk (presentation or conversation) ` +
    `for an audience reading along in real time. The minutes are written in ${target}.\n\n` +
    `[CURRENT MINUTES]\n${current}\n\n` +
    `[NEW TRANSCRIPT — machine translation of roughly the last minute of speech]\n${newText}\n\n` +
    `[SOURCE TRANSCRIPT — what was actually said, in the original language; authoritative when ` +
    `the translation is unclear or wrong]\n${sourceText || "(not available)"}\n\n` +
    `Update the minutes to incorporate the new content, and return the COMPLETE updated minutes.\n` +
    `Rules:\n` +
    `- Organize by topic: extend existing sections, add new ones, and merge or reorganize ` +
    `sections when it makes the flow of the talk clearer.\n` +
    `- Bullet points must be concise, concrete and information-dense: keep facts, numbers, ` +
    `names, decisions and announcements; drop filler, greetings and repetition.\n` +
    `- Stay faithful to what was said — never invent or speculate. Use the source transcript ` +
    `to correct translation errors.\n` +
    `- Consider that the speaker may be a non-native speaker: the transcript can contain ` +
    `grammar mistakes, wrong word choices, false starts and self-corrections. Interpret what ` +
    `the speaker MEANT rather than the literal wording.\n` +
    `- If a passage is unintelligible or too ambiguous to interpret confidently, do not guess ` +
    `or assert an interpretation: keep the unclear words as-is and append a parenthetical ` +
    `"unclear" marker written naturally in ${target} (the equivalent of "(unclear)" in ` +
    `that language — for example "（不明瞭）" if the minutes are in Japanese).\n` +
    `- Do not drop information that is already in the current minutes unless it was wrong or ` +
    `is being merged into a better-phrased point.\n` +
    `- Everything must be written in ${target}.`;

  return generateSections({
    apiKey,
    prompt,
    thinkingLevel: "medium",
    maxOutputTokens: 8192,
    maxSections: 40,
    maxPoints: 20,
  });
}

// 最終版議事録（セッション全体を俯瞰して再構成）。一度きりなので推論レベルを上げる。
export async function finalizeMinutes({ apiKey, targetName, sections, transcript, source }) {
  const target = String(targetName ?? "the target language").slice(0, 60);
  const fullText = String(transcript ?? "").slice(-120000);
  const sourceText = String(source ?? "").slice(-120000);
  const liveSections = sanitizeSections(sections);
  if (!fullText.trim()) throw new Error("transcript is empty");

  const liveMinutes = liveSections.length ? formatMinutes(liveSections) : "(none)";

  const prompt =
    `You are writing the FINAL, polished minutes of a talk (presentation or conversation) ` +
    `that has just ended. The minutes must be written in ${target}.\n\n` +
    `[FULL TRANSCRIPT — machine translation of the entire talk]\n${fullText}\n\n` +
    `[SOURCE TRANSCRIPT — what was actually said, in the original language; authoritative ` +
    `when the translation is unclear or wrong]\n${sourceText || "(not available)"}\n\n` +
    `[LIVE MINUTES — incrementally built during the talk; useful as a hint for topics, ` +
    `but may be fragmented or redundant]\n${liveMinutes}\n\n` +
    `Write the complete final minutes from scratch, with the whole talk in view:\n` +
    `- Organize by the actual structure of the talk: clear topic sections in a logical order, ` +
    `merging fragments and removing redundancy that accumulated in the live minutes.\n` +
    `- Bullet points must be concise, concrete and information-dense: keep all facts, numbers, ` +
    `names, decisions and announcements; drop filler and repetition.\n` +
    `- Stay strictly faithful to the transcript — never invent or speculate. Use the source ` +
    `transcript to correct translation errors.\n` +
    `- Consider that the speaker may be a non-native speaker: the transcript can contain ` +
    `grammar mistakes, wrong word choices, false starts and self-corrections. Interpret what ` +
    `the speaker MEANT rather than the literal wording.\n` +
    `- If a passage is unintelligible or too ambiguous to interpret confidently, do not guess ` +
    `or assert an interpretation: keep the unclear words as-is and append a parenthetical ` +
    `"unclear" marker written naturally in ${target} (the equivalent of "(unclear)" in ` +
    `that language — for example "（不明瞭）" if the minutes are in Japanese).\n` +
    `- Everything must be written in ${target}.`;

  return generateSections({
    apiKey,
    prompt,
    thinkingLevel: "high",
    maxOutputTokens: 16384,
    maxSections: 60,
    maxPoints: 30,
  });
}

// generateContent を responseSchema 付きで呼び、{sections} を正規化して返す
async function generateSections({ apiKey, prompt, thinkingLevel, maxOutputTokens, maxSections, maxPoints }) {
  if (!apiKey) throw new Error("API key is not set");

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens,
      thinkingConfig: { thinkingLevel },
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          sections: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                topic: { type: "STRING" },
                points: { type: "ARRAY", items: { type: "STRING" } },
              },
              required: ["topic", "points"],
            },
          },
        },
        required: ["sections"],
      },
    },
  };

  const resp = await fetch(`${API_BASE}/models/${SUMMARY_MODEL}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`Gemini ${resp.status}`);

  const data = await resp.json();
  const raw =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? "";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("model returned malformed JSON");
  }
  return sanitizeSections(parsed?.sections, { maxSections, maxPoints });
}
