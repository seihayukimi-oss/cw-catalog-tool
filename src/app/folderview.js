// 自分のフォルダ一覧の「どこを・どう見るか」と、フォルダ表示
//   ・エンジンのタブ（横に並べて切り替える）／素材を表示・スキンを表示
//   ・表示の切り替え（フォルダ表示 ⇄ 一覧表示）。一覧表示＝前からの表示
//   ・フォルダ表示：Scenario（素材・スキンの置き場所）の中のフォルダ分けを、開け閉めできる形で見せる
import { S, render, rerenderList } from './state.js';
import { store } from './store.js';
import { h, toast, modal } from './ui.js';
import { ENGINE_KINDS } from '../core/catalog.js';
import { safeRelativePath } from '../core/zip.js';

export const MODE_LABEL = { folder: 'フォルダ表示', list: '一覧表示' };
export const mineMode = () => (S.mineMode === 'list' ? 'list' : 'folder');
export const UNSORTED_NOTE = 'このフォルダは実際のシナリオ・素材フォルダには作成されていません';

/** エンジンのタブ（素材・スキンの置き場所も同じ並びのタブ）。検索欄の下に置く */
export function mineNav() {
  const go = async (fn) => { S.mineSel.clear(); await fn(); render(); };
  const tab = (label, selected, fn) => h('button', { role: 'tab', 'aria-selected': selected ? 'true' : 'false', onclick: () => go(fn) }, label);
  return h('div', { class: 'mine-nav' },
    h('div', { class: 'engine-tabs', role: 'tablist', 'aria-label': 'エンジン' },
      S.engines.map((x) => tab(`${x.name}（${ENGINE_KINDS[x.kind]?.short || x.kind}）`, !S.mineView && x.id === S.engineId,
        async () => { S.mineView = ''; S.engineId = x.id; await store.set('engineId', x.id); })),
      tab('素材の置き場所', S.mineView === 'mat', () => { S.mineView = 'mat'; }),
      tab('スキンの置き場所', S.mineView === 'skin', () => { S.mineView = 'skin'; })));
}

/** 一覧の上の操作：新規フォルダを作成・表示の切り替え（フォルダ表示 ⇄ 一覧表示）・削除モード */
export function mineTools({ rootLabel, onCreate }) {
  const mode = mineMode();
  const other = mode === 'folder' ? 'list' : 'folder';
  const del = !!S.deleteMode;
  return h('div', { class: 'row mine-tools', id: 'mine-tools' },
    onCreate ? h('button', { class: 'btn sm', id: 'folder-new-root', onclick: () => onCreate('') }, `${rootLabel} 内に新規フォルダを作成`) : null,
    h('button', {
      class: 'btn sm mode-btn', id: 'mine-mode', title: `押すと${MODE_LABEL[other]}に切り替えます`,
      onclick: async () => { S.mineMode = other; await store.set('mineMode', other); render(); },
    }, `表示：${MODE_LABEL[mode]}`),
    h('button', {
      class: `btn sm delete-mode${del ? ' on' : ''}`, id: 'delete-mode', 'aria-pressed': del ? 'true' : 'false',
      title: del ? '押すと削除モードを終わります' : '押すと、各作品に「🗑️削除する」ボタンが出ます',
      onclick: () => { S.deleteMode = !del; render(); },
    }, `🗑️ ファイル・データ削除モード：${del ? 'ON' : 'OFF'}`),
    h('button', {
      class: `btn sm copy-mode${S.copyMode ? ' on' : ''}`, id: 'copy-mode', 'aria-pressed': S.copyMode ? 'true' : 'false',
      title: S.copyMode ? '押すとコピーモードを終わります' : '押すと、各作品・フォルダに「📋コピーする先を選択」ボタンが出ます',
      onclick: () => { S.copyMode = !S.copyMode; render(); },
    }, `📋 コピーモード：${S.copyMode ? 'ON' : 'OFF'}`));
}

/** 削除モードのときに各作品に付けるボタン */
export const deleteBtn = (onclick) => h('button', { class: 'btn sm danger delete-btn', onclick }, '🗑️削除する');

/**
 * 削除の確認。消し方を選ぶ：アプリ版は「ごみ箱に移動」が最初から選ばれている（HTML版はごみ箱が使えないので「バックアップを取る」）
 * @returns {Promise<{how: 'trash'|'backup'|'delete'}|null>}
 */
export function confirmDelete({ name, path, place, note }) {
  const canTrash = !!S.platform.canTrash;
  return modal((close) => {
    let how = canTrash ? 'trash' : 'backup';
    const warn = h('p', { class: 'note bad small', style: 'margin:0', hidden: true }, '完全に削除した場合、削除したファイルは復元できません（ごみ箱にも移動されません）。');
    const opt = (v, label, sub) => {
      const r = h('input', { type: 'radio', name: 'delete-how', value: v, id: `delete-${v}`, checked: how === v });
      r.addEventListener('change', () => { how = v; warn.hidden = v !== 'delete'; });
      return h('label', { class: 'check', style: 'align-items:flex-start' }, r, h('span', {}, label, sub ? h('span', { class: 'small muted', style: 'display:block;word-break:break-all' }, sub) : null));
    };
    return h('div', { class: 'stack', id: 'delete-confirm' },
      h('h2', {}, '🗑️ 削除する'),
      h('p', { style: 'margin:0' }, `「${name}」を削除します。よろしいですか？`),
      h('p', { class: 'small muted', style: 'margin:0;word-break:break-all' }, path),
      note ? h('p', { class: 'note warn small', style: 'margin:0' }, note) : null,
      h('div', { class: 'stack', style: 'gap:6px' },
        canTrash ? opt('trash', 'ごみ箱に移動する', 'Windows のごみ箱から元に戻せます') : null,
        opt('backup', 'バックアップを取る（削除せず CWCatalog_backup フォルダへ移動します）', `移動先：${place}`),
        opt('delete', '完全に削除する')),
      warn,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { class: 'btn primary danger-fill', id: 'delete-go', onclick: () => close({ how }) }, '削除する')));
  });
}

/** 新しいフォルダの名前を聞く（1段分の名前だけ。使えない文字は置き換える） */
export async function askFolderName(where) {
  const v = await modal((close) => {
    const inp = h('input', { type: 'text', id: 'newfolder-name', 'aria-label': '新しいフォルダの名前', placeholder: '新しいフォルダの名前' });
    setTimeout(() => inp.focus(), 0);
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close(inp.value.trim()); } },
      h('h2', {}, '新規フォルダを作成'),
      h('p', { class: 'small muted', style: 'margin:0;word-break:break-all' }, `作成する場所：${where}`),
      inp,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '作成する')));
  });
  if (!v) return null;
  const safe = /[/\\]/.test(v) ? null : safeRelativePath(v);
  if (!safe) { toast('フォルダの名前が正しくありません（「/」「\\」や「..」は使えません）', { bad: true }); return null; }
  return safe;
}

/** フォルダを開いた状態にしておく（作ったばかりのフォルダが見えるように） */
export function openFolder(ns, path) {
  S.folderFlip ??= new Set();
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) S.folderFlip.add(`${ns}:${parts.slice(0, i).join('/')}`);
}

/**
 * フォルダ表示
 * @param {{ns: string, recs: object[], cats: string[], parentOf: (r: object) => string|null, card: (r: object) => HTMLElement,
 *          filtering: boolean, rerender: () => void, rootLabel: string,
 *          onCreate?: (parent: string) => void, nested?: boolean, otherLabel?: string,
 *          onDeleteFolder?: (path: string) => void, onCopyFolder?: (path: string) => void}} o
 *   選択モードのときは、フォルダにもチェック欄（S.folderSel に「ns:フォルダ」で入れる）
 *   parentOf：記録が入っているフォルダ（''＝直下＝未整理、null＝フォルダの無いもの（カタログ外の登録など））
 */
export function folderTree(o) {
  S.folderFlip ??= new Set();
  const nodes = new Map();
  const ensure = (p) => {
    if (nodes.has(p)) return nodes.get(p);
    const n = { dirs: new Set(), recs: [] };
    nodes.set(p, n);
    if (p !== '') ensure(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '').dirs.add(p);
    return n;
  };
  ensure('');
  if (!o.filtering) for (const c of o.cats || []) ensure(c);
  const other = [];
  for (const r of o.recs) {
    const p = o.parentOf(r);
    if (p === null) other.push(r);
    else ensure(p).recs.push(r);
  }
  const counts = new Map();
  const count = (p) => {
    if (counts.has(p)) return counts.get(p);
    const n = nodes.get(p);
    const c = n.recs.length + [...n.dirs].reduce((s, d) => s + count(d), 0);
    counts.set(p, c);
    return c;
  };
  const byName = (a, b) => a.localeCompare(b, 'ja');

  const group = (key, summaryKids, bodyFn) => {
    // 絞り込み中は開いた状態から、それ以外は閉じた状態から。押して変えたものは覚えておく
    const fullKey = `${o.ns}:${key}`;
    const open = o.filtering !== S.folderFlip.has(fullKey);
    const det = h('details', { class: 'folder', 'data-folder': key, open }, h('summary', {}, summaryKids), open ? bodyFn() : null);
    det.addEventListener('toggle', () => {
      if (det.open === open) return;
      if (S.folderFlip.has(fullKey)) S.folderFlip.delete(fullKey); else S.folderFlip.add(fullKey);
      o.rerender();
    });
    return det;
  };
  const createBtn = (p) => h('button', {
    class: 'btn ghost sm', title: `「${p}」の中に、新しいフォルダを作ります`,
    onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); o.onCreate(p); },
  }, 'ここに新規フォルダを作成');
  S.folderSel ??= new Set();
  const stop = (fn) => (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
  const folderPick = (p) => {
    const key = `${o.ns}:${p}`;
    const box = h('input', { type: 'checkbox', checked: S.folderSel.has(key), 'aria-label': `フォルダ「${p}」を選ぶ`, class: 'folder-pick' });
    // チェック欄を押しても、フォルダが開け閉めしないように
    box.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (box.checked) S.folderSel.add(key); else S.folderSel.delete(key);
      o.rerender();
    });
    return box;
  };
  const folder = (p) => {
    const n = nodes.get(p);
    return group(p, [
      S.selectMode ? folderPick(p) : null,
      h('span', { class: 'folder-name' }, `📁 ${p.split('/').pop()}`),
      h('span', { class: 'badge plain' }, `${count(p)}件`),
      o.onCreate && o.nested ? createBtn(p) : null,
      S.deleteMode && o.onDeleteFolder ? h('button', { class: 'btn sm danger delete-btn', onclick: stop(() => o.onDeleteFolder(p)) }, '🗑️削除する') : null,
      S.copyMode && o.onCopyFolder ? h('button', { class: 'btn sm copy-btn', onclick: stop(() => o.onCopyFolder(p)) }, '📋コピーする先を選択') : null,
    ], () => h('div', { class: 'folder-body' },
      [...n.dirs].sort(byName).map(folder),
      n.recs.map(o.card),
      !n.dirs.size && !n.recs.length ? h('p', { class: 'small muted', style: 'margin:4px 0' }, '（空のフォルダ）') : null));
  };

  const root = nodes.get('');
  return h('div', { class: 'list folder-tree', id: 'mine-list' },
    [...root.dirs].sort(byName).map(folder),
    root.recs.length ? group('__unsorted', [h('span', { class: 'folder-name' }, '📁 未整理'), h('span', { class: 'badge plain' }, `${root.recs.length}件`)],
      () => h('div', { class: 'folder-body' }, h('p', { class: 'small muted', style: 'margin:4px 0' }, `※${UNSORTED_NOTE}`), root.recs.map(o.card))) : null,
    other.length ? group('__other', [h('span', { class: 'folder-name' }, o.otherLabel || 'その他'), h('span', { class: 'badge plain' }, `${other.length}件`)],
      () => h('div', { class: 'folder-body' }, other.map(o.card))) : null);
}

/** 記録の一覧を描き直す（フォルダの開け閉め用） */
export const rerenderBody = (viewFn) => () => rerenderList('mine-body', viewFn);
