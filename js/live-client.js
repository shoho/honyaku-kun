// Gemini 3.5 Live Translate クライアント。
//
// 接続経路: ユーザーが入力した API キーで Google の Live API（BidiGenerateContent）へ
// WebSocket 直結する。ブラウザの WebSocket はカスタムヘッダーを付けられないため、
// キーは `?key=` クエリで渡す（Google 公式のクライアント直結パターン。
// 接続先は Google のエンドポイントのみで、他のサーバーを経由しない）。
//
// setup は live-translate の公式仕様に従う:
//   - 翻訳先は generationConfig.translationConfig.targetLanguageCode（BCP-47）
//   - ソース言語は自動検出（指定フィールド自体が存在しない）
//   - systemInstruction / realtimeInputConfig は非対応のため送らない
//   - responseModalities は AUDIO のみ対応。翻訳テキストは outputTranscription で受ける
//
// 長時間セッション対策: sessionResumptionUpdate のハンドルを保持し、
// 異常切断時はハンドル付きで自動再接続する。
// 一度も setup が通っていない接続が落ちた場合はキー不正の可能性が高いので
// 再接続せず即エラーにする。

const LIVE_API_VERSION = "v1alpha";
const MAX_RECONNECT_ATTEMPTS = 5;

export class LiveClient {
  constructor({ apiKey, model, targetCode, onOriginal, onTranslation, onStatus, onError }) {
    this.apiKey = apiKey;
    this.model = model;
    this.targetCode = targetCode; // BCP-47（例: "ja", "en"）
    this.onOriginal = onOriginal;
    this.onTranslation = onTranslation;
    this.onStatus = onStatus;
    this.onError = onError;
    this.ws = null;
    this.ready = false;
    this.everReady = false;     // 一度でも setup が通ったか（キー検証の代わり）
    this.closedByUser = false;
    this.resumeHandle = null;   // sessionResumptionUpdate で更新
    this.reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._decoder = new TextDecoder();
  }

  connect() {
    this.onStatus?.("connecting", this.reconnectAttempts ? "Reconnecting…" : undefined);

    const url =
      `wss://generativelanguage.googleapis.com/ws/` +
      `google.ai.generativelanguage.${LIVE_API_VERSION}.GenerativeService.BidiGenerateContent` +
      `?key=${encodeURIComponent(this.apiKey)}`;

    if (this.closedByUser) return;

    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.onopen = () => this._sendSetup();
    this.ws.onmessage = (e) => this._onMessage(e);
    this.ws.onerror = () => {}; // 詳細は close イベント側で扱う
    this.ws.onclose = (e) => this._onClose(e);
  }

  _onClose(e) {
    this.ready = false;
    if (this.closedByUser || e.code === 1000) {
      this.onStatus?.("idle");
      return;
    }
    // 一度も接続が成立していない → キー不正・モデル名不正の可能性が高い。
    // 再接続でリカバーできないので即エラーにする。
    if (!this.everReady) {
      this.onError?.(new Error("Connection failed — check your Gemini API key"));
      this.onStatus?.("idle");
      return;
    }
    // 異常切断 → 指数バックオフで自動再接続（セッション再開ハンドル付き）
    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = 500 * 2 ** this.reconnectAttempts;
      this.reconnectAttempts++;
      this.onStatus?.("connecting", `Reconnecting… (${this.reconnectAttempts})`);
      this._reconnectTimer = setTimeout(() => this.connect(), delay);
    } else {
      this.onError?.(new Error(`Connection lost (code ${e.code})`));
      this.onStatus?.("idle");
    }
  }

  _sendSetup() {
    const setup = {
      setup: {
        ...(this.model ? { model: `models/${this.model}` } : {}),
        generationConfig: {
          responseModalities: ["AUDIO"],
          translationConfig: {
            targetLanguageCode: this.targetCode,
            // 翻訳先と同じ言語の発話もそのまま流す（言語が混在する話でも欠落しない）
            echoTargetLanguage: true,
          },
        },
        // 文字起こしは setup 直下（generationConfig 内に置くと API に拒否される）
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // 再開ハンドルがあれば前回セッションの文脈を引き継ぐ
        sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {},
      },
    };
    this.ws.send(JSON.stringify(setup));
  }

  sendAudio(base64pcm) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: base64pcm }],
        },
      })
    );
  }

  _onMessage(e) {
    // binaryType="arraybuffer" のため data は string か ArrayBuffer のどちらか
    const text =
      typeof e.data === "string" ? e.data : this._decoder.decode(e.data);

    let msg;
    try { msg = JSON.parse(text); } catch { return; }

    if (msg.setupComplete) {
      this.ready = true;
      this.everReady = true;
      this.reconnectAttempts = 0;
      this.onStatus?.("live");
      return;
    }

    if (msg.sessionResumptionUpdate?.resumable && msg.sessionResumptionUpdate.newHandle) {
      this.resumeHandle = msg.sessionResumptionUpdate.newHandle;
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.onOriginal?.(sc.inputTranscription.text);
    }
    // 翻訳テキストは outputTranscription で届く（modelTurn は翻訳音声で、未使用）
    if (sc.outputTranscription?.text) {
      this.onTranslation?.(sc.outputTranscription.text);
    }
  }

  close() {
    this.closedByUser = true;
    this.ready = false;
    clearTimeout(this._reconnectTimer);
    try { this.ws?.close(1000); } catch {}
    this.ws = null;
  }
}
