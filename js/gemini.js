// Gemini REST API クライアント。要約・最終版議事録のプロンプト構築、
// responseSchema による出力強制、形の正規化を担当する。
// API キーはユーザーが UI で入力したものを使い、Google へ直接送る
// （x-goog-api-key ヘッダー。URL クエリには載せない）。

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// 議事録に使えるモデルの単一情報源（UI のプルダウンはこれから生成する）。
// "-latest" はエイリアスで、新リリースごとに実体が差し替わる（2026-05-19 時点の
// gemini-flash-latest の実体は gemini-3.5-flash）。実体を固定したいときは
// バージョン付きの ID を選ぶ。不正な値は Google 側でエラーになるだけ。
export const SUMMARY_MODELS = [
  { id: "gemini-flash-latest", label: "Gemini Flash (latest)" },
  { id: "gemini-flash-lite-latest", label: "Gemini Flash Lite (latest)" },
  { id: "gemini-pro-latest", label: "Gemini Pro (latest)" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash (pinned)" },
];
// 既定（＝プルダウンの初期選択）。model 未指定の呼び出しもこれにフォールバックする。
export const SUMMARY_MODEL = SUMMARY_MODELS[0].id;

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

// ライブ更新・最終版の両プロンプトで完全に同一のルール（話者の言い間違い・
// 不明瞭箇所の扱い・議論の可視化）。文言を直すときに片方だけ直る事故を防ぐため一元化する。
function sharedRules(target) {
  return (
    `- Consider that the speaker may be a non-native speaker: the transcript can contain ` +
    `grammar mistakes, wrong word choices, false starts and self-corrections. Interpret what ` +
    `the speaker MEANT rather than the literal wording.\n` +
    `- If a passage is unintelligible or too ambiguous to interpret confidently, do not guess ` +
    `or assert an interpretation: keep the unclear words as-is and append a parenthetical ` +
    `"unclear" marker written naturally in ${target} (the equivalent of "(unclear)" in ` +
    `that language — for example "（不明瞭）" if the minutes are in Japanese).\n` +
    `- When a topic involved an actual discussion — differing views, proposals being weighed, ` +
    `back-and-forth — make the flow visible to a reader who was NOT present: as separate ` +
    `bullets, state the question at issue, the main positions or options raised with their ` +
    `reasoning, and how it ended. Prefix these bullets with short labels written in ${target} ` +
    `(the equivalents of "Issue:", "View:", "Conclusion:" — e.g. 「論点: …」「意見: …」` +
    `「結論: …」 if the minutes are in Japanese).\n` +
    `- State the outcome honestly: decided, deferred, or still open. Never present one ` +
    `participant's opinion as a decision; if no conclusion was reached, say so explicitly ` +
    `rather than leaving the outcome ambiguous.\n` +
    `- Attribute a view to a speaker only when the transcript itself identifies them (a name, ` +
    `"the presenter", etc.); otherwise use neutral phrasing like "one participant". Never ` +
    `invent speakers.\n` +
    `- One-way explanatory passages with no discussion get plain informative bullets — do not ` +
    `force the issue/view/conclusion structure onto them.\n`
  );
}

// 議事録の言語と入力ブロック・忠実性ルールをモードで切り替える。
//   - "translation": 翻訳くん。機械翻訳＋原文の2系統を渡し、議事録は翻訳先言語で書く
//   - "transcript":  議事録くん。原文の書き起こしのみを渡し、議事録も同じ言語で書く
function minutesTarget(mode, targetName) {
  return mode === "transcript"
    ? "the same language as the transcript"
    : String(targetName ?? "the target language").slice(0, 60);
}

function fidelityRule(mode) {
  return mode === "transcript"
    ? `- Stay faithful to what was said — never invent or speculate. The transcript is raw ` +
      `speech recognition and may contain mis-recognized words; interpret them from context.\n`
    : `- Stay faithful to what was said — never invent or speculate. Use the source transcript ` +
      `to correct translation errors.\n`;
}

// ライブ議事録の更新（約1分ごと）。現在の要約全体＋新規分を渡して全文再生成する。
export async function updateMinutes({ apiKey, model, targetName, sections, transcript, source, mode = "translation" }) {
  const target = minutesTarget(mode, targetName);
  const clean = sanitizeSections(sections);
  const newText = String(transcript ?? "").slice(-16000);
  const sourceText = String(source ?? "").slice(-16000);
  if (!newText.trim()) return clean;

  const current = clean.length ? formatMinutes(clean) : "(まだ要約はない — これが最初の更新)";

  const transcriptBlocks =
    mode === "transcript"
      ? `[NEW TRANSCRIPT — speech-recognition text of roughly the last minute of speech, in ` +
        `the speaker's original language]\n${newText}\n\n`
      : `[NEW TRANSCRIPT — machine translation of roughly the last minute of speech]\n${newText}\n\n` +
        `[SOURCE TRANSCRIPT — what was actually said, in the original language; authoritative when ` +
        `the translation is unclear or wrong]\n${sourceText || "(not available)"}\n\n`;

  const prompt =
    `You are keeping live, structured minutes of an ongoing talk (presentation or conversation) ` +
    `for an audience reading along in real time. The minutes are written in ${target}.\n\n` +
    `[CURRENT MINUTES]\n${current}\n\n` +
    transcriptBlocks +
    `Update the minutes to incorporate the new content, and return the COMPLETE updated minutes.\n` +
    `Rules:\n` +
    `- Organize by topic: extend existing sections, add new ones, and merge or reorganize ` +
    `sections when it makes the flow of the talk clearer.\n` +
    `- Bullet points must be concise, concrete and information-dense: keep facts, numbers, ` +
    `names, decisions and announcements; drop filler, greetings and repetition.\n` +
    fidelityRule(mode) +
    sharedRules(target) +
    `- A discussion may still be in progress: if a topic is being debated and no conclusion ` +
    `has been reached yet, mark it with an "ongoing / not yet decided" label written in ` +
    `${target} (e.g. 「議論中」 if the minutes are in Japanese). Replacing that marker with ` +
    `the actual conclusion in a later update — and reorganizing the bullets around it — is ` +
    `expected, and does not count as dropping information.\n` +
    `- Do not drop information that is already in the current minutes unless it was wrong or ` +
    `is being merged into a better-phrased point.\n` +
    `- Everything must be written in ${target}.`;

  return generateSections({
    apiKey,
    model,
    prompt,
    thinkingLevel: "medium",
    maxOutputTokens: 8192,
    maxSections: 40,
    maxPoints: 20,
  });
}

// 最終版議事録（セッション全体を俯瞰して再構成）。一度きりなので推論レベルを上げる。
export async function finalizeMinutes({ apiKey, model, targetName, sections, transcript, source, mode = "translation" }) {
  const target = minutesTarget(mode, targetName);
  const fullText = String(transcript ?? "").slice(-120000);
  const sourceText = String(source ?? "").slice(-120000);
  const liveSections = sanitizeSections(sections);
  if (!fullText.trim()) throw new GeminiApiError("transcript is empty");

  const liveMinutes = liveSections.length ? formatMinutes(liveSections) : "(none)";

  const transcriptBlocks =
    mode === "transcript"
      ? `[FULL TRANSCRIPT — speech-recognition text of the entire talk, in the speaker's ` +
        `original language]\n${fullText}\n\n`
      : `[FULL TRANSCRIPT — machine translation of the entire talk]\n${fullText}\n\n` +
        `[SOURCE TRANSCRIPT — what was actually said, in the original language; authoritative ` +
        `when the translation is unclear or wrong]\n${sourceText || "(not available)"}\n\n`;

  const prompt =
    `You are writing the FINAL, polished minutes of a talk (presentation or conversation) ` +
    `that has just ended. The minutes must be written in ${target}.\n\n` +
    transcriptBlocks +
    `[LIVE MINUTES — incrementally built during the talk; useful as a hint for topics, ` +
    `but may be fragmented or redundant]\n${liveMinutes}\n\n` +
    `Write the complete final minutes from scratch, with the whole talk in view:\n` +
    `- Organize by the actual structure of the talk: clear topic sections in a logical order, ` +
    `merging fragments and removing redundancy that accumulated in the live minutes.\n` +
    `- Bullet points must be concise, concrete and information-dense: keep all facts, numbers, ` +
    `names, decisions and announcements; drop filler and repetition.\n` +
    fidelityRule(mode) +
    sharedRules(target) +
    `- Reconstruct each discussion from the full transcript rather than copying the live ` +
    `minutes' fragments: now that the outcome is known, present the issue, the views with ` +
    `their reasoning, and the conclusion as a clean progression.\n` +
    `- If the talk produced decisions, action items or open questions, end with one dedicated ` +
    `section (titled in ${target}) listing them, so a reader can grasp the outcomes at a ` +
    `glance. Omit this section if there were none.\n` +
    `- If the talk was long or covered many topics, open with a short overview section ` +
    `(2-3 bullets) summarizing its purpose and overall arc. Omit it for short talks.\n` +
    `- Everything must be written in ${target}.`;

  try {
    return await generateSections({
      apiKey,
      model,
      prompt,
      thinkingLevel: "high",
      maxOutputTokens: 16384,
      maxSections: 60,
      maxPoints: 30,
    });
  } catch (err) {
    // 思考トークンによる上限超過・JSONパースエラー・思考非対応時は medium で自動フォールバック
    const msg = (err?.message || "").toLowerCase();
    if (
      err?.finishReason === "MAX_TOKENS" ||
      msg.includes("max_tokens") ||
      msg.includes("malformed json") ||
      msg.includes("thinking")
    ) {
      return await generateSections({
        apiKey,
        model,
        prompt,
        thinkingLevel: "medium",
        maxOutputTokens: 16384,
        maxSections: 60,
        maxPoints: 30,
      });
    }
    throw err;
  }
}

export class GeminiApiError extends Error {
  constructor(message, { status, code, details, finishReason, blockReason } = {}) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.finishReason = finishReason;
    this.blockReason = blockReason;
  }
}

export function formatMinutesError(e, { isRetryable = true, isFinal = false } = {}) {
  const msg = e?.message || String(e || "Unknown error");
  const msgLower = msg.toLowerCase();
  const prefix = isFinal ? "Final minutes" : "Minutes";
  const retrySuffix = isRetryable ? " — will retry" : "";

  let short = `${prefix} update failed${retrySuffix}`;
  let hint = "";

  if (
    msgLower.includes("context too long") ||
    msgLower.includes("token limit exceeded") ||
    msgLower.includes("payload size") ||
    msgLower.includes("too long") ||
    (msgLower.includes("400") && msgLower.includes("token"))
  ) {
    short = `${prefix}: Context too long${isFinal ? " (try changing model)" : retrySuffix}`;
    hint = "Transcript is very long. Try picking another model (e.g. Gemini Pro) from Minutes model.";
  } else if (msgLower.includes("output token limit") || msgLower.includes("max_tokens")) {
    short = `${prefix}: Output limit reached${isFinal ? " (try changing model)" : retrySuffix}`;
    hint = "Output exceeded token limit. Try changing the Minutes model or retrying.";
  } else if (msgLower.includes("quota") || msgLower.includes("rate limit") || msg.includes("429")) {
    short = `${prefix}: Quota exceeded (429)${isFinal ? " (wait 1 min and retry)" : retrySuffix}`;
    hint = "API rate/quota limit reached. Please wait a minute before retrying.";
  } else if (
    msgLower.includes("api key") ||
    msgLower.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    short = `${prefix}: API key invalid or unauthorized`;
    hint = "Check your Gemini API key in the top header and ensure Generative Language API is enabled.";
  } else if (msgLower.includes("model not found") || msg.includes("404")) {
    short = `${prefix}: Model not found (404)`;
    hint = "Selected model is not available for this API key. Pick another model from Minutes model.";
  } else if (msgLower.includes("safety") || msgLower.includes("blocked")) {
    short = `${prefix}: Blocked by filter`;
    hint = "Generation was blocked by safety filters.";
  } else if (
    msgLower.includes("server error") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504")
  ) {
    const statusMatch = msg.match(/\b(50[0-4])\b/);
    const code = statusMatch ? ` (${statusMatch[1]})` : "";
    short = `${prefix}: Server error${code}${isFinal ? " (retry in a moment)" : retrySuffix}`;
    hint = "Google Gemini server error. Please try again in a few moments.";
  } else if (msgLower.includes("network") || msgLower.includes("failed to fetch")) {
    short = `${prefix}: Network error${isFinal ? " (check connection)" : retrySuffix}`;
    hint = "Network connection failed. Check your internet connection.";
  } else if (msgLower.includes("empty sections")) {
    short = `${prefix}: Empty output (try again)`;
    hint = "Model returned no sections. Click Generate final minutes again to retry.";
  } else if (msgLower.includes("malformed json") || msgLower.includes("empty response")) {
    short = `${prefix}: Invalid model response${isFinal ? " (try again)" : retrySuffix}`;
    hint = "Model returned malformed output. Click Generate final minutes again to retry.";
  } else if (isFinal) {
    short = `${prefix} failed (try again)`;
  }

  const full = hint ? `${msg}\n👉 ${hint}` : msg;
  return { short, full, hint };
}

// generateContent を responseSchema 付きで呼び、{sections} を正規化して返す
async function generateSections({ apiKey, model, prompt, thinkingLevel, maxOutputTokens, maxSections, maxPoints }) {
  if (!apiKey) throw new GeminiApiError("API key is not set");
  const modelId = String(model || SUMMARY_MODEL);

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

  // モデル ID は UI 由来なのでパス埋め込み前にエスケープする
  const resp = await fetch(`${API_BASE}/models/${encodeURIComponent(modelId)}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let errMessage = "";
    let errStatus = resp.status;
    let errDetails = null;
    try {
      const errData = await resp.json();
      errMessage = errData?.error?.message || "";
      errDetails = errData?.error?.details || null;
    } catch {
      try {
        errMessage = await resp.text();
      } catch {}
    }

    let summary = `Gemini ${errStatus}`;
    const msgLower = (errMessage || "").toLowerCase();
    if (errStatus === 429) {
      summary = `Quota / rate limit exceeded (429)`;
    } else if (errStatus === 401 || errStatus === 403) {
      summary = `API key invalid or unauthorized (${errStatus})`;
    } else if (errStatus === 404) {
      summary = `Model not found (${errStatus})`;
    } else if (errStatus === 400) {
      if (
        msgLower.includes("token") ||
        msgLower.includes("length") ||
        msgLower.includes("size") ||
        msgLower.includes("too long") ||
        msgLower.includes("exceed")
      ) {
        summary = `Context too long / token limit exceeded (400)`;
      } else {
        summary = `Invalid request (400)`;
      }
    } else if (errStatus >= 500) {
      summary = `Gemini server error (${errStatus})`;
    }

    const fullMessage = errMessage ? `${summary}: ${errMessage}` : summary;
    throw new GeminiApiError(fullMessage, { status: errStatus, details: errDetails });
  }

  const data = await resp.json();

  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new GeminiApiError(`Prompt blocked by filter (${blockReason})`, { blockReason });
  }

  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiApiError("Output token limit reached (MAX_TOKENS) — response truncated", { finishReason });
  }
  if (finishReason === "SAFETY") {
    throw new GeminiApiError("Response blocked by safety filter (SAFETY)", { finishReason });
  }
  if (finishReason === "RECITATION") {
    throw new GeminiApiError("Response blocked due to recitation (RECITATION)", { finishReason });
  }

  const raw =
    candidate?.content?.parts?.map((p) => p.text || "").join("") ?? "";

  if (!raw.trim()) {
    throw new GeminiApiError(
      finishReason ? `Empty response from model (${finishReason})` : "Empty response from model",
      { finishReason }
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    if (finishReason === "MAX_TOKENS") {
      throw new GeminiApiError("Output token limit reached (truncated JSON)", { finishReason });
    }
    throw new GeminiApiError("Model returned malformed JSON");
  }
  return sanitizeSections(parsed?.sections, { maxSections, maxPoints });
}
