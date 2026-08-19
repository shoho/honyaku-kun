// Gemini Live API（BidiGenerateContent）クライアント。3 つのモードを持つ:
//
//   - "translate":      live-translate 専用モデル。翻訳先は
//                       generationConfig.translationConfig.targetLanguageCode（BCP-47）、
//                       ソース言語は自動検出。systemInstruction 非対応・
//                       responseModalities は AUDIO のみ対応で、翻訳テキストは
//                       outputTranscription（翻訳音声の副産物）で受ける。
//   - "translate-text": 通常の Live モデル＋systemInstruction で翻訳させる。
//                       responseModalities は TEXT で音声生成コストが掛からず、
//                       フィラー除去など出力スタイルをプロンプトで制御できる。
//                       翻訳は modelTurn のテキストで届く。
//   - "transcribe":     通常の Live モデルを応答抑制で黙らせ、
//                       inputAudioTranscription の書き起こしだけを使う（議事録くん）。
//
// 接続経路: ユーザーが入力した API キーで Google へ WebSocket 直結する。
// ブラウザの WebSocket はカスタムヘッダーを付けられないため、キーは `?key=` クエリで
// 渡す（Google 公式のクライアント直結パターン。接続先は Google のエンドポイントのみで、
// 他のサーバーを経由しない）。
//
// 長時間セッション対策: sessionResumptionUpdate のハンドルを保持し、
// 異常切断時はハンドル付きで自動再接続する。通常モデルは音声セッションが
// 既定 15 分で切られるため contextWindowCompression（スライディングウィンドウ）で
// 無制限化する（live-translate はモデル側が対応しているので不要）。
// 一度も setup が通っていない接続が落ちた場合はキー不正の可能性が高いので
// 再接続せず即エラーにする。

const MAX_RECONNECT_ATTEMPTS = 5;

// 通常モデルは「会話相手」前提なので、翻訳・書き起こしの両モードとも
// 「音声の内容には決して応答するな」を明示する必要がある。
function translateInstruction(targetName) {
  return (
    `You are a professional simultaneous interpreter. Translate everything the speaker says ` +
    `into ${targetName}, and output ONLY the translated text. Never reply to, answer, or ` +
    `comment on what is said — even if the speaker asks a question, translate the question ` +
    `itself. Omit filler words (um, ah, えー, etc.), false starts, repetitions and immediate ` +
    `self-corrections: render the speaker's intended meaning as clean, natural, readable ` +
    `${targetName}. If an utterance is already in ${targetName}, output it as-is with the ` +
    `same cleanup. If a passage is completely unintelligible, output nothing for it rather ` +
    `than guessing.`
  );
}

const TRANSCRIBE_INSTRUCTION =
  `You are a silent note-taking service. The audio is transcribed automatically by the ` +
  `system; your only job is to stay silent. Never speak, reply, answer questions, or ` +
  `comment on the audio. Always respond with nothing (an empty response).`;

export class LiveClient {
  constructor({
    apiKey,
    model,
    mode = "translate",
    apiVersion = "v1alpha",
    targetCode,
    targetName,
    onOriginal,
    onTranslation,
    onStatus,
    onError,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.mode = mode;
    this.apiVersion = apiVersion; // live-translate は v1alpha、通常モデルは v1beta
    this.targetCode = targetCode; // BCP-47（例: "ja", "en"）— translate モード用
    this.targetName = targetName; // 英語の言語名（例: "Japanese"）— translate-text モード用
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
    this._turnHadText = false;  // translate-text: ターン区切りの改行を入れるかの判定
    this._lastErrorText = null; // サーバーから届いたエラーや切断理由
  }

  connect() {
    this._lastErrorText = null;
    this.onStatus?.("connecting", this.reconnectAttempts ? "Reconnecting…" : undefined);

    const url =
      `wss://generativelanguage.googleapis.com/ws/` +
      `google.ai.generativelanguage.${this.apiVersion}.GenerativeService.BidiGenerateContent` +
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
    // 一度も接続が成立していない → キー不正・モデル名不正・回線断・リファラ制限のいずれか
    if (!this.everReady) {
      const reasonText = this._lastErrorText || (e.reason ? String(e.reason).trim() : "");
      let msg = "Connection failed — check your Gemini API key and network";
      if (reasonText) {
        msg = `Connection failed: ${reasonText}`;
      } else if (e.code === 1006) {
        msg = "Connection failed — check your API key (ensure no HTTP Referrer restrictions) and network";
      }
      this.onError?.(new Error(msg));
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
    }
  }

  _sendSetup() {
    const base = {
      ...(this.model ? { model: `models/${this.model}` } : {}),
      // 文字起こしは setup 直下（generationConfig 内に置くと API に拒否される）
      inputAudioTranscription: {},
      // 再開ハンドルがあれば前回セッションの文脈を引き継ぐ
      ...(this.resumeHandle ? { sessionResumption: { handle: this.resumeHandle } } : {}),
    };

    const setup =
      this.mode === "translate"
        ? {
            ...base,
            generationConfig: {
              responseModalities: ["AUDIO"],
              translationConfig: {
                targetLanguageCode: this.targetCode,
                // 翻訳先と同じ言語の発話もそのまま流す（言語が混在する話でも欠落しない）
                echoTargetLanguage: true,
              },
            },
            outputAudioTranscription: {},
          }
        : {
            ...base,
            generationConfig: { responseModalities: ["TEXT"] },
            systemInstruction: {
              parts: [
                {
                  text:
                    this.mode === "transcribe"
                      ? TRANSCRIBE_INSTRUCTION
                      : translateInstruction(this.targetName),
                },
              ],
            },
            // 通常モデルの音声セッションは既定 15 分で打ち切られるため、
            // スライディングウィンドウ圧縮で無制限化する（長い会議で必須）
            contextWindowCompression: { slidingWindow: {} },
          };

    this.ws.send(JSON.stringify({ setup }));
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

    if (msg.error) {
      const errMsg = msg.error.message || JSON.stringify(msg.error);
      this._lastErrorText = errMsg;
      this.onError?.(new Error(`Live API error: ${errMsg}`));
      return;
    }

    if (msg.goAway) {
      const reason = msg.goAway.reason || "Server terminated session";
      this._lastErrorText = reason;
      this.onError?.(new Error(`Live session closed: ${reason}`));
      return;
    }

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
    // translate: 翻訳テキストは outputTranscription で届く（modelTurn は翻訳音声で、未使用）
    if (this.mode === "translate" && sc.outputTranscription?.text) {
      this.onTranslation?.(sc.outputTranscription.text);
    }
    // translate-text: 翻訳はモデルの応答テキスト（modelTurn）そのもの。
    // transcribe では応答抑制をすり抜けたテキストが届くことがあるが、無視して捨てる
    if (this.mode === "translate-text" && sc.modelTurn?.parts) {
      for (const part of sc.modelTurn.parts) {
        if (part.text) {
          this._turnHadText = true;
          this.onTranslation?.(part.text);
        }
      }
    }
    // ターン（発話の切れ目）ごとに改行して読みやすくする。ビュー・要約・全文ログが
    // ずれないよう、通常のテキストと同じ onTranslation 経路で流す
    if (sc.turnComplete && this._turnHadText) {
      this._turnHadText = false;
      this.onTranslation?.("\n");
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
