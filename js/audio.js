// 音声取得 → AudioContext(16kHz) → AudioWorklet で PCM 化 → コールバックへ base64 PCM を渡す。
// ソースはマイク（getUserMedia）またはタブ／画面の音声（getDisplayMedia）。

export class AudioPipeline {
  constructor({ onChunk, onError, onEnded }) {
    this.onChunk = onChunk;
    this.onError = onError;
    this.onEnded = onEnded; // ユーザーが「共有を停止」した等、ソース側が終了したとき
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
  }

  // mode: "mic" | "display"
  async start(mode = "mic") {
    // 音声ソースの取得と AudioContext/worklet 準備は独立なので並列に。
    // 片方だけ成功した場合（例: worklet ロード失敗）にマイクが掴まれたまま
    // 残らないよう、失敗時は成功した側を後始末してから投げ直す
    const [streamRes, ctxRes] = await Promise.allSettled([
      mode === "display" ? this._getDisplayAudio() : this._getMicAudio(),
      this._initContext(),
    ]);
    if (streamRes.status === "rejected" || ctxRes.status === "rejected") {
      if (streamRes.status === "fulfilled") {
        streamRes.value.getTracks().forEach((t) => t.stop());
      }
      await this.stop();
      // app.js はストリーム側のエラー（NotAllowedError 等）で文言を出し分けるため優先
      throw streamRes.status === "rejected" ? streamRes.reason : ctxRes.reason;
    }
    this.stream = streamRes.value;

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-processor");
    this.node.port.onmessage = (e) => {
      try {
        this.onChunk(abToBase64(e.data));
      } catch (err) {
        this.onError?.(err);
      }
    };
    this.source.connect(this.node);
    // 出力にはつながない（再生不要）。一部ブラウザ対策で無音destinationへ。
    this.node.connect(this.ctx.destination);
  }

  _getMicAudio() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  async _getDisplayAudio() {
    // タブ／画面共有から音声を取る。video:true は共有ピッカーの表示に必須。
    // macOS の Chrome ではタブ共有のみ音声が取れる（「タブの音声も共有」をオン）。
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        // 動画音声は加工せずそのまま認識へ
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    const audio = stream.getAudioTracks()[0];
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("NO_AUDIO_TRACK");
    }
    // 映像は使わないので即停止（音声トラックは独立して生き続ける）
    stream.getVideoTracks().forEach((t) => t.stop());
    // Chrome の「共有を停止」バーで止められたらセッション終了を通知
    audio.addEventListener("ended", () => this.onEnded?.());
    return stream;
  }

  async _initContext() {
    // 可能なら 16kHz でコンテキストを作る（ブラウザが拒否したら既定rate＋worklet側でダウンサンプル）
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
    } catch {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    // サブパス配信（GitHub Pages 等）でも解決できるよう相対 URL で読み込む
    await this.ctx.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url));
  }

  async stop() {
    try { this.node?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.node = this.source = this.stream = this.ctx = null;
  }
}

export function abToBase64(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.toBase64) return bytes.toBase64(); // Baseline 2025 の組み込み
  // フォールバック: 古いブラウザ向けチャンク変換
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}
