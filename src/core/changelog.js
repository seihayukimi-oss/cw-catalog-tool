// 更新履歴（CHANGELOG.md）を読む。アプリを作るときに読み込んで、アプリの中に入れる。
// 形：「## 版（YYYY-MM-DD）」の下に「### 要点」と「### もっと詳しく」の箇条書き。

import { compareVersions } from './catalog.js';

/**
 * @param {string} md CHANGELOG.md の中身
 * @returns {{version: string, date: string, points: string[], details: string[]}[]} 新しい順
 */
export function parseChangelog(md) {
  const out = [];
  let cur = null, sec = '';
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const v = /^##\s+v?([0-9][0-9A-Za-z.\-+]*)\s*[（(]\s*(\d{4}-\d{2}-\d{2})\s*[）)]/.exec(line);
    if (v) { cur = { version: v[1], date: v[2], points: [], details: [] }; out.push(cur); sec = 'points'; continue; }
    if (!cur) continue;
    if (/^###\s*要点/.test(line)) { sec = 'points'; continue; }
    if (/^###\s*もっと詳しく/.test(line)) { sec = 'details'; continue; }
    const item = /^\s*[-*]\s+(.+)$/.exec(line);
    if (item) cur[sec].push(item[1].trim());
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

/**
 * 前に見た版より新しく、今の版までのもの（更新したあとに、版ごとに出す）
 * @returns 新しい順
 */
export function newSince(log, seen, current) {
  if (!seen) return [];
  return log.filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0);
}
