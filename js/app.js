import { AudioPipeline } from "./audio.js";
import { LiveClient } from "./live-client.js";
import { Summarizer } from "./summarizer.js";
import { finalizeMinutes } from "./gemini.js";

// 選択可能な Live モデル（不正な値は Google 側でエラーになるだけ）
const LIVE_MODELS = [
  { id: "gemini-3.5-live-translate-preview", label: "Gemini 3.5 Live Translate" },
];

// 翻訳先言語の単一情報源（ソース言語はモデルが自動検出するため指定不要）。
// code は translationConfig.targetLanguageCode に渡す BCP-47、name は要約プロンプト用。
const LANGS = [
  { code: "ja", label: "日本語", name: "Japanese" },
  { code: "en", label: "English", name: "English" },
  { code: "zh", label: "中文（简体）", name: "Chinese (Simplified)" },
  { code: "ko", label: "한국어", name: "Korean" },
  { code: "es", label: "Español", name: "Spanish" },
  { code: "fr", label: "Français", name: "French" },
  { code: "de", label: "Deutsch", name: "German" },
  { code: "pt", label: "Português", name: "Portuguese" },
  { code: "it", label: "Italiano", name: "Italian" },
  { code: "id", label: "Bahasa Indonesia", name: "Indonesian" },
  { code: "hi", label: "हिन्दी", name: "Hindi" },
  { code: "vi", label: "Tiếng Việt", name: "Vietnamese" },
  { code: "th", label: "ไทย", name: "Thai" },
  { code: "ru", label: "Русский", name: "Russian" },
];
const LANG_NAMES = Object.fromEntries(LANGS.map((l) => [l.code, l.name]));

const STATUS_TEXT = {
  idle: "Idle",
  connecting: "Connecting…",
  live: "● Live",
  error: "Error",
};

// JS が書き換えるボタンラベルは JS が所有する（HTML側は初期表示のみ）
const FINALIZE_LABEL = "Generate final minutes";
const COPY_LABEL = "Copy";

// API キーはこのブラウザの localStorage にのみ保存し、Google 以外には送らない
const API_KEY_STORAGE = "honyaku-kun.gemini-api-key";

const el = {
  apiKey: document.getElementById("apiKey"),
  liveModel: document.getElementById("liveModel"),
  audioSource: document.getElementById("audioSource"),
  target: document.getElementById("targetLang"),
  copySummary: document.getElementById("copySummary"),
  finalizeBtn: document.getElementById("finalizeBtn"),
  micBtn: document.getElementById("micBtn"),
  micLabel: document.querySelector(".mic-label"),
  status: document.getElementById("status"),
  original: document.getElementById("originalView"),
  translation: document.getElementById("translationView"),
  refined: document.getElementById("refinedView"),
};

const state = {
  running: false,
  audio: null,
  live: null,
  summarizer: null,
  lastSections: [], // コピー用に保持する最新の要約
  wakeLock: null,   // セッション中の画面スリープ防止
  // 最終版議事録の材料となる全文ログ（セッション開始でリセット、停止後も保持）
  fullTranslation: "",
  fullSource: "",
  targetLang: "ja",
  apiKey: "",       // セッション中に入力欄を書き換えられても影響しないよう開始時に固定
};
const FULL_LOG_MAX_CHARS = 200000;

populateLangSelects();
setPlaceholders();
updateStartLabel();
initApiKey();
setStatus("idle"); // 表示文字列の所有権は JS 側に一元化

el.micBtn.addEventListener("click", () => {
  if (state.running) stopSession();
  else startSession();
});

el.audioSource.addEventListener("change", updateStartLabel);

/* ---------- API キー（localStorage に永続化） ---------- */

function initApiKey() {
  try {
    el.apiKey.value = localStorage.getItem(API_KEY_STORAGE) ?? "";
  } catch {}
  el.apiKey.addEventListener("input", () => {
    try {
      localStorage.setItem(API_KEY_STORAGE, el.apiKey.value.trim());
    } catch {}
    el.apiKey.classList.remove("field-input--missing");
  });
}

function currentApiKey() {
  return el.apiKey.value.trim();
}

function startLabel() {
  return el.audioSource.value === "display" ? "Start sharing" : "Start microphone";
}

function updateStartLabel() {
  if (!state.running) el.micLabel.textContent = startLabel();
}

function populateLangSelects() {
  for (const { id, label } of LIVE_MODELS) {
    el.liveModel.add(new Option(label, id));
  }
  for (const { code, label } of LANGS) {
    el.target.add(new Option(label, code));
  }
  el.target.value = "ja";
}

function setStatus(kind, text = STATUS_TEXT[kind] ?? kind) {
  el.status.className = `status status--${kind}`;
  el.status.textContent = text;
}

async function startSession() {
  const apiKey = currentApiKey();
  if (!apiKey) {
    setStatus("error", "Enter your Gemini API key first");
    el.apiKey.classList.add("field-input--missing");
    el.apiKey.focus();
    return;
  }
  state.apiKey = apiKey;

  const targetLang = el.target.value;
  state.targetLang = targetLang;

  clearViews();
  state.lastSections = [];
  state.fullTranslation = "";
  state.fullSource = "";
  el.copySummary.hidden = true;
  el.finalizeBtn.hidden = true;
  el.micBtn.setAttribute("aria-pressed", "true");
  el.micLabel.textContent = "Stop";
  el.target.disabled = el.audioSource.disabled = el.liveModel.disabled = true;
  el.apiKey.disabled = true;

  // ③ 要約スケジューラ（約1分ごとに要約全体を更新 — タイミングは Summarizer が所有）
  state.summarizer = new Summarizer({
    apiKey,
    targetName: LANG_NAMES[targetLang],
    onSummary: (sections) => {
      state.lastSections = sections;
      el.copySummary.hidden = false;
      renderSummary(sections);
      // 要約エラー表示から復帰
      if (state.running && state.live?.ready) setStatus("live");
    },
    onError: (e) => {
      console.warn("[summarize]", e);
      if (state.running) setStatus("error", "Minutes update failed — will retry");
    },
  });

  // ②① Live クライアント（接続ステータスは onStatus 経由で一元管理）
  state.live = new LiveClient({
    apiKey,
    model: el.liveModel.value,
    targetCode: targetLang,
    onStatus: setStatus,
    onOriginal: (t) => {
      appendStream(el.original, t);
      state.summarizer.feedSource(t); // 要約時の誤訳補正の根拠として原文も渡す
      state.fullSource = (state.fullSource + t).slice(-FULL_LOG_MAX_CHARS);
    },
    onTranslation: (t) => {
      appendStream(el.translation, t);
      state.summarizer.feed(t);
      state.fullTranslation = (state.fullTranslation + t).slice(-FULL_LOG_MAX_CHARS);
      el.finalizeBtn.hidden = false;
    },
    onError: (e) => {
      console.error(e);
      setStatus("error", e.message || "Error");
    },
  });
  state.live.connect();

  // 音声（マイク or タブ共有）→ PCM → Live へ
  const mode = el.audioSource.value;
  state.audio = new AudioPipeline({
    onChunk: (b64) => state.live?.sendAudio(b64),
    onError: (e) => {
      console.error(e);
      setStatus("error", "Audio input error");
    },
    // 共有停止バーなどソース側から終了されたら通常停止
    onEnded: () => stopSession(),
  });

  try {
    await state.audio.start(mode);
    state.summarizer.start();
    state.running = true;
    acquireWakeLock(); // プレゼン中に画面スリープで音声が止まるのを防ぐ
  } catch (e) {
    console.error(e);
    setStatus("error", audioStartErrorMessage(e, mode));
    await stopSession();
  }
}

function audioStartErrorMessage(e, mode) {
  if (e.message === "NO_AUDIO_TRACK") {
    return "No audio shared — pick a Chrome tab and enable “Also share tab audio”";
  }
  if (e.name === "NotAllowedError") {
    return mode === "display" ? "Sharing was cancelled" : "Microphone access denied";
  }
  return mode === "display" ? "Could not start sharing" : "Could not start microphone";
}

async function stopSession() {
  state.running = false;
  el.micBtn.setAttribute("aria-pressed", "false");
  el.micLabel.textContent = startLabel();
  el.target.disabled = el.audioSource.disabled = el.liveModel.disabled = false;
  el.apiKey.disabled = false;
  releaseWakeLock();

  try { await state.audio?.stop(); } catch {}
  try { await state.summarizer?.flush(); } catch {}
  state.summarizer?.stop();
  state.live?.close();

  state.audio = state.live = state.summarizer = null;
  setStatus("idle");
}

/* ---------- ビュー更新 ---------- */

function setPlaceholders() {
  el.original.innerHTML = `<span class="placeholder">Recognized speech will appear here once you start.</span>`;
  el.translation.innerHTML = `<span class="placeholder">Live translation streams here.</span>`;
  el.refined.innerHTML = `<span class="placeholder">Topic-organized minutes are compiled here about once a minute.</span>`;
}

function clearViews() {
  el.original.textContent = "";
  el.translation.textContent = "";
  el.refined.textContent = "";
}

// ストリーミングテキストの追記。Text ノードを際限なく増やさないよう末尾に結合する。
function appendStream(node, text) {
  const last = node.lastChild;
  if (last?.nodeType === Node.TEXT_NODE) last.data += text;
  else node.append(text);
  autoscroll(node);
}

// 要約（[{topic, points[]}]）を描画する。全文再生成方式なので毎回差し替え。
// テキストはすべて textContent 経由（XSS安全）。
function renderSummary(sections, { final = false } = {}) {
  el.refined.textContent = "";
  if (final) {
    const badge = document.createElement("span");
    badge.className = "final-badge";
    badge.textContent = "Final minutes";
    el.refined.appendChild(badge);
  }
  for (const { topic, points } of sections) {
    const sec = document.createElement("section");
    sec.className = "sum-section fresh";
    if (topic) {
      const h = document.createElement("h3");
      h.className = "sum-topic";
      h.textContent = topic;
      sec.appendChild(h);
    }
    const ul = document.createElement("ul");
    ul.className = "sum-points";
    for (const point of points) {
      const li = document.createElement("li");
      li.textContent = point;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    el.refined.appendChild(sec);
    setTimeout(() => sec.classList.remove("fresh"), 700);
  }
  autoscroll(el.refined);
}

function autoscroll(node) {
  // ほぼ最下部にいるときだけ自動追従（読み戻し中は邪魔しない）
  const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  if (nearBottom) node.scrollTop = node.scrollHeight;
}

/* ---------- 最終版議事録（二段階要約の第二段） ---------- */

el.finalizeBtn.addEventListener("click", async () => {
  if (!state.fullTranslation.trim()) return;
  const apiKey = state.apiKey || currentApiKey();
  if (!apiKey) {
    setStatus("error", "Enter your Gemini API key first");
    return;
  }
  el.finalizeBtn.disabled = true;
  el.finalizeBtn.textContent = "Generating…";
  try {
    const sections = await finalizeMinutes({
      apiKey,
      targetName: LANG_NAMES[state.targetLang],
      sections: state.lastSections,
      transcript: state.fullTranslation,
      source: state.fullSource,
    });
    if (Array.isArray(sections) && sections.length > 0) {
      state.lastSections = sections;
      renderSummary(sections, { final: true });
      el.copySummary.hidden = false;
      el.finalizeBtn.textContent = "Final ✓";
    } else {
      throw new Error("empty sections");
    }
  } catch (e) {
    console.warn("[finalize]", e);
    el.finalizeBtn.textContent = "Failed — try again";
  } finally {
    el.finalizeBtn.disabled = false;
    setTimeout(() => (el.finalizeBtn.textContent = FINALIZE_LABEL), 2000);
  }
});

/* ---------- 要約のコピー ---------- */

el.copySummary.addEventListener("click", async () => {
  const md = state.lastSections
    .map((s) => `## ${s.topic}\n${s.points.map((p) => `- ${p}`).join("\n")}`)
    .join("\n\n");
  try {
    await navigator.clipboard.writeText(md);
    el.copySummary.textContent = "Copied ✓";
  } catch {
    el.copySummary.textContent = "Copy failed";
  }
  setTimeout(() => (el.copySummary.textContent = COPY_LABEL), 1500);
});

/* ---------- 画面スリープ防止（セッション中のみ） ---------- */

async function acquireWakeLock() {
  try {
    state.wakeLock = await navigator.wakeLock?.request("screen");
  } catch {} // 非対応・省電力モード等では黙って諦める
}

function releaseWakeLock() {
  try { state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

// タブ復帰時に Wake Lock は自動解放されているため取り直す
document.addEventListener("visibilitychange", () => {
  if (state.running && document.visibilityState === "visible") acquireWakeLock();
});

window.addEventListener("beforeunload", () => {
  if (state.running) stopSession();
});
