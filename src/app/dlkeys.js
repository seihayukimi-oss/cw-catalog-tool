// DLキー（パスワード）を、このパソコンの中だけで覚えておく。
//  ・DLキーの画面で「このDLキーを覚える」にしたもの：そのページ（URL）だけで使う。取れたときに覚える
//  ・個人用カタログの DL先 に入れたもの：その作品の DL先 で使う（catalog-view.js の登録・編集の画面）
//  どちらも、DL一覧の書き出し・共用カタログには決して入れない。人に伝えるときは、設定の一覧から1つずつコピーしてもらう

import { S, render, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, fmtDate } from './ui.js';
import { ownSources } from './catalog-data.js';

/** 覚えるときの、ページの見分け方（# のあとは外す） */
export function pageKeyOf(url) {
  try { const u = new URL(url); u.hash = ''; return u.href; } catch { return String(url || ''); }
}

export async function loadDlKeys() {
  S.dlKeys = (await store.get('dlKeys')) || {};
}
/** そのページで覚えているDLキー（無ければ空） */
export const rememberedKey = (url) => S.dlKeys?.[pageKeyOf(url)]?.key || '';
export async function rememberKey(url, key) {
  if (!key) return;
  S.dlKeys[pageKeyOf(url)] = { key, at: new Date().toISOString() };
  await store.set('dlKeys', S.dlKeys);
}
export async function forgetKey(url) {
  if (!S.dlKeys?.[pageKeyOf(url)]) return;
  delete S.dlKeys[pageKeyOf(url)];
  await store.set('dlKeys', S.dlKeys);
}

async function copyKey(key) {
  try { await navigator.clipboard.writeText(key); toast('DLキーをコピーしました'); } catch { toast('コピーできませんでした。キーを選んでコピーしてください', { bad: true }); }
}
/** キーは、いつもは折りたたんでおく（開いたときだけ見える。画面を描き直すと、また閉じる） */
const keyBox = (key) => h('details', { class: 'dlkey' },
  h('summary', { class: 'small' }, 'DLキーを表示'),
  h('div', { class: 'row small' }, h('code', { class: 'url' }, key), h('button', { class: 'btn ghost sm', onclick: () => copyKey(key) }, 'コピー')));

// ------------------------------------------------------------ 設定：DLキーの一覧
export function viewDlKeys() {
  const pages = Object.entries(S.dlKeys || {}).sort((a, b) => (b[1].at || '').localeCompare(a[1].at || ''));
  // 個人用カタログの DL先 に入れたDLキー（直すときは「カタログ」タブの「編集」）
  const inCatalog = [];
  for (const src of ownSources()) {
    for (const e of S.catalogs.get(src.id)?.entries || []) {
      for (const d of e.downloads || []) if (d.dlkey && !inCatalog.some((x) => x.e.name === e.name && x.d.url === d.url)) inCatalog.push({ e, d, src });
    }
  }
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'DLキー（パスワード）は、このパソコンの中だけに保存します。DL一覧の書き出しや共用カタログには入りません。人に伝えたいときは、ここから1つずつ「コピー」して伝えてください（作者さんによっては、サイトに来てDLキーと注意書きを見てほしいと考えています）。'),
    h('h3', {}, 'DLキーの画面で覚えたもの（そのページだけで使います）'),
    pages.length ? h('ul', { class: 'dl' }, pages.map(([url, rec]) => h('li', { class: 'stack', style: 'gap:2px' },
      h('div', { class: 'row' },
        h('span', { class: 'grow', style: 'word-break:break-all' }, url),
        h('span', { class: 'small muted' }, rec.at ? `覚えた日時：${fmtDate(rec.at)}` : ''),
        h('button', {
          class: 'btn ghost sm danger', onclick: async () => {
            if (!(await confirmBox('このページのDLキーを忘れます。次からは、DLキーをもう一度入れることになります。よろしいですか？'))) return;
            await forgetKey(url);
            render();
          },
        }, '忘れる')),
      keyBox(rec.key)))) : h('p', { class: 'small muted', style: 'margin:0' }, 'まだありません。DLキーの画面で「このDLキーを覚える」にして取ってくると、ここに入ります。'),
    h('h3', {}, '個人用カタログの DL先 に入れたもの'),
    inCatalog.length ? h('ul', { class: 'dl' }, inCatalog.map(({ e, d, src }) => h('li', { class: 'stack', style: 'gap:2px' },
      h('div', { class: 'row' },
        h('b', {}, e.name),
        h('span', { class: 'small muted grow', style: 'word-break:break-all' }, `${d.label ? `${d.label}　` : ''}${d.url}`),
        h('span', { class: 'small muted' }, src.name)),
      keyBox(d.dlkey)))) : h('p', { class: 'small muted', style: 'margin:0' }, 'まだありません。'),
    inCatalog.length ? h('p', { class: 'small muted', style: 'margin:0' }, '直す・消すときは、「カタログ」タブで作品の「編集」を開いてください。') : null);
}
