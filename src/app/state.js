// 画面全体で共有する状態と、描画・待ち表示などの共通の道具。

import { h, toast, modal } from './ui.js';

export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export const S = {
  platform: null,
  tab: 'mine',
  engines: [],
  engineId: null,
  dirs: new Map(),
  records: [],
  categories: {},
  // カタログ
  sources: [], // 共用・個人用カタログの一覧（設定）
  catalogs: new Map(), // id → 整えたカタログ
  combined: null, // 候補に含めるカタログを、作品ごとにまとめたもの
  catPrefs: { addTo: 'all', askDefault: true },
  workPrefs: {}, // 作品ごとの設定（デフォルトのDL先など）
  folders: { list: [], map: {} }, // 自分で作るフォルダ（作者さんごと・企画ごとなど）
  expanded: new Set(), // くわしく表示している作品
  catView: { group: '', compact: null },
  manageOpen: false,
  selected: new Set(), // カタログで選んだ作品
  ogp: new Map(), // 紹介ページのカード情報
  // zip・wsnの保存場所
  archive: { on: false, ref: null, label: '' },
  archiveDir: null,
  // シナリオをDLする
  opened: null,
  openedWork: null,
  lastUrl: '',
  pick: 0,
  readmeIdx: 0,
  readmeEnc: '',
  readmeAck: false,
  urlState: null,
  progress: null,
  batch: null,
  filter: { mine: '', mineState: '', mineTag: '', cat: '', catEngine: '', catSource: '', catFolder: '', showHidden: false },
  mineSel: new Set(), // 自分のフォルダ一覧で選んだ記録
  mineView: '', // 'mat'＝素材の置き場所を見ている
  materials: null, // 素材の置き場所 {ref,label,lastScan}
  materialsDir: null,
  tagList: [],
  favs: { works: [], folders: [] },
  tidy: null, // 整理・二重チェックの結果
  busy: '',
};

export const TAB_LABEL = { mine: '自分のフォルダ一覧', add: 'シナリオ・素材・スキンをDLする', catalog: 'カタログ', settings: '設定' };

/** 各タブの画面（app.js で登録する） */
export const views = {};
let renderTop = () => {};
export function setRenderer(fn) { renderTop = fn; }
export function render() { renderTop(); }

export const engine = (id = S.engineId) => S.engines.find((e) => e.id === id) || null;
export const recordsOf = (id = S.engineId) => S.records.filter((r) => r.engineId === id);

export async function dirOf(id, ask = true) {
  if (S.dirs.has(id)) return S.dirs.get(id);
  const e = engine(id);
  if (!e?.ref) return null;
  const d = await S.platform.openFolder(e.ref, { ask });
  if (d) S.dirs.set(id, d);
  return d;
}

export async function busy(label, fn) {
  S.busy = label;
  render();
  try {
    return await fn();
  } catch (e) {
    if (e?.name !== 'AbortError') {
      console.error(e);
      const msg = e?.message || String(e);
      // アプリ版：選んだフォルダの外、または許可が足りない場所に触れようとしたとき
      if (/forbidden path/i.test(msg)) {
        toast('このフォルダを使う許可が足りません。「設定」で、このエンジンの「選び直す」を押して、同じフォルダをもう一度選んでください', { bad: true, ms: 12000 });
      } else {
        toast(msg, { bad: true, ms: 8000 });
      }
    }
    return undefined;
  } finally {
    S.busy = '';
    render();
  }
}

/** 右上に、いまの段階を出す（下の小さい行には、何の作業か） */
export function busyText(text) {
  const el = document.getElementById('busy-text');
  if (el) el.textContent = text;
  const sub = document.getElementById('busy-sub');
  if (sub) sub.textContent = S.busy && !String(text).startsWith(S.busy) ? S.busy : '';
}

const mb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);
/** 右上の進み具合のバー。ratio が null なら隠す。負なら「動いているけど量は分からない」 */
export function busyProgress(ratio, text = '') {
  const bar = document.getElementById('busy-prog');
  if (bar) {
    bar.hidden = ratio == null;
    if (ratio != null) { if (ratio < 0) bar.removeAttribute('value'); else bar.value = Math.min(1, ratio); }
  }
  if (text) busyText(text);
}
/** ダウンロードの進み具合（1つずつ取るとき）。まとめて取るときは、件数で別に出す */
export function netProgress(got, total) {
  if (S.progressByCount) return;
  if (got < 0) busyProgress(-1, 'サイトにつないでいます…');
  else if (total > 0) busyProgress(got / total, `ダウンロード中… ${Math.floor((got / total) * 100)}%（${mb(got)} / ${mb(total)}）`);
  else if (got === 0) busyProgress(-1, 'サイトにつないでいます…');
  else busyProgress(-1, `ダウンロード中… ${mb(got)}`);
}

/** アプリ内ブラウザでのダウンロードの進み具合 */
export function dlProgress(got, total) {
  if (total > 0) busyProgress(got / total, `サイトからダウンロード中… ${Math.floor((got / total) * 100)}%（${mb(got)} / ${mb(total)}）`);
  else busyProgress(-1, `サイトからダウンロード中… ${mb(got)}`);
}

export function rerenderList(id, viewFn) {
  // 入力中のフォーカスを失わないよう、一覧の部分だけ差し替える
  const fresh = viewFn().querySelector(`#${id}`);
  document.getElementById(id)?.replaceWith(fresh);
}

export function confirmBox(msg, { yes = 'はい', no = 'いいえ', title = '' } = {}) {
  return modal((close) => h('div', { class: 'stack' },
    title ? h('h2', {}, title) : null,
    typeof msg === 'string' ? h('p', {}, msg) : msg,
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, no),
      h('button', { class: 'btn primary', onclick: () => close(true) }, yes))));
}

export function goTab(tab) {
  S.tab = tab;
  render();
  window.scrollTo?.(0, 0);
}
