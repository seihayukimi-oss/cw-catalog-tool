// アプリの自動更新用の latest.json を作る（GitHub Actions のリリース時に実行）。
// アプリは https://github.com/<リポジトリ>/releases/latest/download/latest.json を見に行き、
// ここに書かれた版が今より新しければ、署名を確かめてから更新する。
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.env.GITHUB_REPOSITORY;
const tag = process.env.GITHUB_REF_NAME;
if (!repo || !tag) throw new Error('GITHUB_REPOSITORY と GITHUB_REF_NAME が必要です');

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
if (tag !== `v${version}`) throw new Error(`タグ ${tag} と package.json の版 ${version} が一致しません`);

const dir = 'src-tauri/target/release/bundle/nsis';
const exe = readdirSync(dir).find((f) => f.endsWith('-setup.exe'));
if (!exe) throw new Error('インストーラーが見つかりません');
const signature = readFileSync(join(dir, `${exe}.sig`), 'utf8').trim();

const notesFile = process.env.RELEASE_NOTES_FILE;
const notes = notesFile ? readFileSync(notesFile, 'utf8') : `CWカタログ ${version}`;

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(exe)}`,
    },
  },
};
writeFileSync('latest.json', JSON.stringify(latest, null, 2));
console.log(`latest.json: ${version} → ${exe}`);
