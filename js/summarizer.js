// 同時訳（画面②）を定期的にまとめ、構造化された箇条書きの要約（画面③）を
// 育てていく。
//
// 設計:
// - 約1分ごとに「現在の要約全体 + 新しく話された分」をモデルに渡し、
//   更新された要約全体を受け取って差し替える（全文再生成方式）。
//   トピックの統合・再編成が可能で、1回の失敗も次回の更新で自己修復される。
// - 呼び出しは低頻度なので、速度より正確性の高いモデルを使う（gemini.js の SUMMARY_MODEL）。
// - 最初の要約だけは1分待たず、内容が溜まり次第早めに出す。
// - 失敗時は消費分を戻して次回に再試行。

import { updateMinutes } from "./gemini.js";

const CHECK_INTERVAL_MS = 10000;     // 発火条件の確認周期
const UPDATE_INTERVAL_MS = 60000;    // 通常の更新間隔
const FIRST_UPDATE_MIN_CHARS = 120;  // 初回だけ、この量が溜まったら早めに要約
const PENDING_MAX_CHARS = 24000;
const SOURCE_MAX_CHARS = 24000;

export class Summarizer {
  constructor({ apiKey, targetName, onSummary, onError }) {
    this.apiKey = apiKey;
    this.targetName = targetName;
    this.onSummary = onSummary; // (sections: [{topic, points[]}]) を受け取る
    this.onError = onError;
    this.pending = "";        // 前回の要約以降に届いた翻訳
    this.pendingSource = "";  // 同・原文（誤訳に引きずられないための参照）
    this.sections = [];       // 現在の要約
    this.lastUpdate = 0;      // 最後に要約した時刻（0 = 未実施）
    this.timer = null;
    this.busy = false;
  }

  feed(text) {
    this.pending = (this.pending + text).slice(-PENDING_MAX_CHARS);
  }

  feedSource(text) {
    this.pendingSource = (this.pendingSource + text).slice(-SOURCE_MAX_CHARS);
  }

  start() {
    if (!this.timer) {
      this.timer = setInterval(() => this._maybeUpdate(), CHECK_INTERVAL_MS);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // セッション停止時の最終更新。実行中の処理を待ってから残りを反映する。
  async flush() {
    while (this.busy) await new Promise((r) => setTimeout(r, 50));
    if (this.pending.trim()) await this._update();
  }

  _maybeUpdate() {
    if (this.busy || !this.pending.trim()) return;
    // 初回（lastUpdate=0）は経過時間でなく「量」で判断する。
    // Date.now() - 0 は常に巨大なので、時間条件に含めると数文字で発火してしまう
    if (this.lastUpdate === 0) {
      if (this.pending.length >= FIRST_UPDATE_MIN_CHARS) this._update();
      return;
    }
    if (Date.now() - this.lastUpdate >= UPDATE_INTERVAL_MS) this._update();
  }

  async _update() {
    const consumed = this.pending;
    const consumedSource = this.pendingSource;
    this.pending = "";
    this.pendingSource = "";

    this.busy = true;
    try {
      const sections = await updateMinutes({
        apiKey: this.apiKey,
        targetName: this.targetName,
        sections: this.sections,
        transcript: consumed.trim(),
        source: consumedSource.trim(),
      });
      if (Array.isArray(sections) && sections.length > 0) {
        this.sections = sections;
        this.onSummary?.(sections);
      }
      this.lastUpdate = Date.now();
    } catch (err) {
      // 消費した分を戻して次回に再試行
      this.pending = (consumed + this.pending).slice(-PENDING_MAX_CHARS);
      this.pendingSource = (consumedSource + this.pendingSource).slice(-SOURCE_MAX_CHARS);
      this.onError?.(err);
    } finally {
      this.busy = false;
    }
  }
}
