// 更新履歴：設定のいちばん下に出す（新しい5つ＋「もっと見る」）。
// 新しい版に更新したあと、最初の1回だけ「変わったところ」を版ごとに出す（OKで消える）。

import { S, render, APP_VERSION } from './state.js';
import { store } from './store.js';
import { h, modal } from './ui.js';
import { newSince } from '../core/changelog.js';

export const CHANGELOG = typeof __CHANGELOG__ !== 'undefined' ? __CHANGELOG__ : [];
const KV_SEEN = 'seenVersion';

function entryBlock(e, { open = false } = {}) {
  return h('details', { class: 'changelog-entry', open: open || null, 'data-version': e.version },
    h('summary', {}, h('b', {}, e.version), h('span', { class: 'muted small' }, `（${e.date}）`), e.version === APP_VERSION ? h('span', { class: 'badge ok', style: 'margin-left:6px' }, '今の版') : null),
    e.points.length ? h('ul', { class: 'small', style: 'margin:4px 0;padding-left:1.2em' }, e.points.map((p) => h('li', {}, p))) : null,
    e.details.length ? h('details', { class: 'small', style: 'margin-left:1em' }, h('summary', {}, 'もっと詳しく'),
      h('ul', { style: 'margin:4px 0;padding-left:1.2em' }, e.details.map((p) => h('li', {}, p)))) : null);
}

/** 設定のいちばん下 */
export function viewChangelog() {
  if (!CHANGELOG.length) return null;
  const all = !!S.changelogAll;
  const list = all ? CHANGELOG : CHANGELOG.slice(0, 5);
  return h('div', { class: 'card stack', id: 'changelog' },
    list.map((e, i) => entryBlock(e, { open: i === 0 })),
    CHANGELOG.length > 5 ? h('button', { class: 'btn ghost sm', id: 'changelog-more', onclick: () => { S.changelogAll = !all; render(); } }, all ? 'たたむ' : `もっと見る（ほか ${CHANGELOG.length - 5}版）`) : null);
}

/**
 * 起動したとき：前に使っていた版より新しくなっていれば、変わったところを版ごとに出す（最初の1回だけ）。
 * 初めて使うときは何も出さない。
 */
export async function showWhatsNew() {
  const seen = await store.get(KV_SEEN);
  if (seen === APP_VERSION) return;
  const items = newSince(CHANGELOG, seen, APP_VERSION);
  if (items.length) {
    await modal((close) => h('div', { class: 'stack', id: 'whats-new' },
      h('h2', { style: 'margin:0' }, `${APP_VERSION} に更新しました`),
      h('p', { class: 'small muted', style: 'margin:0' }, `更新前の版：${seen}　変更点（「設定」の一番下の「更新履歴」でも閲覧可能です）`),
      h('div', { class: 'stack', style: 'max-height:55vh;overflow:auto' }, items.map((e, i) => entryBlock(e, { open: i === 0 || items.length <= 3 }))),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, 'OK'))));
  }
  await store.set(KV_SEEN, APP_VERSION);
}
