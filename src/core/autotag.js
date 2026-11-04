// Readme・シナリオの説明文から、タグを自動で見つける（店シナ・読み物・人数・戦闘あり／なし など）。
// 書いてあることをそのまま拾うだけで、推測はしない（見つからなければ付けない）。

import { findRating } from './ratings.js';

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 壱: 1, 弐: 2 };
const num = (s) => (/\d/.test(s) ? parseInt(s, 10) : KANJI[s] || 0);
const N = '([1-6１-６一二三四五六])';

/**
 * @param {string} text Readme・説明文などをつないだもの
 * @returns {string[]} 見つけたタグ（重ならない）
 */
export function findTags(text) {
  const t = String(text || '').normalize('NFKC');
  const tags = new Set();
  // 店シナ（アイテムやスキルを買えるシナリオ）
  if (/店シナ|ショップシナ|お店シナ|販売シナ|(?:^|[\s　「【(（])店(?:舗)?シナリオ|ショップ系|店系シナ/m.test(t)) tags.add('店シナ');
  // 読み物（戦闘や判定の少ない、読んで楽しむもの）
  if (/読み物|読みもの|よみもの|ビジュアルノベル|サウンドノベル/.test(t)) tags.add('読み物');
  // 人数
  const persons = [];
  for (const m of t.matchAll(new RegExp(`${N}\\s*人\\s*(専用|用|以上|以下|推奨|から|～|〜|-)`, 'g'))) {
    const n = num(m[1].normalize('NFKC'));
    if (!n) continue;
    const kind = m[2];
    if (kind === '専用') persons.push(`${n}人専用`);
    else if (kind === '用') persons.push(`${n}人用`);
    else if (kind === '以上' || kind === 'から') persons.push(`${n}人以上`);
    else if (kind === '以下') persons.push(`${n}人以下`);
    else if (kind === '推奨') persons.push(`${n}人推奨`);
  }
  if (/ソロ(?:専用|シナリオ|用)|単独(?:専用|行動用)|一人旅/.test(t)) persons.push('1人用');
  if (/パーティ(?:ー)?(?:全員|フル)|フルパーティ|6人パーティ/.test(t) && !persons.length) persons.push('6人用');
  for (const p of persons.slice(0, 3)) tags.add(p);
  // 戦闘
  const noBattle = /戦闘(?:は|が)?(?:なし|無し|ない|無い|ありません|ございません|一切|しません)|非戦闘|ノンバトル|戦闘要素(?:は)?(?:なし|無し|ありません)/.test(t);
  const battle = /戦闘(?:あり|有り|があります|もあります|します)|ボス戦|戦闘シナリオ|バトル(?:あり|有り)/.test(t);
  if (noBattle) tags.add('戦闘なし');
  else if (battle) tags.add('戦闘あり');
  // 長さ
  if (/短編/.test(t)) tags.add('短編');
  else if (/中編/.test(t)) tags.add('中編');
  else if (/長編/.test(t)) tags.add('長編');
  // 対象レベル（「Lv3以上」「Lv5以下」の2つに分けて付ける。3～5 なら Lv3以上・Lv5以下）
  const lvm = t.match(/(?:対象|推奨|適正)\s*(?:レベル|Lv\.?|LV\.?)\s*[:：]?\s*([^\n。、,，/／]{1,20})/i);
  const lv = lvm ? parseLevel(lvm[1]) : null;
  if (lv) for (const x of levelTags(lv)) tags.add(x);
  // 対象年齢（R18・R15）。書いてあるときだけ
  const rating = findRating(t);
  if (rating) tags.add(rating === 'r18' ? 'R18' : 'R15');
  return [...tags];
}

/**
 * 対象レベルの書き方を読む：「3～5」「3-5」「３ー５」「3から5」「Lv3～Lv5」「3以上」「5以下」「3」など
 * @returns {{min: number|null, max: number|null}|null}
 */
export function parseLevel(s) {
  const t = String(s || '').normalize('NFKC').replace(/(?:Lv\.?|LV\.?|lv\.?|レベル)/g, '');
  const two = t.match(/(\d{1,2})\s*(?:[~～〜\-ー―−]|から|to)\s*(\d{1,2})/);
  if (two) { const a = +two[1], b = +two[2]; return { min: Math.min(a, b), max: Math.max(a, b) }; }
  const up = t.match(/(\d{1,2})\s*(?:以上|～$|~$|〜$|-$|から$)/);
  if (up) return { min: +up[1], max: null };
  const down = t.match(/(\d{1,2})\s*以下|(?:[~～〜\-ー]|まで)\s*(\d{1,2})/);
  if (down) return { min: null, max: +(down[1] || down[2]) };
  const one = t.match(/^\s*(\d{1,2})\s*(?:$|[^\d])/);
  if (one) return { min: +one[1], max: +one[1] };
  return null;
}
/** 対象レベルのタグ：下限は「Lv3以上」、上限は「Lv5以下」 */
export const levelTags = (lv) => [lv?.min != null ? `Lv${lv.min}以上` : '', lv?.max != null ? `Lv${lv.max}以下` : ''].filter(Boolean);

/** zipなどを開いた結果（シナリオ1本）から、タグを探す */
export async function findTagsInOpened(opened, scenario) {
  const parts = [scenario?.name || '', scenario?.description || ''];
  const { decodeText } = await import('./text.js');
  for (const r of (opened.readmes || []).slice(0, 4)) {
    const f = opened.files.find((x) => x.path === r.path);
    if (!f) continue;
    try { parts.push(decodeText(await f.read()).text.slice(0, 50000)); } catch { /* 読めないものは飛ばす */ }
  }
  return findTags(parts.join('\n'));
}
