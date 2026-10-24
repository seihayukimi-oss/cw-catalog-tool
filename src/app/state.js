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
  tagList: [],
  favs: { works: [], folders: [] },
  tidy: null, // 整理・二重チェックの結果
  busy: '',
};

export const TAB_LABEL = { mine: '自分のフォルダ一覧', add: 'シナリオをDLする', catalog: 'カタログ', settings: '設定' };

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

/** 見出しの横に、進み具合を小さく出す */
export function busyText(text) {
  const el = document.querySelector('.brand .small');
  if (el) el.textContent = text;
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
