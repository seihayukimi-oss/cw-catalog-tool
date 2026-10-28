// ファイルの集まり（zipの中身／フォルダの中身）から、
// 「どこからどこまでがシナリオか」「どれがReadmeか」を判定する。

import { parseSummaryWsm, parseSummaryXml, isWdp } from './summary.js';
import { decodeText } from './text.js';

/**
 * @typedef {{path: string, size: number, read: () => Promise<Uint8Array>}} FileRef
 */

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const stripExt = (n) => n.replace(/\.[^.]+$/, '');

const README_STRONG = /(read[ _-]?me|りどみ|リドミ|リードミー|はじめに|最初に|必読|お読み|よんで|読んで|説明|規約|利用|著作権|ライセンス|license|注意)/i;
const README_WEAK = /(後記|あとがき|更新履歴|履歴|history|change ?log|おまけ|攻略|ヒント|クレジット|credit|素材)/i;

/** Readmeらしさの点数（0なら候補外） */
export function readmeScore(path, insideRoot) {
  const name = basename(path);
  if (!/\.(txt|md)$/i.test(name)) return 0;
  let s = 1;
  if (README_STRONG.test(name)) s += 10;
  else if (README_WEAK.test(name)) s += 3;
  if (/^[0-9０-９!！@＠★☆_＿]/.test(name)) s += 2; // 01_Readme.txt, !readme.txt, @Readme.txt
  if (!insideRoot) s += 1; // シナリオの外（zipのトップ）にあるものは作者が置いたReadmeの可能性が高い
  return s;
}

/**
 * 名前からバージョンらしき表記を探す（作品のバージョンはファイルの中に無いため）。
 * 例：「サンプル店ver1_01」→ 1.01、「テスト冒険譚Ver1.12」→ 1.12、「デバッグ読みシナ_230124」→ 230124
 */
export function guessVersion(name) {
  const n = name.normalize('NFKC');
  let m = n.match(/ver(?:sion)?[ ._\-]?(\d+(?:[._]\d+)*)/i)
    || n.match(/(?:^|[ _\-(（])v(\d+(?:[._]\d+)+)/i)
    || n.match(/(\d+\.\d+(?:\.\d+)*)/);
  if (m) return m[1].replace(/_/g, '.');
  m = n.match(/(?:^|[_\-\s])((?:20)?\d{6})(?!\d)/);
  if (m) return m[1];
  return null;
}

/**
 * シナリオの範囲を判定する。
 * @param {FileRef[]} files
 * @param {{sourceName?: string}} opts sourceName はzipのファイル名など（トップがシナリオのときのフォルダ名に使う）
 */
export async function analyzeFiles(files, opts = {}) {
  const warnings = [];
  const byDir = new Map();
  for (const f of files) {
    const b = basename(f.path).toLowerCase();
    if (b === 'summary.wsm' || b === 'summary.xml') {
      const dir = dirname(f.path);
      const cur = byDir.get(dir) || {};
      cur[b === 'summary.xml' ? 'xml' : 'wsm'] = f;
      byDir.set(dir, cur);
    }
  }

  // 入れ子になったものは外側だけ残す
  const roots = [...byDir.keys()].sort((a, b) => a.length - b.length);
  const kept = [];
  for (const r of roots) {
    if (!kept.some((k) => k === '' || r.startsWith(k + '/'))) kept.push(r);
  }
  const rootOf = (p) => kept.find((r) => r === '' || p.startsWith(r + '/')) ?? null;

  const scenarios = [];
  for (const root of kept) {
    const s = byDir.get(root);
    let summary;
    try {
      if (s.xml) {
        const { text } = decodeText(await s.xml.read());
        summary = parseSummaryXml(text);
      } else {
        summary = parseSummaryWsm(await s.wsm.read());
      }
    } catch (e) {
      warnings.push(`${root || '(トップ)'} の目印ファイルを読めませんでした：${e.message}`);
      continue;
    }
    const inner = files.filter((f) => rootOf(f.path) === root);

    // Nextの暗号化（WDP）チェック：小さい.widを1つ見る
    let encrypted = null;
    if (summary.format !== 'wsn') {
      const wid = inner.filter((f) => /\.wid$/i.test(f.path)).sort((a, b) => a.size - b.size)[0];
      if (wid) encrypted = isWdp((await wid.read()).subarray(0, 4));
    }

    const folderName = root ? basename(root) : stripExt(opts.sourceName || summary.name || 'scenario');
    scenarios.push({
      root,
      folderName,
      name: summary.name,
      author: summary.author,
      description: summary.description,
      format: summary.format,
      dataVersion: summary.kind === 'wsm' ? summary.dataVersion : null,
      wsnVersion: summary.kind === 'xml' ? summary.dataVersion : null,
      encrypted,
      files: inner.map((f) => f.path),
      size: inner.reduce((a, f) => a + f.size, 0),
      // 内側のフォルダ名 → 外側のフォルダ名 → zipの名前 の順に探す
      versionGuess: [...(root ? root.split('/').reverse() : []), opts.sourceName || '']
        .map(guessVersion).find(Boolean) || null,
    });
  }

  const readmes = files
    .map((f) => ({ path: f.path, size: f.size, root: rootOf(f.path), score: 0 }))
    .map((r) => ({ ...r, score: r.size > 2 * 1024 * 1024 ? 0 : readmeScore(r.path, r.root !== null) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length);

  const outside = files.filter((f) => rootOf(f.path) === null).map((f) => f.path);
  return { scenarios, readmes, outside, warnings };
}

/** Readmeを読む（文字コード自動判定） */
export async function readReadme(file, force) {
  const bytes = await file.read();
  return decodeText(bytes, force);
}
