// ポータブル版の配布物を作る（GitHub Actions で実行）：
//   out/CWCatalog.exe            … アプリ本体
//   out/cw-catalog.html          … HTML版
//   out/はじめに.txt              … 起動・更新・アンインストールのしかた
//   out/THIRD-PARTY-NOTICES.txt  … 部品の許諾文（scripts/third-party.mjs が dist/ に作ったもの）
//   release/CWCatalog-v○-portable.zip … 上の4つをまとめたもの
//   release/latest-portable.json … 「更新を確認」が見に行く情報（署名があるときだけ）
// 使い方：node scripts/make-portable.mjs [--release]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { parseChangelog } from '../src/core/changelog.js';
import { join } from 'node:path';
import { writeZip } from '../src/core/zip.js';

const release = process.argv.includes('--release');
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const repo = process.env.GITHUB_REPOSITORY || 'seihayukimi-oss/cw-catalog-tool';
// リリースの「Run workflow」で動かしたときは、release.yml が決めた TAG（v0.4.5 など）を使う（GITHUB_REF_NAME は main になるため）
const tag = process.env.TAG || process.env.GITHUB_REF_NAME || `v${version}`;
if (release && tag !== `v${version}`) throw new Error(`タグ ${tag} と package.json の版 ${version} が一致しません`);

// tauri build（bundle なし）でできた exe
const dir = 'src-tauri/target/release';
const exeName = ['CWCatalog.exe', 'cw-catalog.exe'].find((n) => existsSync(join(dir, n)))
  || readdirSync(dir).find((n) => /\.exe$/i.test(n));
if (!exeName) throw new Error('アプリの exe が見つかりません');

const sig = existsSync('out/CWCatalog.exe.sig') ? readFileSync('out/CWCatalog.exe.sig', 'utf8') : null;
rmSync('out', { recursive: true, force: true });
mkdirSync('out', { recursive: true });
copyFileSync(join(dir, exeName), 'out/CWCatalog.exe');
if (sig) writeFileSync('out/CWCatalog.exe.sig', sig);
copyFileSync('dist/web/cw-catalog.html', 'out/cw-catalog.html');
// メモ帳などで文字化けしないよう、BOM付きのUTF-8・改行はCRLF
const guide = readFileSync('package/はじめに.txt', 'utf8').replace(/\r?\n/g, '\r\n');
writeFileSync('out/はじめに.txt', '﻿' + guide);
// 部品の許諾文（scripts/third-party.mjs が作る）。リリースでは必ず入れる
const notices = 'dist/THIRD-PARTY-NOTICES.txt';
if (existsSync(notices)) writeFileSync('out/THIRD-PARTY-NOTICES.txt', '﻿' + readFileSync(notices, 'utf8').replace(/\r?\n/g, '\r\n'));
else if (release) throw new Error('部品の許諾文（dist/THIRD-PARTY-NOTICES.txt）がありません。先に node scripts/third-party.mjs を動かしてください');
console.log(`out/: CWCatalog.exe（${exeName} から）・cw-catalog.html・はじめに.txt${existsSync(notices) ? '・THIRD-PARTY-NOTICES.txt' : ''}`);

if (process.argv.includes('--pack')) {
  rmSync('release', { recursive: true, force: true });
  mkdirSync('release', { recursive: true });
  const folder = `CWCatalog-v${version}`;
  const files = ['CWCatalog.exe', 'cw-catalog.html', 'はじめに.txt', 'THIRD-PARTY-NOTICES.txt'].filter((n) => existsSync(join('out', n))).map((n) => ({ path: `${folder}/${n}`, data: new Uint8Array(readFileSync(join('out', n))) }));
  writeFileSync(`release/CWCatalog-v${version}-portable.zip`, writeZip(files));
  copyFileSync('out/CWCatalog.exe', 'release/CWCatalog.exe');
  copyFileSync('dist/web/cw-catalog.html', `release/cw-catalog-v${version}.html`);
  if (release) {
    if (!sig) throw new Error('署名（out/CWCatalog.exe.sig）がありません。TAURI_SIGNING_PRIVATE_KEY を設定してください');
    const notesFile = process.env.RELEASE_NOTES_FILE;
    const latest = {
      version,
      notes: notesFile && existsSync(notesFile) ? readFileSync(notesFile, 'utf8') : changelogNotes(version),
      pub_date: new Date().toISOString(),
      url: `https://github.com/${repo}/releases/download/${tag}/CWCatalog.exe`,
      signature: sig.trim(),
    };
    writeFileSync('release/latest-portable.json', JSON.stringify(latest, null, 2));
  }
  console.log(`release/: ${readdirSync('release').join('・')}`);
}

/** 更新の画面に出す「変わったところ」：CHANGELOG.md のその版の要点 */
function changelogNotes(version) {
  try {
    const e = parseChangelog(readFileSync('CHANGELOG.md', 'utf8')).find((x) => x.version === version);
    if (e?.points.length) return e.points.map((p) => `・${p}`).join('\n');
  } catch { /* なければ下へ */ }
  return `CWカタログ ${version}`;
}
