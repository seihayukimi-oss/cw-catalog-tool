// カタログの保存・読み込み・まとめ直し（画面から使う）。
//  共用カタログ（shared）：作者さんが登録したサイト側のカタログ。URLで読む。書き換えない
//  個人用カタログ（own）：このツールの中で作って、作品を足したり直したりできる
//  個人用カタログ（sub）：有志の方などが作ったDL一覧を読み込んだもの。書き換えない（コピーすれば自分用にできる）

import { parseCatalog } from '../core/catalog.js';
import { combine, workKey, nextPersonalId, exportPersonal, matchWork } from '../core/catalogs.js';
import { sha256Hex } from '../core/archive.js';
import { updateState, compareVersions } from '../core/catalog.js';
import { extractFileList, findNewest } from '../core/filelist.js';
import { S, APP_VERSION } from './state.js';
import { store } from './store.js';
import { SAMPLE_CATALOG } from './sample-catalog.js';

const newId = (kind) => `${kind}-${Math.random().toString(36).slice(2, 10)}`;
const emptyCatalog = () => ({ format: 1, authors: {}, entries: [] });

export async function loadCatalogs() {
  S.listFinds = (await store.get('listFinds')) || {};
  S.catPrefs = { addTo: 'all', askDefault: true, ...((await store.get('catalogPrefs')) || {}) };
  S.workPrefs = (await store.get('workPrefs')) || {};
  await loadFolders();
  S.catView = { group: '', compact: null, ...((await store.get('catView')) || {}) };
  let sources = await store.get('catalogSources');
  if (!sources) sources = await migrateOld();
  S.sources = sources;
  for (const src of sources) {
    const json = await store.get(`cat:${src.id}`);
    try { S.catalogs.set(src.id, parseCatalog(json || emptyCatalog())); } catch { S.catalogs.set(src.id, parseCatalog(emptyCatalog())); }
  }
  rebuild();
}

/** 0.1.4 までの「カタログ1つ」の記録を、新しい形に移す */
async function migrateOld() {
  const sources = [];
  const old = await store.get('catalog');
  const oldUrl = await store.get('catalogUrl', '');
  if (old?.json) {
    const info = old.info || {};
    const fromFile = /^ファイル：/.test(info.url || '');
    const src = {
      id: newId(fromFile ? 'sub' : 'shared'), kind: fromFile ? 'sub' : 'shared',
      name: info.url === 'sample' ? 'サンプル' : fromFile ? info.url.replace(/^ファイル：/, '') : '共用カタログ',
      url: fromFile ? '' : info.url || oldUrl, enabled: true, hidden: [], loadedAt: info.loadedAt || '', count: info.count || 0, sha256: info.sha256 || '',
    };
    await store.set(`cat:${src.id}`, old.json);
    sources.push(src);
  } else if (oldUrl) {
    sources.push({ id: newId('shared'), kind: 'shared', name: '共用カタログ', url: oldUrl, enabled: true, hidden: [], loadedAt: '', count: 0, sha256: '' });
  }
  const own = { id: newId('own'), kind: 'own', name: 'マイカタログ', url: '', enabled: true, hidden: [], loadedAt: '', count: 0 };
  await store.set(`cat:${own.id}`, emptyCatalog());
  sources.push(own);
  await store.set('catalogSources', sources);
  return sources;
}

export async function saveSources() {
  await store.set('catalogSources', S.sources);
}

/** 候補に含めるカタログを、作品ごとにまとめ直す */
export function rebuild() {
  const list = S.sources.filter((s) => s.enabled).map((s) => ({
    id: s.id, kind: s.kind, name: s.name, catalog: S.catalogs.get(s.id) || parseCatalog(emptyCatalog()), hidden: s.hidden || [],
  }));
  S.combined = list.some((l) => l.catalog.entries.length) ? combine(list) : null;
  applyListFinds();
}

// ------------------------------------------------------------ ファイル一覧（アップローダーなど）で見つけた新しい版
/** 一覧で見つけた最新のファイルを、作品の版とDL先に反映する（見つけたものを先に試す） */
function applyListFinds() {
  if (!S.combined || !S.listFinds) return;
  for (const w of S.combined.works) {
    const f = S.listFinds[w.key];
    if (!f || !w.downloads.some((d) => d.kind === 'list')) continue;
    w.listFound = f;
    if (f.version && compareVersions(f.version, w.version) > 0) w.version = f.version;
    if (!w.downloads.some((d) => d.url === f.url)) w.downloads.unshift({ label: `一覧の最新（${f.name}）`, url: f.url, kind: 'page', status: 'active', note: '', fromList: true });
  }
}

/**
 * 「ファイル一覧」のDL先がある作品について、一覧ページを見に行って最新のファイルを探す
 * @returns {Promise<{checked: number, found: number, failed: number}>}
 */
export async function checkFileLists({ onStep } = {}) {
  if (!S.combined) return { checked: 0, found: 0, failed: 0 };
  const targets = S.combined.works.filter((w) => w.downloads.some((d) => d.kind === 'list' && d.status !== 'closed'));
  const pages = new Map(); // 同じ一覧ページは1回だけ読む
  let checked = 0, found = 0, failed = 0;
  for (const w of targets) {
    for (const d of w.downloads.filter((x) => x.kind === 'list' && x.status !== 'closed')) {
      onStep?.(w.name);
      let files = pages.get(d.url);
      if (!files) {
        try {
          const html = await S.platform.fetchText(d.url);
          files = extractFileList(html, d.url);
        } catch { files = null; }
        pages.set(d.url, files || []);
        if (!files) { failed++; continue; }
      }
      checked++;
      const hit = findNewest(files, d.match || w.name);
      if (!hit) continue;
      const prev = S.listFinds[w.key];
      if (!prev || compareVersions(hit.version, prev.version) > 0 || (hit.version === prev.version && hit.url !== prev.url)) found++;
      S.listFinds[w.key] = { url: hit.url, name: hit.name, version: hit.version, list: d.url, at: new Date().toISOString() };
      break;
    }
  }
  await store.set('listFinds', S.listFinds);
  rebuild();
  return { checked, found, failed };
}

export const sourceById = (id) => S.sources.find((s) => s.id === id) || null;
export const ownSources = () => S.sources.filter((s) => s.kind === 'own');

async function putCatalog(src, json) {
  const cat = parseCatalog(json);
  S.catalogs.set(src.id, cat);
  src.count = cat.entries.length;
  await store.set(`cat:${src.id}`, json);
  return cat;
}

/** URLのカタログ（共用・読み込んだDL一覧）を取り直す。meta.json が変わっていなければ本体は取らない */
export async function refreshSource(src, { useMeta = false } = {}) {
  if (!src.url) return false;
  // meta.json（指紋）を先に見て、変わっていなければ本体は取らない。登録フォーム（Google Apps Script）なら ?file=meta
  const metaUrl = /\/index\.json(\?.*)?$/.test(src.url) ? src.url.replace(/index\.json(\?.*)?$/, 'meta.json')
    : /[?&]file=index(&|$)/.test(src.url) ? src.url.replace(/([?&]file=)index/, '$1meta') : '';
  if (useMeta && src.url !== 'sample' && metaUrl && src.sha256) {
    const meta = await S.platform.fetchJson(metaUrl).catch(() => null);
    if (meta?.sha256 && meta.sha256 === src.sha256) { src.checkedAt = new Date().toISOString(); await saveSources(); return false; }
  }
  const json = src.url === 'sample' ? SAMPLE_CATALOG : await S.platform.fetchJson(src.url);
  await putCatalog(src, json);
  // meta.json の sha256 と比べられるよう、index.json と同じ書き方（区切りなしのJSON）で指紋を取る
  src.sha256 = src.url === 'sample' ? '' : await sha256Hex(new TextEncoder().encode(JSON.stringify(json)));
  src.loadedAt = new Date().toISOString();
  if (json.name && src.kind === 'sub' && !src.renamed) src.name = String(json.name).slice(0, 60);
  await saveSources();
  rebuild();
  // 「更新したときもラベルを取り込む」にしていれば
  if (src.labelSync) await importLabels(src, src.labelSync).catch(() => {});
  return true;
}

/** 共用カタログをURLで足す */
export async function addShared(url, name = '') {
  if (S.sources.some((s) => s.url === url)) throw new Error('このカタログはもう登録してあります');
  const src = { id: newId('shared'), kind: 'shared', name: name || (url === 'sample' ? 'サンプル' : new URL(url).hostname), url, enabled: true, hidden: [], loadedAt: '', count: 0, sha256: '' };
  S.sources.push(src);
  try {
    await refreshSource(src);
  } catch (e) {
    S.sources = S.sources.filter((s) => s !== src);
    throw e;
  }
  return src;
}

/** 有志の方などのDL一覧を、個人用カタログとして読み込む（ファイルまたはURL） */
export async function importList({ json, url = '', fileName = '' }) {
  if (url && S.sources.some((s) => s.url === url)) throw new Error('このDL一覧はもう読み込んであります。一覧の「取り直す」で新しくできます');
  const src = {
    id: newId('sub'), kind: 'sub', name: (json?.name && String(json.name).slice(0, 60)) || fileName.replace(/\.json$/i, '') || (url ? new URL(url).hostname : 'DL一覧'),
    url, fileName, enabled: true, hidden: [], loadedAt: new Date().toISOString(), count: 0, sha256: '',
  };
  if (url) {
    S.sources.push(src);
    try { await refreshSource(src); } catch (e) { S.sources = S.sources.filter((s) => s !== src); throw e; }
  } else {
    await putCatalog(src, json); // 形が違えばここで止まる
    S.sources.push(src);
    await saveSources();
    rebuild();
  }
  return src;
}

/** 個人用カタログを新しく作る（copyFrom を渡すと、その中身をコピーする） */
export async function createOwn(name, copyFrom = null) {
  const src = { id: newId('own'), kind: 'own', name: name || '個人用カタログ', url: '', enabled: true, hidden: [...(copyFrom?.hidden || [])], loadedAt: '', count: 0 };
  const base = copyFrom ? S.catalogs.get(copyFrom.id) : null;
  const json = emptyCatalog();
  if (base) {
    json.authors = base.authors;
    json.entries = base.entries.map((e, i) => ({ ...e, id: /^p\d+$/.test(e.id) ? e.id : `p${String(i + 1).padStart(5, '0')}` }));
  }
  await putCatalog(src, json);
  S.sources.push(src);
  await saveSources();
  rebuild();
  return src;
}

export async function removeSource(src) {
  S.sources = S.sources.filter((s) => s !== src);
  S.catalogs.delete(src.id);
  await store.set(`cat:${src.id}`, null);
  await saveSources();
  rebuild();
}

export async function setEnabled(src, on) {
  src.enabled = on;
  await saveSources();
  rebuild();
}

/** 作品を候補から外す／戻す（どのカタログで外すかを指定。省略なら、載っているカタログ全部） */
export async function setHidden(work, hide, sourceIds = null) {
  const ids = sourceIds || work.refs.map((r) => r.sourceId);
  for (const src of S.sources.filter((s) => ids.includes(s.id))) {
    const set = new Set(src.hidden || []);
    if (hide) set.add(work.key); else set.delete(work.key);
    src.hidden = [...set];
  }
  await saveSources();
  rebuild();
}

/** まとめて候補から外す／戻す */
export async function setHiddenMany(works, hide, sourceIds = null) {
  for (const work of works) {
    const ids = sourceIds || work.refs.map((r) => r.sourceId);
    for (const src of S.sources.filter((s) => ids.includes(s.id))) {
      const set = new Set(src.hidden || []);
      if (hide) set.add(work.key); else set.delete(work.key);
      src.hidden = [...set];
    }
  }
  await saveSources();
  rebuild();
}

// ------------------------------------------------------------ フォルダ（作者さんごと・企画ごとなど、自由に名前を付けて分ける）
// 作品は、いくつのフォルダに入れてもよい。共用カタログの作品も入れられる（カタログそのものは変えない）。
export async function loadFolders() {
  const f = (await store.get('folders')) || {};
  S.folders = { list: Array.isArray(f.list) ? f.list : [], map: f.map && typeof f.map === 'object' ? f.map : {} };
}
async function saveFolders() { await store.set('folders', S.folders); }
export const foldersOf = (key) => (S.folders.map[key] || []).map((id) => S.folders.list.find((f) => f.id === id)).filter(Boolean);
export async function createFolder(name) {
  const f = { id: `f-${Math.random().toString(36).slice(2, 10)}`, name: name.slice(0, 60) };
  S.folders.list.push(f);
  await saveFolders();
  return f;
}
export async function renameFolder(id, name) {
  const f = S.folders.list.find((x) => x.id === id);
  if (f) { f.name = name.slice(0, 60); await saveFolders(); }
}
export async function deleteFolder(id) {
  S.folders.list = S.folders.list.filter((f) => f.id !== id);
  for (const k of Object.keys(S.folders.map)) {
    S.folders.map[k] = S.folders.map[k].filter((x) => x !== id);
    if (!S.folders.map[k].length) delete S.folders.map[k];
  }
  await saveFolders();
}
export async function moveFolder(id, d) {
  const i = S.folders.list.findIndex((f) => f.id === id);
  const j = i + d;
  if (i < 0 || j < 0 || j >= S.folders.list.length) return;
  [S.folders.list[i], S.folders.list[j]] = [S.folders.list[j], S.folders.list[i]];
  await saveFolders();
}
export async function putInFolder(keys, id) {
  for (const k of keys) {
    const cur = new Set(S.folders.map[k] || []);
    cur.add(id);
    S.folders.map[k] = [...cur];
  }
  await saveFolders();
}
export async function takeOutOfFolder(keys, id) {
  for (const k of keys) {
    S.folders.map[k] = (S.folders.map[k] || []).filter((x) => x !== id);
    if (!S.folders.map[k].length) delete S.folders.map[k];
  }
  await saveFolders();
}

/** 個人用カタログ（own）の作品を、指定したカタログに入れる／直す／抜く */
export async function saveOwnEntry(entry, { origKey = '', targetIds = [] }) {
  const key = workKey(entry);
  for (const src of ownSources()) {
    const cat = S.catalogs.get(src.id);
    const entries = [...cat.entries];
    const i = entries.findIndex((e) => workKey(e) === (origKey || key));
    if (targetIds.includes(src.id)) {
      if (i >= 0) entries[i] = { ...entry, id: entries[i].id };
      else entries.push({ ...entry, id: nextPersonalId(entries) });
    } else if (i >= 0) {
      entries.splice(i, 1);
    } else continue;
    await putCatalog(src, { format: 1, authors: cat.authors, entries });
  }
  if (origKey && origKey !== key && S.workPrefs[origKey]) {
    S.workPrefs[key] = S.workPrefs[origKey];
    delete S.workPrefs[origKey];
    await store.set('workPrefs', S.workPrefs);
  }
  // 名前・作者を直したら、フォルダの分け方も引き継ぐ
  if (origKey && origKey !== key && S.folders?.map[origKey]) {
    S.folders.map[key] = [...new Set([...(S.folders.map[key] || []), ...S.folders.map[origKey]])];
    delete S.folders.map[origKey];
    await saveFolders();
  }
  await saveSources();
  rebuild();
}

/** 人に渡せるDL一覧（JSON）にする */
export function exportSource(src, { includeKeys = false, labels = null } = {}) {
  const cat = S.catalogs.get(src.id);
  const out = exportPersonal(src.name, cat.entries, { hidden: src.hidden, tool: `CWカタログ ${APP_VERSION}` });
  out.authors = cat.authors || {};
  const def = (e) => S.workPrefs[workKey(e)]?.defaultUrl;
  // デフォルトのDL先にしているものを先頭にしておく（受け取った人もそこから取る）
  out.entries = out.entries.map((e) => {
    const d = def(e);
    let dl = d ? [...e.downloads].sort((a, b) => (b.url === d) - (a.url === d)) : e.downloads;
    // DLキーは、選んだときだけ書き出す
    if (!includeKeys) dl = dl.map(({ dlkey, ...rest }) => rest);
    // ラベル：選んだフォルダの名前を付ける（選ばなければ付けない）
    const { labels: _old, ...rest } = e;
    const names = labels ? foldersOf(workKey(e)).filter((f) => labels.has(f.id)).map((f) => f.name) : [];
    return { ...rest, downloads: dl, ...(names.length ? { labels: names } : {}) };
  });
  return out;
}

/** カタログに付いているラベルの一覧（名前と件数） */
export function labelsOf(src) {
  const count = new Map();
  for (const e of S.catalogs.get(src.id)?.entries || []) for (const l of e.labels || []) count.set(l, (count.get(l) || 0) + 1);
  return [...count].map(([name, n]) => ({ name, n })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
}

/**
 * カタログのラベルを、自分のフォルダとして取り込む
 * @param {{names: string[]|null, prefix: boolean}} opt names が null なら全部。prefix なら「カタログ名：ラベル」というフォルダにする
 * @returns {Promise<number>} 入れた作品の数
 */
export async function importLabels(src, { names = null, prefix = false } = {}) {
  const want = names ? new Set(names) : null;
  let n = 0;
  for (const e of S.catalogs.get(src.id)?.entries || []) {
    for (const l of e.labels || []) {
      if (want && !want.has(l)) continue;
      const fname = (prefix ? `${src.name}：${l}` : l).slice(0, 60);
      let f = S.folders.list.find((x) => x.name === fname);
      if (!f) f = await createFolder(fname);
      const key = workKey(e);
      if (!(S.folders.map[key] || []).includes(f.id)) { await putInFolder([key], f.id); n++; }
    }
  }
  return n;
}

export async function setDefaultUrl(work, url) {
  S.workPrefs[work.key] = { ...(S.workPrefs[work.key] || {}), defaultUrl: url };
  await store.set('workPrefs', S.workPrefs);
}
export const defaultUrlOf = (work) => S.workPrefs[work.key]?.defaultUrl || '';

export async function setCatPrefs(patch) {
  Object.assign(S.catPrefs, patch);
  await store.set('catalogPrefs', S.catPrefs);
}

/** カタログと照らし合わせて、作品と更新状態を決める（候補から外したものは照らし合わせない） */
export function applyCatalog(r) {
  if (!S.combined) return r.type === 'bookmark' ? {} : { state: 'none', workKey: '' };
  if (r.type === 'bookmark') return { state: r.state || 'none' };
  let work = r.workKey ? S.combined.byKey.get(r.workKey) : null;
  let by = work ? 'key' : null;
  if (!work) {
    const m = matchWork(S.combined, r);
    if (m) { work = m.work; by = m.by; }
  }
  if (work?.hidden) work = null;
  const patch = { workKey: work?.key || '' };
  if (work && by === 'sha256' && !r.version) { patch.version = work.version; patch.versionSource = 'catalog'; }
  patch.state = updateState({ ...r, ...patch }, work);
  return patch;
}

export const workOf = (r) => (r.workKey && S.combined?.byKey.get(r.workKey)) || null;

/** カタログが変わったら、手元の記録の更新状態を付け直す */
export async function refreshStates() {
  const all = await store.records();
  for (const r of all) Object.assign(r, applyCatalog(r));
  await store.putRecords(all);
  S.records = await store.records();
}
