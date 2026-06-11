// AudioWorkletProcessor: マイクの Float32 音声を 16kHz / 16bit PCM (mono) に変換し、
// ~100ms ごとにまとめてメインスレッドへ ArrayBuffer を転送する。
// Gemini Live API は "audio/pcm;rate=16000" を期待するため、ここで整形する。

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms @16kHz

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(CHUNK_SAMPLES);
    this._fill = 0;
    // 線形間引きダウンサンプリング用（sampleRate は worklet グローバルで一定）
    this._ratio = sampleRate / TARGET_RATE;
    this._pos = 0; // ブロックをまたぐ小数位置の持ち越し
  }

  _push(sample) {
    // -1..1 の Float を 16bit PCM へ
    let s = Math.max(-1, Math.min(1, sample));
    this._buf[this._fill++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    if (this._fill >= CHUNK_SAMPLES) {
      const out = this._buf.buffer.slice(0);
      this.port.postMessage(out, [out]);
      this._fill = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0]?.[0]; // mono（複数chでも先頭のみ使用）
    if (!ch) return true;

    let pos = this._pos;
    while (pos < ch.length) {
      this._push(ch[Math.floor(pos)]);
      pos += this._ratio;
    }
    this._pos = pos - ch.length;
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
