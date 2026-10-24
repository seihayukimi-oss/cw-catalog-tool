// カタログの保存・読み込み・まとめ直し（画面から使う）。
//  共用カタログ（shared）：作者さんが登録したサイト側のカタログ。URLで読む。書き換えない
//  個人用カタログ（own）：このツールの中で作って、作品を足したり直したりできる
//  個人用カタログ（sub）：有志の方などが作ったDL一覧を読み込んだもの。書き換えない（コピーすれば自分用にできる）

import { parseCatalog } from '../core/catalog.js';
import { combine, workKey, nextPersonalId, exportPersonal, matchWork } from '../core/catalogs.js';
import { sha256Hex } from '../core/archive.js';
import { updateState } from '../core/catalog.js';
import { S, APP_VERSION } from './state.js';
import { store } from './store.js';
import { SAMPLE_CATALOG } from './sample-catalog.js';

const newId = (kind) => `${kind}-${Math.random().toString(36).slice(2, 10)}`;
const emptyCatalog = () => ({ format: 1, authors: {}, entries: [] });

export async function loadCatalogs() {
  S.catPrefs = { addTo: 'all', askDefault: true, ...((await store.get('catalogPrefs')) || {}) };
  S.workPrefs = (await store.get('workPrefs')) || {};
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
  if (useMeta && src.url !== 'sample' && /\/index\.json(\?.*)?$/.test(src.url) && src.sha256) {
    const meta = await S.platform.fetchJson(src.url.replace(/index\.json(\?.*)?$/, 'meta.json')).catch(() => null);
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
  await saveSources();
  rebuild();
}

/** 人に渡せるDL一覧（JSON）にする */
export function exportSource(src, { includeKeys = false } = {}) {
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
    return { ...e, downloads: dl };
  });
  return out;
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
