// 個人用カタログに、何作品かをまとめて登録するための中身（画面に関係ない部分）。
//  ・ダウンロードのリンクから、作品名とバージョンを推測する（ファイルを取ってこないとき）
//  ・作品ごとの情報と、全部に共通の情報（移転先・移転前の配布ページ、作者さんのサイト）から、作品のデータを作る
//  ・同じ作品（作品名＋作者）がもう個人用カタログにあるときは、DL先・紹介ページを足す

import { guessVersion } from './scenario.js';

const ARCHIVE = /\.(zip|wsn|cab|lzh|lha|7z)$/i;
// リンクの文字が、作品名ではなく「ダウンロード」などのボタンの言葉のとき
const GENERIC = /^(dl|d\/l|download|ダウンロード|こちら|ここ|here|click|クリック|zip|wsn|lzh|cab|7z|ファイル|file|本体|最新版|\s|[()（）［］\[\]【】・:：>＞→▶]|ver\.?\s*[\d.]+)+$/i;

/** 作品名から、バージョンの書き方と、区切りの記号を取り除く */
function stripVersion(name) {
  return name
    .normalize('NFKC')
    .replace(/[ _\-(（]*ver(?:sion)?[ ._\-]?\d+(?:[._]\d+)*[)）]?/ig, '')
    .replace(/(?:^|[ _\-(（])v\d+(?:[._]\d+)+[)）]?/ig, '')
    .replace(/[_\-\s]+(?:20)?\d{6}(?!\d)/g, '')
    .replace(/[_]+/g, ' ')
    .replace(/[\s\-_.・]+$/, '')
    .replace(/^[\s\-_.・]+/, '')
    .trim();
}

/** URL の最後の部分（ファイル名）を、読める形で取り出す */
function fileNameOfUrl(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    try { return decodeURIComponent(last); } catch { return last; }
  } catch { return ''; }
}

/**
 * ダウンロードのリンク（リンクの文字と URL）から、作品名とバージョンを推測する。
 * リンクの文字が「ダウンロード」などのときは、ファイル名を使う。
 * @param {{url: string, text?: string}} link
 * @returns {{name: string, version: string, fileName: string}}
 */
export function guessFromLink({ url, text = '' }) {
  const fileName = fileNameOfUrl(url);
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  const useText = t && !GENERIC.test(t) && !ARCHIVE.test(t);
  const source = useText ? t : fileName.replace(ARCHIVE, '');
  const version = guessVersion(source) || guessVersion(fileName.replace(ARCHIVE, '')) || '';
  const name = stripVersion(source) || stripVersion(fileName.replace(ARCHIVE, '')) || source;
  return { name, version, fileName };
}

/** 1行に1つの URL を、http・https のものだけにして並べる（同じものは1つに） */
export function urlLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const u = line.trim();
    if (!u) continue;
    if (!/^https?:\/\/\S+$/.test(u)) throw new Error(`URLは https:// から始まるものにしてください：${u}`);
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

const COMPAT = {
  classic: { cw150: 'expected', next: 'expected', py: 'expected' },
  next: { cw150: 'no', next: 'expected', py: 'unknown' },
  wsn: { cw150: 'no', next: 'no', py: 'expected' },
};

/**
 * 作品ごとの情報と、全部に共通の情報から、個人用カタログの作品を作る。
 * DL先の順番：その作品のリンク（新・通常）→ 移転先の配布ページ（新・通常）→ 移転前の配布ページ（旧・移転済み）
 * @param {{name: string, author?: string, version?: string, type?: string, format?: string, wsnVersion?: number|null,
 *          description?: string, rating?: string, url: string, fileName?: string, sha256?: string}} item
 * @param {{pages?: string[], oldPages?: string[], intro?: string[]}} common
 */
export function bulkEntry(item, common = {}) {
  const format = ['classic', 'next', 'wsn'].includes(item.format) ? item.format : 'classic';
  const downloads = [];
  const add = (url, kind, status) => { if (url && !downloads.some((d) => d.url === url)) downloads.push({ label: '', url, kind, status, until: '', note: '' }); };
  add(item.url, ARCHIVE.test(fileNameOfUrl(item.url)) ? 'direct' : 'page', 'active');
  for (const u of common.pages || []) add(u, 'page', 'active');
  for (const u of common.oldPages || []) add(u, 'page', 'old');
  return {
    id: 'p00000', owner: '', type: ['scenario', 'skin', 'material'].includes(item.type) ? item.type : 'scenario',
    name: String(item.name || '').trim(), author: String(item.author || '').trim(), version: String(item.version || '').trim(), updated: '',
    format, wsn_version: format === 'wsn' ? item.wsnVersion ?? null : null,
    compat: COMPAT[format], convert: 'self',
    downloads,
    file: { name: item.fileName || '', sha256: item.sha256 || '' }, readme: '', level: null,
    tags: [], description: String(item.description || '').trim().slice(0, 2000), requires: [], related: [], links: [],
    intro: (common.intro || []).map((url) => ({ url, label: '' })),
    rating: ['all', 'r15', 'r18'].includes(item.rating) ? item.rating : 'all', content: [],
  };
}

/**
 * もう個人用カタログにある作品に、新しく分かったことを足す。
 * DL先・紹介ページは、無いものだけ後ろに足す。今あるDL先の設定はそのままだが、「移転前」として書いたものは「旧（移転済み）」にする。
 * バージョン・ファイル・紹介文は、空のときだけ入れる
 */
export function mergeEntry(cur, add) {
  const downloads = (cur.downloads || []).map((x) => (x.status !== 'closed' && (add.downloads || []).some((d) => d.url === x.url && d.status === 'old') ? { ...x, status: 'old' } : x));
  for (const d of add.downloads || []) if (!downloads.some((x) => x.url === d.url)) downloads.push(d);
  const intro = [...(cur.intro || [])];
  for (const i of add.intro || []) if (!intro.some((x) => x.url === i.url)) intro.push(i);
  return {
    ...cur,
    version: cur.version || add.version,
    file: cur.file?.sha256 ? cur.file : add.file,
    description: cur.description || add.description,
    downloads, intro,
  };
}
