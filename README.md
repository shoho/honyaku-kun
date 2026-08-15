# 翻訳くん / 議事録くん — Real-time interpretation & minutes

スピーチ・動画音声をリアルタイム処理する 2 モードの Web アプリ。タブで切り替える。

- **翻訳くん** — リアルタイム同時通訳＋ライブ議事録（3 カラム）。翻訳モデルを選択できる:
  - `gemini-3.5-live-translate-preview`（既定）: 翻訳専用モデル。低遅延の逐語訳だが、フィラー（um, ah 等）まで律儀に訳す。API 仕様上、使われない翻訳音声の生成コストが掛かる
  - `gemini-3.1-flash-live-preview` (text): 通常 Live モデル＋プロンプト翻訳。フィラーを除いた読みやすい訳文がテキストで届き、音声生成コストが無い。訳は発話の切れ目ごとにまとまって出る
- **議事録くん** — 翻訳せず、元の言語のままリアルタイム書き起こし＋ライブ議事録（2 カラム）。議事録も話された言語で書く。応答を抑制した `gemini-3.1-flash-live-preview` の入力書き起こしだけを使うため、翻訳 API のコストが掛からない
- 依存ゼロ・ビルド無し・サーバー無し（vanilla HTML/CSS/JS、ESM）。静的ホスティングに置くだけで動く（sandbox 配信向けの単一ファイルビルドも用意、後述）
- Gemini API キーは **UI から入力**し、ブラウザの localStorage にのみ保存
- ブラウザから **Google の Gemini API を直接呼ぶ**（翻訳・書き起こし: Live API WebSocket 直結、議事録: REST）。他のサーバーは一切経由しない
- 議事録の生成は `gemini-flash-latest`（structured output。最新 Flash を指すエイリアスで、2026-05-19 時点の実体は `gemini-3.5-flash`）

## 使い方

1. [Google AI Studio](https://aistudio.google.com/apikey) で Gemini API キーを取得
2. 静的サーバーで配信して開く（ES Modules のため `file://` 直開きでは動きません）

   ```sh
   python3 -m http.server 8000
   # → http://localhost:8000
   ```

3. ヘッダーの **Gemini API Key** 欄にキーを貼り付け（次回以降は自動復元）
4. タブで **翻訳くん / 議事録くん** を選び、音声ソース（マイク / タブ音声）と、翻訳くんの場合は翻訳先言語を選んで **Start**

GitHub Pages・Netlify・S3 など任意の静的ホスティングにそのまま置けます（サブパス配信対応済み）。

## 単一ファイルビルド（sandbox 配信向け）

社内ポータル等が sandbox iframe / CSP sandbox（origin が null になる環境）で配信すると、ES モジュールの読み込みが CORS で弾かれて動きません。その場合は JS / CSS / AudioWorklet / フォント CSS をすべて 1 ファイルに埋め込んだ単一ファイル版を使ってください:

```sh
npm install
npm run build   # → dist/index.html（この 1 ファイルだけ配布すれば動く）
```

通常の静的ホスティングではビルド不要です。フォントファイル（fonts.gstatic.com）のみ外部参照が残るため、外部通信を完全に遮断する環境ではシステムフォントにフォールバックします。

## セキュリティ上の注意

- API キーは `localStorage` に平文で保存されます。**共有マシンでは使わない**でください
- キーの送信先は `generativelanguage.googleapis.com`（Google）のみです
- 公開 URL に置く場合も、キーは各ユーザーが自分のものを入力する設計です（ページ側にキーは含まれません）
- キーには [AI Studio 側で制限](https://cloud.google.com/docs/authentication/api-keys#securing)（Generative Language API のみに絞る API 制限）を掛けることを推奨します。HTTP リファラ制限は、ブラウザの WebSocket ハンドシェイクが Referer を送らない場合に Live 接続だけ弾かれることがあるため、掛ける場合は動作確認をしてください

## 構成

```
index.html        — タブ + カラム UI + API キー入力
styles.css        — デザイントークンは :root に集約
build.mjs         — 単一ファイル版（dist/index.html）の生成スクリプト（esbuild）
js/
  app.js          — UI 配線・タブ / モード状態・描画・API キー管理
  live-client.js  — Live API（BidiGenerateContent）へ WebSocket 直結。
                    translate（翻訳専用モデル）/ translate-text（通常モデルで翻訳）/
                    transcribe（書き起こしのみ・応答抑制）の 3 モード
  audio.js        — マイク / タブ音声 → 16kHz/16bit PCM mono → base64
  pcm-worklet.js  — AudioWorklet（リサンプリング + PCM 化）
  summarizer.js   — 議事録スケジューラ（約60秒ごとに全文再生成）
  gemini.js       — Gemini REST 呼び出し（要約・最終版議事録のプロンプトとスキーマ）
```

ブラウザの WebSocket はカスタムヘッダーを付けられないため、Live API への接続のみ `?key=` クエリでキーを渡します（Google 公式のクライアント直結パターン）。REST はキーを `x-goog-api-key` ヘッダーで送ります。

## 開発

ランタイム依存はゼロですが、テストに Vitest、単一ファイルビルドに esbuild を使います:

```sh
npm install
npm test        # 単体テスト（実ネットワークなし）
npm run dev     # http://localhost:8000
npm run build   # 単一ファイル版を dist/index.html に生成
```

## License

MIT
