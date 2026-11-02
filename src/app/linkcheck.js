// リンク切れの確かめ：ダウンロードはせず、ファイルの頭の少しだけを読んで、相手が「無い」と言うかを見る。
// 結果は覚えておき、カタログの作品に「✖ リンク切れ」と出す。

import { S } from './state.js';
import { store } from './store.js';
import { h, sleep } from './ui.js';

const KV = 'linkCheck';
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

export async function loadLinkCheck() {
  S.linkCheck = (await store.get(KV)) || {};
}
const save = () => store.set(KV, S.linkCheck || {});

/** 確かめた結果を、見せ方に分ける */
export function classifyLink(r) {
  if (!r) return 'unknown';
  if (r.status === 404 || r.status === 410) return 'dead';
  if (r.status === 0) return 'unreach';
  if (r.status >= 500) return 'unreach';
  return 'ok';
}

export const linkState = (url) => S.linkCheck?.[url]?.state || '';

/** 結果を覚える（ダウンロードしようとして404だったときなども） */
export async function markLink(url, state, status = 0) {
  if (!url) return;
  S.linkCheck ||= {};
  S.linkCheck[url] = { state, status, at: new Date().toISOString() };
  await save();
}

/** リンクの印（何も分かっていなければ null） */
export function linkBadge(url) {
  const c = S.linkCheck?.[url];
  if (!c) return null;
  const when = c.at ? new Date(c.at).toLocaleDateString('ja-JP') : '';
  if (c.state === 'dead') return h('span', { class: 'badge bad link-dead', title: `${when}に確かめたとき、ファイルが見つかりませんでした（${c.status}）` }, '✖ リンク切れ');
  if (c.state === 'unreach') return h('span', { class: 'badge warn', title: `${when}に確かめたとき、サイトにつながりませんでした。サイトが一時的に止まっているか、無くなっているかもしれません` }, '✖ つながりません');
  if (c.state === 'ok') return h('span', { class: 'badge plain', title: `${when}に確かめました` }, '✓ リンクあり');
  return null;
}

/** 作品のDL先（終了したものは除く）にリンク切れがあるか */
export const workHasDead = (w) => w.downloads.some((d) => d.status !== 'closed' && linkState(d.url) === 'dead');

/**
 * まとめて確かめる。同じサイトには1件ずつ間をあけて（相手に負担をかけないように）、違うサイトは同時に進める。
 * @param {string[]} urls
 * @returns {Promise<{checked: number, dead: number, unreach: number}>}
 */
export async function checkLinks(urls, { onStep, gap = 1200 } = {}) {
  if (!S.platform.checkLink) return { checked: 0, dead: 0, unreach: 0 };
  const byHost = new Map();
  for (const u of new Set(urls.filter((x) => /^https?:\/\//.test(x)))) {
    const k = hostOf(u);
    if (!byHost.has(k)) byHost.set(k, []);
    byHost.get(k).push(u);
  }
  let checked = 0, dead = 0, unreach = 0;
  const results = {};
  await Promise.all([...byHost.values()].map(async (list) => {
    for (let i = 0; i < list.length; i++) {
      if (i) await sleep(gap);
      const r = await S.platform.checkLink(list[i]);
      const state = classifyLink(r);
      results[list[i]] = { state, status: r.status || 0, at: new Date().toISOString() };
      checked++;
      if (state === 'dead') dead++;
      if (state === 'unreach') unreach++;
      onStep?.(checked);
    }
  }));
  // 全部つながらないときは、こちらがネットにつながっていないだけかもしれないので覚えない
  if (checked && unreach === checked && checked > 1) return { checked, dead: 0, unreach, offline: true };
  S.linkCheck = { ...(S.linkCheck || {}), ...results };
  await save();
  return { checked, dead, unreach };
}

/** しばらく確かめていないもの（日数） */
export const staleLink = (url, days = 7) => {
  const c = S.linkCheck?.[url];
  return !c || Date.now() - new Date(c.at).getTime() > days * 86400000;
};
