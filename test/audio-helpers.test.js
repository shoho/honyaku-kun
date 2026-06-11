import { describe, it, expect } from "vitest";
import { abToBase64 } from "../js/audio.js";

function expected(bytes) {
  return Buffer.from(bytes).toString("base64");
}

describe("abToBase64", () => {
  it("空バッファ", () => {
    expect(abToBase64(new ArrayBuffer(0))).toBe("");
  });

  it("小さなバッファ", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
    expect(abToBase64(bytes.buffer)).toBe(expected(bytes));
  });

  it("チャンク境界（32768バイト）をまたぐ大きなバッファ", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    expect(abToBase64(bytes.buffer)).toBe(expected(bytes));
  });

  it("実際の音声チャンクサイズ（3200バイト=100ms PCM）", () => {
    const bytes = new Uint8Array(3200);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) % 256;
    expect(abToBase64(bytes.buffer)).toBe(expected(bytes));
  });
});
