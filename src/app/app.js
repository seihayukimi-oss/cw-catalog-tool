// CWカタログツール 本体（HTML版・アプリ版で共通）
// 画面ごとのファイル：
//   add.js          … シナリオをDLする（中身の確認・インストール）
//   download.js     … URL・配布ページ・カタログの配布元から取ってくる
//   batch.js        … まとめてDL
//   catalog-view.js … カタログ（管理・一覧・紹介・個人用カタログの編集）
//   catalog-data.js … カタログの保存と読み込み

import { scanScenarioFolder, detectEngineKind, checkEngineFolder } from '../core/scan.js';
import { ENGINE_KINDS, compareVersions } from '../core/catalog.js';
import { comparePage } from '../core/pagecheck.js';
import { S, views, setRenderer, render, busy, busyText, engine, recordsOf, dirOf, rerenderList, confirmBox, goTab, TAB_LABEL, APP_VERSION } from './state.js';
import { store, recordId, exportRecords, importRecords } from './store.js';
import { h, toast, modal, fmtDate, formatBadge, sleep } from './ui.js';
import { loadCatalogs, applyCatalog, workOf, refreshSource, refreshStates } from './catalog-data.js';
import { viewAdd, setupDrop, VERSION_SOURCE } from './add.js';
import { downloadWork, handleInstallLink, viewLinkMaker } from './download.js';
import { viewCatalog, prefsBlock } from './catalog-view.js';
import { startBatch } from './batch.js';

const STATE_LABEL = { latest: '最新', update: '更新あり', unknown: '版不明', none: 'カタログ外' };

// ------------------------------------------------------------ 起動
export async function startApp(platform) {
  S.platform = platform;
  document.documentElement.dataset.platform = platform.kind;
  S.engines = await store.engines();
  S.engineId = (await store.get('engineId')) || S.engines[0]?.id || null;
  S.categories = (await store.get('categories')) || {};
  S.archive = { on: false, ref: null, label: '', ...((await store.get('archive')) || {}) };
  await loadCatalogs();
  S.records = await store.records();
  if (S.records.some((r) => r.entryId && !('workKey' in r))) await refreshStates(); // 0.1.4 までの記録を新しい形に
  for (const e of S.engines) {
    const d = await platform.openFolder(e.ref).catch(() => null); // 許可が残っていればそのまま使える
    if (d) S.dirs.set(e.id, d);
  }
  if (S.archive.ref) S.archiveDir = await platform.openFolder(S.archive.ref).catch(() => null);
  Object.assign(views, { mine: viewMine, add: viewAdd, catalog: viewCatalog, settings: viewSettings });
  setRenderer(draw);
  setupDrop();
  render();
  handleInstallLink();
  if (platform.canUpdateSelf) setTimeout(() => checkSelf(false), 3000);
}

// ------------------------------------------------------------ 描画
function draw() {
  const root = document.getElementById('app');
  const view = views[S.tab]();
  const updates = S.records.filter((r) => r.state === 'update').length;
  const pending = S.batch ? S.batch.items.filter((i) => !['done'].includes(i.status)).length : S.opened ? 1 : 0;
  const tabs = [
    ['mine', TAB_LABEL.mine, updates ? h('span', { class: 'count', title: '更新あり' }, updates) : null],
    ['add', TAB_LABEL.add, pending ? h('span', { class: 'count' }, pending) : null],
    ['catalog', TAB_LABEL.catalog],
    ['settings', TAB_LABEL.settings],
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

// ------------------------------------------------------------ 自分のフォルダ一覧
function viewMine() {
  if (!S.engines.length) {
    return h('div', { class: 'card stack' },
      h('h2', {}, 'はじめに'),
      h('p', {}, 'CardWirth（1.50・Next・Py）のフォルダを登録すると、入っているシナリオを読み取って一覧にします。'),
      S.platform.canWriteFolders
        ? h('button', { class: 'btn primary', onclick: addEngine }, 'CardWirthのフォルダを登録する')
        : h('p', { class: 'note warn' }, `このブラウザはフォルダの読み書きに対応していません。パソコンのChrome・Edgeか、アプリ版を使ってください。zipの中身の確認と、WebCardWirth用の書き出しは「${TAB_LABEL.add}」タブでできます。`),
    );
  }
  if (!engine()) S.engineId = S.engines[0].id;
  const e = engine();
  const connected = e && S.dirs.has(e.id);
  const q = S.filter.mine.normalize('NFKC').toLowerCase();
  let recs = recordsOf().filter((r) => !q || `${r.name} ${r.author} ${r.path} ${(r.tags || []).join(' ')}`.normalize('NFKC').toLowerCase().includes(q));
  if (S.filter.mineState) recs = recs.filter((r) => (S.filter.mineState === 'missing' ? r.missing : (r.state || 'none') === S.filter.mineState));
  recs.sort((a, b) => (b.state === 'update') - (a.state === 'update') || (a.path || '').localeCompare(b.path || '', 'ja'));
  const updates = S.records.filter((r) => r.state === 'update' && workOf(r) && r.type !== 'bookmark');

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
        updates.length ? h('button', { class: 'btn primary', onclick: () => startBatch(updates.map((r) => ({ work: workOf(r), record: r })), '更新ありをまとめてDL') }, `更新ありをまとめてDL（${updates.length}件）`) : null,
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

function recordCard(r) {
  const work = workOf(r);
  const st = r.state || (S.combined ? 'none' : null);
  const save = async (patch) => {
    Object.assign(r, patch);
    Object.assign(r, applyCatalog(r));
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
        work ? h('button', { class: 'btn ghost', onclick: () => { S.filter.cat = work.name; S.filter.catSource = ''; goTab('catalog'); } }, 'カタログ') : null,
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
      r.versionSource ? h('span', { class: 'small muted' }, VERSION_SOURCE[r.versionSource]) : null,
      h('span', { class: 'row' }, (r.tags || []).map((t) => h('span', { class: 'tag' }, t,
        h('button', { 'aria-label': `${t}を外す`, onclick: () => save({ tags: r.tags.filter((x) => x !== t) }) }, '×'))), tagInput),
    ),
    st === 'update' && work ? h('div', { class: 'note warn row', style: 'margin-top:8px' },
      h('span', {}, `新しい版 ${work.version} があります（手元：${r.version}）`),
      h('button', { class: 'btn sm', onclick: () => downloadWork(work) }, 'ダウンロード'),
      h('button', { class: 'btn ghost sm', onclick: () => startBatch([{ work, record: r }], '更新をDL') }, 'この場所に入れ直す')) : null,
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
const ENGINE_HELP = `CardWirth/              ← ここを選ぶ
├─ CardWirth.exe        （NextはCardWirthNext.exe、PyはCardWirthPy.exe）
├─ Scenario/            ← ここではありません
├─ Yado/
└─ …`;

/** エンジンのフォルダの選び方を説明してから、選んでもらう。よくある間違いは選び直してもらう */
async function pickEngineFolder() {
  const go = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'CardWirthのフォルダを選びます'),
    h('p', { style: 'margin:0' }, h('b', {}, 'CardWirth.exe（または CardWirthNext.exe・CardWirthPy.exe）が入っているフォルダ'), 'を選んでください。'),
    h('p', { class: 'note warn', style: 'margin:0' }, '「Scenario」フォルダそのものではなく、そのひとつ上のフォルダです。'),
    h('pre', { class: 'readme', style: 'max-height:none' }, ENGINE_HELP),
    h('p', { class: 'small muted', style: 'margin:0' }, 'ツールは、この中の「Scenario」にシナリオを入れ、「CWCatalog_backup」に置き換える前のものを残します。宿（Yado）には触りません。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, 'フォルダを選ぶ'))));
  if (!go) return null;
  for (;;) {
    const picked = await S.platform.pickFolder();
    const chk = await checkEngineFolder(picked.dir);
    if (chk.ok) return { picked, kind: chk.kind };
    const msg = {
      scenario: '「Scenario」フォルダが選ばれています。ひとつ上の、CardWirth.exe がある方のフォルダを選び直してください。',
      inside: 'シナリオのフォルダ（Summary.wsm などがある場所）が選ばれています。CardWirth.exe がある、CardWirth本体のフォルダを選び直してください。',
      yado: '宿（Yado）のフォルダが選ばれているようです。ひとつ上の、CardWirth.exe がある方のフォルダを選び直してください。',
      noscenario: `「${picked.label}」には「Scenario」フォルダがありません。CardWirth.exe がある場所を選んでください。`,
    }[chk.problem];
    const choice = await modal((close) => h('div', { class: 'stack' },
      h('h2', {}, '選んだフォルダが違うようです'),
      h('p', { style: 'margin:0' }, msg),
      h('pre', { class: 'readme', style: 'max-height:none' }, ENGINE_HELP),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close('cancel') }, 'やめる'),
        chk.problem === 'noscenario' && chk.kind ? h('button', { class: 'btn', onclick: () => close('use') }, 'このまま登録する') : null,
        h('button', { class: 'btn primary', onclick: () => close('again') }, '選び直す'))));
    if (choice === 'use') return { picked, kind: chk.kind };
    if (choice !== 'again') return null;
  }
}

async function addEngine() {
  await busy('フォルダを登録', async () => {
    const r = await pickEngineFolder();
    if (!r) return;
    let kind = r.kind || (await detectEngineKind(r.picked.dir));
    if (!kind) kind = await chooseKind(r.picked.label);
    if (!kind) return;
    await registerEngine(r.picked, kind);
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

async function connectEngine(id) {
  await busy('フォルダに接続', async () => {
    const d = await dirOf(id, true);
    if (!d) throw new Error('フォルダを使う許可がありませんでした。もう一度押して許可してください');
    toast('接続しました');
  });
}

async function scanEngine(id) {
  await busy('読み取り中', async () => {
    const d = await dirOf(id, true);
    if (!d) throw new Error('フォルダに接続できませんでした');
    const res = await scanScenarioFolder(d, { onProgress: (p) => busyText(`読み取り中… ${p}`) });
    const old = new Map(recordsOf(id).filter((r) => r.type !== 'bookmark').map((r) => [r.id, r]));
    const now = new Date().toISOString();
    const fresh = res.items.map((it) => {
      const rid = recordId(id, it.path, it.inner);
      const prev = old.get(rid) || {};
      old.delete(rid);
      const r = {
        tags: [], version: '', versionSource: '', workKey: '', readmes: [],
        ...prev,
        id: rid, engineId: id, path: it.path, inner: it.inner || '', type: it.type,
        name: it.name, author: it.author, format: it.format, dataVersion: it.dataVersion ?? null, wsnVersion: it.wsnVersion ?? null,
        encrypted: it.encrypted ?? null, versionGuess: it.versionGuess || '', sha256: it.sha256 || prev.sha256 || '',
        note: it.note || prev.note || '', seenAt: now, missing: false,
      };
      return { ...r, ...applyCatalog(r) };
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

// ------------------------------------------------------------ カタログ外（ブックマーク）
async function addBookmark() {
  const v = await modal((close) => {
    const f = { name: h('input', { type: 'text', required: true }), author: h('input', { type: 'text' }), url: h('input', { type: 'url', placeholder: 'https://' }), ver: h('input', { type: 'text' }), note: h('input', { type: 'text' }) };
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close({ name: f.name.value.trim(), author: f.author.value.trim(), url: f.url.value.trim(), version: f.ver.value.trim(), note: f.note.value.trim() }); } },
      h('h2', {}, 'カタログ外の作品を登録'),
      h('p', { class: 'small muted' }, '配布ページを登録しておくと、アプリ版では「更新チェック」でページの変化（配布ファイル名の変化）を確認できます。DLもしたい作品は「カタログ」タブの「＋作品を登録（個人用）」が便利です。'),
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
async function checkUpdates() {
  await busy('更新チェック', async () => {
    const remote = S.sources.filter((s) => s.enabled && s.url);
    let online = true;
    const failed = [];
    for (const src of remote) {
      try { await refreshSource(src, { useMeta: true }); } catch (e) { failed.push(`${src.name}：${e.message}`); }
    }
    if (remote.length && failed.length === remote.length) online = false;
    if (failed.length) toast(`取れなかったカタログがあります（前回の内容で確認します）：${failed.join('／')}`, { bad: true, ms: 9000 });
    if (!S.combined) toast('カタログがまだありません。「カタログ」タブで共用カタログを追加するか、個人用カタログに作品を登録してください');
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

// ------------------------------------------------------------ 設定
function viewSettings() {
  const engs = S.engines.map((e) => h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'item-title' }, e.name), h('div', { class: 'meta' }, `${ENGINE_KINDS[e.kind]?.name || e.kind}・${e.label || ''}`)),
      h('div', { class: 'row' },
        h('span', { class: `badge ${S.dirs.has(e.id) ? 'ok' : 'plain'}` }, S.dirs.has(e.id) ? '接続中' : '未接続'),
        !S.dirs.has(e.id) ? h('button', { class: 'btn sm', onclick: () => (e.ref ? connectEngine(e.id) : reconnect(e)) }, '接続') : null,
        e.needsReconnect || !e.ref || S.platform.kind === 'app' ? h('button', { class: 'btn sm', onclick: () => reconnect(e) }, '選び直す') : null,
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
  const dev = location.hash.includes('dev-opfs') && S.platform.opfsFolder;

  return h('div', {},
    h('h2', {}, 'エンジン'),
    h('p', { class: 'small muted' }, 'CardWirth.exe（CardWirthNext.exe・CardWirthPy.exe）が入っているフォルダを登録します。「Scenario」フォルダそのものではありません。'),
    engs,
    S.platform.canWriteFolders
      ? h('div', { class: 'row', style: 'margin-bottom:18px' }, h('button', { class: 'btn primary', onclick: addEngine }, 'エンジンを追加'),
        dev ? h('button', { class: 'btn', id: 'dev-opfs', onclick: async () => { const p = await S.platform.opfsFolder('test-engine'); await registerEngine(p, (await detectEngineKind(p.dir)) || 'py'); } }, 'テスト用（ブラウザ内）') : null)
      : h('p', { class: 'note warn' }, 'このブラウザでは、フォルダの登録はできません（パソコンのChrome・Edge、またはアプリ版で使えます）。'),

    h('h2', {}, 'zip・wsnの保存場所'),
    viewArchiveSettings(dev),

    h('h2', {}, 'カタログ'),
    h('div', { class: 'card stack' },
      prefsBlock(),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { S.manageOpen = true; goTab('catalog'); } }, 'カタログの管理を開く'),
        h('span', { class: 'small muted' }, '共用カタログ・個人用カタログの追加、候補に含めるかどうか、DL一覧の読み込み・書き出しはここから'))),

    h('h2', {}, 'サイトに貼るリンクを作る（作者さん向け）'),
    viewLinkMaker(),

    h('h2', {}, '記録'),
    h('div', { class: 'card stack' },
      h('p', { class: 'small muted', style: 'margin:0' }, '自分のフォルダ一覧の記録（バージョン・タグ・メモなど）を、ファイルに書き出したり読み込んだりできます。形式は公開されているので、他のツールからも読めます。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: async () => { const j = await exportRecords(APP_VERSION); await S.platform.saveFile(`cwcatalog-records-${new Date().toISOString().slice(0, 10)}.json`, new TextEncoder().encode(JSON.stringify(j, null, 2))); } }, '書き出す'),
        h('button', { class: 'btn', onclick: () => importIn.click() }, '読み込む'), importIn)),

    S.platform.canUpdateSelf ? h('div', {}, h('h2', {}, 'アプリの更新'),
      h('div', { class: 'card row' }, h('span', { class: 'grow' }, `今の版：${APP_VERSION}`), h('button', { class: 'btn', onclick: () => checkSelf(true) }, '更新を確認'))) : null,

    h('h2', {}, 'このツールについて'),
    h('div', { class: 'card small stack' },
      h('p', { style: 'margin:0' }, `CWカタログ ${APP_VERSION}（${S.platform.label}）`),
      h('ul', { style: 'margin:0;padding-left:1.2em' },
        h('li', {}, 'ツールが書き込むのは、登録したエンジンの「Scenario」と「CWCatalog_backup」フォルダ、それと指定したzip・wsnの保存場所だけです。宿（Yado）には触りません。'),
        h('li', {}, 'zipの中のファイルを実行することはありません。'),
        h('li', {}, 'ネットにつなぐのは、カタログの読み込み・更新チェック・ダウンロード・紹介を見るボタンを押したときだけです。'),
        S.platform.kind === 'web' ? h('li', {}, 'HTML版では、作者さんのサイトから直接ダウンロードできないことが多いです（ブラウザの制限）。その場合は配布ページを開いて、落としたファイルをドロップしてください。') : null)),
  );
}

function viewArchiveSettings(dev) {
  const pick = async (useOpfs = false) => busy('保存場所を選ぶ', async () => {
    const p = useOpfs ? await S.platform.opfsFolder('test-archive') : await S.platform.pickFolder({ title: 'zip・wsnを保存するフォルダを選んでください', id: 'cw-archive' });
    S.archive = { ...S.archive, ref: p.ref, label: p.label, on: true };
    S.archiveDir = p.dir;
    await store.set('archive', S.archive);
    toast(`「${p.label}」に保存するようにしました`);
  });
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'シナリオを入れるとき、元のzip・wsnを別のフォルダにも残しておけます（入れ直し・バックアップ用）。エンジンのScenarioフォルダとは別の場所を選んでください。'),
    h('div', { class: 'row' },
      h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: S.archive.on, disabled: !S.archive.ref, 'aria-label': 'インストールしたときにzipも保存する',
        onchange: async (ev) => { S.archive.on = ev.target.checked; await store.set('archive', S.archive); render(); },
      }), 'インストールしたときに、元のzip・wsnも保存する'),
      h('span', { class: 'grow small muted' }, S.archive.ref ? `保存場所：${S.archive.label}${S.archiveDir ? '' : '（次に保存するとき許可を聞きます）'}` : '保存場所：未設定'),
      S.platform.canWriteFolders ? h('button', { class: 'btn sm', onclick: () => pick() }, S.archive.ref ? '保存場所を変える' : '保存場所を選ぶ') : null,
      dev ? h('button', { class: 'btn sm', id: 'dev-opfs-archive', onclick: () => pick(true) }, 'テスト用保存場所') : null),
    !S.platform.canWriteFolders ? h('p', { class: 'note warn small', style: 'margin:0' }, 'このブラウザでは、保存場所の登録はできません。') : null);
}

async function reconnect(e) {
  await busy('フォルダを選び直す', async () => {
    const r = await pickEngineFolder();
    if (!r) return;
    e.ref = r.picked.ref;
    e.label = r.picked.label;
    e.needsReconnect = false;
    await store.putEngine(e);
    S.dirs.set(e.id, r.picked.dir);
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
