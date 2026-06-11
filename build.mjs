// 単一ファイル版（dist/index.html）を生成する。
// 社内ポータル等が sandbox iframe / CSP sandbox で配信して origin が null になると、
// ES モジュール（type="module"）の読み込みは CORS で弾かれる。インラインの classic
// script は CORS の対象外なので、JS/CSS/ワークレットをすべて 1 ファイルに埋め込む。
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const worklet = await readFile("js/pcm-worklet.js", "utf8");
// 空のまま埋め込むと audio.js の分岐が相対 URL 側へ落ち、単一ファイル版では
// import.meta.url が undefined のため実行時のわかりにくい TypeError になる
if (!worklet.trim()) throw new Error("js/pcm-worklet.js が空です（ビルド中断）");

const result = await build({
  entryPoints: ["js/app.js"],
  bundle: true,
  format: "iife",
  write: false,
  // audio.js はこの値があると相対 URL ではなく埋め込みソースから worklet を読む。
  // グローバル変数の実行時注入ではなく、参照箇所をビルド時に文字列定数へ置換する
  define: { "globalThis.__PCM_WORKLET_SOURCE__": JSON.stringify(worklet) },
  // 単一ファイル版では import.meta.url の分岐（相対 URL 読み込み）に入らない
  logOverride: { "empty-import-meta": "silent" },
});

// インライン化したとき HTML パーサが閉じタグを誤認しないようにエスケープ
// （JS/CSS とも文字列・コメント内の \/ は / と解釈されるので表示は変わらない）
const escapeCloseTag = (text, tag) => text.replace(new RegExp(`</${tag}`, "gi"), `<\\/${tag}`);
const js = escapeCloseTag(result.outputFiles[0].text, "script");
const css = escapeCloseTag(await readFile("styles.css", "utf8"), "style");

let html = await readFile("index.html", "utf8");
const replaceOnce = (source, target, replacement) => {
  if (!source.includes(target)) throw new Error(`index.html に ${target} が見つかりません`);
  return source.replace(target, () => replacement);
};
html = replaceOnce(html, '<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}</style>`);
html = replaceOnce(
  html,
  '<script type="module" src="./js/app.js"></script>',
  `<script>\n${js}</script>`
);

// Google Fonts の stylesheet もビルド時に取り込み、外部 CSS 依存を 1 つ減らす。
// フォントファイルは fonts.gstatic.com 参照のまま（ACAO: * のため origin null でも取得可）。
// 取得失敗時（オフラインビルド等）は <link> を残し、実行時のフォールバックに任せる
const fontLink = html.match(/<link[^>]*href="(https:\/\/fonts\.googleapis\.com\/css2[^"]*)"[^>]*\/>/);
if (fontLink) {
  try {
    const res = await fetch(fontLink[1].replaceAll("&amp;", "&"), {
      // woff2 の @font-face を返してもらうためモダンブラウザの UA を名乗る
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = replaceOnce(html, fontLink[0], `<style>\n${escapeCloseTag(await res.text(), "style")}</style>`);
  } catch (err) {
    console.warn(`Google Fonts の CSS を取得できないため <link> を残します: ${err.message}`);
  }
}

await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", html);
console.log(`dist/index.html (${(html.length / 1024).toFixed(1)} KB) を生成しました`);
