# 翻訳くん — Real-time interpretation & live minutes

スピーチ・動画音声をリアルタイム同時通訳し、ライブ議事録を育てる 3 カラム Web アプリ。

- 依存ゼロ・ビルド無し・サーバー無し（vanilla HTML/CSS/JS、ESM）。静的ホスティングに置くだけで動く
- Gemini API キーは **UI から入力**し、ブラウザの localStorage にのみ保存
- ブラウザから **Google の Gemini API を直接呼ぶ**（翻訳: Live API WebSocket 直結、議事録: REST）。他のサーバーは一切経由しない
- 翻訳は `gemini-3.5-live-translate-preview`（Live API / BidiGenerateContent）、議事録は `gemini-3.5-flash`（structured output）

## 使い方

1. [Google AI Studio](https://aistudio.google.com/apikey) で Gemini API キーを取得
2. 静的サーバーで配信して開く（ES Modules のため `file://` 直開きでは動きません）

   ```sh
   python3 -m http.server 8000
   # → http://localhost:8000
   ```

3. ヘッダーの **Gemini API Key** 欄にキーを貼り付け（次回以降は自動復元）
4. 音声ソース（マイク / タブ音声）と翻訳先言語を選んで **Start**

GitHub Pages・Netlify・S3 など任意の静的ホスティングにそのまま置けます（サブパス配信対応済み）。

## セキュリティ上の注意

- API キーは `localStorage` に平文で保存されます。**共有マシンでは使わない**でください
- キーの送信先は `generativelanguage.googleapis.com`（Google）のみです
- 公開 URL に置く場合も、キーは各ユーザーが自分のものを入力する設計です（ページ側にキーは含まれません）
- キーには [AI Studio 側で制限](https://cloud.google.com/docs/authentication/api-keys#securing)（HTTP リファラ制限・API 制限）を掛けることを推奨します

## 構成

```
index.html        — 3 カラム UI + API キー入力
styles.css        — デザイントークンは :root に集約
js/
  app.js          — UI 配線・状態・描画・API キー管理
  live-client.js  — Live API（BidiGenerateContent）へ WebSocket 直結
  audio.js        — マイク / タブ音声 → 16kHz/16bit PCM mono → base64
  pcm-worklet.js  — AudioWorklet（リサンプリング + PCM 化）
  summarizer.js   — 議事録スケジューラ（約60秒ごとに全文再生成）
  gemini.js       — Gemini REST 呼び出し（要約・最終版議事録のプロンプトとスキーマ）
```

ブラウザの WebSocket はカスタムヘッダーを付けられないため、Live API への接続のみ `?key=` クエリでキーを渡します（Google 公式のクライアント直結パターン）。REST はキーを `x-goog-api-key` ヘッダーで送ります。

## License

MIT
