// 自分のフォルダ一覧の「タグ」：
//  ・よく使うタグを先に用意しておく（最初は「積み」「プレイ中」「クリア」「お気に入り」）
//  ・作品を選んで、まとめて付ける・外す（検索で絞り込んでからでも）
//  ・タグで絞り込む・タグの名前を変える・消す
// カタログの「お気に入り」（作品・フォルダ）もここで扱う。

import { S, render, busy, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, modal } from './ui.js';

export const DEFAULT_TAGS = ['積み', 'プレイ中', 'クリア', 'お気に入り'];

export async function loadTags() {
  const saved = await store.get('tagList');
  S.tagList = Array.isArray(saved) ? saved : [...DEFAULT_TAGS];
  // 前から付いているタグも一覧に入れる
  for (const r of S.records) for (const t of r.tags || []) if (!S.tagList.includes(t)) S.tagList.push(t);
  S.favs = { works: [], folders: [], ...((await store.get('favs')) || {}) };
}
async function saveTags() { await store.set('tagList', S.tagList); }
export async function addTagName(t) {
  t = t.trim().slice(0, 40);
  if (t && !S.tagList.includes(t)) { S.tagList.push(t); await saveTags(); }
  return t;
}

/** 記録にタグを付ける・外す（まとめて） */
export async function applyTags(records, add = [], remove = []) {
  for (const r of records) {
    const set = new Set(r.tags || []);
    add.forEach((t) => set.add(t));
    remove.forEach((t) => set.delete(t));
    r.tags = [...set];
  }
  await store.putRecords(records);
  S.records = await store.records();
}

/** タグを選ぶ窓（複数選べる・新しいタグも作れる） */
export function pickTags(title, { mode = 'add', present = [] } = {}) {
  return modal((close) => {
    const chosen = new Set();
    const list = h('div', { class: 'tag-pick' });
    const names = () => (mode === 'remove' ? S.tagList.filter((t) => present.includes(t)) : S.tagList);
    const draw = () => list.replaceChildren(...(names().length ? names().map((t) => h('label', { class: `chip${chosen.has(t) ? ' on' : ''}` },
      h('input', { type: 'checkbox', checked: chosen.has(t), onchange: (ev) => { if (ev.target.checked) chosen.add(t); else chosen.delete(t); draw(); } }), t)) : [h('span', { class: 'small muted' }, 'まだタグがありません')]));
    const newIn = h('input', { type: 'text', class: 'grow', placeholder: '新しいタグ', 'aria-label': '新しいタグ' });
    const addNew = async () => {
      const t = await addTagName(newIn.value);
      if (!t) return;
      chosen.add(t);
      newIn.value = '';
      draw();
    };
    newIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addNew(); } });
    draw();
    return h('div', { class: 'stack' },
      h('h2', {}, title),
      list,
      mode === 'add' ? h('div', { class: 'row' }, newIn, h('button', { class: 'btn', onclick: addNew }, '＋タグを作る')) : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { class: 'btn primary', onclick: () => close([...chosen]) }, mode === 'add' ? '付ける' : '外す')));
  });
}

/** 1件のタグの欄：付いているタグ（×で外す）＋入力欄（候補つき）＋「追加」ボタン */
export function tagEditor(r, save) {
  const listId = 'tag-suggest';
  if (!document.getElementById(listId)) {
    document.body.append(h('datalist', { id: listId }));
  }
  document.getElementById(listId).replaceChildren(...S.tagList.map((t) => h('option', { value: t })));
  const input = h('input', { type: 'text', class: 'sm', placeholder: 'タグ', style: 'width:8em', 'aria-label': 'タグを追加', list: listId });
  const add = async () => {
    const t = await addTagName(input.value);
    if (!t) return;
    await save({ tags: [...new Set([...(r.tags || []), t])] });
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } });
  return h('span', { class: 'row tag-editor' },
    (r.tags || []).map((t) => h('span', { class: 'tag' }, t,
      h('button', { 'aria-label': `${t}を外す`, onclick: () => save({ tags: r.tags.filter((x) => x !== t) }) }, '×'))),
    input,
    h('button', { class: 'btn sm', 'aria-label': 'タグを追加する', onclick: add }, '＋追加'));
}

/** タグで絞り込む並び（すべて・各タグ・タグなし） */
export function tagChips(recs) {
  const count = (t) => recs.filter((r) => (t === '__none' ? !(r.tags || []).length : (r.tags || []).includes(t))).length;
  const chip = (t, label, n) => h('button', {
    class: `chip${S.filter.mineTag === t ? ' on' : ''}`, 'aria-pressed': S.filter.mineTag === t ? 'true' : 'false',
    onclick: () => { S.filter.mineTag = t; render(); },
  }, label, h('span', { class: 'n' }, n));
  return h('div', { class: 'row folder-chips', style: 'margin-top:8px' },
    h('span', { class: 'small muted' }, 'タグ'),
    chip('', 'すべて', recs.length),
    S.tagList.map((t) => chip(t, t, count(t))),
    chip('__none', 'タグなし', count('__none')),
    h('button', { class: 'btn ghost sm', onclick: manageTags }, 'タグの整理'));
}

/** タグの名前を変える・順番・消す（付けてある作品にもまとめて反映） */
export async function manageTags() {
  await modal((close) => {
    const body = h('div', { class: 'stack' });
    const newIn = h('input', { type: 'text', class: 'grow', placeholder: '新しいタグ', 'aria-label': '新しいタグの名前' });
    const draw = () => body.replaceChildren(...S.tagList.map((t, i) => h('div', { class: 'row src-row' },
      h('b', { class: 'grow' }, t),
      h('span', { class: 'small muted' }, `${S.records.filter((r) => (r.tags || []).includes(t)).length}件`),
      h('button', { class: 'btn ghost sm', disabled: i === 0, 'aria-label': '上へ', onclick: async () => { [S.tagList[i - 1], S.tagList[i]] = [S.tagList[i], S.tagList[i - 1]]; await saveTags(); draw(); } }, '↑'),
      h('button', { class: 'btn ghost sm', disabled: i === S.tagList.length - 1, 'aria-label': '下へ', onclick: async () => { [S.tagList[i + 1], S.tagList[i]] = [S.tagList[i], S.tagList[i + 1]]; await saveTags(); draw(); } }, '↓'),
      h('button', {
        class: 'btn ghost sm', onclick: async () => {
          const n = await modal((c) => { const inp = h('input', { type: 'text', value: t, style: 'width:100%' }); return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); c(inp.value.trim().slice(0, 40) || null); } }, h('h2', {}, 'タグの名前を変える'), inp, h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { type: 'button', class: 'btn', onclick: () => c(null) }, 'やめる'), h('button', { type: 'submit', class: 'btn primary' }, '決定'))); });
          if (!n || n === t) return;
          await busy('タグの名前を変える', async () => {
            const recs = S.records.filter((r) => (r.tags || []).includes(t));
            await applyTags(recs, [n], [t]);
            S.tagList[i] = n;
            S.tagList = [...new Set(S.tagList)];
            await saveTags();
            if (S.filter.mineTag === t) S.filter.mineTag = n;
          });
          draw();
        },
      }, '名前'),
      h('button', {
        class: 'btn ghost sm danger', onclick: async () => {
          const n = S.records.filter((r) => (r.tags || []).includes(t)).length;
          if (!(await confirmBox(`タグ「${t}」を消します${n ? `（付けてある${n}件からも外します。作品は消えません）` : ''}。よろしいですか？`))) return;
          await applyTags(S.records.filter((r) => (r.tags || []).includes(t)), [], [t]);
          S.tagList = S.tagList.filter((x) => x !== t);
          await saveTags();
          if (S.filter.mineTag === t) S.filter.mineTag = '';
          draw();
        },
      }, '消す'))));
    draw();
    return h('div', { class: 'stack' }, h('h2', {}, 'タグの整理'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'ここで作ったタグは、作品を選んで「タグを付ける」で、まとめて付けられます。'),
      body,
      h('div', { class: 'row' }, newIn, h('button', { class: 'btn', onclick: async () => { if (await addTagName(newIn.value)) { newIn.value = ''; draw(); } } }, '＋タグを作る')),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる')));
  });
  render();
}

// ------------------------------------------------------------ カタログのお気に入り（作品・フォルダ）
async function saveFavs() { await store.set('favs', S.favs); }
export const isFavWork = (key) => S.favs.works.includes(key);
export const isFavFolder = (id) => S.favs.folders.includes(id);
/** お気に入りの作品か、お気に入りのフォルダに入っている作品 */
export const inFavorites = (w) => isFavWork(w.key) || (S.folders.map[w.key] || []).some(isFavFolder);
export async function setFavWorks(keys, on) {
  const set = new Set(S.favs.works);
  keys.forEach((k) => (on ? set.add(k) : set.delete(k)));
  S.favs.works = [...set];
  await saveFavs();
}
export async function toggleFavFolder(id) {
  S.favs.folders = isFavFolder(id) ? S.favs.folders.filter((x) => x !== id) : [...S.favs.folders, id];
  await saveFavs();
}
