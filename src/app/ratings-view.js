// シナリオラベル（R18・R15・注意のラベル）の表示と設定。
//  ・R18 はいつもは出さない。設定でONにするとき、初回だけ年齢確認（パソコンが変わったら聞き直す）
//  ・R15・注意のラベルは、いつも出して、ラベルを付けるだけ。設定で「苦手なラベルの作品を隠す」を選べる

import { S, render, busy, goTab, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, modal } from './ui.js';
import { DEFAULT_CONTENT_LABELS, RATING_NAME } from '../core/ratings.js';

const KV_AGE = 'ageCheck';

export async function loadRatingPrefs() {
  S.catPrefs.hideLabels ||= [];
  const age = await store.get(KV_AGE);
  const key = await S.platform.machineKey?.().catch(() => '') || '';
  S.machineKey = key;
  // 年齢確認は、確かめたときと同じパソコン・同じユーザーのときだけ有効
  S.ageOk = !!(age?.ok && age.key === key);
}

/** R18 の作品を出すか（設定がONで、このパソコンで年齢確認が済んでいる） */
export const r18On = () => !!(S.catPrefs?.showR18 && S.ageOk);
/** カタログに出してよい作品か（R18 は、設定がONのときだけ） */
export const catalogVisible = (w) => w.rating !== 'r18' || r18On();
/** 注意のラベルの一覧（最初からのものと、カタログで増やしたもの） */
export const contentLabelDefs = () => S.combined?.contentLabels || DEFAULT_CONTENT_LABELS;
export const contentLabelName = (id) => contentLabelDefs().find((d) => d.id === id)?.name || id;
/** 苦手なラベルとして隠しているものが付いているか */
export const hiddenByLabel = (w) => {
  const hide = S.catPrefs?.hideLabels || [];
  return !!hide.length && (hide.includes(w.rating) || (w.content || []).some((c) => hide.includes(c)));
};

/** 作品のシナリオラベル（バッジ） */
export function labelBadges(w) {
  if (!w) return [];
  const out = [];
  if (w.rating === 'r18') out.push(h('span', { class: 'badge bad rating-r18', title: '成人向け（R18）の作品です' }, 'R18'));
  if (w.rating === 'r15') out.push(h('span', { class: 'badge warn rating-r15', title: '15歳以上向け（R15）の作品です' }, 'R15'));
  for (const c of w.content || []) out.push(h('span', { class: 'badge warn content-label', title: '注意のラベル' }, `⚠ ${contentLabelName(c)}`));
  return out;
}

/** R18 の設定をONにしようとしたときの年齢確認（初回だけ。パソコンが変わったら、もう一度） */
async function askAge() {
  return modal((close) => h('div', { class: 'stack', id: 'age-check' },
    h('h2', { style: 'margin:0' }, '年齢の確認'),
    h('p', { style: 'margin:0' }, 'R18（成人向け）の作品を表示します。あなたは18歳以上ですか？'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'このPCで一度確認します。別のPCで起動した場合や、アプリを再導入した場合は再度確認が行われます。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'いいえ'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, 'はい'))));
}

/** R18 の作品を表示する・しない */
export async function setShowR18(on) {
  if (on && !S.ageOk) {
    if (!(await askAge())) { toast('R18の作品は表示しません'); render(); return false; }
    S.ageOk = true;
    await store.set(KV_AGE, { ok: true, key: S.machineKey || '', at: new Date().toISOString() });
  }
  const { setCatPrefs, refreshSource, refreshStates } = await import('./catalog-data.js');
  await setCatPrefs({ showR18: !!on });
  // 共用カタログの R18 の分（index-r18.json）は、ONにしたときだけ取りに行く
  if (on) {
    await busy('R18の作品を読み込む', async () => {
      for (const src of S.sources.filter((s) => s.enabled && s.kind === 'shared' && s.url && s.url !== 'sample')) {
        await refreshSource(src, { force: true }).catch(() => {});
      }
      await refreshStates();
    });
  }
  toast(on ? 'R18の作品を表示します' : 'R18の作品を表示しないようにしました');
  render();
  return true;
}

/** R18 がOFFのときに、R18の作品に触れたときの案内 */
export async function r18Guide(name = '') {
  const go = await confirmBox(`${name ? `「${name}」は` : 'この作品は'}R18シナリオです。表示するには設定で『R18表示』を有効にしてください。`, { yes: '設定を開く', no: '閉じる', title: 'R18シナリオです' });
  if (go) { goTab('settings'); setTimeout(() => document.getElementById('rating-settings')?.scrollIntoView({ block: 'start' }), 50); }
}

/** 設定：シナリオラベル */
export function viewRatingSettings() {
  const p = S.catPrefs;
  const r18 = h('input', { type: 'checkbox', id: 'pref-r18', checked: r18On(), onchange: (ev) => setShowR18(ev.target.checked) });
  const media = h('input', { type: 'checkbox', id: 'pref-r18-media', checked: !!p.r18Media, disabled: !r18On(), onchange: async (ev) => { const { setCatPrefs } = await import('./catalog-data.js'); await setCatPrefs({ r18Media: ev.target.checked }); render(); } });
  const hideBox = (id, name) => h('label', { class: 'check' },
    h('input', {
      type: 'checkbox', checked: (p.hideLabels || []).includes(id), 'aria-label': `「${name}」のラベルの作品を隠す`,
      onchange: async (ev) => {
        const { setCatPrefs } = await import('./catalog-data.js');
        const set = new Set(p.hideLabels || []);
        if (ev.target.checked) set.add(id); else set.delete(id);
        await setCatPrefs({ hideLabels: [...set] });
        render();
      },
    }), name);
  return h('div', { class: 'card stack small', id: 'rating-settings' },
    h('p', { class: 'muted', style: 'margin:0' }, '作品には、対象年齢（R18・R15）と、注意のラベル（グロ・残酷描写など）を付けられます。まとめて「シナリオラベル」（ラベル）と呼びます。'),
    h('label', { class: 'check' }, r18, 'R18（成人向け）作品を表示する'),
    h('p', { class: 'muted', style: 'margin:0 0 0 1.6em' }, '初期状態では非表示です。ONに切り替える際、初回のみ年齢確認を行います。R18作品はアプリ内で直接ダウンロードせず、お使いのブラウザで配布元ページを開きます。※ローカル保存済みの作品はOFFでも表示されます。'),
    h('label', { class: 'check', style: 'margin-left:1.6em' }, media, 'R18作品の画像・説明文を常時表示する（オフ時は選択時のみ表示）'),
    h('div', {}, h('div', { class: 'muted' }, '特定のラベルを持つ作品を非表示にする（チェックを入れたラベルの作品を一覧から除外します）'),
      h('div', { class: 'row', id: 'hide-labels' }, hideBox('r15', RATING_NAME.r15), contentLabelDefs().map((d) => hideBox(d.id, d.name)))));
}
