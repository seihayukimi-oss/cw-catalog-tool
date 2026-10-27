// 使っている部品の一覧と、部品の許諾文を作る：
//   docs/みんな向け/使っている部品.md … 部品の名前・版・ライセンスの一覧（リポジトリに入れる）
//   dist/THIRD-PARTY-NOTICES.txt     … 部品の許諾文（配る zip に入れる。make-portable.mjs が使う）
// 対象：アプリに入る部品だけ（npm の dependencies と、その先。Rust は Windows 向けの通常の依存とその先）。
// Rust の部品の許諾文は cargo が取ってきた部品のソースから読むので、先に cargo metadata か cargo build を動かしておく。
// 使い方：リポジトリのいちばん上で node scripts/third-party.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

/** 部品のフォルダにある許諾文のファイルを読む */
function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => LICENSE_FILE.test(n)).sort()
    .map((n) => readFileSync(join(dir, n), 'utf8').replace(/\r\n/g, '\n').trim()).filter(Boolean);
}

// ------------------------------------------------------------ npm
function npmPackages() {
  const out = new Map();
  const walk = (name) => {
    if (out.has(name)) return;
    const dir = join('node_modules', name);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    out.set(name, { name, version: pkg.version, license: pkg.license || '', url: repo.replace(/^git\+/, '').replace(/\.git$/, ''), texts: licenseTexts(dir) });
    Object.keys(pkg.dependencies || {}).forEach(walk);
  };
  Object.keys(JSON.parse(readFileSync('package.json', 'utf8')).dependencies || {}).forEach(walk);
  return [...out.values()];
}

// ------------------------------------------------------------ Rust
function cargoPackages() {
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--filter-platform', 'x86_64-pc-windows-msvc'],
    { cwd: 'src-tauri', maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }));
  const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const root = meta.resolve.root;
  // 通常の依存（kind が null）だけをたどる。試験用・組み立て用の部品はアプリに入らない
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const d of nodes.get(stack.pop())?.deps || []) {
      if (!d.dep_kinds.some((k) => k.kind === null) || seen.has(d.pkg)) continue;
      seen.add(d.pkg);
      stack.push(d.pkg);
    }
  }
  seen.delete(root);
  return [...seen].map((id) => pkgs.get(id)).map((p) => {
    const dir = dirname(p.manifest_path);
    const texts = licenseTexts(dir);
    if (!texts.length && p.license_file && existsSync(join(dir, p.license_file))) texts.push(readFileSync(join(dir, p.license_file), 'utf8').trim());
    return { name: p.name, version: p.version, license: p.license || (p.license_file ? '（ライセンスのファイルあり）' : ''), url: p.repository || `https://crates.io/crates/${p.name}`, texts };
  });
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
const npm = npmPackages().sort(byName);
const cargo = cargoPackages().sort(byName);

// ------------------------------------------------------------ 一覧（docs/みんな向け/使っている部品.md）
const row = (p) => `| ${p.name} | ${p.version} | ${p.license || '（不明）'} | ${p.url ? `<${p.url}>` : ''} |`;
const md = `# 使っている部品

CWカタログ（アプリ版・HTML版）に入っている、ほかの方が作った部品の一覧です。
部品の許諾文は、配布物の zip に入っている \`THIRD-PARTY-NOTICES.txt\` にまとめてあります。

※ このファイルは \`node scripts/third-party.mjs\` で自動で作っています（手で直さない）。

## 画面と中身（JavaScript）：${npm.length}個

アプリ版・HTML版の両方に入ります。

| 部品 | 版 | ライセンス | 入手先 |
|---|---|---|---|
${npm.map(row).join('\n')}

## アプリ版の器（Rust）：${cargo.length}個

アプリ版（CWCatalog.exe）にだけ入ります。

| 部品 | 版 | ライセンス | 入手先 |
|---|---|---|---|
${cargo.map(row).join('\n')}
`;
mkdirSync('docs/みんな向け', { recursive: true });
writeFileSync('docs/みんな向け/使っている部品.md', md);

// ------------------------------------------------------------ 許諾文（dist/THIRD-PARTY-NOTICES.txt）
// 同じ文の許諾は1つにまとめ、その文を使う部品の名前を上に並べる
const groups = new Map();
for (const p of [...npm, ...cargo]) {
  const text = p.texts.length ? p.texts.join('\n\n----\n\n') : `（許諾文のファイルが部品に入っていません。ライセンス：${p.license || '不明'}。入手先：${p.url || 'なし'}）`;
  const key = createHash('sha256').update(text).digest('hex');
  if (!groups.has(key)) groups.set(key, { text, names: [] });
  groups.get(key).names.push(`${p.name} ${p.version}`);
}
const line = '='.repeat(72);
const notices = [
  'CWカタログ 使っている部品の許諾文（THIRD-PARTY NOTICES）',
  '',
  'CWカタログには、次の部品が入っています。それぞれの許諾文を、下に載せます。',
  '部品の一覧は https://github.com/seihayukimi-oss/cw-catalog-tool/blob/main/docs/みんな向け/使っている部品.md にもあります。',
  '',
  ...[...groups.values()].flatMap((g) => [line, ...g.names, line, '', g.text, '']),
].join('\n');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/THIRD-PARTY-NOTICES.txt', notices);

const missing = [...npm, ...cargo].filter((p) => !p.texts.length).map((p) => p.name);
console.log(`docs/みんな向け/使っている部品.md：npm ${npm.length}個・Rust ${cargo.length}個`);
console.log(`dist/THIRD-PARTY-NOTICES.txt：許諾文 ${groups.size}種類（${Math.round(notices.length / 1024)}KB）`);
if (missing.length) console.log(`※ 許諾文のファイルが無い部品：${missing.join('、')}`);
