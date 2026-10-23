// CWカタログツール 本体（HTML版・アプリ版で共通）

import { openArchive, openFolder, sha256Hex } from '../core/archive.js';
import { planInstall, performInstall, exportForWeb } from '../core/install.js';
import { scanScenarioFolder, detectEngineKind } from '../core/scan.js';
import { decodeText } from '../core/text.js';
import {
  parseCatalog, matchEntry, updateState, usableDownloads, playability, ENGINE_KINDS, compareVersions,
} from '../core/catalog.js';
import { comparePage } from '../core/pagecheck.js';
import { decodeHtml, extractDownloadLinks, extractDownloadForms, metaRefreshUrl, pageText, pageTitle, siteNotice } from '../core/weblink.js';
import { looksLikeZip } from '../core/zip.js';
import { store, recordId, exportRecords, importRecords } from './store.js';
import { h, toast, modal, fmtSize, fmtDate, formatBadge, sleep } from './ui.js';
import { SAMPLE_CATALOG } from './sample-catalog.js';

const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

const S = {
  platform: null,
  tab: 'mine',
  engines: [],
  engineId: null,
  dirs: new Map(),
  records: [],
  categories: {},
  catalog: null,
  catalogInfo: null,
  opened: null,
  pick: 0,
  readmeIdx: 0,
  readmeEnc: '',
  readmeAck: false,
  pendingEntry: null,
  filter: { mine: '', mineState: '', cat: '', catEngine: '', catType: '' },
  busy: '',
};

const STATE_LABEL = { latest: '最新', update: '更新あり', unknown: '版不明', none: 'カタログ外' };

// ------------------------------------------------------------ 起動
export async function startApp(platform) {
  S.platform = platform;
  document.documentElement.dataset.platform = platform.kind;
  S.engines = await store.engines();
  S.engineId = (await store.get('engineId')) || S.engines[0]?.id || null;
  S.categories = (await store.get('categories')) || {};
  const cached = await store.get('catalog');
  if (cached) {
    try { S.catalog = parseCatalog(cached.json); S.catalogInfo = cached.info; } catch { /* 壊れていたら捨てる */ }
  }
  S.records = await store.records();
  for (const e of S.engines) {
    const d = await platform.openFolder(e.ref).catch(() => null); // 許可が残っていればそのまま使える
    if (d) S.dirs.set(e.id, d);
  }
  setupDrop();
  render();
  handleInstallLink();
  if (platform.canUpdateSelf) setTimeout(() => checkSelf(false), 3000);
}

const engine = (id = S.engineId) => S.engines.find((e) => e.id === id) || null;
const recordsOf = (id = S.engineId) => S.records.filter((r) => r.engineId === id);

async function dirOf(id, ask = true) {
  if (S.dirs.has(id)) return S.dirs.get(id);
  const e = engine(id);
  if (!e?.ref) return null;
  const d = await S.platform.openFolder(e.ref, { ask });
  if (d) S.dirs.set(id, d);
  return d;
}

async function busy(label, fn) {
  S.busy = label;
  render();
  try {
    return await fn();
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); toast(e.message || String(e), { bad: true, ms: 8000 }); }
    return undefined;
  } finally {
    S.busy = '';
    render();
  }
}

// ------------------------------------------------------------ 描画
function render() {
  const root = document.getElementById('app');
  const view = { mine: viewMine, add: viewAdd, catalog: viewCatalog, settings: viewSettings }[S.tab]();
  const updates = S.records.filter((r) => r.state === 'update').length;
  const tabs = [
    ['mine', '手持ち', updates ? h('span', { class: 'count' }, updates) : null],
    ['add', '入れる', S.opened ? h('span', { class: 'count' }, '1') : null],
    ['catalog', 'カタログ'],
    ['settings', '設定'],
  ];
  root.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'top-inner' },
      h('div', { class: 'brand' }, h('h1', {}, 'CWカタログ'), h('span', { class: 'plat' }, `${S.platform.label} ${APP_VERSION}`),
        S.busy ? h('span', { class: 'small muted' }, `${S.busy}…`) : null),
      h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([k, label, extra]) => h('button', {
        role: 'tab', 'aria-selected': S.tab === k ? 'true' : 'false', onclick: () => { S.tab = k; render(); },
      }, label, extra))))),
    h('main', {}, view),
  );
}

// ------------------------------------------------------------ 手持ち
function viewMine() {
  if (!S.engines.length) {
    return h('div', { class: 'card stack' },
      h('h2', {}, 'はじめに'),
      h('p', {}, 'CardWirth（1.50・Next・Py）のフォルダを登録すると、入っているシナリオを読み取って一覧にします。'),
      S.platform.canWriteFolders
        ? h('button', { class: 'btn primary', onclick: addEngine }, 'CardWirthのフォルダを登録する')
        : h('p', { class: 'note warn' }, 'このブラウザはフォルダの読み書きに対応していません。パソコンのChrome・Edgeか、アプリ版を使ってください。zipの中身の確認と、WebCardWirth用の書き出しは「入れる」タブでできます。'),
    );
  }
  if (!engine()) S.engineId = S.engines[0].id;
  const e = engine();
  const connected = e && S.dirs.has(e.id);
  const q = S.filter.mine.normalize('NFKC').toLowerCase();
  let recs = recordsOf().filter((r) => !q || `${r.name} ${r.author} ${r.path} ${(r.tags || []).join(' ')}`.normalize('NFKC').toLowerCase().includes(q));
  if (S.filter.mineState) recs = recs.filter((r) => (S.filter.mineState === 'missing' ? r.missing : (r.state || 'none') === S.filter.mineState));
  recs.sort((a, b) => (b.state === 'update') - (a.state === 'update') || (a.path || '').localeCompare(b.path || '', 'ja'));

  const list = h('div', { class: 'list', id: 'mine-list' }, recs.length ? recs.map(recordCard) : h('p', { class: 'empty' }, recordsOf().length ? '見つかりませんでした' : 'まだ記録がありません。「読み取る」を押してください'));

  return h('div', {},
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('select', { 'aria-label': 'エンジン', onchange: async (ev) => { S.engineId = ev.target.value; await store.set('engineId', S.engineId); render(); } },
          S.engines.map((x) => h('option', { value: x.id, selected: x.id === S.engineId ? 'selected' : null }, `${x.name}（${ENGINE_KINDS[x.kind]?.short || x.kind}）`))),
        connected
          ? h('button', { class: 'btn', onclick: () => scanEngine(e.id) }, '読み取る')
          : h('button', { class: 'btn primary', onclick: () => connectEngine(e.id) }, 'フォルダに接続'),
        h('button', { class: 'btn', onclick: checkUpdates }, '更新チェック'),
        h('button', { class: 'btn', onclick: addBookmark }, 'カタログ外を登録'),
        S.platform.kind === 'app' && e.kind !== 'wcw' ? h('button', { class: 'btn', onclick: () => busy('起動', () => S.platform.launch(e.ref, e.kind)) }, '起動') : null,
      ),
      h('div', { class: 'row', style: 'margin-top:10px' },
        h('input', { type: 'search', class: 'grow', placeholder: '名前・作者・タグで絞り込み', value: S.filter.mine, oninput: (ev) => { S.filter.mine = ev.target.value; rerenderList('mine-list', viewMine); } }),
        h('select', { 'aria-label': '状態', onchange: (ev) => { S.filter.mineState = ev.target.value; render(); } },
          [['', 'すべて'], ['update', '更新あり'], ['unknown', '版不明'], ['latest', '最新'], ['none', 'カタログ外'], ['missing', '見つからない']]
            .map(([v, l]) => h('option', { value: v, selected: S.filter.mineState === v ? 'selected' : null }, l))),
      ),
      e.lastScan ? h('p', { class: 'small muted', style: 'margin:8px 0 0' }, `最後に読み取った日時：${fmtDate(e.lastScan)}／${recordsOf().length}件`) : null,
      !connected && S.platform.kind === 'web' ? h('p', { class: 'small muted', style: 'margin:6px 0 0' }, 'ブラウザは開くたびにフォルダの許可を聞き直します。「フォルダに接続」を押して許可してください。') : null,
    ),
    list,
  );
}

function rerenderList(id, viewFn) {
  // 入力中のフォーカスを失わないよう、一覧の部分だけ差し替える
  const fresh = viewFn().querySelector(`#${id}`);
  document.getElementById(id)?.replaceWith(fresh);
}

function recordCard(r) {
  const entry = r.entryId && S.catalog?.byId.get(r.entryId);
  const st = r.state || (S.catalog ? 'none' : null);
  const save = async (patch) => {
    Object.assign(r, patch);
    if (S.catalog) Object.assign(r, applyCatalog(r));
    await store.putRecord(r);
    render();
  };
  const tagInput = h('input', {
    type: 'text', class: 'sm', placeholder: '＋タグ', style: 'width:7em', 'aria-label': 'タグを追加',
    onkeydown: (ev) => {
      if (ev.key === 'Enter' && ev.target.value.trim()) {
        const t = ev.target.value.trim();
        save({ tags: [...new Set([...(r.tags || []), t])] });
      }
    },
  });
  return h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', { class: 'row' },
        h('span', { class: 'item-title' }, r.name || '(名前なし)'),
        r.type === 'bookmark' ? h('span', { class: 'badge plain' }, 'ブックマーク') : formatBadge(r),
        r.encrypted ? h('span', { class: 'badge enc', title: 'NextのWirthBuilderで暗号化（WDP）されたデータです' }, '暗号化') : null,
        st ? h('span', { class: `badge ${st === 'update' ? 'update' : st === 'latest' ? 'ok' : 'plain'}` }, STATE_LABEL[st]) : null,
        r.missing ? h('span', { class: 'badge bad' }, '見つからない') : null,
        r.pageChanged ? h('span', { class: 'badge update' }, 'ページに変化あり') : null,
      ),
      h('div', { class: 'row' },
        r.readmes?.length ? h('button', { class: 'btn ghost', onclick: () => showReadmes(r) }, 'りどみ') : null,
        r.pageUrl ? h('button', { class: 'btn ghost', onclick: () => S.platform.openUrl(r.pageUrl) }, '配布ページ') : null,
        entry ? h('button', { class: 'btn ghost', onclick: () => { S.filter.cat = entry.name; S.tab = 'catalog'; render(); } }, 'カタログ') : null,
        r.missing || r.type === 'bookmark' ? h('button', { class: 'btn ghost danger', onclick: async () => { await store.deleteRecord(r.id); S.records = S.records.filter((x) => x.id !== r.id); render(); } }, '削除') : null,
      )),
    h('div', { class: 'meta' }, [r.author, r.type === 'bookmark' ? r.pageUrl : r.path].filter(Boolean).join('　')),
    h('div', { class: 'row', style: 'margin-top:6px' },
      h('label', { class: 'row small muted' }, 'バージョン',
        h('input', {
          type: 'text', class: 'ver', value: r.version || '', placeholder: r.versionGuess || '未設定',
          onchange: (ev) => save({ version: ev.target.value.trim(), versionSource: ev.target.value.trim() ? 'user' : '' }),
        })),
      !r.version && r.versionGuess ? h('button', { class: 'btn sm', onclick: () => save({ version: r.versionGuess, versionSource: 'guess' }) }, `推測「${r.versionGuess}」を使う`) : null,
      r.versionSource ? h('span', { class: 'small muted' }, { catalog: '（カタログで確定）', user: '（手入力）', guess: '（名前から推測）' }[r.versionSource]) : null,
      h('span', { class: 'row' }, (r.tags || []).map((t) => h('span', { class: 'tag' }, t,
        h('button', { 'aria-label': `${t}を外す`, onclick: () => save({ tags: r.tags.filter((x) => x !== t) }) }, '×'))), tagInput),
    ),
    st === 'update' && entry ? h('div', { class: 'note warn', style: 'margin-top:8px' },
      `新しい版 ${entry.version} があります（手元：${r.version}）`,
      downloadButtons(entry)) : null,
    r.note ? h('div', { class: 'small muted', style: 'margin-top:4px' }, r.note) : null,
  );
}

function showReadmes(r) {
  modal((close) => {
    let idx = 0;
    const pre = h('pre', { class: 'readme' }, r.readmes[0].text);
    return h('div', { class: 'stack' },
      h('h2', {}, `${r.name} のりどみ`),
      h('div', { class: 'readme-list' }, r.readmes.map((x, i) => h('button', {
        class: 'btn sm', 'aria-pressed': i === 0 ? 'true' : 'false',
        onclick: (ev) => { idx = i; pre.textContent = r.readmes[i].text; ev.target.parentElement.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', j === idx ? 'true' : 'false')); },
      }, x.name))),
      pre,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close() }, '閉じる')));
  });
}

// ------------------------------------------------------------ エンジン
async function addEngine() {
  await busy('フォルダを登録', async () => {
    const picked = await S.platform.pickFolder();
    let kind = await detectEngineKind(picked.dir);
    if (!(await picked.dir.dir('Scenario'))) {
      const ok = await confirmBox('このフォルダには「Scenario」フォルダがありません。CardWirthのフォルダ（CardWirth.exe などがある場所）を選んでください。それでも登録しますか？');
      if (!ok) return;
    }
    if (!kind) kind = await chooseKind(picked.label);
    if (!kind) return;
    await registerEngine(picked, kind);
  });
}

async function registerEngine(picked, kind) {
  const id = 'eng-' + Math.random().toString(36).slice(2, 10);
  const e = { id, name: `${ENGINE_KINDS[kind].name}`, kind, ref: picked.ref, label: picked.label, addedAt: new Date().toISOString() };
  await store.putEngine(e);
  S.engines.push(e);
  S.dirs.set(id, picked.dir);
  S.engineId = id;
  await store.set('engineId', id);
  toast(`${e.name} を登録しました。読み取りを始めます`);
  await scanEngine(id);
}

function chooseKind(label) {
  return modal((close) => {
    const sel = h('select', {}, Object.entries(ENGINE_KINDS).filter(([k]) => k !== 'wcw').map(([k, v]) => h('option', { value: k }, v.name)));
    return h('div', { class: 'stack' },
      h('h2', {}, 'どのエンジンですか？'),
      h('p', { class: 'small muted' }, `「${label}」からは自動で判定できませんでした。`),
      sel,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { class: 'btn primary', onclick: () => close(sel.value) }, '決定')));
  });
}

function confirmBox(msg) {
  return modal((close) => h('div', { class: 'stack' },
    h('p', {}, msg),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'いいえ'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, 'はい'))));
}

async function connectEngine(id) {
  await busy('フォルダに接続', async () => {
    const d = await dirOf(id, true);
    if (!d) throw new Error('フォルダを使う許可がありませんでした。もう一度押して許可してください');
    if (engine(id)?.needsReconnect) {
      toast('記録を読み込んだエンジンなので、フォルダを選び直してください');
    }
    toast('接続しました');
  });
}

async function scanEngine(id) {
  await busy('読み取り中', async () => {
    const d = await dirOf(id, true);
    if (!d) throw new Error('フォルダに接続できませんでした');
    const res = await scanScenarioFolder(d, { onProgress: (p) => { const el = document.querySelector('.brand .small'); if (el) el.textContent = `読み取り中… ${p}`; } });
    const old = new Map(recordsOf(id).filter((r) => r.type !== 'bookmark').map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const fresh = res.items.map((it) => {
      const rid = recordId(id, it.path, it.inner);
      const prev = old.get(rid) || {};
      old.delete(rid);
      const r = {
        tags: [], version: '', versionSource: '', entryId: '', readmes: [],
        ...prev,
        id: rid, engineId: id, path: it.path, inner: it.inner || '', type: it.type,
        name: it.name, author: it.author, format: it.format, dataVersion: it.dataVersion ?? null, wsnVersion: it.wsnVersion ?? null,
        encrypted: it.encrypted ?? null, versionGuess: it.versionGuess || '', sha256: it.sha256 || prev.sha256 || '',
        note: it.note || prev.note || '', seenAt: now, missing: false,
      };
      return S.catalog ? { ...r, ...applyCatalog(r) } : r;
    });
    const missing = [...old.values()].map((r) => ({ ...r, missing: true }));
    await store.putRecords([...fresh, ...missing]);
    S.records = await store.records();
    S.categories[id] = res.categories;
    await store.set('categories', S.categories);
    const e = engine(id);
    e.lastScan = now;
    await store.putEngine(e);
    toast(`${fresh.length}件を読み取りました${missing.length ? `（見つからないもの ${missing.length}件）` : ''}${res.warnings.length ? `。読めなかったもの ${res.warnings.length}件` : ''}`);
    if (res.warnings.length) console.warn(res.warnings);
  });
}

/** カタログと照らし合わせて、作品IDと更新状態を決める */
function applyCatalog(r) {
  if (!S.catalog) return {};
  if (r.type === 'bookmark') return { state: r.state || 'none' };
  let entry = r.entryId ? S.catalog.byId.get(r.entryId) : null;
  let by = entry ? 'id' : null;
  if (!entry) {
    const m = matchEntry(S.catalog, r);
    if (m) { entry = m.entry; by = m.by; }
  }
  const patch = { entryId: entry?.id || '' };
  if (entry && by === 'sha256' && !r.version) { patch.version = entry.version; patch.versionSource = 'catalog'; }
  patch.state = updateState({ ...r, ...patch }, entry);
  return patch;
}

// ------------------------------------------------------------ カタログ外（ブックマーク）
async function addBookmark() {
  const v = await modal((close) => {
    const f = { name: h('input', { type: 'text', required: true }), author: h('input', { type: 'text' }), url: h('input', { type: 'url', placeholder: 'https://' }), ver: h('input', { type: 'text' }), note: h('input', { type: 'text' }) };
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close({ name: f.name.value.trim(), author: f.author.value.trim(), url: f.url.value.trim(), version: f.ver.value.trim(), note: f.note.value.trim() }); } },
      h('h2', {}, 'カタログ外の作品を登録'),
      h('p', { class: 'small muted' }, '配布ページを登録しておくと、アプリ版では「更新チェック」でページの変化（配布ファイル名の変化）を確認できます。'),
      h('label', { class: 'field' }, '作品名', f.name),
      h('label', { class: 'field' }, '作者', f.author),
      h('label', { class: 'field' }, '配布ページのURL', f.url),
      h('label', { class: 'field' }, '手元のバージョン', f.ver),
      h('label', { class: 'field' }, 'メモ', f.note),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '登録')));
  });
  if (!v || !v.name) return;
  if (v.url && !/^https?:\/\//.test(v.url)) { toast('URLは https:// から始まるものにしてください', { bad: true }); return; }
  const r = {
    id: recordId(S.engineId || 'none', `bookmark:${Date.now().toString(36)}`), engineId: S.engineId || 'none', type: 'bookmark',
    path: '', name: v.name, author: v.author, pageUrl: v.url, version: v.version, versionSource: v.version ? 'user' : '',
    note: v.note, tags: [], format: 'unknown', state: 'none', addedAt: new Date().toISOString(),
  };
  await store.putRecord(r);
  S.records.push(r);
  render();
}

// ------------------------------------------------------------ 更新チェック
async function loadCatalog(url, { quiet = false, useMeta = false } = {}) {
  // 更新チェックのときは、まず小さい meta.json だけを見て、変わっていなければ本体を取らない
  if (useMeta && url !== 'sample' && /\/index\.json(\?.*)?$/.test(url) && S.catalogInfo?.url === url && S.catalogInfo.sha256) {
    const meta = await S.platform.fetchJson(url.replace(/index\.json(\?.*)?$/, 'meta.json')).catch(() => null);
    if (meta?.sha256 && meta.sha256 === S.catalogInfo.sha256) {
      S.catalogInfo = { ...S.catalogInfo, checkedAt: new Date().toISOString() };
      return;
    }
  }
  const json = url === 'sample' ? SAMPLE_CATALOG : await S.platform.fetchJson(url);
  const cat = parseCatalog(json);
  S.catalog = cat;
  // meta.json の sha256 と比べられるよう、index.json と同じ書き方（区切りなしのJSON）で指紋を取る
  const sha256 = url === 'sample' ? '' : await sha256Hex(new TextEncoder().encode(JSON.stringify(json)));
  S.catalogInfo = { url, loadedAt: new Date().toISOString(), count: cat.entries.length, sha256 };
  await store.set('catalog', { json, info: S.catalogInfo });
  if (!quiet) toast(`カタログを読み込みました（${cat.entries.length}件）`);
}

async function checkUpdates() {
  await busy('更新チェック', async () => {
    const url = await store.get('catalogUrl', '');
    let online = true;
    if (url) {
      try { await loadCatalog(url, { quiet: true, useMeta: true }); } catch (e) { online = false; toast(`カタログを取れませんでした（前回の内容で確認します）：${e.message}`, { bad: true }); }
    } else if (!S.catalog) {
      toast('カタログのURLが未設定です。「カタログ」タブで設定できます');
    }
    const all = await store.records();
    const changed = [];
    for (const r of all) {
      const patch = applyCatalog(r);
      if (Object.keys(patch).length) { Object.assign(r, patch); changed.push(r); }
    }

    // カタログ外のブックマーク：アプリ版だけ配布ページを見に行く
    let pages = 0, pageChanged = 0, pageFailed = 0;
    if (S.platform.canCheckPages && online) {
      const bms = all.filter((r) => r.type === 'bookmark' && r.pageUrl);
      for (const r of bms) {
        try {
          const html = await S.platform.fetchText(r.pageUrl);
          const c = comparePage(html, r.pageSnapshot);
          r.pageSnapshot = { mode: c.mode, snapshot: c.snapshot, at: new Date().toISOString() };
          if (c.changed) { r.pageChanged = { added: c.added, removed: c.removed, at: r.pageSnapshot.at }; pageChanged++; }
          pages++;
        } catch { pageFailed++; }
        if (!changed.includes(r)) changed.push(r);
        await sleep(1500); // 相手のサイトに負担をかけないよう、1件ずつ間をあける
      }
    }
    await store.putRecords(changed);
    S.records = await store.records();
    await store.set('lastCheck', new Date().toISOString());
    const n = S.records.filter((r) => r.state === 'update').length;
    toast([`更新あり ${n}件`, pages ? `ページ確認 ${pages}件（変化 ${pageChanged}件${pageFailed ? `・確認できず ${pageFailed}件` : ''}）` : ''].filter(Boolean).join('／'));
  });
}

// ------------------------------------------------------------ 入れる
function setupDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.querySelector('.drop')?.classList.add('over'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.querySelector('.drop')?.classList.remove('over'); } });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    const item = e.dataTransfer.items?.[0];
    // フォルダのドロップ（Chrome・Edge）
    if (item?.getAsFileSystemHandle) {
      const handle = await item.getAsFileSystemHandle().catch(() => null);
      if (handle?.kind === 'directory') {
        const { FsaDirFromHandle } = S.platform;
        if (FsaDirFromHandle) return openSource(() => openFolder(FsaDirFromHandle(handle)));
      }
    }
    const file = e.dataTransfer.files[0];
    await openSource(async () => openArchive(new Uint8Array(await file.arrayBuffer()), file.name));
  });
}

async function openSource(fn, entry = null) {
  S.tab = 'add';
  const opened = await busy('分析中', fn);
  if (!opened) return;
  S.opened = opened;
  S.pick = 0;
  S.readmeIdx = 0;
  S.readmeEnc = '';
  S.readmeAck = !opened.readmes.length;
  S.pendingEntry = entry || (S.catalog && opened.scenarios[0] ? matchEntry(S.catalog, { ...opened.scenarios[0], sha256: opened.source.sha256 })?.entry : null) || null;
  S.matchBy = S.pendingEntry && S.pendingEntry.file.sha256 === opened.source.sha256 ? 'sha256' : S.pendingEntry ? 'name' : null;
  render();
}

function viewAdd() {
  const fileInput = h('input', {
    type: 'file', accept: '.zip,.wsn', style: 'display:none',
    onchange: async (ev) => {
      const f = ev.target.files[0];
      if (f) await openSource(async () => openArchive(new Uint8Array(await f.arrayBuffer()), f.name));
    },
  });
  const drop = h('div', { class: 'drop stack' },
    h('div', { class: 'big' }, 'zip・wsn をここにドロップ'),
    h('div', { class: 'small muted' }, '展開済みのフォルダもドロップできます（Chrome・Edge・アプリ版）'),
    h('div', { class: 'row', style: 'justify-content:center' },
      h('button', { class: 'btn', onclick: () => fileInput.click() }, 'ファイルを選ぶ'),
      S.platform.canWriteFolders ? h('button', { class: 'btn', onclick: () => openSource(async () => openFolder(await S.platform.pickSourceFolder())) }, 'フォルダを選ぶ') : null),
    fileInput);
  const urlBox = viewUrlBox();
  if (!S.opened) {
    return h('div', {}, drop, urlBox,
      h('div', { class: 'card soft small' },
        h('h3', {}, 'できること'),
        h('ul', { style: 'margin:0;padding-left:1.2em' },
          h('li', {}, '文字化けしたファイル名を正しく読み直します（UTF-8・Shift_JISを自動判定）'),
          h('li', {}, 'シナリオの範囲・形式（クラシック／Next／Py）・暗号化の有無を判定します'),
          h('li', {}, 'りどみを表示してから、エンジンのScenarioフォルダに入れます（同じものがあればバックアップしてから置き換え）'),
          h('li', {}, 'WebCardWirthの「追加データのインストール（ZIP）」で入れやすいzipに書き出せます'))));
  }

  const o = S.opened;
  const sc = o.scenarios[S.pick];
  const entry = S.pendingEntry;
  const parts = [drop, urlBox];

  parts.push(h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'item-title' }, o.source.name),
        h('div', { class: 'meta' }, `${fmtSize(o.source.size)}・${o.files.length}ファイル${o.source.sha256 ? `・SHA-256 ${o.source.sha256.slice(0, 12)}…` : ''}`)),
      h('button', { class: 'btn ghost', onclick: () => { S.opened = null; render(); } }, '閉じる')),
    o.nonUtf8Names ? h('p', { class: 'note ok small' }, `UTF-8の目印が無いファイル名 ${o.nonUtf8Names}件 を、文字コードを判定して読み直しました。`) : null,
    entry ? h('p', { class: 'note ok small' }, `カタログの「${entry.name}」ver ${entry.version} と${S.matchBy === 'sha256' ? 'ファイルが一致しました（版まで確定）' : '名前が一致しました'}。`) : null,
    o.warnings?.length ? h('details', { class: 'small' }, h('summary', {}, `注意 ${o.warnings.length}件`), h('ul', {}, o.warnings.map((w) => h('li', {}, w)))) : null,
  ));

  if (!sc) {
    parts.push(h('div', { class: 'card note bad' }, 'シナリオが見つかりませんでした（Summary.wsm・Summary.xml がありません）。スキンや素材のzipは、この版ではまだ扱えません。'));
    return h('div', {}, parts);
  }

  if (o.scenarios.length > 1) {
    parts.push(h('div', { class: 'card' }, h('h3', {}, `${o.scenarios.length}本のシナリオが入っています`),
      h('div', { class: 'row' }, o.scenarios.map((s, i) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'pick', checked: i === S.pick, onchange: () => { S.pick = i; render(); } }), s.name)))));
  }

  parts.push(h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('span', { class: 'item-title' }, sc.name), formatBadge(sc),
      sc.encrypted ? h('span', { class: 'badge enc' }, '暗号化（WDP）') : null),
    h('div', { class: 'meta' }, `${sc.author}・${sc.root || '(zipのトップ)'}・${sc.files.length}ファイル・${fmtSize(sc.size)}`),
    sc.description ? h('div', { class: 'desc full' }, sc.description.replace(/^\n+|\s+$/g, '')) : null));

  // りどみ
  if (o.readmes.length) {
    const cur = o.readmes[S.readmeIdx];
    const pre = h('pre', { class: 'readme', id: 'readme-view' }, '読み込み中…');
    const fileRef = o.files.find((f) => f.path === cur.path);
    fileRef.read().then((b) => {
      const t = decodeText(b, S.readmeEnc || undefined);
      pre.textContent = t.text;
      const info = document.getElementById('readme-enc');
      if (info) info.textContent = `${t.encoding === 'shift_jis' ? 'Shift_JIS' : t.encoding.toUpperCase()}${t.lossy ? '（一部読めない文字あり）' : ''}`;
    });
    parts.push(h('div', { class: 'card stack' },
      h('div', { class: 'row between' }, h('h3', {}, 'りどみ'),
        h('div', { class: 'row small' }, h('span', { id: 'readme-enc', class: 'muted' }),
          h('select', { 'aria-label': '文字コード', onchange: (ev) => { S.readmeEnc = ev.target.value; render(); } },
            [['', '自動'], ['utf-8', 'UTF-8'], ['shift_jis', 'Shift_JIS'], ['utf-16le', 'UTF-16']].map(([v, l]) => h('option', { value: v, selected: S.readmeEnc === v ? 'selected' : null }, l))))),
      h('div', { class: 'readme-list' }, o.readmes.slice(0, 12).map((r, i) => h('button', {
        class: 'btn sm', 'aria-pressed': i === S.readmeIdx ? 'true' : 'false', onclick: () => { S.readmeIdx = i; render(); },
      }, r.path.split('/').pop()))),
      pre,
      authorReadme(entry),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.readmeAck, onchange: (ev) => { S.readmeAck = ev.target.checked; render(); } }), 'りどみを読みました'),
    ));
  }

  // 入れ先
  const eng = engine();
  const cats = S.categories[S.engineId] || [];
  const catSel = h('select', { id: 'dest-cat' }, h('option', { value: '' }, '（Scenario直下）'), cats.map((c) => h('option', { value: c }, c)), h('option', { value: '__new' }, '新しいフォルダ…'));
  catSel.value = S.destCat && (cats.includes(S.destCat) || S.destCat === '__new') ? S.destCat : '';
  const newCat = h('input', { type: 'text', id: 'dest-newcat', placeholder: '新しい分類フォルダ名', style: S.destCat === '__new' ? '' : 'display:none', value: S.destNewCat || '' });
  catSel.addEventListener('change', () => { S.destCat = catSel.value; newCat.style.display = catSel.value === '__new' ? '' : 'none'; });
  newCat.addEventListener('input', () => { S.destNewCat = newCat.value; });
  const nameIn = h('input', { type: 'text', id: 'dest-name', value: S.destName ?? sc.folderName, oninput: (ev) => { S.destName = ev.target.value; } });
  const verIn = h('input', { type: 'text', class: 'ver', id: 'dest-ver', value: S.destVer ?? (S.matchBy === 'sha256' ? entry.version : sc.versionGuess || ''), oninput: (ev) => { S.destVer = ev.target.value; } });

  let planInfo = null;
  if (eng) {
    try {
      const plan = planInstall(o, S.pick, eng, '', { folderName: sc.folderName });
      planInfo = plan;
    } catch (e) { planInfo = { error: e.message }; }
  }
  const play = eng ? playability(sc, eng.kind) : null;
  const connected = eng && S.dirs.has(eng.id);
  const [force, setForce] = [S.force, (v) => { S.force = v; render(); }];
  const canInstall = eng && S.platform.canWriteFolders && S.readmeAck && play && (play.ok || force) && !S.busy;

  parts.push(h('div', { class: 'card stack' },
    h('h3', {}, '入れ先'),
    S.engines.length ? h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'エンジン',
        h('select', { onchange: async (ev) => { S.engineId = ev.target.value; await store.set('engineId', S.engineId); S.destCat = undefined; render(); } },
          S.engines.map((x) => h('option', { value: x.id, selected: x.id === S.engineId ? 'selected' : null }, `${x.name}${S.dirs.has(x.id) ? '' : '（未接続）'}`)))),
      h('label', { class: 'field' }, '分類フォルダ', catSel, newCat),
      h('label', { class: 'field' }, 'フォルダ名', nameIn),
      h('label', { class: 'field' }, 'バージョン（記録用）', verIn),
    ) : h('p', { class: 'small muted' }, 'エンジンが未登録です。「設定」タブで登録すると、ここから直接インストールできます。'),
    play ? h('p', { class: `note ${play.level === 'ok' ? 'ok' : play.level === 'caution' ? 'warn' : 'bad'}` },
      play.level === 'ok' ? `${eng.name}で遊べます。` : play.reason,
      play.level === 'convert' ? '（Next→Pyの変換は、今後のアプリ版で「自己責任」で使える機能として追加予定です）' : null) : null,
    planInfo?.warnings?.map((w) => h('p', { class: 'note warn small' }, w)),
    play && !play.ok ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!force, onchange: (ev) => setForce(ev.target.checked) }), 'それでも入れる') : null,
    !S.readmeAck ? h('p', { class: 'small muted' }, '※ りどみを読んでからインストールできます') : null,
    S.progress ? h('div', { class: 'stack' },
      h('progress', { id: 'inst-prog', max: S.progress.total || 1, value: S.progress.done }),
      h('div', { id: 'inst-prog-text', class: 'small muted' }, '準備中…')) : null,
    h('div', { class: 'row' },
      eng && !connected ? h('button', { class: 'btn', onclick: () => connectEngine(eng.id) }, 'フォルダに接続') : null,
      h('button', { class: 'btn primary', disabled: !canInstall, onclick: doInstall }, 'インストール'),
      h('button', { class: 'btn', disabled: !S.readmeAck, onclick: doExportWeb }, 'WebCardWirth用に書き出す'),
    ),
  ));
  return h('div', {}, parts);
}

function authorReadme(entry) {
  const a = entry && S.catalog?.authors?.[entry.owner];
  if (!a?.readme_url) return null;
  const box = h('details', { class: 'small' }, h('summary', {}, `作者さん共通のりどみ（${a.names[0] || entry.author}）`));
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const pre = h('pre', { class: 'readme' }, '読み込み中…');
    box.append(pre);
    try {
      const b = await S.platform.fetchFile(a.readme_url);
      pre.textContent = b ? decodeText(b).text : '読み込めませんでした。';
    } catch (e) { pre.textContent = `読み込めませんでした：${e.message}`; }
  }, { once: false });
  return box;
}

async function doInstall() {
  const o = S.opened;
  const sc = o.scenarios[S.pick];
  const eng = engine();
  const catVal = document.getElementById('dest-cat')?.value ?? '';
  const cat = catVal === '__new' ? (document.getElementById('dest-newcat')?.value || '').trim() : catVal;
  const folderName = (document.getElementById('dest-name')?.value || sc.folderName).trim();
  const version = (document.getElementById('dest-ver')?.value || '').trim();

  // フォルダの許可は、ボタンを押した直後に聞く（時間がたつとブラウザが確認を出せなくなるため）
  let d = S.dirs.get(eng.id);
  if (!d) {
    toast('ブラウザの上部に「編集を許可しますか？」の確認が出たら、許可を押してください', { ms: 12000 });
    d = await dirOf(eng.id, true).catch(() => null);
    if (!d) { toast('フォルダを使う許可がありませんでした。もう一度「インストール」を押して許可してください', { bad: true, ms: 9000 }); return; }
  }

  let last = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - last > 15000) {
      const t = document.getElementById('inst-prog-text');
      if (t) t.textContent = '止まっているように見えます。ブラウザの上部に許可の確認や、ウイルス対策ソフトの確認が出ていないか見てください。';
    }
  }, 5000);
  const setProgress = (done, total, phase, name) => {
    last = Date.now();
    S.progress = { done, total, phase };
    const bar = document.getElementById('inst-prog');
    const t = document.getElementById('inst-prog-text');
    if (bar) { bar.max = total; bar.value = done; }
    if (t) t.textContent = `${phase === 'backup' ? '前のものをバックアップ中' : '書き込み中'}　${done} / ${total}　${name.split('/').pop()}`;
    const head = document.querySelector('.brand .small');
    if (head) head.textContent = `インストール中… ${done}/${total}`;
  };

  S.progress = { done: 0, total: 0, phase: 'write' };
  await busy('インストール中', async () => {
    const plan = planInstall(o, S.pick, eng, cat, { folderName });
    setProgress(0, plan.files.length, 'write', '');
    const res = await performInstall(d, plan, { onProgress: setProgress });
    const readmes = [];
    for (const r of o.readmes.slice(0, 4)) {
      const f = o.files.find((x) => x.path === r.path);
      readmes.push({ name: r.path.split('/').pop(), text: decodeText(await f.read()).text.slice(0, 200000) });
    }
    const entry = S.pendingEntry;
    const rec = {
      id: recordId(eng.id, plan.dest, ''), engineId: eng.id, path: plan.dest, inner: '', type: plan.passthrough ? 'archive' : 'folder',
      name: sc.name, author: sc.author, format: sc.format, dataVersion: sc.dataVersion, wsnVersion: sc.wsnVersion, encrypted: sc.encrypted,
      version, versionSource: version ? (S.matchBy === 'sha256' && version === entry?.version ? 'catalog' : 'user') : '',
      versionGuess: sc.versionGuess || '', tags: (await store.getRecord(recordId(eng.id, plan.dest, '')))?.tags || [],
      entryId: entry?.id || '', sha256: o.source.sha256 || '', sourceName: o.source.name,
      installedAt: new Date().toISOString(), seenAt: new Date().toISOString(), missing: false, readmes,
    };
    Object.assign(rec, applyCatalog(rec));
    await store.putRecord(rec);
    S.records = await store.records();
    if (cat && !(S.categories[eng.id] || []).includes(cat)) {
      S.categories[eng.id] = [...(S.categories[eng.id] || []), cat].sort();
      await store.set('categories', S.categories);
    }
    toast(`「${sc.name}」を ${plan.dest} に入れました${res.backup ? `（前のものは ${res.backup} にバックアップ）` : ''}`, { ms: 9000 });
    S.opened = null;
    S.destName = S.destVer = undefined;
    S.force = false;
    S.tab = 'mine';
  });
  clearInterval(watchdog);
  S.progress = null;
  render();
}

async function doExportWeb() {
  await busy('書き出し中', async () => {
    const out = await exportForWeb(S.opened, S.pick);
    await S.platform.saveFile(out.fileName, out.data);
    toast(`${out.fileName} を書き出しました。WebCardWirthのインストールページの「追加データのインストール（ZIP）」で入れてください`, { ms: 9000 });
  });
}

// ------------------------------------------------------------ カタログ
function downloadButtons(entry) {
  const dls = usableDownloads(entry);
  return h('span', { class: 'row', style: 'margin-left:6px' }, dls.slice(0, 2).map((d) => h('button', {
    class: 'btn sm', onclick: () => getDownload(entry, d),
  }, d.kind === 'direct' ? `ダウンロード（${d.label || 'ファイル'}）` : `ページを開く（${d.label || 'ページ'}）`)));
}

async function getDownload(entry, d) {
  // 直接DLも配布ページも、まず読み込んでみる（ページなら同意ボタン・リンクを探す）
  return fetchFromUrl(d.url, entry);
}

// ------------------------------------------------------------ 同意してダウンロード（A）・アプリ内ブラウザ（B）
/**
 * A：ページのダウンロードフォームを、本人が同意したあとに送信して、zipまで取ってくる。
 * 送信後のページに本物のファイルへのリンクや自動移動があれば、それも1〜2回たどる。
 */
async function agreeAndDownload(st, form, values) {
  const entry = st.entry || null;
  const res = await busy('同意して取得中', async () => {
    const body = new URLSearchParams([...form.fields, ...Object.entries(values)]);
    let target = form.action;
    let opts;
    if (form.method === 'POST') {
      opts = { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: st.finalUrl || st.url } };
    } else {
      const u = new URL(target);
      for (const [k, v] of body) u.searchParams.append(k, v);
      target = u.href;
      opts = { headers: { Referer: st.finalUrl || st.url } };
    }
    let r = await S.platform.fetchResource(target, opts);
    for (let hop = 0; hop < 2 && r && !r.blocked && !looksLikeZip(r.bytes); hop++) {
      const html = decodeHtml(r.bytes, r.contentType);
      const next = extractDownloadLinks(html, r.finalUrl).find((l) => l.kind === 'file')?.url || metaRefreshUrl(html, r.finalUrl);
      if (!next) { r.html = html; break; }
      r = await S.platform.fetchResource(next, { headers: { Referer: r.finalUrl } });
    }
    return r;
  });
  if (!res) return;
  if (res.blocked) {
    S.urlState = { ...st, status: 'blocked' };
    render();
    await S.platform.openUrl(st.url);
    return;
  }
  if (looksLikeZip(res.bytes)) {
    S.urlState = null;
    const name = res.fileName && /\.(zip|wsn)$/i.test(res.fileName) ? res.fileName : `${res.fileName || entry?.name || 'download'}.zip`;
    await openSource(async () => openArchive(res.bytes, name), entry);
    return;
  }
  toast('同意のあとにファイルが見つかりませんでした。DLキーが違うか、ページの作りが変わったのかもしれません。ページを開いて確かめてください', { bad: true, ms: 9000 });
}

/** B：アプリ内ブラウザで配布ページを開き、本人がサイトのボタンを押して落ちてきたファイルを受け取る */
async function inAppDownload(url, entry = null) {
  if (!S.platform.canInAppBrowse) { await S.platform.openUrl(url); return; }
  toast('配布ページを別の窓で開きました。サイトのダウンロードボタンを押すと、ここに取り込みます', { ms: 9000 });
  const got = await busy('アプリ内ブラウザで待っています', () => S.platform.openInAppBrowser(url));
  if (!got) return;
  if (!looksLikeZip(got.bytes)) { toast(`${got.fileName} はzip・wsnではないようです`, { bad: true }); return; }
  S.urlState = null;
  await openSource(async () => openArchive(got.bytes, got.fileName || 'download.zip'), entry);
}

// ------------------------------------------------------------ サイトからの「CWカタログで入れる」リンク
/**
 * 作者さんのサイトに置いたリンク（…/cw-catalog.html#install=<zipのURL>&name=<作品名>）から開かれたとき、
 * 取ってくる前に必ず確認する。勝手にダウンロード・インストールはしない。
 * 作品IDで頼むこともできる：#entry=e00012（カタログを読み込んでいるとき）
 */
async function handleInstallLink() {
  const params = new URLSearchParams((location.hash || '').slice(1) || location.search.slice(1));
  const url = (params.get('install') || '').trim();
  const entryId = (params.get('entry') || '').trim();
  if (!url && !entryId) return;
  // 読み込み直したときにもう一度聞かないよう、アドレスから消す（テスト用の印は残す）
  const keep = location.hash.includes('dev-opfs') ? '#dev-opfs' : '';
  try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&](install|entry|name)=[^&]*/g, '') + keep); } catch { /* file:// などで使えなくても続ける */ }

  let entry = null;
  if (entryId) {
    entry = S.catalog?.byId.get(entryId) || null;
    if (!entry) { toast(`作品ID ${entryId} がカタログに見つかりませんでした。「カタログ」タブでカタログを読み込んでから、もう一度リンクを押してください`, { bad: true, ms: 10000 }); return; }
  }
  if (url && !/^https?:\/\//.test(url)) { toast('リンクのURLが正しくありません', { bad: true }); return; }
  const target = url || usableDownloads(entry)[0]?.url;
  if (!target) { toast('この作品には、今DLできる配布元がありません', { bad: true }); return; }
  let host = '';
  try { host = new URL(target).hostname; } catch { /* 上で検査済み */ }
  const name = entry?.name || (params.get('name') || '').slice(0, 100);

  const ok = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'このシナリオを取ってきますか？'),
    name ? h('div', { class: 'item-title' }, name) : null,
    entry ? h('div', { class: 'meta' }, `${entry.author}・ver ${entry.version}・カタログの作品 ${entry.id}`) : null,
    h('div', { class: 'note' }, h('div', { class: 'small muted' }, '取得先'), h('b', {}, host), h('div', { class: 'small', style: 'word-break:break-all' }, target)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'リンクを押したサイトから、取り込みを頼まれました。取ってきたあとに中身とりどみを表示するので、入れるかどうかはそこで決められます。知らないサイトからの場合は「やめる」を押してください。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, '取ってくる'))));
  if (!ok) return;
  if (entry) {
    const d = usableDownloads(entry)[0];
    return d.kind === 'direct' ? fetchFromUrl(d.url, entry) : getDownload(entry, d);
  }
  return fetchFromUrl(target);
}

/** 作者さん向け：サイトに貼る「CWカタログで入れる」リンクを作る */
function viewLinkMaker() {
  const base = /^https:/.test(location.protocol) ? location.origin + location.pathname : 'https://<アカウント>.github.io/cw-catalog-tool/cw-catalog.html';
  const urlIn = h('input', { type: 'url', class: 'grow', placeholder: '作品のzipのURL' });
  const nameIn = h('input', { type: 'text', placeholder: '作品名（確認画面に出ます）' });
  const out = h('textarea', { rows: 4, readonly: true, style: 'width:100%;font-family:monospace;font-size:.82rem' });
  const make = () => {
    const u = urlIn.value.trim();
    if (!/^https?:\/\//.test(u)) { out.value = ''; return; }
    const link = `${base}#install=${encodeURIComponent(u)}${nameIn.value.trim() ? `&name=${encodeURIComponent(nameIn.value.trim())}` : ''}`;
    const esc = (x) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    out.value = `${link}\n\n<a href="${esc(link)}" target="_blank" rel="noopener">CWカタログで入れる</a>`;
  };
  urlIn.addEventListener('input', make);
  nameIn.addEventListener('input', make);
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, '作者さんのサイトやWikiに貼ると、押した人のツールが開いて「このシナリオを取ってきますか？」と確認したうえで取り込みます。'),
    h('div', { class: 'row' }, urlIn, nameIn),
    out,
    h('p', { class: 'small muted', style: 'margin:0' }, '※ HTML版で直接取ってこられるのは、読み込みを許可しているサイト（GitHub Pages など）に置いたファイルだけです。それ以外のサイトでは、配布ページを開く案内になります。'));
}

/** 同意画面：ページの文章（規約など）を見せて、本人が同意したら送信する */
function viewAgree(st) {
  const form = st.forms[0];
  const keyInputs = form.inputs.map((i) => h('label', { class: 'field' }, i.label === i.name ? `入力欄（${i.name}）` : i.label,
    h('input', { type: i.type, 'data-name': i.name, autocomplete: 'off' })));
  const check = h('input', { type: 'checkbox' });
  const btn = h('button', { class: 'btn primary sm', disabled: true }, `同意して${form.label || 'ダウンロード'}`);
  check.addEventListener('change', () => { btn.disabled = !check.checked; });
  btn.addEventListener('click', () => {
    const values = {};
    for (const l of keyInputs) { const inp = l.querySelector('input'); values[inp.dataset.name] = inp.value; }
    agreeAndDownload(st, form, values);
  });
  return h('div', { class: 'card soft stack', style: 'margin:0' },
    h('div', {}, h('b', {}, 'このページは、内容に同意してからダウンロードする形式です')),
    h('pre', { class: 'readme', style: 'max-height:220px' }, st.text || '（本文を読み取れませんでした。「ブラウザで開く」で確かめてください）'),
    keyInputs,
    h('label', { class: 'check' }, check, 'ページの内容・規約を読んで、同意します'),
    h('div', { class: 'row' }, btn,
      S.platform.kind === 'web' ? h('span', { class: 'small muted' }, '※ HTML版では、多くのサイトでブラウザの制限により送信できません（アプリ版なら取れます）') : null));
}

// ------------------------------------------------------------ URLから
function viewUrlBox() {
  const input = h('input', { type: 'url', class: 'grow', id: 'url-in', placeholder: '作品のzipのURL、または配布ページのURL', value: S.urlState?.url || '' });
  const go = () => {
    const u = input.value.trim();
    if (!/^https?:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
    fetchFromUrl(u);
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  const st = S.urlState;
  let detail = null;
  if (st?.status === 'blocked') {
    detail = h('div', { class: 'note warn small' },
      `このサイトは、ブラウザから直接読み込めない設定になっています（他のサイトのファイルは、相手が許可していないとブラウザが読ませない仕組みです。${S.platform.kind === 'web' ? 'アプリ版なら取れます' : ''}）。ページを開いたので、そこでダウンロードしたファイルを上にドロップしてください。`,
      st.notice ? h('div', { style: 'margin-top:6px' }, st.notice) : null,
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ページをもう一度開く')));
  } else if (st?.status === 'error') {
    detail = h('div', { class: 'note bad small' }, `読み込めませんでした：${st.message}`,
      h('div', { class: 'row', style: 'margin-top:6px' },
        S.platform.canInAppBrowse ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, st.entry) }, 'アプリ内で開いてダウンロード') : null,
        h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ブラウザで開く')));
  } else if (st?.status === 'page') {
    const inApp = S.platform.canInAppBrowse
      ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, st.entry) }, 'アプリ内で開いてダウンロード')
      : null;
    detail = h('div', { class: 'stack small' },
      h('div', {}, h('b', {}, st.title || st.url)),
      st.notice ? h('div', { class: 'note warn' }, st.notice) : null,
      st.forms?.length ? viewAgree(st) : null,
      st.links.length ? h('div', {}, `ダウンロードらしいリンクが ${st.links.length}件 ありました`) : (!st.forms?.length ? h('div', {}, 'ダウンロードのリンクは見つかりませんでした') : null),
      st.links.length ? h('ul', { class: 'dl' }, st.links.map((l) => h('li', {},
        h('span', { class: 'badge plain' }, l.kind === 'file' ? 'ファイル' : 'ページ'),
        h('span', { class: 'grow', style: 'word-break:break-all' }, l.text || l.url),
        h('button', { class: 'btn sm', onclick: () => fetchFromUrl(l.url, st.entry) }, '取ってくる'),
        h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(l.url) }, '開く')))) : null,
      h('div', { class: 'row' }, inApp, h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ブラウザで開く')));
  }
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'URLから'), input, h('button', { class: 'btn', onclick: go }, '取ってくる')),
    detail);
}

/**
 * URLから取ってくる。
 *  ・zip／wsnそのもの → そのまま分析
 *  ・ページ → ダウンロードらしいリンクを並べる
 *  ・ブラウザの制限で読めない／同意が必要なページ → ページを開く
 */
async function fetchFromUrl(url, entry = null) {
  S.tab = 'add';
  const res = await busy('読み込み中', async () => {
    try { return await S.platform.fetchResource(url); } catch (e) { return { error: e.message || String(e) }; }
  });
  if (!res) return;
  if (res.error) {
    // サイトが自動の読み込みを断ることもある。アプリ版なら、アプリ内ブラウザで本人が押す方法に切り替えられる
    S.urlState = { url, status: 'error', message: res.error, entry };
    render();
    return;
  }
  if (res.blocked) {
    S.urlState = { url, status: 'blocked', notice: siteNotice(url), entry };
    render();
    await S.platform.openUrl(url);
    return;
  }
  if (looksLikeZip(res.bytes)) {
    S.urlState = null;
    const name = res.fileName && /\.(zip|wsn)$/i.test(res.fileName) ? res.fileName : `${res.fileName || entry?.name || 'download'}.zip`;
    await openSource(async () => openArchive(res.bytes, name), entry);
    return;
  }
  const head = new TextDecoder('latin1').decode(res.bytes.subarray(0, 512)).trimStart();
  if (/html/i.test(res.contentType) || head.startsWith('<')) {
    const html = decodeHtml(res.bytes, res.contentType);
    S.urlState = {
      url, finalUrl: res.finalUrl, status: 'page', entry, title: pageTitle(html),
      links: extractDownloadLinks(html, res.finalUrl), forms: extractDownloadForms(html, res.finalUrl),
      text: pageText(html, 3000), notice: siteNotice(res.finalUrl),
    };
    render();
    return;
  }
  toast('zip・wsnのファイルでも、ページでもないようです', { bad: true });
}

/** 長い紹介文は折りたたんで、「すべて表示」で開けるようにする */
function descBlock(text) {
  const t = text.replace(/^\n+|\s+$/g, '');
  const long = t.split('\n').length > 5 || t.length > 180;
  const box = h('div', { class: 'desc' + (long ? '' : ' full') }, t);
  if (!long) return box;
  const btn = h('button', { class: 'btn ghost sm', onclick: () => { const open = box.classList.toggle('full'); btn.textContent = open ? 'たたむ' : 'すべて表示'; } }, 'すべて表示');
  return h('div', {}, box, btn);
}

function viewCatalog() {
  const urlIn = h('input', { type: 'url', class: 'grow', placeholder: 'https://（カタログの index.json）', id: 'cat-url' });
  store.get('catalogUrl', '').then((v) => { urlIn.value = v; });
  const fileIn = h('input', {
    type: 'file', accept: '.json,application/json', style: 'display:none',
    onchange: async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      await busy('カタログを読み込み', async () => {
        const json = JSON.parse(await f.text());
        const cat = parseCatalog(json);
        S.catalog = cat;
        S.catalogInfo = { url: `ファイル：${f.name}`, loadedAt: new Date().toISOString(), count: cat.entries.length };
        await store.set('catalog', { json, info: S.catalogInfo });
        await refreshStates();
      });
    },
  });
  const head = h('div', { class: 'card stack' },
    h('div', { class: 'row' }, urlIn,
      h('button', {
        class: 'btn primary', onclick: async () => {
          const u = urlIn.value.trim();
          if (!/^https:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
          await store.set('catalogUrl', u);
          await busy('カタログを読み込み', async () => { await loadCatalog(u); await refreshStates(); });
        },
      }, '読み込む'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, 'ファイルから'),
      h('button', { class: 'btn ghost', onclick: () => busy('サンプル', async () => { await loadCatalog('sample'); await refreshStates(); }) }, 'サンプル'),
      fileIn),
    S.catalogInfo ? h('p', { class: 'small muted', style: 'margin:0' }, `${S.catalogInfo.url === 'sample' ? 'サンプル' : S.catalogInfo.url}・${S.catalogInfo.count}件・${fmtDate(S.catalogInfo.loadedAt)}`) : h('p', { class: 'small muted', style: 'margin:0' }, 'カタログはまだ読み込まれていません。'));

  if (!S.catalog) return h('div', {}, head);

  const filters = h('div', { class: 'row', style: 'margin-bottom:12px' },
    h('input', { type: 'search', class: 'grow', placeholder: '作品名・作者・タグで検索', value: S.filter.cat, oninput: (ev) => { S.filter.cat = ev.target.value; rerenderList('cat-list', viewCatalog); } }),
    h('select', { 'aria-label': 'エンジン', onchange: (ev) => { S.filter.catEngine = ev.target.value; render(); } },
      [['', 'すべてのエンジン'], ['cw150', '1.50で遊べる'], ['next', 'Nextで遊べる'], ['py', 'Pyで遊べる']].map(([v, l]) => h('option', { value: v, selected: S.filter.catEngine === v ? 'selected' : null }, l))));

  const q = S.filter.cat.normalize('NFKC').toLowerCase();
  const owned = new Map(S.records.filter((r) => r.entryId).map((r) => [r.entryId, r]));
  const items = S.catalog.entries.filter((e) => {
    if (S.filter.catEngine && !['verified', 'expected'].includes(e.compat[S.filter.catEngine])) return false;
    return !q || `${e.name} ${e.author} ${e.tags.join(' ')}`.normalize('NFKC').toLowerCase().includes(q);
  });
  const LV = { verified: ['確認済み', 'ok'], expected: ['動くはず', 'warn'], no: ['非対応', 'bad'], unknown: ['未確認', 'plain'] };
  const list = h('div', { class: 'list', id: 'cat-list' }, items.length ? items.map((e) => {
    const mine = owned.get(e.id);
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'item-title' }, e.name), formatBadge({ format: e.format, wsnVersion: e.wsn_version }),
        mine ? h('span', { class: `badge ${mine.state === 'update' ? 'update' : 'ok'}` }, mine.state === 'update' ? `手持ち ${mine.version}→${e.version}` : '手持ちにあり') : null),
      h('div', { class: 'meta' }, `${e.author}・ver ${e.version}${e.updated ? `・${e.updated}` : ''}・${e.id}`),
      h('div', { class: 'row', style: 'margin:6px 0' },
        ['cw150', 'next', 'py'].map((k) => h('span', { class: `badge ${LV[e.compat[k]][1]}` }, `${ENGINE_KINDS[k].short}：${LV[e.compat[k]][0]}`)),
        e.convert === 'forbidden' ? h('span', { class: 'badge bad' }, '変換NG') : null,
        e.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
      e.description ? descBlock(e.description) : null,
      h('ul', { class: 'dl' }, e.downloads.map((d) => h('li', { class: d.status },
        h('span', {}, d.label || d.url.replace(/^https?:\/\//, '').split('/')[0]),
        h('span', { class: 'badge plain' }, d.kind === 'direct' ? '直接DL' : 'ページ経由'),
        { mirror: h('span', { class: 'badge plain' }, '予備'), old: h('span', { class: 'badge plain' }, '旧・移転済み'), closed: h('span', { class: 'badge bad' }, `終了${d.until ? ` ${d.until}` : ''}`) }[d.status] || null,
        d.note ? h('span', { class: 'small muted' }, d.note) : null,
        ['active', 'mirror'].includes(d.status) ? h('button', { class: 'btn sm', onclick: () => getDownload(e, d) }, d.kind === 'direct' ? 'ダウンロード' : 'ページを開く') : null))),
    );
  }) : h('p', { class: 'empty' }, '見つかりませんでした'));
  return h('div', {}, head, filters, list);
}

async function refreshStates() {
  const all = await store.records();
  for (const r of all) Object.assign(r, applyCatalog(r));
  await store.putRecords(all);
  S.records = await store.records();
}

// ------------------------------------------------------------ 設定
function viewSettings() {
  const engs = S.engines.map((e) => h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'item-title' }, e.name), h('div', { class: 'meta' }, `${ENGINE_KINDS[e.kind]?.name || e.kind}・${e.label || ''}`)),
      h('div', { class: 'row' },
        h('span', { class: `badge ${S.dirs.has(e.id) ? 'ok' : 'plain'}` }, S.dirs.has(e.id) ? '接続中' : '未接続'),
        !S.dirs.has(e.id) ? h('button', { class: 'btn sm', onclick: () => (e.ref ? connectEngine(e.id) : reconnect(e)) }, '接続') : null,
        e.needsReconnect || !e.ref ? h('button', { class: 'btn sm', onclick: () => reconnect(e) }, '選び直す') : null,
        h('button', {
          class: 'btn sm danger', onclick: async () => {
            if (!(await confirmBox(`「${e.name}」の登録と、その記録を消します。フォルダの中身は消えません。よろしいですか？`))) return;
            await store.deleteEngine(e.id);
            S.engines = S.engines.filter((x) => x.id !== e.id);
            S.records = await store.records();
            S.dirs.delete(e.id);
            if (S.engineId === e.id) S.engineId = S.engines[0]?.id || null;
            render();
          },
        }, '登録を外す'))),
    h('div', { class: 'row', style: 'margin-top:8px' },
      h('label', { class: 'field grow' }, '表示名', h('input', { type: 'text', value: e.name, onchange: async (ev) => { e.name = ev.target.value.trim() || e.name; await store.putEngine(e); render(); } })),
      h('label', { class: 'field' }, '種類', h('select', { onchange: async (ev) => { e.kind = ev.target.value; await store.putEngine(e); render(); } },
        Object.entries(ENGINE_KINDS).filter(([k]) => k !== 'wcw').map(([k, v]) => h('option', { value: k, selected: e.kind === k ? 'selected' : null }, v.name)))))));

  const importIn = h('input', {
    type: 'file', accept: '.json', style: 'display:none', onchange: async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      await busy('記録を読み込み', async () => {
        const n = await importRecords(JSON.parse(await f.text()));
        S.engines = await store.engines();
        S.records = await store.records();
        toast(`${n}件の記録を読み込みました。エンジンのフォルダは「選び直す」で接続してください`);
      });
    },
  });

  return h('div', {},
    h('h2', {}, 'エンジン'),
    engs,
    S.platform.canWriteFolders
      ? h('div', { class: 'row', style: 'margin-bottom:18px' }, h('button', { class: 'btn primary', onclick: addEngine }, 'エンジンを追加'),
        location.hash.includes('dev-opfs') && S.platform.opfsFolder ? h('button', { class: 'btn', id: 'dev-opfs', onclick: async () => { const p = await S.platform.opfsFolder('test-engine'); await registerEngine(p, (await detectEngineKind(p.dir)) || 'py'); } }, 'テスト用（ブラウザ内）') : null)
      : h('p', { class: 'note warn' }, 'このブラウザでは、フォルダの登録はできません（パソコンのChrome・Edge、またはアプリ版で使えます）。'),

    h('h2', {}, 'サイトに貼るリンクを作る（作者さん向け）'),
    viewLinkMaker(),

    h('h2', {}, '記録'),
    h('div', { class: 'card stack' },
      h('p', { class: 'small muted', style: 'margin:0' }, '手持ちの記録（バージョン・タグ・メモなど）を、ファイルに書き出したり読み込んだりできます。形式は公開されているので、他のツールからも読めます。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { const j = await exportRecords(APP_VERSION); await S.platform.saveFile(`cwcatalog-records-${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(JSON.stringify(j, null, 2))); } }, '書き出す'),
        h('button', { class: 'btn', onclick: () => importIn.click() }, '読み込む'), importIn)),

    S.platform.canUpdateSelf ? h('div', {}, h('h2', {}, 'アプリの更新'),
      h('div', { class: 'card row' }, h('span', { class: 'grow' }, `今の版：${APP_VERSION}`), h('button', { class: 'btn', onclick: () => checkSelf(true) }, '更新を確認'))) : null,

    h('h2', {}, 'このツールについて'),
    h('div', { class: 'card small stack' },
      h('p', { style: 'margin:0' }, `CWカタログ ${APP_VERSION}（${S.platform.label}）`),
      h('ul', { style: 'margin:0;padding-left:1.2em' },
        h('li', {}, 'ツールが書き込むのは、登録したエンジンの「Scenario」と「CWCatalog_backup」フォルダだけです。宿（Yado）には触りません。'),
        h('li', {}, 'zipの中のファイルを実行することはありません。'),
        h('li', {}, 'ネットにつなぐのは、カタログの読み込み・更新チェック・ダウンロードのボタンを押したときだけです。'),
        S.platform.kind === 'web' ? h('li', {}, 'HTML版では、作者さんのサイトから直接ダウンロードできないことが多いです（ブラウザの制限）。その場合は配布ページを開いて、落としたファイルをドロップしてください。') : null)),
  );
}

async function reconnect(e) {
  await busy('フォルダを選び直す', async () => {
    const picked = await S.platform.pickFolder();
    e.ref = picked.ref;
    e.label = picked.label;
    e.needsReconnect = false;
    await store.putEngine(e);
    S.dirs.set(e.id, picked.dir);
    toast('接続しました');
  });
}

async function checkSelf(manual) {
  try {
    const u = await S.platform.checkSelfUpdate();
    if (!u) { if (manual) toast('最新の版です'); return; }
    const ok = await modal((close) => h('div', { class: 'stack' },
      h('h2', {}, `新しい版 ${u.version} があります`),
      u.notes ? h('pre', { class: 'readme' }, u.notes) : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(false) }, 'あとで'),
        h('button', { class: 'btn primary', onclick: () => close(true) }, '更新して再起動'))));
    if (ok) await busy('アプリを更新中', () => u.install());
  } catch (e) {
    if (manual) toast(`更新を確認できませんでした：${e.message}`, { bad: true });
  }
}

export const _test = { S, compareVersions };
