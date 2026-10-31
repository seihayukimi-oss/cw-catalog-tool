// 素材・スキン（シナリオではないもの）：
//  ・「素材の置き場所」「スキンの置き場所」に、分類フォルダを分けて入れる（実際のファイルも分かれる）
//    スキン（Skin.xml があるもの）は、分類フォルダをスキンの種類で自動で決められる。Pyのエンジンの Data/Skin にも入れられる
//  ・アプリ版は、最初から exe の横の「CWCatalog_保存」の中に「zip保存」「素材」「スキン」を用意して使う（設定で変えられる）
//  ・自分のフォルダ一覧で置き場所を選ぶと、入っているものを一覧にして、タグ付け・分類フォルダへの移動ができる
// シナリオも、選んで「分類フォルダへ移す」で、Scenario の中の分類フォルダ（例：Scenario/_店）へ動かせる。

import { installMaterial, moveWithin, moveToBackup, BACKUP_DIR } from '../core/install.js';
import { safeRelativePath } from '../core/zip.js';
import { existsAt } from '../core/fs.js';
import { backupOpts, backupFull, backupPlace } from './backup.js';
import { readSkin } from '../core/skin.js';
import { S, render, busy, dirOf, engine, rerenderList } from './state.js';
import { store, recordId } from './store.js';
import { h, toast, modal, fmtDate } from './ui.js';
import { applyCatalog } from './catalog-data.js';
import { tagEditor, tagChips, pickTags, applyTags, addTagName } from './tags.js';
import { catPicker } from './catpick.js';
import { choosePlace } from './place.js';
import { mineMode, mineTools, folderTree, askFolderName, rerenderBody, deleteBtn } from './folderview.js';
import { deleteItems, copyItems, selection, favoriteAll, selectModeBtn, copyBtn } from './fileops.js';

export const MAT = '__mat';
export const SKIN = '__skin';
export const KINDS = {
  material: { key: 'material', id: MAT, kv: 'materials', label: '素材', place: '素材の置き場所', opfs: 'test-materials', zipSub: '素材', example: '例：効果音、立ち絵、背景' },
  skin: { key: 'skin', id: SKIN, kv: 'skins', label: 'スキン', place: 'スキンの置き場所', opfs: 'test-skins', zipSub: 'スキン', example: '例：和風、現代' },
};
export const isStashId = (id) => id === MAT || id === SKIN;
const kindOfId = (id) => (id === SKIN ? KINDS.skin : KINDS.material);
const stash = (k) => S.stash[k];
const isApp = () => S.platform.kind === 'app';

// ------------------------------------------------------------ 置き場所
export async function loadStash() {
  S.stash = {};
  S.stashDir = {};
  for (const k of Object.values(KINDS)) S.stash[k.key] = { ref: null, label: '', keepZip: true, ...((await store.get(k.kv)) || {}) };
  // アプリ版：最初から使える保存フォルダ（exe の横の CWCatalog_保存）
  if (S.platform.defaultStoreDirs) {
    const d = await S.platform.defaultStoreDirs().catch(() => null);
    if (d) {
      S.storeRoot = d.root;
      for (const k of Object.values(KINDS)) {
        if (!S.stash[k.key].ref) { S.stash[k.key] = { ...S.stash[k.key], ref: d[k.key], label: d[k.key], auto: true }; await store.set(k.kv, S.stash[k.key]); }
      }
      if (!S.archive.ref) { S.archive = { ...S.archive, ref: d.zip, label: d.zip, on: true, auto: true }; await store.set('archive', S.archive); }
    }
  }
  for (const k of Object.values(KINDS)) {
    if (S.stash[k.key].ref) S.stashDir[k.key] = await S.platform.openFolder(S.stash[k.key].ref).catch(() => null);
  }
  S.materials = S.stash.material; // 前からの呼び方
}

export async function stashDirOf(kind, ask = true) {
  if (S.stashDir[kind]) return S.stashDir[kind];
  const st = stash(kind);
  if (!st?.ref) return null;
  const d = await S.platform.openFolder(st.ref, { ask });
  if (d) S.stashDir[kind] = d;
  return d;
}
export const materialsDirOf = (ask) => stashDirOf('material', ask);

export async function pickStashFolder(kind, useOpfs = false) {
  const k = KINDS[kind];
  return busy(`${k.place}を選ぶ`, async () => {
    const p = useOpfs ? await S.platform.opfsFolder(k.opfs) : await S.platform.pickFolder({ title: `${k.label}を置くフォルダを選んでください`, id: `cw-${kind}` });
    S.stash[kind] = { ...S.stash[kind], ref: p.ref, label: p.label, auto: false, lastScan: '' };
    S.stashDir[kind] = p.dir;
    if (kind === 'material') S.materials = S.stash.material;
    await store.set(k.kv, S.stash[kind]);
    toast(`${k.label}は「${p.label}」に入れるようにしました`);
    await scanStash(kind, true);
  });
}
export const pickMaterialsFolder = (useOpfs) => pickStashFolder('material', useOpfs);

/** 置き場所の分類フォルダ（1段目のフォルダ） */
async function categoriesOf(d) {
  return (await d.entries()).filter((e) => e.kind === 'dir' && e.name !== BACKUP_DIR).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 置き場所を読み取る：1段目＝分類フォルダ、その中のフォルダ・ファイル＝1つの素材（スキン）。分類に入っていないファイルは1段目のもの */
export async function scanStash(kind, quiet = false) {
  const k = KINDS[kind];
  const d = await stashDirOf(kind, true);
  if (!d) throw new Error(`${k.place}を使う許可がありませんでした`);
  const old = new Map(S.records.filter((r) => r.engineId === k.id).map((r) => [r.id, r]));
  const items = [];
  const cats = await categoriesOf(d);
  const now = new Date().toISOString();
  const push = (path, fk) => {
    const id = recordId(k.id, path);
    const prev = old.get(id) || {};
    old.delete(id);
    items.push({ tags: [], ...prev, id, engineId: k.id, type: kind, path, name: path.split('/').pop(), author: '', format: 'none', kind: fk, missing: false, seenAt: now });
  };
  for (const e of await d.entries()) if (e.kind === 'file') push(e.name, 'file');
  for (const c of cats) {
    const sub = await d.dir(c);
    // スキンは、分類フォルダを使わずにそのまま置かれていることもある（Skin.xml があればそれが1つのスキン）
    if (kind === 'skin' && (await sub.has('Skin.xml'))) { push(c, 'dir'); continue; }
    for (const e of await sub.entries()) push(`${c}/${e.name}`, e.kind);
  }
  const missing = [...old.values()].map((r) => ({ ...r, missing: true }));
  await store.putRecords([...items, ...missing]);
  S.records = await store.records();
  S.categories[k.id] = cats;
  await store.set('categories', S.categories);
  S.stash[kind].lastScan = now;
  await store.set(k.kv, S.stash[kind]);
  if (!quiet) toast(`${k.label} ${items.length}件を読み取りました${missing.length ? `（見つからないもの ${missing.length}件）` : ''}`);
}
export const scanMaterials = (quiet) => scanStash('material', quiet);

// ------------------------------------------------------------ 入れる
const pyEngines = () => S.engines.filter((e) => e.kind === 'py');

/**
 * シナリオではないものを入れる（ひとつずつ・まとめて の両方で使う）
 * @param {object} o openArchive の結果
 * @param {{kind: 'material'|'skin', to?: string, cat: string, name: string, asArc?: boolean, skip?: Set<string>, skin?: object}} m
 *   to：スキンのとき、'stash'（スキンの置き場所）かPyのエンジンのid（Data/Skin に入れる）
 * @returns {Promise<{dest: string, written: number, where: string, zip: string|null}>}
 */
export async function installNonScenario(o, m) {
  let files = o.files.filter((f) => !m.skip?.has(f.path));
  if (!m.asArc && !files.length) throw new Error('入れるファイルを1つ以上選んでください');
  // スキンは、Skin.xml のあるフォルダの中身だけを入れる
  if (m.kind === 'skin' && m.skin && m.skin.root) {
    files = files.filter((f) => f.path.startsWith(m.skin.root)).map((f) => ({ ...f, path: f.path.slice(m.skin.root.length) }));
  }
  const src = m.asArc ? o : { ...o, files };
  const d = destOf(o, m);
  let root;
  if (d.engineId) {
    root = await dirOf(d.engineId, true);
    if (!root) throw new Error(`${engine(d.engineId)?.name || 'エンジン'}のフォルダに接続できませんでした`);
  } else {
    root = m.place?.dir || await stashDirOf(m.kind, true);
    if (!root) throw new Error(`${KINDS[m.kind].place}を使う許可がありませんでした。「設定」で選び直してください`);
  }
  // もう同じ名前のものがあれば、バックアップに移してから置き換える
  let backup = null;
  if (d.dest && (await existsAt(root, d.dest))) {
    if (m.place) throw new Error(`選んだ保存先に、同じ名前のものがもうあります：${d.dest}。フォルダ名を変えてください`);
    const bk = d.engineId ? ['engine', d.engineId] : [m.kind, ''];
    const moved = await moveToBackup(root, d.dest, { anywhere: true, ...(await backupOpts(...bk)) });
    backup = backupFull(bk[0], bk[1], moved);
  }
  const r = await installMaterial(root, src, { category: d.category, folderName: m.name.trim(), asArchive: !!m.asArc });
  // 元のzipも残す（設定でオン・オフ）
  let zip = null;
  if (!m.asArc && stash(m.kind)?.keepZip && (S.archive.ref || o.zipPlace)) {
    const { saveArchive } = await import('./add.js');
    zip = await saveArchive(o, { force: true, subdir: o.zipPlace ? '' : KINDS[m.kind].zipSub }).catch(() => null);
  }
  if (!d.engineId && !m.place) await scanStash(m.kind, true).catch(() => {});
  // 入れた場所（エクスプローラーで開く用。zipのまま置いたときは、そのフォルダ）
  const full = d.baseRef ? joinPath(d.baseRef, m.asArc ? r.dest.split('/').slice(0, -1).join('/') : r.dest) : '';  // アプリ版だけ
  return { ...r, where: d.where, zip, backup, full };
}

const joinPath = (base, rel) => [base.replace(/[\\/]+$/, ''), ...rel.split('/').filter(Boolean)].join(isApp() ? '\\' : '/');

/**
 * 入れ先を決める（まだ書き込まない）
 * @returns {{dest: string, category: string, engineId: string|null, baseRef: string, where: string, full: string}}
 */
export function destOf(o, m) {
  const toEngine = m.kind === 'skin' && m.to && m.to !== 'stash' ? m.to : null;
  const category = toEngine ? 'Data/Skin' : (m.cat || '');
  const leaf = m.asArc ? safeRelativePath(o.archiveName || o.source.name) : safeRelativePath(m.name.trim() || '');
  const cat = category ? safeRelativePath(category) : '';
  const dest = leaf && !leaf.includes('/') && (category ? cat : true) ? [cat, leaf].filter(Boolean).join('/') : '';
  const e = toEngine ? engine(toEngine) : null;
  const pl = !e && m.place ? m.place : null; // 「保存先を選ぶ」で今回だけ選んだ場所
  const baseRef = e ? e.ref : pl ? pl.ref : stash(m.kind)?.ref || '';
  const where = e ? `${e.name} の Data/Skin` : pl ? `選んだ保存先（${pl.label}・今回だけ）` : `${KINDS[m.kind].place}（${stash(m.kind)?.label || '未設定'}）`;
  // HTML版では、置き場所はブラウザの「フォルダの許可」なので、場所の文字はない
  const label = e ? e.label : pl ? pl.label : stash(m.kind)?.label || '';
  const full = dest ? (typeof baseRef === 'string' && baseRef ? joinPath(baseRef, dest) : `「${label}」の中の ${dest}`) : '';
  return { dest, category, engineId: toEngine, baseRef: typeof baseRef === 'string' ? baseRef : '', where, full };
}

/** 入れ先の様子（もう入っているか・別の分類に同じ名前があるか）。置き場所は、最後に読み取った記録で見る */
export function destStatus(o, m) {
  const d = destOf(o, m);
  if (!d.dest) return { ...d, text: 'フォルダ名を入れてください', level: 'bad' };
  if (d.engineId) return { ...d, text: `入れ先：${d.full || d.dest}（同じ名前のものがあれば、前のものはバックアップに移してから置き換えます）`, level: 'muted' };
  if (m.place) return { ...d, text: `入れ先：${d.full || d.dest}（今回だけ選んだ保存先。同じ名前のものがあるときは入れずに止めます）`, level: 'muted' };
  const id = KINDS[m.kind].id;
  const recs = S.records.filter((r) => r.engineId === id && !r.missing);
  const here = recs.some((r) => r.path === d.dest);
  const leaf = d.dest.split('/').pop();
  const elsewhere = recs.filter((r) => r.path !== d.dest && r.path.split('/').pop() === leaf).map((r) => r.path);
  if (here) return { ...d, exists: true, level: 'warn', text: `もう入っています：${d.full || d.dest}。このまま入れると、前のものは ${backupPlace(m.kind)} に移してから置き換えます` };
  if (elsewhere.length) return { ...d, level: 'warn', text: `入れ先：${d.full || d.dest}（新しく入れます）。別の分類フォルダにも同じ名前のものがあります：${elsewhere.slice(0, 3).join('、')}` };
  return { ...d, level: 'ok', text: `入れ先：${d.full || d.dest}（まだ入っていないので、新しく入れます）` };
}

/** スキンの分類フォルダを自動で決める（Skin.xml の種類） */
export const autoSkinCat = (skin) => (skin?.type || 'その他').replace(/[\\/:*?"<>|]/g, '_');

/** 「シナリオ・素材・スキンをDLする」タブで、シナリオではないものを開いたときの欄 */
export function viewMaterialInstall(o) {
  if (o.skinInfo === undefined) {
    o.skinInfo = null;
    readSkin(o).then((info) => { o.skinInfo = info; if (info && o.mat) { o.mat.kind = 'skin'; o.mat.name = info.folderName; o.mat.catState = {}; } render(); }).catch(() => {});
  }
  const skin = o.skinInfo;
  const m = o.mat || (o.mat = { kind: skin ? 'skin' : 'material', to: 'stash', name: skin?.folderName || (o.archiveName || o.source.name).replace(/\.[^.]+$/, ''), asArc: false, catState: {}, skip: new Set() });
  const k = KINDS[m.kind];
  const card = h('div', { class: 'card stack' },
    h('h3', {}, skin ? `スキンのようです（${skin.name || skin.folderName}${skin.type ? `・種類：${skin.type}` : ''}${skin.author ? `・${skin.author}` : ''}）` : 'シナリオではないようです（スキン・素材・効果音など）'),
    h('p', { class: 'small muted', style: 'margin:0' }, skin
      ? 'Skin.xml があるので、CardWirthPy のスキンとして入れられます。'
      : 'Summary.wsm・Summary.xml が無いので、シナリオとしては入れられません。素材・スキンとして、置き場所に分類フォルダを分けて入れられます。'),
    h('div', { class: 'row', role: 'radiogroup', 'aria-label': '入れ方' },
      Object.values(KINDS).map((x) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'mat-kind', checked: m.kind === x.key, onchange: () => { m.kind = x.key; m.catState = {}; render(); } }), `${x.label}として入れる`))));
  const st = stash(m.kind);
  const toEngine = m.kind === 'skin' && m.to !== 'stash';
  if (!toEngine && !st?.ref) {
    card.append(h('div', { class: 'row' },
      S.platform.canWriteFolders ? h('button', { class: 'btn primary', onclick: () => pickStashFolder(m.kind).then(render) }, `${k.place}を決める`) : h('span', { class: 'small muted' }, 'このブラウザでは、フォルダに入れられません。'),
      location.hash.includes('dev-opfs') && S.platform.opfsFolder ? h('button', { class: 'btn', id: `dev-opfs-${m.kind === 'skin' ? 'skins' : 'materials'}`, onclick: () => pickStashFolder(m.kind, true).then(render) }, `テスト用（${k.label}）`) : null));
    return card;
  }
  // 入れ先の様子（もう入っているか・新しく入れるか）。入力を変えるたびに書き直す
  const statusEl = h('div', { class: 'small dest-status', id: 'mat-dest' });
  const curCat = () => { let c = cp ? cp.value() : ''; if (c === '__auto') c = autoSkinCat(skin); return c; };
  const upd = () => {
    const ds = destStatus(o, { ...m, cat: curCat(), skin });
    statusEl.className = `small dest-status note ${ds.level === 'ok' ? 'ok' : ds.level === 'warn' ? 'warn' : ds.level === 'bad' ? 'bad' : ''}`;
    statusEl.replaceChildren(...[h('span', {}, ds.text), openBtn(ds.baseRef, '置き場所を確認する'),
      !toEngine && S.platform.canWriteFolders ? h('button', { class: 'btn ghost sm', id: 'mat-place', title: 'フォルダを選んで、今回だけ、または次からもそこに入れます', onclick: () => pickMatPlace(o, m) }, '保存先を選ぶ…') : null,
      m.place ? h('button', { class: 'btn ghost sm', onclick: () => { m.place = null; render(); } }, 'いつもの置き場所に戻す') : null].filter(Boolean));
  };
  const nameIn = h('input', { type: 'text', id: 'mat-name', value: m.name, 'aria-label': 'フォルダ名', oninput: (ev) => { m.name = ev.target.value; upd(); } });
  if (o.execExcluded) m.asArc = false; // 実行ファイル入りのzipは、そのままは置かない
  const asArc = h('input', { type: 'checkbox', checked: m.asArc, disabled: !!o.execExcluded, title: o.execExcluded ? '実行ファイルが入っているので、zipのままは置けません' : null, 'aria-label': 'zipのまま置く', onchange: (ev) => { m.asArc = ev.target.checked; pick.hidden = m.asArc; upd(); } });
  const pick = filePicker(o, m);
  pick.hidden = m.asArc;
  const cp = toEngine ? null : catPicker({
    cats: S.categories[k.id] || [], rootLabel: `（${k.place}の直下）`, state: m.catState, idPrefix: 'mat',
    autoLabel: m.kind === 'skin' ? `自動（スキンの種類で分ける：${autoSkinCat(skin)}）` : '', placeholder: `新しい分類フォルダの名前（${k.example}）`,
    onChange: () => upd(),
  });
  const dests = m.kind === 'skin' ? h('label', { class: 'field' }, '入れ先',
    h('select', { id: 'skin-to', onchange: (ev) => { m.to = ev.target.value; render(); } },
      h('option', { value: 'stash', selected: m.to === 'stash' ? 'selected' : null }, `スキンの置き場所（${st?.label || '未設定'}）`),
      pyEngines().map((e) => h('option', { value: e.id, selected: m.to === e.id ? 'selected' : null }, `${e.name} の Data/Skin（すぐ使える）`)))) : null;
  card.append(...[
    dests,
    h('div', { class: 'grid2' }, cp?.el, h('label', { class: 'field' }, 'フォルダ名', nameIn)),
    o.source.kind === 'archive' && m.kind === 'material' ? h('label', { class: 'check small' }, asArc, '展開せずに、zipなどのまま置く') : null,
    pick,
    statusEl,
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary', id: 'mat-install', onclick: async () => {
          let cat = cp ? cp.value() : '';
          if (cat === '__auto') cat = autoSkinCat(skin);
          if (m.catState?.isNew && !cat) { toast('新しい分類フォルダの名前を入れてください', { bad: true }); return; }
          if (o.readmes?.length && !o.matAck) {
            const { readmeModal } = await import('./add.js');
            if (!(await readmeModal(o, o.source.name))) return;
            o.matAck = true;
          }
          await busy(`${k.label}を入れる`, async () => {
            const r = await installNonScenario(o, { ...m, cat, skin });
            toast(`${r.where} の ${r.dest} に入れました（${m.asArc ? 'zipのまま' : `${r.written}ファイル`}）${r.backup ? `。前のものは ${r.backup} に移しました` : ''}${r.zip ? `。元のzipは「${r.zip}」に残しました` : ''}`, { ms: 9000 });
            S.lastMatDone = { full: r.full, where: r.where, dest: r.dest };
            S.opened = null;
          });
        },
      }, toEngine ? `${engine(m.to)?.name} に入れる` : m.place ? '選んだ保存先に入れる' : `${k.place}に入れる`),
      o.readmes?.length ? h('span', { class: 'small muted' }, '入れる前に Readme（利用規約）を確認します') : null),
    st?.keepZip && (S.archive.ref || o.zipPlace) && !m.asArc && !o.execExcluded ? zipPlaceRow(o, k.zipSub) : null,
  ].filter(Boolean));
  upd();
  return card;
}

/** 素材・スキンの保存先を選ぶ（今回だけ／次からも） */
async function pickMatPlace(o, m) {
  const k = KINDS[m.kind];
  const p = await choosePlace({ title: `${k.label}を入れるフォルダを選んでください`, id: m.kind, what: k.place });
  if (!p) return;
  if (p.remember) {
    S.stash[m.kind] = { ...S.stash[m.kind], ref: p.ref, label: p.label, auto: false, lastScan: '' };
    S.stashDir[m.kind] = p.dir;
    if (m.kind === 'material') S.materials = S.stash.material;
    await store.set(k.kv, S.stash[m.kind]);
    m.place = null;
    await busy(`${k.place}を読み取る`, () => scanStash(m.kind, true));
    toast(`${k.label}は、次からも「${p.label}」に入れます`);
  } else {
    m.place = p;
    toast(`今回だけ「${p.label}」に入れます`);
  }
  render();
}

/** 元のzipの保存先（確認・選ぶ）。素材・スキンとシナリオの両方で使う */
export function zipPlaceRow(o, sub = '') {
  const isApp = S.platform.kind === 'app';
  const where = o.zipPlace ? `「${o.zipPlace.label}」（今回だけ）` : `「${S.archive.label}」${sub ? `の「${sub}」` : ''}`;
  const full = o.zipPlace ? o.zipPlace.ref : isApp && S.archive.ref ? joinPath(S.archive.ref, sub) : '';
  return h('div', { class: 'row small', id: 'zip-place' },
    h('span', { class: 'muted' }, `元の ${o.archiveName || o.source.name} は ${where} に保存します`),
    openBtn(full, '置き場所を確認する'),
    S.platform.canWriteFolders ? h('button', { class: 'btn ghost sm', id: 'zip-place-pick', onclick: () => pickZipPlace(o) }, '保存先を選ぶ…') : null,
    o.zipPlace ? h('button', { class: 'btn ghost sm', onclick: () => { o.zipPlace = null; render(); } }, 'いつもの保存場所に戻す') : null);
}

export async function pickZipPlace(o) {
  const p = await choosePlace({ title: '元のzip・wsnを保存するフォルダを選んでください', id: 'archive', what: 'zip・wsnの保存場所' });
  if (!p) return;
  if (p.remember) {
    S.archive = { ...S.archive, ref: p.ref, label: p.label, on: true, auto: false };
    S.archiveDir = p.dir;
    await store.set('archive', S.archive);
    o.zipPlace = null;
    toast(`zip・wsnは、次からも「${p.label}」に保存します`);
  } else {
    o.zipPlace = p;
    toast(`元のzipは、今回だけ「${p.label}」に保存します`);
  }
  render();
}

/** どのファイルを入れるか選ぶ欄（最初は全部。フォルダごとにも選べる） */
function filePicker(o, m) {
  m.skip ||= new Set();
  const groups = new Map();
  for (const f of o.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const count = h('span', { class: 'small muted' });
  const upd = () => { count.textContent = `${o.files.length - m.skip.size} / ${o.files.length} ファイルを入れます`; };
  upd();
  const box = h('div', { class: 'file-pick' });
  const draw = () => {
    box.replaceChildren(...[...groups].map(([dir, fs]) => {
      const allOn = fs.every((f) => !m.skip.has(f.path));
      const someOn = fs.some((f) => !m.skip.has(f.path));
      const head = h('input', { type: 'checkbox', checked: allOn, 'aria-label': `フォルダ「${dir || '（いちばん上）'}」をまとめて選ぶ`, onchange: (ev) => { fs.forEach((f) => (ev.target.checked ? m.skip.delete(f.path) : m.skip.add(f.path))); draw(); upd(); } });
      head.indeterminate = someOn && !allOn;
      return h('div', {},
        h('div', { class: 'dir row' }, head, `📁 ${dir || '（いちばん上）'}`, h('span', { class: 'small muted' }, `${fs.length}件`)),
        fs.map((f) => h('label', { class: 'small' },
          h('input', { type: 'checkbox', checked: !m.skip.has(f.path), 'aria-label': `${f.path}を入れる`, onchange: (ev) => { if (ev.target.checked) m.skip.delete(f.path); else m.skip.add(f.path); draw(); upd(); } }),
          `📄 ${f.path.split('/').pop()}`)));
    }));
  };
  draw();
  return h('details', { class: 'small', open: o.files.length <= 30 ? true : null },
    h('summary', {}, '入れるファイルを選ぶ　', count),
    h('div', { class: 'row', style: 'margin:6px 0' },
      h('button', { class: 'btn sm', onclick: () => { m.skip.clear(); draw(); upd(); } }, 'すべて選ぶ'),
      h('button', { class: 'btn ghost sm', onclick: () => { o.files.forEach((f) => m.skip.add(f.path)); draw(); upd(); } }, 'すべて外す')),
    box);
}

// ------------------------------------------------------------ 分類フォルダへ移す
/**
 * 選んだもの（シナリオ・素材・スキン）を、分類フォルダへ動かす（実際のファイルを動かす）
 * @param {object[]} recs 同じ入れ物（同じエンジン、または同じ置き場所）の記録
 */
export async function moveToCategory(recs) {
  const id = recs[0].engineId;
  const isStash = isStashId(id);
  const k = isStash ? kindOfId(id) : null;
  const base = isStash ? '' : 'Scenario';
  const cats = S.categories[id] || [];
  const target = await modal((close) => {
    const state = {};
    const cp = catPicker({ cats, rootLabel: isStash ? `（${k.place}の直下）` : '（Scenario の直下）', state, idPrefix: 'move', nested: !isStash });
    return h('div', { class: 'stack' },
      h('h2', {}, `${recs.length}件を分類フォルダへ移す`),
      h('p', { class: 'small muted', style: 'margin:0' }, `${isStash ? k.place : 'Scenario フォルダ'}の中で、実際のフォルダやファイルを動かします（宿の冒険の記録などには影響しません）。`),
      cp.el,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { class: 'btn primary', id: 'move-go', onclick: () => { const c = cp.value(); if (state.isNew && !c) { toast('新しい分類フォルダの名前を入れてください', { bad: true }); return; } if (state.isNew && (/[/\\]/.test((state.newCat || '').trim()) || !safeRelativePath(c))) { toast('フォルダの名前が正しくありません（「/」「\\」や「..」は使えません）', { bad: true }); return; } close({ cat: c }); } }, '移す')));
  });
  if (!target) return;
  await busy('分類フォルダへ移す', async () => {
    const d = isStash ? await stashDirOf(k.key, true) : await dirOf(id, true);
    if (!d) throw new Error('フォルダに接続できませんでした');
    const toDir = [base, target.cat].filter(Boolean).join('/');
    const log = [];
    const byPath = new Map();
    for (const r of recs) { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); }
    let moved = 0;
    for (const [path, group] of byPath) {
      try {
        const dest = await moveWithin(d, path, toDir);
        if (dest === path) continue;
        for (const r of group) {
          const nr = { ...r, id: recordId(r.engineId, dest, r.inner || ''), path: dest };
          if (!isStash) Object.assign(nr, applyCatalog(nr));
          await store.deleteRecord(r.id);
          await store.putRecord(nr);
        }
        moved++;
        log.push(`${path} → ${dest}`);
      } catch (e) {
        log.push(`${path}：${e.message}`);
      }
    }
    S.records = await store.records();
    if (target.cat && !cats.includes(target.cat)) {
      S.categories[id] = [...cats, target.cat].sort();
      await store.set('categories', S.categories);
    }
    S.mineSel.clear();
    await showLog(`分類フォルダへ移しました（${moved}件）`, log);
  });
}

/** 結果の記録を見せる窓 */
export function showLog(title, lines) {
  return modal((close) => h('div', { class: 'stack' },
    h('h2', {}, title),
    lines.length ? h('pre', { class: 'readme log' }, lines.join('\n')) : h('p', { class: 'small muted' }, '動かしたものはありません'),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる'))));
}

/** フォルダをエクスプローラーで開くボタン（アプリ版だけ） */
export function openBtn(path, label = 'エクスプローラーで開く') {
  if (!isApp() || !path || !S.platform.revealFolder) return null;
  return h('button', { class: 'btn ghost sm', title: path, onclick: () => S.platform.revealFolder(path).catch((e) => toast(`開けませんでした：${e.message || e}`, { bad: true })) }, `📂 ${label}`);
}

// ------------------------------------------------------------ 設定タブ
export function viewStashSettings(dev) {
  return h('div', { class: 'stack' }, Object.values(KINDS).map((k) => {
    const st = stash(k.key);
    const keep = h('input', { type: 'checkbox', checked: st.keepZip !== false, 'aria-label': `${k.label}の元のzipも残す`, onchange: async (ev) => { st.keepZip = ev.target.checked; await store.set(k.kv, st); } });
    return h('div', { class: 'card stack' },
      h('h3', { style: 'margin:0' }, k.place),
      h('div', { class: 'row' },
        h('span', { class: 'grow small', style: 'word-break:break-all' }, st.ref ? `${st.label}${st.auto ? '（最初から用意したフォルダ）' : ''}${S.stashDir[k.key] ? '' : '（次に使うとき許可を聞きます）'}` : '未設定'),
        openBtn(st.ref),
        S.platform.canWriteFolders ? h('button', { class: 'btn sm', onclick: () => pickStashFolder(k.key).then(render) }, st.ref ? '置き場所を変える' : '置き場所を選ぶ') : null,
        dev ? h('button', { class: 'btn sm', id: `dev-opfs-${k.key === 'skin' ? 'skins' : 'materials'}-set`, onclick: () => pickStashFolder(k.key, true).then(render) }, `テスト用（${k.label}）`) : null),
      h('label', { class: 'check small' }, keep, `${k.label}の導入時、元のzipファイルも保存フォルダ（「zip・wsnの保存場所」の「${k.zipSub}」）へ残す`),
      k.key === 'skin' ? h('p', { class: 'small muted', style: 'margin:0' }, 'スキン（Skin.xml があるもの）は、種類（Skin.xml の Type）で分類フォルダを自動で分けられます。CardWirthPy を登録していれば、その Data/Skin に直接入れることもできます。') : null,
      !S.platform.canWriteFolders ? h('p', { class: 'note warn small', style: 'margin:0' }, 'このブラウザでは、置き場所の登録はできません。') : null);
  }));
}
export const viewMaterialsSettings = viewStashSettings;

// ------------------------------------------------------------ 自分のフォルダ一覧（置き場所を選んだとき）
export function viewStashMine(kind, makeSel) {
  const k = KINDS[kind];
  const st = stash(kind);
  const q = S.filter.mine.normalize('NFKC').toLowerCase();
  const mine = S.records.filter((r) => r.engineId === k.id);
  let recs = mine.filter((r) => !q || `${r.name} ${r.path} ${(r.tags || []).join(' ')}`.normalize('NFKC').toLowerCase().includes(q));
  const allRecs = recs;
  const tg = S.filter.mineTag || '';
  if (tg) recs = recs.filter((r) => (tg === '__none' ? !(r.tags || []).length : (r.tags || []).includes(tg)));
  recs.sort((a, b) => (a.path || '').localeCompare(b.path || '', 'ja'));
  const sel = recs.filter((r) => S.mineSel.has(r.id));

  const head = h('div', { class: 'card' },
    h('div', { class: 'row' },
      st?.ref
        ? h('button', { class: 'btn', onclick: () => busy(`${k.label}を読み取る`, () => scanStash(kind)) }, '読み取る')
        : h('button', { class: 'btn primary', onclick: () => pickStashFolder(kind).then(render) }, `${k.place}を決める`),
      openBtn(st?.ref),
      st?.ref ? h('button', { class: 'btn ghost sm', onclick: () => pickStashFolder(kind).then(render) }, '置き場所を変える') : null),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('input', { type: 'search', class: 'grow', placeholder: '名前・分類・タグで絞り込み', value: S.filter.mine, oninput: (ev) => { S.filter.mine = ev.target.value; rerenderList('mine-body', () => viewStashMine(kind, makeSel)); } })),
    makeSel(),
    h('p', { class: 'small muted', style: 'margin:8px 0 0;word-break:break-all' },
      st?.ref ? `${k.place}：${st.label}${st.lastScan ? `／最後に読み取った日時：${fmtDate(st.lastScan)}／${mine.length}件` : ''}` : `${k.label}は「シナリオ・素材・スキンをDLする」タブで開くと、ここ（${k.place}）に分類して入れられます。`),
    tagChips(allRecs));

  const loc = { kind };
  const pickd = selection(loc, mine);
  const psel = pickd.records;
  const nPicked = recs.filter((r) => S.mineSel.has(r.id)).length + pickd.folders.length;
  const selBar = recs.length || pickd.folders.length ? h('div', { class: 'card batch-bar', id: 'mine-bar' },
    h('div', { class: 'row' },
      h('span', { class: 'small' }, `${recs.length}件${q || tg ? '（絞り込み中）' : ''}`),
      selectModeBtn(),
      S.selectMode ? h('button', { class: 'btn sm', disabled: recs.every((r) => S.mineSel.has(r.id)), onclick: () => { recs.forEach((r) => S.mineSel.add(r.id)); render(); } }, '表示中をすべて選ぶ') : null,
      S.selectMode && nPicked ? h('button', { class: 'btn ghost sm', onclick: () => { S.mineSel.clear(); S.folderSel?.clear(); render(); } }, '選択を解除') : null),
    S.selectMode && nPicked ? h('div', { class: 'row sel-actions' },
      h('b', { class: 'small' }, `選んだもの（${pickd.folders.length ? `フォルダ${pickd.folders.length}件・` : ''}${k.label}${psel.length}件）に：`),
      h('button', { class: 'btn primary sm', disabled: !psel.length, onclick: async () => { const t = await pickTags(`${psel.length}件にタグを付ける`); if (t?.length) { await applyTags(psel, t, []); render(); } } }, 'タグを付ける'),
      h('button', { class: 'btn sm', disabled: !psel.length, onclick: async () => { const present = [...new Set(psel.flatMap((r) => r.tags || []))]; const t = await pickTags(`${psel.length}件からタグを外す`, { mode: 'remove', present }); if (t?.length) { await applyTags(psel, [], t); render(); } } }, 'タグを外す'),
      h('button', { class: 'btn sm', disabled: !psel.length, onclick: () => favoriteAll(psel) }, '★お気に入りにする'),
      h('button', { class: 'btn sm', onclick: async () => { const ok = psel.filter((r) => !r.missing); if (ok.length) await moveToCategory(ok); render(); } }, '分類フォルダへ移す'),
      S.deleteMode ? h('button', { class: 'btn sm danger delete-btn', disabled: !pickd.items.length, onclick: () => deleteItems(loc, pickd.items) }, '🗑️選んだものを削除') : null,
      S.copyMode ? h('button', { class: 'btn sm copy-btn', disabled: !pickd.items.length, onclick: () => copyItems(loc, pickd.items) }, '📋選んだものをコピー') : null) : null) : null;

  const groups = new Map();
  for (const r of recs) {
    const c = r.path.includes('/') ? r.path.split('/')[0] : '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  const cats = S.categories[k.id] || [];
  const onCreate = st?.ref && S.platform.canWriteFolders !== false ? () => createStashFolder(kind) : null;
  const filtering = !!(q || tg);
  const list = mineMode() === 'folder' && (recs.length || (!filtering && cats.length)) ? folderTree({
    ns: k.id, recs, cats, card: stashCard, filtering, rerender: rerenderBody(() => viewStashMine(kind, makeSel)),
    parentOf: (r) => (r.path.includes('/') ? r.path.split('/')[0] : ''),
    rootLabel: k.place, nested: false,
    onCreate,
    onDeleteFolder: st?.ref ? (p) => deleteItems(loc, [{ rel: p, name: p, isFolder: true }]) : null,
    onCopyFolder: st?.ref ? (p) => copyItems(loc, [{ rel: p, name: p, isFolder: true }]) : null,
  }) : h('div', { class: 'list', id: 'mine-list' }, recs.length
    ? [...groups].map(([c, rs]) => h('details', { class: 'group', open: true },
      h('summary', {}, h('span', { class: 'group-name' }, c || '（分類なし）'), h('span', { class: 'badge plain' }, `${rs.length}件`)),
      rs.map(stashCard)))
    : h('p', { class: 'empty' }, mine.length ? '見つかりませんでした' : st?.ref ? 'まだ記録がありません。「読み取る」を押してください' : `まだ${k.place}が決まっていません`));
  return h('div', {}, head, h('div', { id: 'mine-body' }, selBar, mineTools({ rootLabel: k.place, onCreate }), list));
}
export const viewMaterialsMine = (makeSel) => viewStashMine('material', makeSel);

/** 素材・スキンの置き場所の直下に、空の分類フォルダを作る（置き場所は1段目だけが分類フォルダ） */
async function createStashFolder(kind) {
  const k = KINDS[kind];
  const name = await askFolderName(k.place);
  if (!name) return;
  const done = await busy('フォルダを作成', async () => {
    const d = await stashDirOf(kind, true);
    if (!d) throw new Error(`${k.place}を使う許可がありませんでした`);
    if (await existsAt(d, name)) throw new Error(`同じ名前のものがすでにあります：${name}`);
    await d.dir(name, { create: true });
    S.categories[k.id] = [...new Set([...(S.categories[k.id] || []), name])].sort((a, b) => a.localeCompare(b, 'ja'));
    await store.set('categories', S.categories);
    return true;
  });
  if (!done) return;
  toast(`${k.place}に「${name}」を作成しました`);
  render();
}

const locOfRec = (r) => ({ kind: kindOfId(r.engineId).key });

function stashCard(r) {
  const save = async (patch) => { Object.assign(r, patch); await store.putRecord(r); S.records = await store.records(); render(); };
  const fav = (r.tags || []).includes('お気に入り');
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      !S.selectMode ? null : h('input', { type: 'checkbox', checked: S.mineSel.has(r.id), 'aria-label': `${r.name}を選ぶ`, onchange: (ev) => { if (ev.target.checked) S.mineSel.add(r.id); else S.mineSel.delete(r.id); render(); } }),
      h('button', {
        class: `btn star${fav ? ' on' : ''}`, 'aria-label': `${r.name}をお気に入りにする`, 'aria-pressed': fav ? 'true' : 'false', title: '「お気に入り」タグを付ける・外す',
        onclick: async () => { await addTagName('お気に入り'); await save({ tags: fav ? r.tags.filter((t) => t !== 'お気に入り') : [...(r.tags || []), 'お気に入り'] }); },
      }, fav ? '★' : '☆'),
      h('span', { class: 'item-title' }, r.name),
      h('span', { class: 'badge plain' }, r.kind === 'dir' ? 'フォルダ' : 'ファイル'),
      r.missing ? h('span', { class: 'badge bad' }, '見つからない') : null,
      r.missing ? h('button', { class: 'btn ghost danger sm', onclick: async () => { await store.deleteRecord(r.id); S.records = await store.records(); render(); } }, '記録を消す') : null,
      S.deleteMode && !r.missing ? deleteBtn(() => deleteItems(locOfRec(r), [{ rel: r.path, name: r.name }])) : null,
      S.copyMode && !r.missing ? copyBtn(() => copyItems(locOfRec(r), [{ rel: r.path, name: r.name }])) : null),
    h('div', { class: 'meta' }, r.path),
    h('div', { class: 'row', style: 'margin-top:6px' }, tagEditor(r, save)));
}
