// 自分のフォルダ一覧の、まとめての操作（削除・コピー・選んだものへのタグ／お気に入り）
//   場所（loc）：{ kind: 'engine', id } ／ { kind: 'material' } ／ { kind: 'skin' }
//   もの（item）：{ rel: 'Scenario/_店/サンプル店' のような、その場所の中の相対パス, name, isFolder }
import { S, render, busy, busyText, dirOf, engine } from './state.js';
import { store } from './store.js';
import { h, toast, modal } from './ui.js';
import { moveToBackup } from '../core/install.js';
import { existsAt, removeAt, dirAt, readAt, writeAt, copyTree } from '../core/fs.js';
import { backupOpts, backupFull, backupPlace } from './backup.js';
import { KINDS, MAT, SKIN, stashDirOf, scanStash, showLog, openBtn } from './materials.js';
import { catPicker } from './catpick.js';
import { confirmDelete } from './folderview.js';
import { safeRelativePath } from '../core/zip.js';
import { addTagName } from './tags.js';

const isApp = () => S.platform.kind === 'app';
let rescanEngine = async () => {};
/** エンジンを読み取り直す関数（app.js から渡す） */
export function setRescanEngine(fn) { rescanEngine = fn; }

export const locOfId = (id) => (id === MAT ? { kind: 'material' } : id === SKIN ? { kind: 'skin' } : { kind: 'engine', id });
const idOf = (loc) => (loc.kind === 'engine' ? loc.id : KINDS[loc.kind].id);
const placeName = (loc) => (loc.kind === 'engine' ? engine(loc.id)?.name || '' : KINDS[loc.kind].place);
const refOf = (loc) => (loc.kind === 'engine' ? engine(loc.id)?.ref : S.stash?.[loc.kind]?.ref);
const rootOf = async (loc) => {
  const d = loc.kind === 'engine' ? await dirOf(loc.id, true) : await stashDirOf(loc.kind, true);
  if (!d) throw new Error(`${placeName(loc)}のフォルダに接続できませんでした`);
  return d;
};
const absPath = (loc, rel) => [String(refOf(loc) || '').replace(/[\\/]+$/, ''), ...rel.split('/').filter(Boolean)].join('\\');
/** フォルダ表示のフォルダ（'_店' など）→ その場所の中の相対パス */
export const folderRel = (loc, folder) => (loc.kind === 'engine' ? `Scenario/${folder}` : folder);
const bkKind = (loc) => (loc.kind === 'engine' ? 'engine' : loc.kind);

/** 消したもの・移したものの記録と、分類フォルダの一覧を直す */
async function forget(loc, rel) {
  const id = idOf(loc);
  for (const r of S.records.filter((x) => x.engineId === id && (x.path === rel || x.path?.startsWith(`${rel}/`)))) {
    await store.deleteRecord(r.id);
    S.mineSel.delete(r.id);
  }
  const cat = loc.kind === 'engine' ? rel.replace(/^Scenario\/?/, '') : rel;
  if (cat && S.categories[id]) {
    S.categories[id] = S.categories[id].filter((c) => c !== cat && !c.startsWith(`${cat}/`));
    await store.set('categories', S.categories);
  }
  S.folderSel?.delete(`${id}:${cat}`);
}

/**
 * 削除する（確認してから）。消し方：ごみ箱（アプリ版）・バックアップ・完全に削除
 * @param {object} loc
 * @param {{rel: string, name: string, isFolder?: boolean}[]} items
 */
export async function deleteItems(loc, items, { note = '' } = {}) {
  if (!items.length) return;
  const folders = items.filter((it) => it.isFolder).length;
  const name = items.length === 1 ? items[0].name : `選んだ${items.length}件（${folders ? `フォルダ${folders}件・` : ''}作品・データ${items.length - folders}件）`;
  const ans = await confirmDelete({
    name, path: items.map((it) => it.rel).join('\n'), place: backupPlace(bkKind(loc), loc.id),
    note: note || (folders ? '※フォルダの中身もすべて削除されます。' : ''),
  });
  if (!ans) return;
  const log = await busy('削除する', async () => {
    const d = await rootOf(loc);
    const out = [];
    for (const [i, it] of items.entries()) {
      busyText(`削除しています… ${i + 1}/${items.length}`);
      try {
        if (!(await existsAt(d, it.rel))) throw new Error('見つかりません');
        if (ans.how === 'trash') {
          await S.platform.trash(absPath(loc, it.rel));
          out.push(`ごみ箱へ移動　${it.rel}`);
        } else if (ans.how === 'backup') {
          const dest = await moveToBackup(d, it.rel, { anywhere: loc.kind !== 'engine', ...(await backupOpts(bkKind(loc), loc.id)) });
          out.push(`移動　${it.rel}\n　　→ ${backupFull(bkKind(loc), loc.id, dest)}`);
        } else {
          await removeAt(d, it.rel);
          out.push(`削除　${it.rel}`);
        }
        await forget(loc, it.rel);
      } catch (e) {
        out.push(`失敗　${it.rel}：${e.message}`);
      }
    }
    S.records = await store.records();
    return out;
  });
  if (!log) return;
  if (items.length === 1 && !log[0].startsWith('失敗')) toast(ans.how === 'trash' ? 'ごみ箱に移動しました' : ans.how === 'backup' ? `削除しました（${log[0].split('→ ')[1] ? `バックアップ：${log[0].split('→ ')[1]}` : 'バックアップを取りました'}）` : '削除しました', { ms: 8000 });
  else await showLog(`削除しました（${items.length}件）`, log);
  render();
}

/** コピーする先を選ぶ：エンジン（の Scenario の中）・素材の置き場所・スキンの置き場所、その中のフォルダ */
async function pickCopyDest(count) {
  const targets = [
    ...S.engines.map((e) => ({ loc: { kind: 'engine', id: e.id }, label: `${e.name}（Scenario）` })),
    ...['material', 'skin'].filter((k) => S.stash?.[k]?.ref).map((k) => ({ loc: { kind: k }, label: KINDS[k].place })),
  ];
  if (!targets.length) { toast('コピーできる場所がありません', { bad: true }); return null; }
  return modal((close) => {
    const state = {};
    let ti = 0;
    const holder = h('div', {});
    const draw = () => {
      const t = targets[ti];
      Object.keys(state).forEach((k) => delete state[k]);
      const cp = catPicker({ cats: S.categories[idOf(t.loc)] || [], rootLabel: t.loc.kind === 'engine' ? '（Scenario の直下）' : `（${KINDS[t.loc.kind].place}の直下）`, state, idPrefix: 'copy', nested: t.loc.kind === 'engine' });
      holder.replaceChildren(cp.el);
      holder.value = cp.value;
    };
    const sel = h('select', { id: 'copy-target', 'aria-label': 'コピーする先' }, targets.map((t, i) => h('option', { value: String(i) }, t.label)));
    sel.addEventListener('change', () => { ti = Number(sel.value); draw(); });
    draw();
    return h('div', { class: 'stack', id: 'copy-dialog' },
      h('h2', {}, '📋 コピーする先を選択'),
      h('p', { class: 'small muted', style: 'margin:0' }, `${count}件をコピーします。元のものはそのまま残ります。`),
      h('label', { class: 'field' }, h('span', {}, 'コピーする先'), sel),
      holder,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', {
          class: 'btn primary', id: 'copy-go', onclick: () => {
            const c = holder.value();
            if (state.isNew && !c) { toast('新しいフォルダの名前を入れてください', { bad: true }); return; }
            if (state.isNew && (/[/\\]/.test((state.newCat || '').trim()) || !safeRelativePath(c))) { toast('フォルダの名前が正しくありません（「/」「\\」や「..」は使えません）', { bad: true }); return; }
            close({ loc: targets[ti].loc, cat: c === '__auto' ? '' : c });
          },
        }, 'ここにコピーする')));
  });
}

/**
 * コピーする（コピーする先を選んでから）
 * @param {object} loc 元の場所
 * @param {{rel: string, name: string, isFolder?: boolean}[]} items
 */
export async function copyItems(loc, items) {
  if (!items.length) return;
  const dest = await pickCopyDest(items.length);
  if (!dest) return;
  const base = [dest.loc.kind === 'engine' ? 'Scenario' : '', dest.cat].filter(Boolean).join('/');
  const log = await busy('コピーする', async () => {
    const src = await rootOf(loc);
    const dst = await rootOf(dest.loc);
    const out = [];
    for (const [i, it] of items.entries()) {
      busyText(`コピーしています… ${i + 1}/${items.length}`);
      const name = it.rel.split('/').pop();
      const to = [base, name].filter(Boolean).join('/');
      try {
        if (idOf(loc) === idOf(dest.loc) && (to === it.rel || to.startsWith(`${it.rel}/`))) throw new Error('同じ場所・自分の中にはコピーできません');
        if (await existsAt(dst, to)) throw new Error(`コピーする先に同じ名前のものがあります：${to}`);
        const kind = await existsAt(src, it.rel);
        if (!kind) throw new Error('見つかりません');
        if (kind === 'dir') await copyTree(await dirAt(src, it.rel), await dirAt(dst, to, { create: true }));
        else await writeAt(dst, to, await readAt(src, it.rel));
        out.push(`コピー　${it.rel}\n　　→ ${placeName(dest.loc)}：${to}`);
      } catch (e) {
        out.push(`失敗　${it.rel}：${e.message}`);
      }
    }
    return out;
  });
  if (!log) return;
  // コピーした先を読み取り直して、一覧に出す
  if (dest.loc.kind === 'engine') await rescanEngine(dest.loc.id);
  else await busy(`${KINDS[dest.loc.kind].label}を読み取る`, () => scanStash(dest.loc.kind, true));
  // コピーした先のフォルダを、エクスプローラーで開けるようにする（アプリ版だけ。下の方に出す）
  const destPath = absPath(dest.loc, base);
  await modal((close) => h('div', { class: 'stack', id: 'copy-done' },
    h('h2', {}, `コピーしました（${items.length}件）`),
    h('pre', { class: 'readme log' }, log.join('\n')),
    h('div', { class: 'row', style: 'justify-content:space-between' },
      h('div', { class: 'row' },
        h('span', { class: 'small muted', style: 'word-break:break-all' }, `コピーした先：${placeName(dest.loc)}${base ? `／${base}` : ''}`),
        isApp() ? openBtn(destPath, 'コピーした先をエクスプローラーで開く') : null),
      h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる'))));
  render();
}

/** 選んだもの（作品と、フォルダ表示で選んだフォルダ）を、操作できる形にする */
export function selection(loc, recs) {
  const id = idOf(loc);
  const folders = [...(S.folderSel || [])].filter((k) => k.startsWith(`${id}:`)).map((k) => k.slice(id.length + 1));
  const fRels = folders.map((f) => folderRel(loc, f));
  const inFolder = (path) => fRels.some((f) => path === f || path?.startsWith(`${f}/`));
  const picked = recs.filter((r) => S.mineSel.has(r.id));
  // タグ・お気に入りなどは、選んだフォルダの中の作品も含める
  const records = [...new Map([...picked, ...recs.filter((r) => inFolder(r.path))].map((r) => [r.id, r])).values()];
  // 削除・コピーは、フォルダはフォルダごと。フォルダの中で選んだ作品は二重にしない。zipの中の複数作品は1つのファイルとして扱う
  const items = [
    ...folders.filter((f) => !folders.some((g) => g !== f && f.startsWith(`${g}/`))).map((f) => ({ rel: folderRel(loc, f), name: f.split('/').pop(), isFolder: true })),
    ...[...new Map(picked.filter((r) => r.path && r.type !== 'bookmark' && !r.missing && !inFolder(r.path)).map((r) => [r.path, { rel: r.path, name: r.name || r.path.split('/').pop() }])).values()],
  ];
  return { folders, records, items };
}

/** 選んだものを「お気に入り」にする */
export async function favoriteAll(list) {
  await addTagName('お気に入り');
  for (const r of list) {
    if ((r.tags || []).includes('お気に入り')) continue;
    r.tags = [...(r.tags || []), 'お気に入り'];
    await store.putRecord(r);
  }
  S.records = await store.records();
  toast(`${list.length}件をお気に入りにしました`);
  render();
}

/** 選択モードの切り替え（OFFにしたら選んだものを外す） */
export function toggleSelectMode() {
  S.selectMode = !S.selectMode;
  if (!S.selectMode) { S.mineSel.clear(); S.folderSel?.clear(); }
  render();
}
export const selectModeBtn = () => h('button', {
  class: `btn sm select-mode${S.selectMode ? ' on' : ''}`, id: 'select-mode', 'aria-pressed': S.selectMode ? 'true' : 'false',
  title: S.selectMode ? '押すと選択モードを終わります（選んだものは外れます）' : '押すと、作品とフォルダにチェック欄が出て、まとめて操作できます',
  onclick: toggleSelectMode,
}, `☑ 選択モード：${S.selectMode ? 'ON' : 'OFF'}`);

/** 削除・コピーのボタン（作品・フォルダの行に付ける） */
export const copyBtn = (onclick) => h('button', { class: 'btn sm copy-btn', onclick }, '📋コピーする先を選択');
export { isApp };
