// 「シナリオをDLする」タブ：取ってきた（またはドロップした）zip・wsn・フォルダの中身を見て、エンジンに入れる。

import { openArchive, openFolder } from '../core/archive.js';
import { planInstall, performInstall, exportForWeb } from '../core/install.js';
import { decodeText } from '../core/text.js';
import { playability } from '../core/catalog.js';
import { matchWork } from '../core/catalogs.js';
import { downloadsFromZone } from '../core/urls.js';
import { S, render, busy, busyText, engine, dirOf, goTab } from './state.js';
import { store, recordId } from './store.js';
import { h, toast, modal, fmtSize, formatBadge } from './ui.js';
import { applyCatalog } from './catalog-data.js';
import { viewUrlBox } from './download.js';
import { viewBatch } from './batch.js';
import { editEntry } from './catalog-view.js';
import { openLocalFiles, pickFiles, pickDownloads } from './localfiles.js';
import { viewMaterialInstall } from './materials.js';
import { backupOpts, backupFull } from './backup.js';
import { existsAt } from '../core/fs.js';

export const VERSION_SOURCE = { catalog: '（カタログで確定）', dl: '（カタログからDLした版）', user: '（手入力）', guess: '（名前から推測）' };

export function setupDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.querySelector('.drop')?.classList.add('over'); } });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.querySelector('.drop')?.classList.remove('over'); } });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    // まとめてDLの「操作待ち」の欄に落としたときは、そちらで受け取る
    if (e.target?.closest?.('[data-batch-drop]')) return;
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
    const files = [...e.dataTransfer.files].filter((f) => /\.(zip|wsn|cab|lzh|lha|7z|rar)$/i.test(f.name) || e.dataTransfer.files.length === 1);
    if (files.length > 1) {
      // 複数ドロップしたら、まとめて入れる
      const list = [];
      for (const f of files) list.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      await openLocalFiles(list);
      return;
    }
    const file = files[0] || e.dataTransfer.files[0];
    await openSource(async () => openArchive(new Uint8Array(await file.arrayBuffer()), file.name));
  });
}

/**
 * 中身を分析して画面に出す。
 * @param {object|null} work カタログの作品から取ってきたときは、その作品
 */
export async function openSource(fn, work = null) {
  S.tab = 'add';
  const opened = await busy('分析中', fn);
  if (!opened) return;
  S.opened = opened;
  S.openedZone = S.pendingZone || null; // ダウンロードフォルダなどから開いたときの「DL元」
  S.pendingZone = null;
  S.pick = 0;
  S.readmeIdx = 0;
  S.readmeEnc = '';
  S.readmeAck = !opened.readmes.length;
  S.destName = S.destVer = undefined;
  S.force = false;
  const sc = opened.scenarios[0];
  const m = S.combined && sc ? matchWork(S.combined, { ...sc, sha256: opened.source.sha256 }) : null;
  S.openedWork = work || m?.work || null;
  S.matchBy = m && (!work || m.work === work) ? m.by : null;
  S.openedVia = work ? 'catalog' : '';
  render();
}

/** 入れたときの記録用バージョンの初期値 */
function defaultVersion(sc) {
  const w = S.openedWork;
  if (w && S.matchBy === 'sha256') return { version: w.version, source: 'catalog' };
  if (w && S.openedVia === 'catalog') return { version: w.version, source: 'dl' };
  return { version: sc.versionGuess || '', source: sc.versionGuess ? 'guess' : '' };
}

export function viewAdd() {
  const fileInput = h('input', {
    type: 'file', accept: '.zip,.wsn,.cab,.lzh,.lha,.7z', hidden: true, multiple: true,
    onchange: async (ev) => {
      const fs = [...ev.target.files];
      if (fs.length > 1) {
        const list = [];
        for (const f of fs) list.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        await openLocalFiles(list);
      } else if (fs[0]) await openSource(async () => openArchive(new Uint8Array(await fs[0].arrayBuffer()), fs[0].name));
      ev.target.value = '';
    },
  });
  const drop = h('div', { class: 'drop stack' },
    h('div', { class: 'big' }, 'zip・wsn・cab・lzh・7z をここにドロップ'),
    h('div', { class: 'small muted' }, '展開済みのフォルダもドロップできます（Chrome・Edge・アプリ版）。複数のファイルは、まとめて入れられます'),
    h('div', { class: 'row', style: 'justify-content:center' },
      h('button', { class: 'btn', onclick: () => (S.platform.pickArchiveFiles ? pickFiles() : fileInput.click()) }, 'ファイルを選ぶ'),
      S.platform.canPickDownloads ? h('button', { class: 'btn', onclick: pickDownloads }, '「ダウンロード」から選ぶ') : null,
      S.platform.canWriteFolders ? h('button', { class: 'btn', onclick: () => openSource(async () => openFolder(await S.platform.pickSourceFolder())) }, 'フォルダを選ぶ') : null),
    fileInput);
  const batch = S.batch ? viewBatch() : null;
  const urlBox = viewUrlBox();
  if (!S.opened) {
    return h('div', {}, batch, drop, urlBox,
      h('div', { class: 'card soft small' },
        h('h3', {}, 'できること'),
        h('ul', { style: 'margin:0;padding-left:1.2em' },
          h('li', {}, '「カタログ」タブで作品を選ぶと、まとめてDLしてまとめて入れられます'),
          h('li', {}, '文字化けしたファイル名を正しく読み直します（UTF-8・Shift_JISを自動判定）'),
          h('li', {}, 'シナリオの範囲・形式（クラシック／Next／Py）・暗号化の有無を判定します'),
          h('li', {}, 'Readmeを表示してから、エンジンのScenarioフォルダに入れます（同じものがあればバックアップしてから置き換え）'),
          h('li', {}, 'WebCardWirthの「追加データのインストール（ZIP）」で入れやすいzipに書き出せます'))));
  }

  const o = S.opened;
  const sc = o.scenarios[S.pick];
  const work = S.openedWork;
  const parts = [batch, drop, urlBox];

  parts.push(h('div', { class: 'card' },
    h('div', { class: 'row between' },
      h('div', {}, h('div', { class: 'item-title' }, o.source.name),
        h('div', { class: 'meta' }, `${o.source.outer ? `${o.source.outer.name} の中・` : ''}${fmtSize(o.source.size)}・${o.files.length}ファイル${o.source.sha256 ? `・SHA-256 ${o.source.sha256.slice(0, 12)}…` : ''}`)),
      h('div', { class: 'row' },
        sc ? h('button', { class: 'btn sm', onclick: () => editEntry({ prefill: prefillFromOpened() }) }, work ? '個人用カタログに追加・編集' : '個人用カタログに登録') : null,
        h('button', { class: 'btn ghost', onclick: () => { S.opened = null; render(); } }, '閉じる'))),
    o.nonUtf8Names ? h('p', { class: 'note ok small' }, `日本語のファイル名 ${o.nonUtf8Names}件 を、文字コードを判定して読み直しました。`) : null,
    S.openedZone ? h('p', { class: 'small muted', style: 'margin:6px 0 0;word-break:break-all' }, `DL元（ブラウザの記録）：${S.openedZone.referrerUrl || S.openedZone.hostUrl}`) : null,
    work ? h('p', { class: 'note ok small' }, `カタログの「${work.name}」ver ${work.version} ${S.matchBy === 'sha256' ? 'とファイルが一致しました（版まで確定）' : S.openedVia === 'catalog' ? 'から取ってきました' : 'と名前が一致しました'}。`) : null,
    o.warnings?.length ? h('details', { class: 'small' }, h('summary', {}, `注意 ${o.warnings.length}件`), h('ul', {}, o.warnings.map((w) => h('li', {}, w)))) : null,
  ));

  if (!sc) {
    parts.push(viewMaterialInstall(o));
    return h('div', {}, parts);
  }

  if (o.scenarios.length > 1) {
    parts.push(h('div', { class: 'card' }, h('h3', {}, `${o.scenarios.length}本のシナリオが入っています`),
      h('div', { class: 'row' }, o.scenarios.map((s, i) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'pick', checked: i === S.pick, onchange: () => { S.pick = i; S.destName = undefined; render(); } }), s.name)))));
  }

  parts.push(h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('span', { class: 'item-title' }, sc.name), formatBadge(sc),
      sc.encrypted ? h('span', { class: 'badge enc' }, '暗号化（WDP）') : null),
    h('div', { class: 'meta' }, `${sc.author}・${sc.root || '(zipのトップ)'}・${sc.files.length}ファイル・${fmtSize(sc.size)}`),
    sc.description ? h('div', { class: 'desc full' }, sc.description.replace(/^\n+|\s+$/g, '')) : null));

  // Readme
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
      h('div', { class: 'row between' }, h('h3', {}, 'Readme'),
        h('div', { class: 'row small' }, h('span', { id: 'readme-enc', class: 'muted' }),
          h('select', { 'aria-label': '文字コード', onchange: (ev) => { S.readmeEnc = ev.target.value; render(); } },
            [['', '自動'], ['utf-8', 'UTF-8'], ['shift_jis', 'Shift_JIS'], ['utf-16le', 'UTF-16']].map(([v, l]) => h('option', { value: v, selected: S.readmeEnc === v ? 'selected' : null }, l))))),
      h('div', { class: 'readme-list' }, o.readmes.slice(0, 12).map((r, i) => h('button', {
        class: 'btn sm', 'aria-pressed': i === S.readmeIdx ? 'true' : 'false', onclick: () => { S.readmeIdx = i; render(); },
      }, r.path.split('/').pop()))),
      pre,
      authorReadme(work),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.readmeAck, onchange: (ev) => { S.readmeAck = ev.target.checked; render(); } }), 'Readme（利用規約）を読みました'),
    ));
  }

  // 入れ先
  const eng = engine();
  const dest = destFields(S.engineId, {
    cat: S.destCat, newCat: S.destNewCat, name: S.destName ?? sc.folderName,
    onCat: (v) => { S.destCat = v; }, onNewCat: (v) => { S.destNewCat = v; }, onName: (v) => { S.destName = v; },
  });
  const dv = defaultVersion(sc);
  const verIn = h('input', { type: 'text', class: 'ver', id: 'dest-ver', value: S.destVer ?? dv.version, oninput: (ev) => { S.destVer = ev.target.value; } });

  let planInfo = null;
  if (eng) {
    try { planInfo = planInstall(o, S.pick, eng, '', { folderName: sc.folderName }); } catch (e) { planInfo = { error: e.message }; }
  }
  const play = eng ? playability(sc, eng.kind) : null;
  const connected = eng && S.dirs.has(eng.id);
  const canInstall = eng && S.platform.canWriteFolders && S.readmeAck && play && (play.ok || S.force) && !S.busy;

  parts.push(h('div', { class: 'card stack' },
    h('h3', {}, '入れ先'),
    S.engines.length ? h('div', { class: 'grid2' },
      h('label', { class: 'field' }, 'エンジン', engineSelect((v) => { S.destCat = undefined; }, true)),
      dest.cat,
      dest.name,
      h('label', { class: 'field' }, 'バージョン（記録用）', verIn),
    ) : h('p', { class: 'small muted' }, 'エンジンが未登録です。「設定」タブで登録すると、ここから直接インストールできます。'),
    play ? h('p', { class: `note ${play.level === 'ok' ? 'ok' : play.level === 'caution' ? 'warn' : 'bad'}` },
      play.level === 'ok' ? `${eng.name}で遊べます。` : play.reason,
      play.level === 'convert' ? '（Next→Pyの変換は、今後のアプリ版で「自己責任」で使える機能として追加予定です）' : null) : null,
    planInfo?.warnings?.map((w) => h('p', { class: 'note warn small' }, w)),
    play && !play.ok ? h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: !!S.force, onchange: (ev) => { S.force = ev.target.checked; render(); } }), 'それでも入れる') : null,
    !S.readmeAck ? h('p', { class: 'small muted' }, '※ Readme（利用規約）を読んでからインストールできます') : null,
    archiveNote(o),
    S.progress ? h('div', { class: 'stack' },
      h('progress', { id: 'inst-prog', max: S.progress.total || 1, value: S.progress.done }),
      h('div', { id: 'inst-prog-text', class: 'small muted' }, '準備中…')) : null,
    h('div', { class: 'row' },
      eng && !connected ? h('button', { class: 'btn', onclick: () => connectEngineQuiet(eng.id) }, 'フォルダに接続') : null,
      h('button', { class: 'btn primary', disabled: !canInstall, onclick: doInstall }, 'インストール'),
      o.source.kind === 'archive' && S.archive.ref ? h('button', { class: 'btn', disabled: !!S.busy, onclick: () => busy('保存中', async () => { const n = await saveArchive(o, { force: true }); if (n) toast(`「${S.archive.label}」に ${n} を保存しました`); }) }, 'zipを保存場所に保存') : null,
      h('button', { class: 'btn', disabled: !S.readmeAck, onclick: doExportWeb }, 'WebCardWirth用に書き出す'),
    ),
  ));
  return h('div', {}, parts);
}

/** エンジンの選択（変えると「最後に使ったエンジン」として覚える） */
export function engineSelect(onChange, showConnect = false, value = S.engineId, id = '') {
  return h('select', {
    id: id || null, 'aria-label': 'エンジン',
    onchange: async (ev) => { if (!id) { S.engineId = ev.target.value; await store.set('engineId', S.engineId); } onChange?.(ev.target.value); render(); },
  }, S.engines.map((x) => h('option', { value: x.id, selected: x.id === value ? 'selected' : null }, `${x.name}${showConnect && !S.dirs.has(x.id) ? '（未接続）' : ''}`)));
}

/** 分類フォルダ・フォルダ名の欄 */
export function destFields(engineId, { cat, newCat, name, onCat, onNewCat, onName, idPrefix = 'dest' }) {
  const cats = S.categories[engineId] || [];
  const catSel = h('select', { id: `${idPrefix}-cat` }, h('option', { value: '' }, '（Scenario直下）'), cats.map((c) => h('option', { value: c }, c)), h('option', { value: '__new' }, '新しいフォルダ…'));
  catSel.value = cat && (cats.includes(cat) || cat === '__new') ? cat : '';
  const newIn = h('input', { type: 'text', id: `${idPrefix}-newcat`, placeholder: '新しい分類フォルダ名', style: catSel.value === '__new' ? '' : 'display:none', value: newCat || '' });
  catSel.addEventListener('change', () => { onCat?.(catSel.value); newIn.style.display = catSel.value === '__new' ? '' : 'none'; });
  newIn.addEventListener('input', () => onNewCat?.(newIn.value));
  const nameIn = name === null ? null : h('input', { type: 'text', id: `${idPrefix}-name`, value: name, oninput: (ev) => onName?.(ev.target.value) });
  return {
    cat: h('label', { class: 'field' }, '分類フォルダ', catSel, newIn),
    name: nameIn ? h('label', { class: 'field' }, 'フォルダ名', nameIn) : null,
    value: () => (catSel.value === '__new' ? newIn.value.trim() : catSel.value),
  };
}

function archiveNote(o) {
  if (o.source.kind !== 'archive') return null;
  if (S.archive.on && S.archive.ref) return h('p', { class: 'small muted', style: 'margin:0' }, `インストールすると、元の ${o.source.name} も「${S.archive.label}」に保存します（設定で変えられます）`);
  return null;
}

async function connectEngineQuiet(id) {
  await busy('フォルダに接続', async () => {
    const d = await dirOf(id, true);
    if (!d) throw new Error('フォルダを使う許可がありませんでした。もう一度押して許可してください');
    toast('接続しました');
  });
}

function authorReadme(work) {
  const a = work && S.combined?.authors?.[work.owner];
  if (!a?.readme_url) return null;
  const box = h('details', { class: 'small' }, h('summary', {}, `作者さん共通のReadme（${a.names[0] || work.author}）`));
  box.addEventListener('toggle', async () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const pre = h('pre', { class: 'readme' }, '読み込み中…');
    box.append(pre);
    try {
      const b = await S.platform.fetchFile(a.readme_url);
      pre.textContent = b ? decodeText(b).text : '読み込めませんでした。';
    } catch (e) { pre.textContent = `読み込めませんでした：${e.message}`; }
  });
  return box;
}

/** Readmeを別の窓で読む（まとめてDLのとき）。「読みました」を押すと true */
export function readmeModal(opened, title, { next = false } = {}) {
  return modal((close) => {
    let idx = 0, enc = '';
    const pre = h('pre', { class: 'readme', id: 'readme-modal' }, '読み込み中…');
    const encInfo = h('span', { class: 'muted small' });
    const show = async () => {
      const f = opened.files.find((x) => x.path === opened.readmes[idx].path);
      const t = decodeText(await f.read(), enc || undefined);
      pre.textContent = t.text;
      encInfo.textContent = `${t.encoding === 'shift_jis' ? 'Shift_JIS' : t.encoding.toUpperCase()}${t.lossy ? '（一部読めない文字あり）' : ''}`;
    };
    const tabs = h('div', { class: 'readme-list' }, opened.readmes.slice(0, 12).map((r, i) => h('button', {
      class: 'btn sm', 'aria-pressed': i === 0 ? 'true' : 'false',
      onclick: (ev) => { idx = i; tabs.querySelectorAll('button').forEach((b, j) => b.setAttribute('aria-pressed', j === i ? 'true' : 'false')); show(); },
    }, r.path.split('/').pop())));
    show();
    return h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, `${title} のReadme`),
        h('div', { class: 'row' }, encInfo, h('select', { 'aria-label': '文字コード', onchange: (ev) => { enc = ev.target.value; show(); } },
          [['', '自動'], ['utf-8', 'UTF-8'], ['shift_jis', 'Shift_JIS'], ['utf-16le', 'UTF-16']].map(([v, l]) => h('option', { value: v }, l))))),
      tabs, pre,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, next ? 'ここでやめる' : '閉じる'),
        h('button', { class: 'btn primary', onclick: () => close(true) }, next ? 'Readme（利用規約）を読みました・次へ' : 'Readme（利用規約）を読みました')));
  });
}

// ------------------------------------------------------------ zip・wsnの保存場所
export async function archiveDirOf(ask = true) {
  if (S.archiveDir) return S.archiveDir;
  if (!S.archive.ref) return null;
  const d = await S.platform.openFolder(S.archive.ref, { ask });
  if (d) S.archiveDir = d;
  return d;
}

/**
 * 元のzip・wsnを保存場所に置く。同じ名前で同じ大きさのものがあれば置かない。違えば「名前_2.zip」のようにする。
 * @returns {Promise<string|null>} 保存したファイル名
 */
export async function saveArchive(opened, { force = false } = {}) {
  const bytes = opened.archiveBytes || opened.bytes;
  if (opened.source.kind !== 'archive' || !bytes) return null;
  if (!force && !S.archive.on) return null;
  const d = await archiveDirOf(true);
  if (!d) throw new Error('zipの保存場所を使う許可がありませんでした。設定の「zip・wsnの保存場所」で選び直してください');
  const base = (opened.archiveName || opened.source.name).replace(/[\\/:*?"<>|]/g, '_');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base, ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 100; i++) {
    const name = i === 1 ? base : `${stem}_${i}${ext}`;
    if (await d.has(name)) {
      const size = await d.fileSize(name).catch(() => -1);
      if (size === bytes.length) return name; // 同じものがもうある
      continue;
    }
    await d.writeFile(name, bytes);
    return name;
  }
  throw new Error('保存場所に同じ名前のファイルが多すぎます');
}

// ------------------------------------------------------------ インストール
/**
 * 1本インストールして、記録を残す（ひとつずつ・まとめて の両方で使う）。
 * @returns {{plan, res, rec, archived: string|null}}
 */
export async function installOpened({ opened, pick, eng, dir, cat, folderName, version, versionSource, work, onProgress }) {
  const sc = opened.scenarios[pick];
  const plan = planInstall(opened, pick, eng, cat, { folderName });
  onProgress?.(0, plan.files.length, 'write', '');
  const bk = (await existsAt(dir, plan.dest)) ? await backupOpts('engine', eng.id) : {};
  const res = await performInstall(dir, plan, { onProgress, ...bk });
  res.backupShown = res.backup ? (S.backupFolder?.ref || S.platform.kind === 'app' ? backupFull('engine', eng.id, res.backup) : res.backup) : null;
  const readmes = [];
  for (const r of opened.readmes.slice(0, 4)) {
    const f = opened.files.find((x) => x.path === r.path);
    readmes.push({ name: r.path.split('/').pop(), text: decodeText(await f.read()).text.slice(0, 200000) });
  }
  const rid = recordId(eng.id, plan.dest, '');
  const rec = {
    id: rid, engineId: eng.id, path: plan.dest, inner: '', type: plan.passthrough ? 'archive' : 'folder',
    name: sc.name, author: sc.author, format: sc.format, dataVersion: sc.dataVersion, wsnVersion: sc.wsnVersion, encrypted: sc.encrypted,
    version, versionSource: version ? versionSource || 'user' : '',
    versionGuess: sc.versionGuess || '', tags: (await store.getRecord(rid))?.tags || [],
    workKey: work?.key || '', sha256: opened.source.sha256 || '', sourceName: opened.source.name,
    installedAt: new Date().toISOString(), seenAt: new Date().toISOString(), missing: false, readmes,
  };
  Object.assign(rec, applyCatalog(rec));
  await store.putRecord(rec);
  if (cat && !(S.categories[eng.id] || []).includes(cat)) {
    S.categories[eng.id] = [...(S.categories[eng.id] || []), cat].sort();
    await store.set('categories', S.categories);
  }
  let archived = null;
  try { archived = await saveArchive(opened); } catch (e) { toast(`zipを保存場所に置けませんでした：${e.message}`, { bad: true }); }
  return { plan, res, rec, archived };
}

/** フォルダの許可は、ボタンを押した直後に聞く（時間がたつとブラウザが確認を出せなくなるため） */
export async function ensureDir(eng) {
  let d = S.dirs.get(eng.id);
  if (!d) {
    toast('ブラウザの上部に「編集を許可しますか？」の確認が出たら、許可を押してください', { ms: 12000 });
    d = await dirOf(eng.id, true).catch(() => null);
    if (!d) { toast('フォルダを使う許可がありませんでした。もう一度押して許可してください', { bad: true, ms: 9000 }); return null; }
  }
  // zipの保存場所も、ここで一緒に許可をもらっておく
  if (S.archive.on && S.archive.ref && !S.archiveDir) await archiveDirOf(true).catch(() => null);
  return d;
}

/** 止まっていそうなら知らせる見張り */
export function watchdog(textId) {
  let last = Date.now();
  const t = setInterval(() => {
    if (Date.now() - last > 15000) {
      const el = document.getElementById(textId);
      if (el) el.textContent = '止まっているように見えます。ブラウザの上部に許可の確認や、ウイルス対策ソフトの確認が出ていないか見てください。';
    }
  }, 5000);
  return { poke: () => { last = Date.now(); }, stop: () => clearInterval(t) };
}

async function doInstall() {
  const o = S.opened;
  const sc = o.scenarios[S.pick];
  const eng = engine();
  const catVal = document.getElementById('dest-cat')?.value ?? '';
  const cat = catVal === '__new' ? (document.getElementById('dest-newcat')?.value || '').trim() : catVal;
  const folderName = (document.getElementById('dest-name')?.value || sc.folderName).trim();
  const version = (document.getElementById('dest-ver')?.value || '').trim();
  const dv = defaultVersion(sc);

  const d = await ensureDir(eng);
  if (!d) return;

  const wd = watchdog('inst-prog-text');
  const setProgress = (done, total, phase, name) => {
    wd.poke();
    S.progress = { done, total, phase };
    const bar = document.getElementById('inst-prog');
    const t = document.getElementById('inst-prog-text');
    if (bar) { bar.max = total || 1; bar.value = done; }
    if (t) t.textContent = `${phase === 'backup' ? '前のものをバックアップ中' : '書き込み中'}　${done} / ${total}　${name.split('/').pop()}`;
    busyText(`インストール中… ${done}/${total}`);
  };

  S.progress = { done: 0, total: 0, phase: 'write' };
  await busy('インストール中', async () => {
    const { plan, res, archived } = await installOpened({
      opened: o, pick: S.pick, eng, dir: d, cat, folderName, version,
      versionSource: version && version === dv.version ? dv.source || 'user' : 'user', work: S.openedWork, onProgress: setProgress,
    });
    S.records = await store.records();
    toast(`「${sc.name}」を ${plan.dest} に入れました${res.backup ? `（前のものは ${res.backupShown} にバックアップ）` : ''}${archived ? `。zipは「${S.archive.label}」に保存しました` : ''}`, { ms: 9000 });
    S.opened = null;
    S.destName = S.destVer = undefined;
    S.force = false;
    S.tab = 'mine';
  });
  wd.stop();
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

/** いま開いているものから、個人用カタログに登録するときの下書きを作る */
function prefillFromOpened() {
  const o = S.opened;
  const sc = o.scenarios[S.pick];
  const w = S.openedWork;
  if (w) return { work: w };
  const url = S.lastUrl && /^https?:\/\//.test(S.lastUrl) ? S.lastUrl : '';
  const fromZone = downloadsFromZone(S.openedZone);
  const downloads = fromZone.length
    ? fromZone.map((d) => ({ url: d.url, label: '', kind: d.kind, status: 'active', note: '' }))
    : url ? [{ url, label: '', kind: /\.(zip|wsn|cab|lzh|lha|7z)(\?|$)/i.test(url) ? 'direct' : 'page', status: 'active', note: '' }] : [];
  return {
    entry: {
      name: sc.name, author: sc.author, version: sc.versionGuess || '', format: sc.format === 'none' ? 'classic' : sc.format,
      wsn_version: sc.wsnVersion ?? null, description: (sc.description || '').trim().slice(0, 2000), tags: [], intro: [],
      downloads,
      file: { name: o.source.kind === 'archive' ? o.source.name : '', sha256: o.source.sha256 || '' },
    },
  };
}

export { goTab };
