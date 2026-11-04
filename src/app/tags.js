// 自分のフォルダ一覧の「タグ」：
//  ・よく使うタグを先に用意しておく（最初は「後で遊ぶ」「プレイ中」「クリア」「お気に入り」）
//  ・作品を選んで、まとめて付ける・外す（検索で絞り込んでからでも）
//  ・タグで絞り込む・タグの名前を変える・消す
// カタログの「お気に入り」（作品・フォルダ）もここで扱う。

import { S, render, busy, confirmBox } from './state.js';
import { insertTag, arrangeTags } from '../core/tagorder.js';
import { store } from './store.js';
import { h, toast, modal } from './ui.js';
import { icon } from './icons.js';

export const DEFAULT_TAGS = ['後で遊ぶ', 'プレイ中', 'クリア', 'お気に入り'];
const OLD_TSUMI = '積み'; // 0.9.1 までの名前（読み込むときに「後で遊ぶ」に直す）

export async function loadTags() {
  const saved = await store.get('tagList');
  S.tagList = Array.isArray(saved) ? saved : [...DEFAULT_TAGS];
  // 「積み」タグは「後で遊ぶ」に名前が変わった（一度だけ直す）
  if (!(await store.get('tagRenamedTsumi'))) {
    const fixed = S.records.filter((r) => (r.tags || []).includes(OLD_TSUMI));
    for (const r of fixed) r.tags = [...new Set(r.tags.map((t) => (t === OLD_TSUMI ? '後で遊ぶ' : t)))];
    if (fixed.length) { await store.putRecords(fixed); S.records = await store.records(); }
    S.tagList = [...new Set(S.tagList.map((t) => (t === OLD_TSUMI ? '後で遊ぶ' : t)))];
    await store.set('tagList', S.tagList);
    await store.set('tagRenamedTsumi', true);
  }
  // 前から付いているタグも一覧に入れる
  for (const r of S.records) for (const t of r.tags || []) if (!S.tagList.includes(t)) S.tagList = insertTag(S.tagList, t);
  S.favs = { works: [], folders: [], ...((await store.get('favs')) || {}) };
  S.autoTag = (await store.get('autoTag', true)) !== false;
  // カタログのタグ：入れるときに自分のタグとして付けるか（最初はオフ）・自分のフォルダ一覧に出すか（最初はオン）
  S.catTagAuto = (await store.get('catTagAuto', false)) === true;
  S.catTagShow = (await store.get('catTagShow', true)) !== false;
  // 個人用カタログに登録するとき（共用カタログから写す・自分のフォルダから登録する）、タグも引き継ぐか（最初はオン）
  S.tagCopy = (await store.get('tagCopy', true)) !== false;
}
export async function setTagCopy(on) { S.tagCopy = !!on; await store.set('tagCopy', S.tagCopy); }
export async function setCatTagAuto(on) { S.catTagAuto = !!on; await store.set('catTagAuto', S.catTagAuto); }
export async function setCatTagShow(on) { S.catTagShow = !!on; await store.set('catTagShow', S.catTagShow); }
/** カタログのタグの呼び方：作者様本人の登録の作品は「作者様推奨タグ」、ほかは「カタログのタグ」 */
export const catTagLabel = (work) => (work?.refs?.some((r) => r.entry?.claim === 'author') ? '作者様推奨タグ' : 'カタログのタグ');
async function saveTags() { await store.set('tagList', S.tagList); }
export async function addTagName(t) {
  t = t.trim().slice(0, 40);
  // 対象レベルのタグ（Lv3以上・Lv5以下）は、後ろのレベルのタグのまとまりに、決まった順で入れる
  if (t && !S.tagList.includes(t)) { S.tagList = insertTag(S.tagList, t); await saveTags(); }
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
    const tools = h('div', { class: 'tag-tools' });
    const newIn = h('input', { type: 'text', class: 'grow', placeholder: '新しいタグ', 'aria-label': '新しいタグの名前' });
    // 選択モード：チェックを付けたタグを、まとめて上下に動かす
    let selMode = false;
    const sel = new Set();
    const moveSel = async (how) => {
      S.tagList = moveTags(S.tagList, sel, how);
      await saveTags();
      draw();
    };
    const drawTools = () => {
      const picked = S.tagList.filter((t) => sel.has(t));
      const k = picked.length;
      const atTop = !k || S.tagList.slice(0, k).every((t) => sel.has(t));
      const atBottom = !k || S.tagList.slice(-k).every((t) => sel.has(t));
      tools.classList.toggle('on', selMode);
      // replaceChildren は null を「null」という文字にしてしまうので、出さないものは外してから渡す
      tools.replaceChildren(...[
        h('div', { class: 'row' },
          h('button', {
            class: `btn sm select-mode${selMode ? ' on' : ''}`, id: 'tag-select-mode', 'aria-pressed': selMode ? 'true' : 'false',
            title: selMode ? '押すと選択モードを終わります（選んだものは外れます）' : '押すと、タグにチェック欄が出て、まとめて順番を変えられます',
            onclick: () => { selMode = !selMode; if (!selMode) sel.clear(); draw(); },
          }, icon('check'), `選択モード：${selMode ? 'ON' : 'OFF'}`)),
        selMode ? h('div', { class: 'row sel-actions' },
          h('b', { class: 'small' }, `選んだタグ（${k}件）を：`),
          h('button', { class: 'btn sm', disabled: atTop, onclick: () => moveSel('top') }, '一番上へ'),
          h('button', { class: 'btn sm', disabled: atTop, onclick: () => moveSel('up') }, '1つ上へ'),
          h('button', { class: 'btn sm', disabled: atBottom, onclick: () => moveSel('down') }, '1つ下へ'),
          h('button', { class: 'btn sm', disabled: atBottom, onclick: () => moveSel('bottom') }, '一番下へ')) : null,
      ].filter(Boolean));
    };
    const draw = () => { drawTools(); body.replaceChildren(...S.tagList.map((t, i) => h('div', { class: 'row src-row tag-row', 'data-tag': t },
      h('span', { class: 'drag-grip', title: 'つかんで上下に動かすと、順番を変えられます', 'aria-hidden': 'true', onpointerdown: (ev) => dragTag(ev, body, draw) }, icon('grip')),
      selMode ? h('input', { type: 'checkbox', checked: sel.has(t), 'aria-label': `「${t}」を選ぶ`, onchange: (ev) => { if (ev.target.checked) sel.add(t); else sel.delete(t); drawTools(); } }) : null,
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
            if (sel.delete(t)) sel.add(n);
            await saveTags();
            if (S.filter.mineTag === t) S.filter.mineTag = n;
          });
          draw();
        },
      }, '名前'),
      h('button', {
        class: 'btn ghost sm danger', onclick: async () => {
          const n = S.records.filter((r) => (r.tags || []).includes(t)).length;
          if (!(await confirmBox(`タグ「${t}」を消します${n ? `（付けてある${n}件からも外します、作品は消えません）` : ''}。よろしいですか？`))) return;
          await applyTags(S.records.filter((r) => (r.tags || []).includes(t)), [], [t]);
          S.tagList = S.tagList.filter((x) => x !== t);
          sel.delete(t);
          await saveTags();
          if (S.filter.mineTag === t) S.filter.mineTag = '';
          draw();
        },
      }, '消す')))); };
    draw();
    return h('div', { class: 'stack' }, h('h2', {}, 'タグの整理'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'ここで作ったタグは、作品を選んで「タグを付ける」で、まとめて付けられます。'),
      h('div', { class: 'row' },
        h('button', {
          class: 'btn sm', id: 'tag-arrange', title: '「後で遊ぶ」「プレイ中」「クリア」「お気に入り」のあとに、店シナ → 読み物 → 人数 → 人数専用 → シナリオの長さ → 戦闘・Lv → そのほか の順に並べます',
          onclick: async () => {
            if (!(await confirmBox('タグを、店シナ → 読み物 → 人数 → 人数専用 → シナリオの長さ → 戦闘・Lv → そのほか の順に並べ替えます。（「後で遊ぶ」「プレイ中」「クリア」「お気に入り」はいちばん上のまま、「そのほか」は今の順のままです）よろしいですか？', { yes: '並べ替える', no: 'やめる' }))) return;
            S.tagList = arrangeTags(S.tagList, DEFAULT_TAGS);
            await saveTags();
            draw();
          },
        }, 'タグを自動で整える'),
        h('span', { class: 'small muted' }, '店シナ・読み物・人数・人数専用・長さ・戦闘とLv・そのほか、の順に並べます')),
      tools,
      body,
      h('div', { class: 'row' }, newIn, h('button', { class: 'btn', onclick: async () => { if (await addTagName(newIn.value)) { newIn.value = ''; draw(); } } }, '＋タグを作る')),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる')));
  });
  render();
}

/**
 * 選んだタグをまとめて動かす（選んだもの同士の順番はそのまま）
 * @param {string[]} list 今の順番
 * @param {Set<string>} picked 選んだタグ
 * @param {'top'|'up'|'down'|'bottom'} how
 */
export function moveTags(list, picked, how) {
  const a = [...list];
  if (how === 'top') return [...a.filter((t) => picked.has(t)), ...a.filter((t) => !picked.has(t))];
  if (how === 'bottom') return [...a.filter((t) => !picked.has(t)), ...a.filter((t) => picked.has(t))];
  if (how === 'up') {
    for (let i = 1; i < a.length; i++) if (picked.has(a[i]) && !picked.has(a[i - 1])) [a[i - 1], a[i]] = [a[i], a[i - 1]];
  } else if (how === 'down') {
    for (let i = a.length - 2; i >= 0; i--) if (picked.has(a[i]) && !picked.has(a[i + 1])) [a[i + 1], a[i]] = [a[i], a[i + 1]];
  }
  return a;
}

/**
 * タグの整理：左のつまみ（⋮⋮）をつかんで上下に動かし、順番を変える（マウスでも指でも）
 * 動かしている間は行だけを入れ替え、離したときに順番を保存する
 */
function dragTag(ev, body, draw) {
  if (ev.button > 0) return;
  const row = ev.currentTarget.closest('.tag-row');
  if (!row) return;
  ev.preventDefault();
  const grip = ev.currentTarget;
  grip.setPointerCapture?.(ev.pointerId);
  const box = row.closest('dialog');
  row.classList.add('dragging');
  let lastY = ev.clientY;
  let timer = 0;
  // つかんでいる行そのものは動かさず、ほかの行を前後へ動かす（つかんだ行を動かすと、指・マウスの追いかけが切れるため）
  const place = (y) => {
    const others = [...body.querySelectorAll('.tag-row')].filter((r) => r !== row);
    let at = others.findIndex((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
    if (at < 0) at = others.length;
    const want = [...others.slice(0, at), row, ...others.slice(at)];
    if ([...body.children].every((e, i) => e === want[i])) return;
    others.slice(0, at).forEach((r) => body.insertBefore(r, row));
    others.slice(at).forEach((r) => body.append(r));
  };
  // 窓の端に近づいたら、少しずつ送る（タグが多いとき・スマホ）
  const edge = () => {
    if (!box) return;
    const b = box.getBoundingClientRect();
    const d = lastY < b.top + 40 ? -8 : lastY > b.bottom - 40 ? 8 : 0;
    if (d) { box.scrollTop += d; place(lastY); }
    timer = requestAnimationFrame(edge);
  };
  timer = requestAnimationFrame(edge);
  const move = (e) => { lastY = e.clientY; place(lastY); };
  let done = false;
  const end = async () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(timer);
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', end);
    grip.removeEventListener('pointercancel', end);
    grip.removeEventListener('lostpointercapture', end);
    row.classList.remove('dragging');
    const order = [...body.querySelectorAll('.tag-row')].map((r) => r.dataset.tag);
    if (order.join('\n') !== S.tagList.join('\n')) { S.tagList = order; await saveTags(); }
    draw();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
  grip.addEventListener('lostpointercapture', end);
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
