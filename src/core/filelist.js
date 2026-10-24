// アップローダー（uploader.jp など）のファイル一覧ページから、作品の最新のファイルを探す。
// アップローダーは、新しい版を上げるたびにURL（…/download/12 → …/download/17）が変わるため、
// 「一覧ページ」を登録しておき、作品名に合うファイルのうち版がいちばん新しいものを選ぶ。
import { guessVersion } from './scenario.js';
import { normalizeName, compareVersions } from './catalog.js';

const ARCHIVE = /\.(zip|wsn|cab|lzh|lha|7z|rar)$/i;
const unesc = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'");

/** 一覧ページのファイル（リンクの文字か title がファイル名のもの） */
export function extractFileList(html, baseUrl) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(unesc(m[3]), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || /\/(edit|delete)\//i.test(url.pathname)) continue;
    const attrs = `${m[1]} ${m[4]}`;
    const title = unesc((attrs.match(/\btitle\s*=\s*(["'])(.*?)\1/i) || [])[2] || '');
    const text = unesc(m[5].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const name = ARCHIVE.test(text) ? text : ARCHIVE.test(title) ? title : '';
    if (!name) continue;
    url.hash = '';
    if (!out.has(url.href)) out.set(url.href, { url: url.href, name });
  }
  return [...out.values()];
}

/** URLの最後の番号（…/download/17 → 17）。同じ版なら新しく上げたほうを選ぶため */
const serial = (u) => Number((u.match(/(\d+)(?:\/?$|\?)/) || [])[1] || 0);

/**
 * 一覧から、作品のいちばん新しいファイルを選ぶ
 * @param {{url, name}[]} files
 * @param {string} match 作品名（またはファイル名の目印）
 * @returns {{url, name, version}|null}
 */
export function findNewest(files, match) {
  const key = normalizeName(String(match || '').replace(/ver(?:sion)?[ ._\-]?\d.*$/i, ''));
  if (!key) return null;
  const hits = files
    .filter((f) => normalizeName(f.name.replace(ARCHIVE, '')).includes(key))
    .map((f) => ({ ...f, version: guessVersion(f.name.replace(ARCHIVE, '')) || '' }));
  if (!hits.length) return null;
  hits.sort((a, b) => compareVersions(b.version, a.version) || serial(b.url) - serial(a.url));
  return hits[0];
}
