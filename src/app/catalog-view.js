// 「カタログ」タブ：共用・個人用カタログの管理、作品の一覧・紹介・DL、個人用カタログへの登録と編集。

import { ENGINE_KINDS } from '../core/catalog.js';
import { chooseDownloads, statusOf, ageRoleOf, introKind, INTRO_LABEL, workKey, KIND_LABEL } from '../core/catalogs.js';
import { decodeHtml, parseOgp } from '../core/weblink.js';
import { urlAdvice, inAppSite } from '../core/urls.js';
import { S, render, busy, rerenderList, confirmBox, goTab } from './state.js';
import { h, toast, modal, fmtDate, formatBadge } from './ui.js';
import {
  addShared, importList, createOwn, removeSource, setEnabled, setHidden, setHiddenMany, refreshSource, saveSources, exportSource,
  saveOwnEntry, ownSources, sourceById, setDefaultUrl, defaultUrlOf, setCatPrefs, refreshStates,
  foldersOf, createFolder, renameFolder, deleteFolder, moveFolder, putInFolder, takeOutOfFolder, labelsOf, importLabels,
} from './catalog-data.js';
import { store } from './store.js';
import { isFavWork, isFavFolder, inFavorites, setFavWorks, toggleFavFolder } from './tags.js';
import { downloadWork, downloadFrom, dlLabel } from './download.js';
import { startBatch } from './batch.js';

const LV = { verified: ['確認済み', 'ok'], expected: ['動くはず', 'warn'], no: ['非対応', 'bad'], unknown: ['未確認', 'plain'] };
const AGE = { new: '新', old: '旧（移転済み）', closed: '終了' };
const ROLE = { normal: '通常', mirror: '予備' };

// ------------------------------------------------------------ 一覧
const GROUPS = [['', 'そのまま'], ['author', '作者ごと'], ['folder', 'フォルダごと'], ['name', '名前順'], ['updated', '新しい順']];

function filteredWorks() {
  if (!S.combined) return [];
  const q = S.filter.cat.normalize('NFKC').toLowerCase();
  const fid = S.filter.catFolder;
  const list = S.combined.works.filter((w) => {
    if (S.filter.catSource && !w.refs.some((r) => r.sourceId === S.filter.catSource)) return false;
    if (!S.filter.showHidden && (S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden)) return false;
    if (S.filter.catEngine && !['verified', 'expected'].includes(w.compat?.[S.filter.catEngine])) return false;
    if (fid === '__none' && (S.folders.map[w.key] || []).length) return false;
    if (fid === '__fav' && !inFavorites(w)) return false;
    if (fid && fid !== '__none' && fid !== '__fav' && !(S.folders.map[w.key] || []).includes(fid)) return false;
    return !q || `${w.name} ${w.author} ${w.tags.join(' ')} ${w.description || ''} ${foldersOf(w.key).map((f) => f.name).join(' ')}`.normalize('NFKC').toLowerCase().includes(q);
  });
  const g = S.catView.group;
  const byName = (a, b) => a.name.localeCompare(b.name, 'ja');
  if (g === 'name' || g === 'author' || g === 'folder') list.sort(byName);
  if (g === 'updated') list.sort((a, b) => (b.updated || '').localeCompare(a.updated || '') || byName(a, b));
  return list;
}
const filtering = () => !!(S.filter.cat.trim() || S.filter.catEngine || S.filter.catSource || S.filter.catFolder);
const compactView = () => (S.catView.compact == null ? (S.combined?.works.length || 0) > 30 : S.catView.compact);
async function saveView(patch) { Object.assign(S.catView, patch); await store.set('catView', S.catView); render(); }

export function viewCatalog() {
  const hasAny = !!S.combined;
  const manage = viewManage(!hasAny || S.manageOpen);
  if (!hasAny) {
    return h('div', {}, manage,
      h('div', { class: 'card soft small' },
        h('p', { style: 'margin:0' }, 'まだ作品がありません。'),
        h('ul', { style: 'margin:6px 0 0;padding-left:1.2em' },
          h('li', {}, '共用カタログ：作者さんが登録したカタログのURL（index.json）を追加します'),
          h('li', {}, '個人用カタログ：有志の方のDL一覧を読み込むか、「＋作品を登録」で自分で作品を足します')),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => editEntry({}) }, '＋作品を登録（個人用）'))));
  }

  const works = filteredWorks();
  const filters = h('div', { class: 'card stack' },
    h('div', { class: 'row' },
      h('input', { type: 'search', class: 'grow', id: 'cat-q', placeholder: '作品名・作者・タグ・紹介文・フォルダ名で検索', value: S.filter.cat, oninput: (ev) => { S.filter.cat = ev.target.value; rerenderList('cat-body', viewCatalog); } }),
      h('button', { class: 'btn', onclick: () => editEntry({}) }, '＋作品を登録（個人用）')),
    h('div', { class: 'row' },
      h('select', { 'aria-label': 'カタログ', onchange: (ev) => { S.filter.catSource = ev.target.value; render(); } },
        h('option', { value: '' }, 'すべてのカタログ'),
        S.sources.filter((s) => s.enabled).map((s) => h('option', { value: s.id, selected: S.filter.catSource === s.id ? 'selected' : null }, `${KIND_LABEL[s.kind]}：${s.name}`))),
      h('select', { 'aria-label': 'エンジン', onchange: (ev) => { S.filter.catEngine = ev.target.value; render(); } },
        [['', 'すべてのエンジン'], ['cw150', '1.50で遊べる'], ['next', 'Nextで遊べる'], ['py', 'Pyで遊べる']].map(([v, l]) => h('option', { value: v, selected: S.filter.catEngine === v ? 'selected' : null }, l))),
      h('select', { 'aria-label': '並べ方', onchange: (ev) => saveView({ group: ev.target.value }) },
        GROUPS.map(([v, l]) => h('option', { value: v, selected: S.catView.group === v ? 'selected' : null }, `並べ方：${l}`))),
      h('select', { 'aria-label': '表示', onchange: (ev) => saveView({ compact: ev.target.value === 'compact' }) },
        h('option', { value: 'full', selected: !compactView() ? 'selected' : null }, '表示：くわしく'),
        h('option', { value: 'compact', selected: compactView() ? 'selected' : null }, '表示：コンパクト')),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: S.filter.showHidden, onchange: (ev) => { S.filter.showHidden = ev.target.checked; render(); } }), '候補から外したものも表示')),
    folderChips());

  return h('div', {}, manage, filters, h('div', { id: 'cat-body' }, batchBar(works), viewList(works)));
}

/** フォルダの切り替え（すべて・未分類・自分で作ったフォルダ） */
function folderChips() {
  const all = S.combined.works.filter((w) => S.filter.showHidden || !w.hidden);
  const count = (fid) => all.filter((w) => (fid === '__none' ? !(S.folders.map[w.key] || []).length : fid === '__fav' ? inFavorites(w) : (S.folders.map[w.key] || []).includes(fid))).length;
  const folders = [...S.folders.list].sort((a, b) => isFavFolder(b.id) - isFavFolder(a.id));
  const chip = (fid, label, n) => h('button', {
    class: `chip${S.filter.catFolder === fid ? ' on' : ''}`, 'aria-pressed': S.filter.catFolder === fid ? 'true' : 'false',
    onclick: () => { S.filter.catFolder = fid; render(); },
  }, label, h('span', { class: 'n' }, n));
  return h('div', { class: 'row folder-chips' },
    h('span', { class: 'small muted' }, 'フォルダ'),
    chip('', 'すべて', all.length),
    chip('__fav', '★お気に入り', count('__fav')),
    folders.map((f) => chip(f.id, `${isFavFolder(f.id) ? '★' : ''}${f.name}`, count(f.id))),
    S.folders.list.length ? chip('__none', '未分類', count('__none')) : null,
    h('button', { class: 'btn ghost sm', onclick: async () => { const name = await askName('新しいフォルダ', '', 'フォルダの名前（例：作者さんの名前、企画の名前）'); if (name) { const f = await createFolder(name); S.filter.catFolder = f.id; toast(`フォルダ「${name}」を作りました。作品を選んで「フォルダに入れる」で入れられます`, { ms: 7000 }); render(); } } }, '＋新しいフォルダ'),
    S.folders.list.length ? h('button', { class: 'btn ghost sm', onclick: manageFolders }, 'フォルダの整理') : null);
}

function batchBar(works) {
  const sel = S.combined.works.filter((w) => S.selected.has(w.key));
  const visibleSel = works.filter((w) => S.selected.has(w.key)).length;
  const inFolder = S.filter.catFolder && S.filter.catFolder !== '__none' ? S.folders.list.find((f) => f.id === S.filter.catFolder) : null;
  const anyHidden = sel.some((w) => (S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden));
  const anyShown = sel.some((w) => !(S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden));
  return h('div', { class: 'card batch-bar', id: 'batch-bar' },
    h('div', { class: 'row' },
      h('span', { class: 'small' }, `${works.length}件${filtering() ? '（絞り込み中）' : ''}`),
      filtering() && works.length ? h('button', { class: 'btn primary sm', onclick: () => startBatch(works.map((work) => ({ work })), '検索結果をまとめてDL') }, `検索結果${works.length}件をまとめてDL`) : null,
      h('button', { class: 'btn sm', disabled: !works.length || visibleSel === works.length, onclick: () => { works.forEach((w) => S.selected.add(w.key)); render(); } }, '表示中をすべて選ぶ'),
      sel.length ? h('button', { class: 'btn ghost sm', onclick: () => { S.selected.clear(); render(); } }, '選択を解除') : null),
    sel.length ? h('div', { class: 'row sel-actions' },
      h('b', { class: 'small' }, `選んだ${sel.length}件を：`),
      h('button', { class: 'btn primary sm', onclick: () => { startBatch(sel.map((work) => ({ work })), '選んだ作品をまとめてDL'); S.selected.clear(); } }, 'まとめてDL'),
      h('button', { class: 'btn sm', onclick: () => putSelectedInFolder(sel) }, 'フォルダに入れる'),
      sel.some((w) => !isFavWork(w.key)) ? h('button', { class: 'btn sm', onclick: async () => { await setFavWorks(sel.map((w) => w.key), true); toast(`${sel.length}件をお気に入りにしました`); S.selected.clear(); render(); } }, '★お気に入りにする') : null,
      sel.some((w) => isFavWork(w.key)) ? h('button', { class: 'btn sm', onclick: async () => { await setFavWorks(sel.map((w) => w.key), false); toast(`${sel.length}件をお気に入りから外しました`); S.selected.clear(); render(); } }, 'お気に入りから外す') : null,
      inFolder ? h('button', { class: 'btn sm', onclick: async () => { await takeOutOfFolder(sel.map((w) => w.key), inFolder.id); toast(`${sel.length}件を「${inFolder.name}」から外しました`); S.selected.clear(); render(); } }, `「${inFolder.name}」から外す`) : null,
      anyShown ? h('button', { class: 'btn sm', onclick: () => hideSelected(sel, true) }, '候補から外す') : null,
      anyHidden ? h('button', { class: 'btn sm', onclick: () => hideSelected(sel, false) }, '候補に戻す') : null) : null);
}

async function putSelectedInFolder(sel) {
  const choice = await modal((close) => {
    const newIn = h('input', { type: 'text', placeholder: '新しいフォルダの名前', class: 'grow' });
    return h('div', { class: 'stack' },
      h('h2', {}, `${sel.length}件をフォルダに入れる`),
      h('p', { class: 'small muted', style: 'margin:0' }, '1つの作品を、いくつのフォルダに入れてもかまいません。共用カタログの作品も入れられます（カタログそのものは変わりません）。'),
      S.folders.list.length ? h('div', { class: 'stack' }, S.folders.list.map((f) => h('button', { class: 'btn', style: 'justify-content:flex-start', onclick: () => close({ id: f.id }) }, f.name))) : null,
      h('div', { class: 'row' }, newIn, h('button', { class: 'btn primary', onclick: () => { const n = newIn.value.trim(); if (n) close({ name: n }); } }, '新しく作って入れる')),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, 'やめる')));
  });
  if (!choice) return;
  const f = choice.id ? S.folders.list.find((x) => x.id === choice.id) : await createFolder(choice.name);
  await putInFolder(sel.map((w) => w.key), f.id);
  S.selected.clear();
  toast(`${sel.length}件を「${f.name}」に入れました`);
  render();
}

async function hideSelected(sel, hide) {
  const ids = S.filter.catSource ? [S.filter.catSource] : null;
  await setHiddenMany(sel, hide, ids);
  await refreshStates();
  S.selected.clear();
  toast(hide ? `${sel.length}件を候補から外しました（「候補から外したものも表示」で戻せます）` : `${sel.length}件を候補に戻しました`);
  render();
}

/** フォルダの名前を変える・順番・消す */
async function manageFolders() {
  await modal((close) => {
    const body = h('div', { class: 'stack' });
    const draw = () => body.replaceChildren(...S.folders.list.map((f, i) => h('div', { class: 'row src-row' },
      h('button', { class: `btn ghost sm star${isFavFolder(f.id) ? ' on' : ''}`, 'aria-label': `${f.name}をお気に入りにする`, 'aria-pressed': isFavFolder(f.id) ? 'true' : 'false', title: 'お気に入りのフォルダは、先頭に並び、「★お気に入り」にも出ます', onclick: async () => { await toggleFavFolder(f.id); draw(); } }, isFavFolder(f.id) ? '★' : '☆'),
      h('b', { class: 'grow' }, f.name),
      h('span', { class: 'small muted' }, `${Object.values(S.folders.map).filter((ids) => ids.includes(f.id)).length}件`),
      h('button', { class: 'btn ghost sm', disabled: i === 0, 'aria-label': '上へ', onclick: async () => { await moveFolder(f.id, -1); draw(); } }, '↑'),
      h('button', { class: 'btn ghost sm', disabled: i === S.folders.list.length - 1, 'aria-label': '下へ', onclick: async () => { await moveFolder(f.id, 1); draw(); } }, '↓'),
      h('button', { class: 'btn ghost sm', onclick: async () => { const n = await askName('フォルダの名前を変える', f.name, 'フォルダの名前'); if (n) { await renameFolder(f.id, n); draw(); } } }, '名前'),
      h('button', { class: 'btn ghost sm danger', onclick: async () => { if (await confirmBox(`フォルダ「${f.name}」を消します。中の作品は消えません（フォルダから外れるだけです）。よろしいですか？`)) { await deleteFolder(f.id); if (S.filter.catFolder === f.id) S.filter.catFolder = ''; draw(); } } }, '消す'))));
    draw();
    return h('div', { class: 'stack' }, h('h2', {}, 'フォルダの整理'), body,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる')));
  });
  render();
}

function viewList(works) {
  const owned = new Map(S.records.filter((r) => r.workKey).map((r) => [r.workKey, r]));
  if (!works.length) return h('div', { class: 'list', id: 'cat-list' }, h('p', { class: 'empty' }, '見つかりませんでした'));
  const g = S.catView.group;
  if (g !== 'author' && g !== 'folder') return h('div', { class: 'list', id: 'cat-list' }, works.map((w) => workCard(w, owned.get(w.key))));
  // 作者ごと・フォルダごとにまとめる
  const groups = new Map();
  const add = (k, w) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(w); };
  for (const w of works) {
    if (g === 'author') add(w.author || '（作者不明）', w);
    else {
      const fs = foldersOf(w.key);
      if (fs.length) fs.forEach((f) => add(f.name, w)); else add('（未分類）', w);
    }
  }
  const keys = [...groups.keys()];
  if (g === 'author') keys.sort((a, b) => a.localeCompare(b, 'ja'));
  else keys.sort((a, b) => (a === '（未分類）') - (b === '（未分類）') || S.folders.list.findIndex((f) => f.name === a) - S.folders.list.findIndex((f) => f.name === b));
  return h('div', { class: 'list', id: 'cat-list' }, keys.map((k) => {
    const ws = groups.get(k);
    const det = h('details', { class: 'group', open: true },
      h('summary', {}, h('span', { class: 'group-name' }, k), h('span', { class: 'badge plain' }, `${ws.length}件`),
        h('button', { class: 'btn ghost sm', onclick: (ev) => { ev.preventDefault(); ws.forEach((w) => S.selected.add(w.key)); render(); } }, 'まとめて選ぶ')),
      ws.map((w) => workCard(w, owned.get(w.key))));
    return det;
  }));
}

/** 長い紹介文は折りたたんで、「すべて表示」で開けるようにする */
export function descBlock(text) {
  const t = text.replace(/^\n+|\s+$/g, '');
  const long = t.split('\n').length > 5 || t.length > 180;
  const box = h('div', { class: 'desc' + (long ? '' : ' full') }, t);
  if (!long) return box;
  const btn = h('button', { class: 'btn ghost sm', onclick: () => { const open = box.classList.toggle('full'); btn.textContent = open ? '▲ たたむ' : '▼ すべて表示'; } }, '▼ すべて表示');
  return h('div', {}, box, btn);
}

function workCard(w, mine) {
  const order = chooseDownloads(w, defaultUrlOf(w));
  const def = order[0] || null;
  const inOwn = w.refs.some((r) => r.kind === 'own');
  const hiddenHere = S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden;
  const open = !compactView() || S.expanded.has(w.key);
  const sel = h('input', {
    type: 'checkbox', checked: S.selected.has(w.key), 'aria-label': `${w.name}を選ぶ`,
    onchange: (ev) => { if (ev.target.checked) S.selected.add(w.key); else S.selected.delete(w.key); document.getElementById('batch-bar')?.replaceWith(batchBar(filteredWorks())); },
  });
  const head = h('div', { class: 'row between' },
    h('div', { class: 'row' }, sel,
      h('button', { class: `btn ghost sm star${isFavWork(w.key) ? ' on' : ''}`, 'aria-label': `${w.name}をお気に入りにする`, 'aria-pressed': isFavWork(w.key) ? 'true' : 'false', title: isFavWork(w.key) ? 'お気に入りから外す' : 'お気に入りにする', onclick: async () => { await setFavWorks([w.key], !isFavWork(w.key)); render(); } }, isFavWork(w.key) ? '★' : '☆'),
      h('span', { class: 'item-title' }, w.name), w.type && w.type !== 'scenario' ? h('span', { class: 'badge plain' }, w.type === 'skin' ? 'スキン' : '素材') : formatBadge({ format: w.format, wsnVersion: w.wsn_version }),
      mine ? h('span', { class: `badge ${mine.state === 'update' ? 'update' : 'ok'}` }, mine.state === 'update' ? `入っている版 ${mine.version}→${w.version}` : 'フォルダにあり') : null,
      hiddenHere ? h('span', { class: 'badge plain' }, '候補から外しています') : null,
      w.refs.some((r) => r.entry.claim === 'proxy') && !w.refs.some((r) => r.entry.claim === 'author') ? h('span', { class: 'badge plain', title: '作者さん以外の方が登録したものです（作者さんは、登録フォームの「サイト認証」で引き取れます）' }, '代理登録') : null,
      foldersOf(w.key).map((f) => h('span', { class: 'badge folder' }, f.name)),
      w.listFound ? h('span', { class: 'badge update', title: `ファイル一覧（${w.listFound.list}）で見つけたファイル：${w.listFound.name}` }, `一覧の最新 ${w.listFound.version ? `ver ${w.listFound.version}` : w.listFound.name}`) : null),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary sm', disabled: !def, onclick: () => downloadWork(w) }, 'ダウンロード'),
      open ? h('button', { class: 'btn sm', onclick: () => editEntry({ work: w }) }, inOwn ? '編集' : '個人用カタログへ') : null,
      open ? h('button', { class: 'btn ghost sm', onclick: () => toggleHidden(w, !hiddenHere) }, hiddenHere ? '候補に戻す' : '候補から外す') : null,
      compactView() ? h('button', { class: 'btn ghost sm', 'aria-expanded': open ? 'true' : 'false', onclick: () => { if (open) S.expanded.delete(w.key); else S.expanded.add(w.key); render(); } }, open ? '▲ たたむ' : '▼ くわしく') : null));
  const meta = h('div', { class: 'meta' }, [w.author, `ver ${w.version}`, w.updated].filter(Boolean).join('・'),
    h('span', { class: 'row', style: 'display:inline-flex;margin-left:8px;gap:4px' }, w.refs.map((r) => h('span', { class: `badge src ${r.kind}` }, r.sourceName))));
  if (!open) return h('div', { class: `card work compact${hiddenHere ? ' hidden-work' : ''}` }, head, meta);
  return h('div', { class: `card work${hiddenHere ? ' hidden-work' : ''}` },
    head, meta,
    h('div', { class: 'row', style: 'margin:6px 0' },
      ['cw150', 'next', 'py'].map((k) => h('span', { class: `badge ${LV[w.compat?.[k] || 'unknown'][1]}` }, `${ENGINE_KINDS[k].short}：${LV[w.compat?.[k] || 'unknown'][0]}`)),
      w.convert === 'forbidden' ? h('span', { class: 'badge bad' }, '変換NG') : null,
      w.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
    // 共用カタログ（登録フォームから）の作品：作品IDと、直す・削除を依頼するフォーム
    ...w.refs.filter((r) => r.kind === 'shared' && S.catalogs.get(r.sourceId)?.links?.manage).slice(0, 1).map((r) => h('div', { class: 'row small muted', style: 'margin:2px 0 6px' },
      h('span', {}, `作品ID：${r.entry.id}（${r.sourceName}）`),
      h('button', { class: 'btn ghost sm', onclick: () => { toast(`フォームの「作品ID」に ${r.entry.id} と入れてください`, { ms: 9000 }); S.platform.openUrl(S.catalogs.get(r.sourceId).links.manage); } }, '登録を直す・削除を依頼'))),
    w.description ? descBlock(w.description) : null,
    introBlock(w),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, w.downloads.length ? 'DL先' : 'DL先：まだ登録されていません（「編集」から足せます）'),
    h('ul', { class: 'dl' }, w.downloads.map((d) => {
      const { age, role } = ageRoleOf(d.status);
      const isDef = def && d.url === def.url;
      return h('li', { class: d.status },
        isDef ? h('span', { class: 'badge ok', title: '「ダウンロード」を押すと、ここから取ります' }, '★デフォルト') : null,
        h('span', {}, dlLabel(d)),
        h('span', { class: 'badge plain' }, d.kind === 'direct' ? '直接DL' : d.kind === 'list' ? 'ファイル一覧' : d.fromList ? '一覧で見つけた最新' : 'ページ経由'),
        h('span', { class: `badge ${age === 'new' ? 'plain' : age === 'closed' ? 'bad' : 'plain'}` }, `${AGE[age]}${age === 'closed' && d.until ? ` ${d.until}` : ''}`),
        h('span', { class: 'badge plain' }, ROLE[role]),
        d.dlkey ? h('span', { class: 'badge plain', title: '個人用カタログに登録したDLキーを、同意画面に入れます' }, 'DLキーあり') : null,
        inAppSite(d.url) ? h('span', { class: 'badge plain', title: inAppSite(d.url).why }, 'アプリ内で開いて押す') : null,
        d.note ? h('span', { class: 'small muted' }, d.note) : null,
        d.status !== 'closed' ? h('button', { class: 'btn sm', onclick: () => downloadFrom(w, d) }, 'ここから取る') : null,
        d.status !== 'closed' && !isDef ? h('button', { class: 'btn ghost sm', onclick: async () => { await setDefaultUrl(w, d.url); toast(`「${dlLabel(d)}」をデフォルトのDL先にしました`); render(); } }, 'デフォルトにする') : null);
    })));
}

async function toggleHidden(w, hide) {
  const ids = S.filter.catSource ? [S.filter.catSource] : null;
  await setHidden(w, hide, ids);
  await refreshStates();
  S.selected.delete(w.key);
  toast(hide ? `「${w.name}」を候補から外しました（「候補から外したものも表示」で戻せます）` : `「${w.name}」を候補に戻しました`);
  render();
}

// ------------------------------------------------------------ 紹介ページ（HP・X・Misskeyなど）
function introBlock(w) {
  if (!w.intro.length) return null;
  const loaded = w.intro.some((i) => S.ogp.has(i.url));
  return h('div', { class: 'intro' },
    h('div', { class: 'row small' }, h('span', { class: 'muted' }, '紹介'),
      w.intro.map((i) => h('button', { class: 'btn ghost sm', title: i.url, onclick: () => S.platform.openUrl(i.url) },
        h('span', { class: 'badge plain' }, INTRO_LABEL[introKind(i.url)]), i.label || i.url.replace(/^https?:\/\//, '').slice(0, 40))),
      !loaded ? h('button', { class: 'btn sm', onclick: () => loadIntros(w) }, '紹介を見る') : null),
    loaded ? h('div', { class: 'intro-cards' }, w.intro.map((i) => ogpCard(i))) : null);
}

function ogpCard(i) {
  const o = S.ogp.get(i.url);
  if (!o) return null;
  if (o.status === 'loading') return h('div', { class: 'ogp small muted' }, '読み込み中…');
  if (o.status !== 'ok') {
    return h('div', { class: 'ogp small muted' },
      o.status === 'blocked' ? 'HTML版では、このサイトの紹介を読み込めません（ブラウザの制限）。' : `紹介を読み込めませんでした${o.message ? `（${o.message}）` : ''}。`,
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(i.url) }, '開いて見る'));
  }
  return h('div', { class: 'ogp' },
    o.img ? h('img', { src: o.img, alt: '', loading: 'lazy' }) : null,
    h('div', { class: 'ogp-text' },
      h('div', { class: 'small muted' }, [INTRO_LABEL[introKind(i.url)], o.site].filter(Boolean).join('・')),
      h('b', {}, o.title || i.url),
      o.description ? h('div', { class: 'small' }, o.description) : null,
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(i.url) }, '開く')));
}

async function loadIntros(w) {
  for (const i of w.intro) if (!S.ogp.has(i.url)) S.ogp.set(i.url, { status: 'loading' });
  render();
  for (const i of w.intro) {
    if (S.ogp.get(i.url)?.status !== 'loading') continue;
    S.ogp.set(i.url, await fetchOgp(i.url));
    render();
  }
}

async function fetchOgp(url) {
  try {
    const r = await S.platform.fetchResource(url, { headers: { Accept: 'text/html' } });
    if (r.blocked) return { status: 'blocked' };
    const og = parseOgp(decodeHtml(r.bytes, r.contentType), r.finalUrl || url);
    if (!og.title && !og.description) return { status: 'none', message: '紹介の情報が見つかりませんでした' };
    let img = '';
    if (og.image) {
      const ir = await S.platform.fetchResource(og.image).catch(() => null);
      const type = ir?.contentType?.split(';')[0] || '';
      if (ir && !ir.blocked && /^image\/(png|jpe?g|gif|webp|avif)$/i.test(type) && ir.bytes.length < 5 * 1024 * 1024) {
        img = URL.createObjectURL(new Blob([ir.bytes], { type }));
      }
    }
    return { status: 'ok', ...og, img };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// ------------------------------------------------------------ カタログの管理
const after = async (fn, msg) => {
  const r = await busy('カタログ', async () => { const x = await fn(); await refreshStates(); if (msg) toast(typeof msg === 'function' ? msg(x) : msg); return x; });
  // 読み込んだカタログにラベルが付いていれば、取り込むかどうか聞く
  if (r?.id && r.kind !== 'own' && labelsOf(r).length && !r.labelAsked) { r.labelAsked = true; await saveSources(); await labelDialog(r); }
  return r;
};

export function viewManage(open) {
  if (!open) {
    const n = S.sources.length;
    return h('div', { class: 'card row between manage-closed' },
      h('span', { class: 'small' }, `カタログ ${n}件（共用 ${S.sources.filter((s) => s.kind === 'shared').length}・個人用 ${S.sources.filter((s) => s.kind !== 'shared').length}）・候補に含めているもの ${S.sources.filter((s) => s.enabled).length}件`),
      h('button', { class: 'btn sm', onclick: () => { S.manageOpen = true; render(); } }, '▼ カタログの管理'));
  }
  const shared = S.sources.filter((s) => s.kind === 'shared');
  const personal = S.sources.filter((s) => s.kind !== 'shared');
  const section = (title, desc, list) => h('section', { class: 'manage-sec' },
    h('h3', {}, title),
    h('p', { class: 'small muted' }, desc),
    list.length ? h('div', { class: 'src-list' }, list.map(sourceRow)) : h('p', { class: 'small muted empty-src' }, 'まだありません。右上の「＋ カタログを追加」から追加できます。'));

  return h('div', { class: 'card stack manage', id: 'manage' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'カタログの管理'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: addCatalogDialog }, '＋ カタログを追加'),
        S.combined ? h('button', { class: 'btn ghost sm', onclick: () => { S.manageOpen = false; render(); } }, '▲ たたむ') : null)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'チェックを外したカタログの作品は、一覧・更新チェック・まとめてDLに出なくなります。'),
    section('共用カタログ', '作者さんが登録フォームから登録した作品のカタログです。', shared),
    section('個人用カタログ', '自分で作るカタログと、有志の方のDL一覧です。いくつでも持てます。', personal),
    h('p', { class: 'small muted', style: 'margin:0' }, '作品を登録するときの入れ先や、デフォルトのDL先の確認は ',
      h('button', { class: 'btn ghost sm', onclick: () => goTab('settings') }, '「設定」タブ'), ' で変えられます。'));
}

/** 「＋ カタログを追加」：何を足すかを選ぶ */
async function addCatalogDialog() {
  const done = await modal((close) => {
    const sharedUrl = h('input', { type: 'url', class: 'grow', placeholder: 'https://…/index.json', id: 'shared-url' });
    const listUrl = h('input', { type: 'url', class: 'grow', placeholder: 'https://…（DL一覧の .json）', id: 'list-url' });
    const ownName = h('input', { type: 'text', class: 'grow', placeholder: '例：お気に入り、短編まとめ', id: 'own-name' });
    const fileIn = h('input', {
      type: 'file', accept: '.json,application/json', hidden: true, id: 'list-file',
      onchange: async (ev) => {
        const f = ev.target.files[0];
        if (!f) return;
        close(true);
        await after(async () => importList({ json: JSON.parse(await f.text()), fileName: f.name }), (src) => `「${src.name}」を個人用カタログとして読み込みました（${src.count}件）`);
      },
    });
    const choice = (title, desc, ...body) => h('div', { class: 'add-choice' }, h('b', {}, title), h('div', { class: 'small muted' }, desc), h('div', { class: 'row' }, ...body));
    const go = (fn, msg) => { close(true); after(fn, msg); };
    return h('div', { class: 'stack' },
      h('h2', {}, 'カタログを追加'),
      choice('共用カタログをURLで追加', '作者さんが登録したカタログの index.json のURL（登録フォームのウェブアプリなら …/exec?file=index）を入れます。',
        sharedUrl, h('button', { class: 'btn primary', onclick: () => {
          const u = sharedUrl.value.trim();
          if (!/^https:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
          go(() => addShared(u), (src) => `「${src.name}」を追加しました（${src.count}件）`);
        } }, '追加')),
      choice('有志の方のDL一覧を読み込む', '人からもらったDL一覧（.json）を、個人用カタログの1つとして読み込みます。',
        h('button', { class: 'btn', onclick: () => fileIn.click() }, 'ファイルを選ぶ'), fileIn,
        h('span', { class: 'small muted' }, 'または'), listUrl,
        h('button', { class: 'btn', onclick: () => {
          const u = listUrl.value.trim();
          if (!/^https?:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
          go(() => importList({ url: u }), (src) => `「${src.name}」を読み込みました（${src.count}件）`);
        } }, 'URLから読み込む')),
      choice('個人用カタログを新しく作る', '自分で作品を登録していくカタログです。',
        ownName, h('button', { class: 'btn', onclick: () => {
          const name = ownName.value.trim().slice(0, 60);
          if (!name) { toast('カタログの名前を入れてください', { bad: true }); return; }
          go(() => createOwn(name), `「${name}」を作りました`);
        } }, '作る')),
      !S.sources.some((s) => s.url === 'sample') ? choice('お試し用のサンプル', '書式見本の作品が2件入ったカタログです（実在の作品ではありません）。',
        h('button', { class: 'btn', onclick: () => go(() => addShared('sample', 'サンプル'), 'サンプルのカタログを追加しました') }, 'サンプルを入れる')) : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(false) }, '閉じる')));
  });
  return done;
}

/** 「作品を個人用カタログに登録するとき」「デフォルトのDL先が使えないとき」の設定（設定タブに出す） */
export function prefsBlock() {
  const radio = (v, label) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'addTo', value: v, checked: S.catPrefs.addTo === v, onchange: () => setCatPrefs({ addTo: v }).then(render) }), label);
  return h('div', { class: 'stack small' },
    h('div', {}, h('div', { class: 'muted' }, '作品を個人用カタログに登録するとき'),
      h('div', { class: 'row' }, radio('all', 'すべての個人用カタログに入れる'), radio('choose', '入れるカタログを毎回選ぶ'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.catPrefs.askDefault, onchange: (ev) => setCatPrefs({ askDefault: ev.target.checked }) }),
      'デフォルトのDL先から取れず、別の配布元から取ったとき「こちらをデフォルトのDL先に変更しますか？」と聞く'));
}

function sourceRow(s) {
  const hidden = (s.hidden || []).length;
  const kindLabel = s.kind === 'own' ? '自分で作成' : s.kind === 'sub' ? `読み込み${s.url ? '（URL）' : '（ファイル）'}` : s.url === 'sample' ? 'サンプル' : 'URL';
  return h('div', { class: `src-row${s.enabled ? '' : ' off'}` },
    h('input', { type: 'checkbox', class: 'src-toggle', checked: s.enabled, 'aria-label': `${s.name}を候補に含める`, title: 'チェックを外すと、このカタログの作品は候補に出なくなります', onchange: (ev) => after(() => setEnabled(s, ev.target.checked)) }),
    h('div', { class: 'grow' },
      h('div', { class: 'row' }, h('b', {}, s.name), h('span', { class: 'badge plain' }, kindLabel), !s.enabled ? h('span', { class: 'badge plain' }, '候補に含めない') : null),
      h('div', { class: 'meta' }, [`${s.count || 0}件`, hidden ? `外した作品 ${hidden}件` : '', s.loadedAt ? `読み込み ${fmtDate(s.loadedAt)}` : ''].filter(Boolean).join('・'))),
    S.catalogs.get(s.id)?.links?.register ? h('button', { class: 'btn sm', title: '作者さん以外の方も登録できます（代理登録）', onclick: () => S.platform.openUrl(S.catalogs.get(s.id).links.register) }, '作品を登録する') : null,
    S.catalogs.get(s.id)?.links?.manage ? h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(S.catalogs.get(s.id).links.manage) }, '登録を直す・削除を依頼') : null,
    s.url ? h('button', { class: 'btn sm', onclick: () => after(() => refreshSource(s), (changed) => (changed ? `「${s.name}」を取り直しました（${s.count}件）` : '変わっていませんでした')) }, '取り直す') : null,
    h('button', { class: 'btn ghost sm', 'aria-label': `${s.name}のメニュー`, onclick: () => sourceMenu(s) }, '⋯'));
}

/** カタログごとのメニュー（書き出す・名前・コピー・削除） */
async function sourceMenu(s) {
  const act = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, s.name),
    s.url && s.url !== 'sample' ? h('p', { class: 'small muted', style: 'margin:0;word-break:break-all' }, s.url) : s.fileName ? h('p', { class: 'small muted', style: 'margin:0' }, `ファイル：${s.fileName}`) : null,
    h('div', { class: 'stack menu-list' },
      s.kind !== 'shared' ? h('button', { class: 'btn', onclick: () => close('export') }, 'DL一覧として書き出す（人に渡せるファイル）') : null,
      labelsOf(s).length ? h('button', { class: 'btn', onclick: () => close('labels') }, `ラベルを取り込む（${labelsOf(s).length}種類${s.labelSync ? '・自動で取り込み中' : ''}）`) : null,
      s.kind === 'sub' ? h('button', { class: 'btn', onclick: () => close('copy') }, 'コピーして自分用にする（自由に直せるようになります）') : null,
      h('button', { class: 'btn', onclick: () => close('rename') }, '名前を変える'),
      h('button', { class: 'btn danger', onclick: () => close('delete') }, s.kind === 'own' ? '削除する' : '外す')),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる'))));
  if (act === 'export') return exportList(s);
  if (act === 'labels') return labelDialog(s);
  if (act === 'copy') { const name = await askName('自分用にコピー', `${s.name}（コピー）`); if (name) after(() => createOwn(name, s), `「${name}」を作りました。こちらは自由に直せます`); return; }
  if (act === 'rename') { const name = await askName('名前を変える', s.name); if (name) { s.name = name; s.renamed = true; await saveSources(); after(async () => {}); } return; }
  if (act === 'delete') {
    const warn = s.kind === 'own' ? `「${s.name}」と、そこに登録した作品（${s.count || 0}件）を消します。先に「DL一覧として書き出す」で残しておくこともできます。よろしいですか？` : `「${s.name}」を外します。よろしいですか？`;
    if (await confirmBox(warn)) after(() => removeSource(s), `「${s.name}」を外しました`);
  }
}

async function exportList(s) {
  const entries = S.catalogs.get(s.id)?.entries || [];
  const hasKeys = entries.some((e) => e.downloads.some((d) => d.dlkey));
  // このカタログの作品が入っているフォルダ（ラベルとして書き出せる）
  const keys = new Set(entries.map((e) => workKey(e)));
  const folders = S.folders.list.map((f) => ({ f, n: [...keys].filter((k) => (S.folders.map[k] || []).includes(f.id)).length })).filter((x) => x.n);
  let includeKeys = false;
  let labels = null;
  if (hasKeys || folders.length) {
    const box = h('input', { type: 'checkbox', 'aria-label': 'DLキーも書き出す' });
    const labelOn = h('input', { type: 'checkbox', checked: true, id: 'export-labels', 'aria-label': 'フォルダをラベルとして書き出す' });
    const picks = folders.map((x) => ({ ...x, box: h('input', { type: 'checkbox', checked: true, 'aria-label': `${x.f.name}を書き出す` }) }));
    const pickBox = h('div', { class: 'row tag-pick' }, picks.map((p) => h('label', { class: 'chip' }, p.box, p.f.name, h('span', { class: 'n' }, p.n))));
    labelOn.addEventListener('change', () => { pickBox.hidden = !labelOn.checked; });
    const go = await modal((close) => h('div', { class: 'stack' },
      h('h2', {}, 'DL一覧として書き出す'),
      folders.length ? h('div', { class: 'stack' },
        h('label', { class: 'check' }, labelOn, 'フォルダ（作者さんごと・企画ごとなどの分け方）を、ラベルとして一緒に書き出す'),
        pickBox,
        h('p', { class: 'small muted', style: 'margin:0' }, '受け取った人は、ラベルを取り込むかどうか、どのラベルを取り込むかを選べます。')) : null,
      hasKeys ? h('div', { class: 'stack' },
        h('p', { style: 'margin:0' }, `「${s.name}」には、DLキーを入れた作品があります。`),
        h('label', { class: 'check' }, box, 'DLキーも書き出す'),
        h('p', { class: 'small muted', style: 'margin:0' }, '作者さんによっては、サイトに来てDLキーと注意書きを見てほしいと考えています。人に渡すときは、書き出さないのがおすすめです。')) : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
        h('button', { class: 'btn primary', onclick: () => close(true) }, '書き出す'))));
    if (!go) return;
    includeKeys = box.checked;
    if (folders.length && labelOn.checked) labels = new Set(picks.filter((p) => p.box.checked).map((p) => p.f.id));
  }
  const json = exportSource(s, { includeKeys, labels });
  const safe = s.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'dl-list';
  await S.platform.saveFile(`${safe}.json`, new TextEncoder().encode(JSON.stringify(json, null, 2)));
  toast(`${json.entries.length}件を「${safe}.json」に書き出しました。受け取った人は「DL一覧を読み込む」で使えます`, { ms: 9000 });
}

/** カタログに付いているラベルを、自分のフォルダとして取り込む（範囲を選ぶ） */
async function labelDialog(s) {
  const list = labelsOf(s);
  if (!list.length) { toast('このカタログにはラベルがありません'); return; }
  const sync = s.labelSync || null;
  const picks = list.map((l) => ({ ...l, box: h('input', { type: 'checkbox', checked: !sync?.names || sync.names.includes(l.name), 'aria-label': `ラベル「${l.name}」を取り込む` }) }));
  const prefix = h('input', { type: 'checkbox', checked: !!sync?.prefix, 'aria-label': 'カタログの名前を付けたフォルダにする' });
  const auto = h('input', { type: 'checkbox', checked: !!sync, 'aria-label': 'カタログを取り直したときも取り込む' });
  const res = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, `「${s.name}」のラベルを取り込む`),
    h('p', { class: 'small muted', style: 'margin:0' }, 'カタログを作った人が付けた分け方（作者さんごと・企画ごとなど）を、自分の「フォルダ」として取り込みます。取り込むラベルを選んでください。'),
    h('div', { class: 'row', style: 'gap:6px' },
      h('button', { class: 'btn sm', onclick: () => picks.forEach((p) => { p.box.checked = true; }) }, 'すべて選ぶ'),
      h('button', { class: 'btn ghost sm', onclick: () => picks.forEach((p) => { p.box.checked = false; }) }, 'すべて外す')),
    h('div', { class: 'row tag-pick', id: 'label-picks' }, picks.map((p) => h('label', { class: 'chip' }, p.box, p.name, h('span', { class: 'n' }, p.n)))),
    h('label', { class: 'check small' }, prefix, `フォルダの名前の前に、カタログの名前を付ける（例：「${s.name}：${list[0].name}」。自分のフォルダと混ざらないように）`),
    h('label', { class: 'check small' }, auto, 'このカタログを取り直したときも、選んだラベルを取り込む'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      s.labelSync ? h('button', { class: 'btn ghost', onclick: () => close('stop') }, '自動の取り込みをやめる') : null,
      h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
      h('button', { class: 'btn primary', id: 'label-go', onclick: () => close('go') }, '取り込む'))));
  if (res === 'stop') { s.labelSync = null; await saveSources(); toast('自動の取り込みをやめました'); return; }
  if (res !== 'go') return;
  const names = picks.filter((p) => p.box.checked).map((p) => p.name);
  if (!names.length) { toast('取り込むラベルを選んでください', { bad: true }); return; }
  const opt = { names: names.length === list.length && auto.checked ? null : names, prefix: prefix.checked };
  s.labelSync = auto.checked ? opt : null;
  await saveSources();
  const n = await importLabels(s, opt);
  toast(`${names.length}種類のラベルを取り込みました（${n}件をフォルダに入れました）`, { ms: 8000 });
  render();
}

function askName(title, value, label = 'カタログの名前') {
  return modal((close) => {
    const inp = h('input', { type: 'text', value, style: 'width:100%' });
    setTimeout(() => inp.focus(), 0);
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close(inp.value.trim().slice(0, 60) || null); } },
      h('h2', {}, title), h('label', { class: 'field' }, label, inp),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '決定')));
  });
}

// ------------------------------------------------------------ 個人用カタログへの登録・編集
const COMPAT_BY_FORMAT = {
  classic: { cw150: 'expected', next: 'expected', py: 'expected' },
  next: { cw150: 'no', next: 'expected', py: 'unknown' },
  wsn: { cw150: 'no', next: 'no', py: 'expected' },
};

/**
 * 作品を個人用カタログに登録する・直す。
 * @param {{work?: object, prefill?: {work?: object, entry?: object}}} args
 */
export async function editEntry({ work = null, prefill = null } = {}) {
  work = work || prefill?.work || null;
  if (!ownSources().length) await createOwn('マイカタログ');
  const ownRef = work?.refs.find((r) => r.kind === 'own');
  const base = ownRef?.entry || (work ? { ...work.refs[0].entry, downloads: work.downloads, intro: work.intro, tags: work.tags } : prefill?.entry) || {};
  const origKey = ownRef ? work.key : '';
  const inOwn = new Set(work ? work.refs.filter((r) => r.kind === 'own').map((r) => r.sourceId) : []);
  const preset = inOwn.size ? inOwn : new Set(S.catPrefs.addTo === 'all' ? ownSources().map((s) => s.id) : []);
  const curDefault = work ? defaultUrlOf(work) || chooseDownloads(work)[0]?.url || '' : '';

  const v = await modal((close) => {
    const f = {
      name: h('input', { type: 'text', value: base.name || '', required: true }),
      author: h('input', { type: 'text', value: base.author || '' }),
      version: h('input', { type: 'text', class: 'ver', value: base.version || '' }),
      updated: h('input', { type: 'date', value: base.updated || '' }),
      type: h('select', { 'aria-label': '種類' }, [['scenario', 'シナリオ'], ['skin', 'スキン（CardWirthPy）'], ['material', '素材（画像・音など）']].map(([k, l]) => h('option', { value: k, selected: (['scenario', 'skin'].includes(base.type || 'scenario') ? base.type || 'scenario' : 'material') === k ? 'selected' : null }, l))),
      format: h('select', {}, [['classic', 'クラシック（1.50・Next・Py）'], ['next', 'Next仕様'], ['wsn', 'Py仕様（WSN）']].map(([k, l]) => h('option', { value: k, selected: (base.format || 'classic') === k ? 'selected' : null }, l))),
      tags: h('input', { type: 'text', value: (base.tags || []).join('、'), placeholder: '探索、短編（「、」か「,」で区切る）' }),
      description: h('textarea', { rows: 4, style: 'width:100%' }),
    };
    f.description.value = base.description || '';
    const intros = (base.intro || []).map((i) => ({ ...i }));
    const dls = (base.downloads || []).filter((d) => !d.fromList).map((d) => ({ ...ageRoleOf(d.status), url: d.url, label: d.label || '', kind: d.kind || 'page', note: d.note || '', until: d.until || '', dlkey: d.dlkey || '', match: d.match || '' }));
    let def = curDefault || dls[0]?.url || '';

    const introBox = h('div', { class: 'stack' });
    const drawIntros = () => introBox.replaceChildren(
      ...intros.map((i, n) => h('div', { class: 'row edit-row' },
        h('span', { class: 'badge plain' }, INTRO_LABEL[introKind(i.url)]),
        h('input', { type: 'url', class: 'grow', value: i.url, placeholder: 'https://（作者さんのサイト・X・Misskeyの投稿など）', 'aria-label': '紹介ページのURL', oninput: (ev) => { i.url = ev.target.value.trim(); } }),
        h('input', { type: 'text', value: i.label, placeholder: '表示名（任意）', style: 'width:9em', oninput: (ev) => { i.label = ev.target.value; } }),
        h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': '消す', onclick: () => { intros.splice(n, 1); drawIntros(); } }, '×'))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { intros.push({ url: '', label: '' }); drawIntros(); } }, '＋紹介ページ'));
    drawIntros();

    const dlBox = h('div', { class: 'stack' });
    const sel = (opts, val, on, label) => h('select', { 'aria-label': label, onchange: (ev) => on(ev.target.value) }, Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: k === val ? 'selected' : null }, l)));
    const drawDls = () => dlBox.replaceChildren(
      // 注意書きの欄（adv）は行ごとに作る
      ...dls.map((d, n, _all, adv = h('div')) => h('div', { class: 'edit-dl' },
        h('div', { class: 'row' },
          h('label', { class: 'check small', title: '「ダウンロード」を押したときに、ここから取ります' },
            h('input', { type: 'radio', name: 'def-dl', checked: def === d.url && !!d.url, onchange: () => { def = d.url; } }), 'デフォルト'),
          h('input', { type: 'url', class: 'grow', value: d.url, placeholder: 'https://（zipのURL、または配布ページ）', 'aria-label': 'DL先のURL', oninput: (ev) => { const was = def === d.url; d.url = ev.target.value.trim(); if (was) def = d.url; showAdvice(adv, d.url); } }),
          h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': '消す', onclick: () => { dls.splice(n, 1); drawDls(); } }, '×')),
        showAdvice(adv, d.url),
        h('div', { class: 'row small' },
          h('input', { type: 'text', value: d.label, placeholder: '名前（例：作者サイト、uploader.jp）', style: 'width:11em', oninput: (ev) => { d.label = ev.target.value; } }),
          sel({ page: '配布ページ', direct: '直接DL（zipそのもの）', list: 'ファイル一覧（アップローダーなど）' }, d.kind, (x) => { d.kind = x; drawDls(); }, '種類'),
          d.kind === 'list' ? h('input', { type: 'text', value: d.match, placeholder: '一覧で探す名前（空なら作品名）', style: 'width:13em', 'aria-label': '一覧で探す名前', oninput: (ev) => { d.match = ev.target.value; } }) : null,
          sel({ new: '新（今の配布先）', old: '旧（移転済み）', closed: '終了' }, d.age, (x) => { d.age = x; }, '新旧'),
          sel({ normal: '通常', mirror: '予備' }, d.role, (x) => { d.role = x; }, '通常・予備'),
          h('input', { type: 'text', value: d.dlkey, placeholder: 'DLキー（任意）', style: 'width:9em', 'aria-label': 'DLキー', autocomplete: 'off', oninput: (ev) => { d.dlkey = ev.target.value.trim(); } }),
          h('input', { type: 'text', value: d.note, placeholder: 'メモ（例：作者さんのXで告知）', class: 'grow', oninput: (ev) => { d.note = ev.target.value; } })))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { dls.push({ url: '', label: '', kind: 'page', age: 'new', role: 'normal', note: '', until: '', dlkey: '' }); drawDls(); } }, '＋DL先'));
    drawDls();

    const targets = ownSources().map((s) => ({ s, box: h('input', { type: 'checkbox', checked: preset.has(s.id) }) }));
    const err = h('p', { class: 'note bad small', style: 'display:none' });
    const submit = (ev) => {
      ev.preventDefault();
      const fail = (m) => { err.textContent = m; err.style.display = ''; };
      const name = f.name.value.trim();
      if (!name) return fail('作品名を入れてください');
      const badUrl = [...intros.map((i) => i.url), ...dls.map((d) => d.url)].find((u) => u && !/^https?:\/\/\S+$/.test(u));
      if (badUrl) return fail(`URLは https:// から始まるものにしてください：${badUrl}`);
      const ids = targets.filter((t) => t.box.checked).map((t) => t.s.id);
      if (!ids.length && !inOwn.size) return fail('入れる個人用カタログを1つ以上選んでください');
      const format = f.format.value;
      const entry = {
        id: base.id && /^p\d+$/.test(base.id) ? base.id : 'p00000',
        owner: base.owner || '', type: f.type.value === 'material' && base.type && !['scenario', 'skin'].includes(base.type) ? base.type : f.type.value, name, author: f.author.value.trim(), version: f.version.value.trim(),
        updated: f.updated.value || '', format, wsn_version: format === 'wsn' ? base.wsn_version ?? null : null,
        compat: base.format === format && base.compat ? base.compat : COMPAT_BY_FORMAT[format], convert: base.convert || 'self',
        downloads: dls.filter((d) => d.url).map((d) => ({ label: d.label.trim(), url: d.url, kind: d.kind, status: statusOf(d.age, d.role), until: d.until, note: d.note.trim(), ...(d.dlkey ? { dlkey: d.dlkey } : {}), ...(d.kind === 'list' && d.match?.trim() ? { match: d.match.trim() } : {}) })),
        file: base.file || {}, readme: base.readme || '', level: base.level || null,
        tags: f.tags.value.split(/[、,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 30),
        description: f.description.value.trim(), requires: [], related: [], links: base.links || [],
        intro: intros.filter((i) => i.url).map((i) => ({ url: i.url, label: i.label.trim() })),
      };
      close({ entry, ids, def });
    };

    return h('form', { class: 'stack entry-edit', onsubmit: submit },
      h('h2', {}, origKey ? '個人用カタログの作品を直す' : '個人用カタログに登録'),
      work && !origKey ? h('p', { class: 'small muted', style: 'margin:0' }, '共用カタログ・読み込んだDL一覧の作品をコピーして、個人用カタログに入れます。元のカタログは変わりません。') : null,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '作品名', f.name),
        h('label', { class: 'field' }, '作者', f.author),
        h('label', { class: 'field' }, 'バージョン', f.version),
        h('label', { class: 'field' }, '更新日', f.updated),
        h('label', { class: 'field' }, '種類', f.type),
        h('label', { class: 'field' }, '形式（シナリオのとき）', f.format),
        h('label', { class: 'field' }, 'タグ', f.tags)),
      h('label', { class: 'field' }, '紹介文', f.description),
      h('div', {}, h('div', { class: 'small muted' }, '紹介ページ（DLの前に見てもらう、作者さんのサイト・X・Misskeyなど）'), introBox),
      h('div', {}, h('div', { class: 'small muted' }, 'DL先（「デフォルト」にしたところから先に取ります。取れなければ、新→予備→旧の順に試します）'), dlBox),
      h('p', { class: 'small muted', style: 'margin:0' }, '「ファイル一覧」にすると、アップローダーの一覧ページ（例：https://uu.getuploader.com/○○/）から、作品名に合うファイルのうち版がいちばん新しいものを、「更新チェック」のときに探します（アプリ版）。新しい版を上げるたびにURLが変わるアップローダーで便利です。'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'DLキーは、この個人用カタログの中だけに保存します（DL一覧として書き出すときは、書き出すかどうかを選べます）。'),
      h('div', {}, h('div', { class: 'small muted' }, `入れる個人用カタログ${inOwn.size ? '（チェックを外すと、そのカタログから抜けます）' : ''}`),
        h('div', { class: 'row' }, targets.map((t) => h('label', { class: 'check' }, t.box, t.s.name)))),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '保存')));
  });
  if (!v) return;
  await busy('保存中', async () => {
    await saveOwnEntry(v.entry, { origKey, targetIds: v.ids });
    const key = workKey(v.entry);
    const w = S.combined?.byKey.get(key);
    if (w && v.def && v.entry.downloads.some((d) => d.url === v.def)) await setDefaultUrl(w, v.def);
    await refreshStates();
    toast(v.ids.length ? `「${v.entry.name}」を${v.ids.map((id) => sourceById(id)?.name).join('・')}に保存しました` : `「${v.entry.name}」を個人用カタログから外しました`);
  });
}

/** DL先のURLについての注意（期限付き・OneDrive・Google ドライブ・アプリ内で押すサイト） */
function showAdvice(box, url) {
  const a = urlAdvice(url);
  box.className = a ? `small note ${a.level === 'warn' ? 'warn' : ''}` : '';
  box.textContent = a ? a.text : '';
  return box;
}
