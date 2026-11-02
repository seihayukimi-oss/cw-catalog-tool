// 画面の文の一覧を作る（ゆきみんさんに文の直しをお願いするとき用）。リポジトリのいちばん上で：node scripts/strings/listall.mjs 出力先.txt
import { readFileSync, writeFileSync } from 'node:fs';
import { extract } from './strings.mjs';
const ver = JSON.parse(readFileSync('package.json', 'utf8')).version;
const GROUPS = [
  ['共通：画面の枠・タブ・自分のフォルダ一覧・設定', ['src/app/app.js', 'src/app/state.js', 'src/app/ui.js', 'src/app/credits.js']],
  ['「シナリオ・素材・スキンをDLする」タブ：開いたファイル・インストール', ['src/app/add.js', 'src/app/localfiles.js', 'src/app/catpick.js']],
  ['URLから取得・同意ページ・DLキー・アプリ内ブラウザ・作者さん向けリンク', ['src/app/download.js']],
  ['一括ダウンロード', ['src/app/batch.js']],
  ['素材・スキン（置き場所・インストール・一覧）', ['src/app/materials.js', 'src/app/place.js']],
  ['カタログ（一覧・作品カード・管理・登録・書き出し）', ['src/app/catalog-view.js', 'src/app/catalog-data.js', 'src/app/sample-catalog.js']],
  ['安全（実行ファイルの警告・中身の一覧・中身を見る・安全のしくみ）', ['src/app/safety-view.js', 'src/app/linkcheck.js']],
  ['シナリオラベル（R18・R15・注意ラベル）', ['src/app/ratings-view.js']],
  ['タグ', ['src/app/tags.js']],
  ['整理・二重チェック', ['src/app/tidy.js']],
  ['バックアップ先', ['src/app/backup.js']],
  ['更新履歴', ['src/app/changelog-view.js']],
  ['【アプリ版だけ】アプリの更新・ポータブル版・Windows設定との連携・アプリ内ブラウザ', ['src/app/appshell.js', 'src/platform/tauri.js']],
  ['【HTML版だけ】ブラウザでの動作', ['src/platform/browser.js']],
  ['内部の処理から出るメッセージ（エラー・注意など。トーストや注意欄に出ます）', ['src/core/zip.js', 'src/core/sevenzip.js', 'src/core/cab.js', 'src/core/lzh.js', 'src/core/lzma.js', 'src/core/archive.js', 'src/core/install.js', 'src/core/peek.js', 'src/core/safety.js', 'src/core/urls.js', 'src/core/catalog.js', 'src/core/catalogs.js', 'src/core/scan.js', 'src/core/summary.js', 'src/core/fs.js', 'src/core/weblink.js', 'src/core/scenario.js', 'src/core/ratings.js', 'src/app/store.js']],
  ['【アプリ版だけ】アプリの内部（Rust）から出るメッセージ・アプリ内ブラウザの窓の題名', ['src-tauri/src/main.rs', 'src-tauri/src/net.rs', 'src-tauri/src/update.rs', 'src-tauri/src/folders.rs', 'src-tauri/src/downloads.rs', 'src-tauri/src/portable.rs', 'src-tauri/src/winint.rs']],
];
const JP = /[\u3040-\u30ff\u3400-\u9fff\uff01-\uff60]/;
/** Rust：コメントでない行の "…" を取り出す */
function extractRust(src) {
  const out = [];
  src = src.split('#[cfg(test)]')[0]; // 試験用の文は除く
  src.split('\n').forEach((l, i) => {
    if (/^\s*\/\//.test(l)) return;
    for (const m of l.matchAll(/"((?:[^"\\]|\\.)*)"/g)) if (JP.test(m[1])) out.push({ line: i + 1, text: m[1].replace(/\{[^}]*\}/g, '〔…〕') });
  });
  return out;
}
const lines = [];
lines.push(`CWカタログ ${ver}　画面に出る文の一覧（HTML版・アプリ版）`);
lines.push('='.repeat(40));
lines.push('');
lines.push('・ボタン・見出し・説明・お知らせ（トースト）・確認の画面・マウスを乗せたときの説明・エラーなど、');
lines.push('  プログラムの中に書いてある日本語の文を、画面（機能）ごとに並べました。');
lines.push('・行の頭の「ファイル名:数字」は、プログラムの中の場所です。直したい文は、この番号ごと書き換えて送ってもらえれば、');
lines.push('  そのとおりに直します（番号はそのままにしてください）。');
lines.push('・〔 〕の中は、実際には作品名・件数などが入るところです。');
lines.push('・同じ画面の中でも、アプリ版だけ・HTML版だけで出る文が混ざっています（【アプリ版だけ】【HTML版だけ】の章は、その版だけで使うものです）。');
lines.push('・はじめに.txt・更新履歴（CHANGELOG.md）・README は、それぞれのファイルをご覧ください。');
lines.push('');
let total = 0;
for (const [title, files] of GROUPS) {
  lines.push('');
  lines.push(`■ ${title}`);
  lines.push('-'.repeat(40));
  for (const f of files) {
    const seen = new Set();
    const items = (f.endsWith('.rs') ? extractRust : extract)(readFileSync(f, 'utf8')).filter((s) => { const k = s.text; if (k.trim().length < 2 || /\\[sdwb]|\(\?[:=!]/.test(k)) return false; if (seen.has(k)) return false; seen.add(k); return true; });
    if (!items.length) continue;
    lines.push(`［${f.replace(/^src\//, '')}］`);
    for (const s of items) { lines.push(`${f.split('/').pop()}:${s.line}　${s.text.replace(/\n/g, '⏎')}`); total++; }
    lines.push('');
  }
}
lines.splice(3, 0, `（全部で ${total} 件）`);
writeFileSync(process.argv[2], lines.join('\r\n') + '\r\n', 'utf8');
console.log(total);
