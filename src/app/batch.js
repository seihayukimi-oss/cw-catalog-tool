// まとめてDL：カタログで選んだ作品・検索結果・更新ありの作品を、順番に取ってきて、まとめて入れる。
//  ① 取得：直接DLできるものは自動で。同意やDLキーが必要なページ・ブラウザの制限で取れないものは「操作待ち」に
//  ② 確認：Readmeを読む・入れ先を決める
//  ③ まとめてインストール

import { openArchive } from '../core/archive.js';
import { playability } from '../core/catalog.js';
import { S, render, busyText, engine, goTab } from './state.js';
import { store } from './store.js';
import { h, toast, modal, fmtSize, formatBadge, sleep } from './ui.js';
import { tryDownloads, dlLabel, pagePanel, inAppDownload, deliver, tryAutoAgree } from './download.js';
import { setDefaultUrl, setCatPrefs } from './catalog-data.js';
import { execWarning, contentsBox, safetyNote } from './safety-view.js';
import { readmeModal, installOpened, ensureDir, destFields, engineSelect, watchdog } from './add.js';
import { KINDS, stashDirOf, installNonScenario, autoSkinCat, destStatus, openBtn } from './materials.js';
import { readSkin } from '../core/skin.js';
import { findTagsInOpened } from '../core/autotag.js';
import { backupOpts } from './backup.js';

const STATUS = {
  wait: ['待機中', 'plain'], fetch: ['取得中', 'plain'], ready: ['準備OK', 'ok'], action: ['操作待ち', 'warn'],
  error: ['取れませんでした', 'bad'], installing: ['インストール中', 'plain'], done: ['入れました', 'ok'], failed: ['入れられませんでした', 'bad'],
};

let seq = 0;

/**
 * まとめてDLを始める。
 * @param {{work: object, record?: object}[]} list record があれば「更新」として、その場所に置き換える
 */
export function startBatch(list, title = 'まとめてDL') {
  // R18 の作品は、まとめてDLには入れない（配布元をブラウザで開いて、1つずつ取ってもらう）
  const r18 = list.filter((x) => x.work?.rating === 'r18');
  if (r18.length) toast(`R18の作品（${r18.length}件：${r18.slice(0, 3).map((x) => `「${x.work.name}」`).join('')}${r18.length > 3 ? '…' : ''}）は、まとめてDLには入れません。作品の「ダウンロード」から、配布元をブラウザで開いてください`, { ms: 12000 });
  const rest = list.filter((x) => x.work?.rating !== 'r18');
  if (!rest.length) return null;
  return startItems(rest, title);
}

/**
 * 手元のファイル（ダウンロードフォルダ・複数選んだファイル）をまとめて入れる
 * @param {{name: string, bytes: Uint8Array, zone?: object}[]} files
 */
export async function startLocalBatch(files, title = '選んだファイルをまとめて入れる') {
  if (S.batch?.running || S.batch?.installing) { toast('まとめてDLの途中です。終わってから、もう一度押してください', { bad: true }); return; }
  const items = files.map((f) => ({
    id: ++seq, work: null, name: f.name, status: 'fetch', message: '読み込み中…', include: true, ack: false, pick: 0, force: false,
    target: null, engineId: null, folderName: '', zone: f.zone || null,
  }));
  S.batch = { title, items, engineId: S.engineId, cat: '', newCat: '', running: true, installing: false, stop: false, done: false };
  goTab('add');
  for (const [i, it] of items.entries()) {
    await analyze(it, files[i].bytes, files[i].name);
    render();
  }
  S.batch.running = false;
  render();
}

function startItems(list, title) {
  if (S.batch?.running || S.batch?.installing) { toast('まとめてDLの途中です。終わってから、もう一度押してください', { bad: true }); return; }
  const seen = new Set();
  const items = [];
  for (const { work, record } of list) {
    if (!work || seen.has(work.key)) continue;
    seen.add(work.key);
    const target = record ? splitPath(record) : null;
    items.push({
      id: ++seq, work, name: work.name, status: 'wait', message: '', include: true, ack: false, pick: 0, force: false,
      target, engineId: record?.engineId || null, folderName: target?.folderName || '',
    });
  }
  if (!items.length) { toast('DLする作品がありません', { bad: true }); return; }
  S.batch = { title, items, engineId: S.engineId, cat: '', newCat: '', running: false, installing: false, stop: false, done: false };
  goTab('add');
  runFetch();
}

/** 記録の場所（Scenario/分類/名前）を分ける */
function splitPath(r) {
  const segs = (r.path || '').split('/');
  if (segs[0] !== 'Scenario' || segs.length < 2) return null;
  const last = segs.pop();
  const folderName = r.type === 'archive' ? last.replace(/\.(wsn|zip)$/i, '') : last;
  return { cat: segs.slice(1).join('/'), folderName, path: r.path };
}

async function runFetch() {
  const b = S.batch;
  b.running = true;
  b.stop = false;
  render();
  const switches = [];
  for (const it of b.items) {
    if (b.stop || S.batch !== b) break;
    if (it.status !== 'wait') continue;
    it.status = 'fetch';
    it.message = '';
    render();
    let from = '';
    const out = await tryDownloads(it.work, {
      onTry: (d) => { from = dlLabel(d); it.message = `${from} から取得中…`; render(); },
      onProgress: (got, total) => {
        it.message = got < 0 ? `${from} につないでいます…` : `${from} からダウンロード中… ${total > 0 ? `${Math.floor((got / total) * 100)}%（${fmtSize(got)} / ${fmtSize(total)}）` : fmtSize(got)}`;
        const el = document.getElementById(`bi-msg-${it.id}`);
        if (el) el.textContent = it.message; else render();
      },
    }).catch((e) => ({ res: { kind: 'error', message: e.message } }));
    it.used = out.used;
    if (out.used && out.failed?.length) {
      it.fellBack = { from: out.first, to: out.used, why: out.failed[0].message };
      switches.push(it);
    }
    await receive(it, out.res);
    render();
    await sleep(600); // 相手のサイトに負担をかけないよう、1件ずつ間をあける
  }
  b.running = false;
  render();
  if (switches.length && S.catPrefs.askDefault && S.batch === b) await askSwitches(switches);
}

/** 取ってきた結果を、その作品の欄に入れる */
async function receive(it, res) {
  if (res.kind === 'zip') return analyze(it, res.bytes, res.fileName);
  if (res.kind === 'page' && await tryAutoAgree(res.st, itemHandler(it))) {
    if (it.status === 'fetch') { it.status = 'action'; it.page = res.st; it.message = '同意を覚えているサイトでしたが、取れませんでした。下で確かめてください'; }
    return;
  }
  if (res.kind === 'inapp') {
    it.status = 'action'; it.page = null; it.blocked = ''; it.inapp = res;
    it.message = `${res.why}。${S.platform.canInAppBrowse ? '「アプリ内で開いてダウンロード」を押して、サイトのボタンを押してください' : 'ページを開いてDLしたファイルを、この欄にドロップしてください'}`;
    return;
  }
  if (res.kind === 'page') {
    it.status = 'action'; it.page = res.st; it.blocked = '';
    it.message = res.st.forms?.length ? '同意（またはDLキー）が必要なページです。下で操作してください' : '配布ページです。下のリンクから取ってください';
    return;
  }
  if (res.kind === 'blocked') {
    it.status = 'action'; it.page = null; it.blocked = res.url;
    it.message = 'ブラウザの制限で直接取れません。ページを開いてDLしたファイルを、この欄にドロップしてください';
    return;
  }
  if (res.kind === 'none') { it.status = 'error'; it.message = 'この作品には、今DLできる配布元がありません'; return; }
  it.status = 'error';
  it.message = res.message || 'zip・wsnのファイルでも、ページでもないようです';
}

async function analyze(it, bytes, fileName) {
  try {
    const o = await openArchive(bytes, fileName);
    it.material = false;
    if (!o.scenarios.length) {
      // シナリオではないもの（スキン・素材など）：それぞれの置き場所に入れる
      const skin = await readSkin(o).catch(() => null);
      const kind = skin || it.work?.type === 'skin' ? 'skin' : 'material';
      if (!S.stash?.[kind]?.ref) { it.status = 'error'; it.message = `${fileName} はシナリオではないようです（${KINDS[kind].label}）。「設定」の「${KINDS[kind].place}」を決めると、まとめて入れられます`; return; }
      it.opened = o;
      it.material = true;
      it.matKind = kind;
      it.skin = skin;
      it.pick = 0;
      it.ack = !o.readmes.length;
      it.folderName = skin?.folderName || (o.archiveName || o.source.name).replace(/\.[^.]+$/, '');
      it.matCat = it.matCat || '';
      it.status = 'ready';
      it.message = '';
      it.page = null; it.blocked = ''; it.inapp = null;
      return;
    }
    it.opened = o;
    it.pick = 0;
    it.autoTags = S.autoTag === false ? [] : await findTagsInOpened(o, o.scenarios[0]).catch(() => []);
    it.ack = !o.readmes.length;
    it.folderName = it.target?.folderName || o.scenarios[0].folderName;
    it.exact = !!(o.source.sha256 && it.work?.shas.has(o.source.sha256));
    it.status = 'ready';
    it.message = '';
    it.page = null; it.blocked = ''; it.inapp = null;
  } catch (e) {
    it.status = 'error';
    it.message = e.message;
  }
}

/** 操作待ちの作品で、ページから取れたとき・ファイルを渡されたときの受け取り方 */
function itemHandler(it) {
  return {
    got: async (bytes, fileName) => { await analyze(it, bytes, fileName); render(); },
    page: (st) => { it.page = st; it.status = 'action'; render(); },
    blocked: async (url) => { it.page = null; it.blocked = url; it.status = 'action'; it.message = 'ブラウザの制限で直接取れません。ページを開いてDLしたファイルを、この欄にドロップしてください'; render(); await S.platform.openUrl(url); },
    error: (url, message) => toast(`読み込めませんでした：${message}`, { bad: true }),
    inapp: (res) => { it.inapp = res; it.page = null; it.status = 'action'; render(); },
  };
}

async function askSwitches(items) {
  const checks = items.map((it) => ({ it, box: h('input', { type: 'checkbox', checked: true }) }));
  const stop = h('input', { type: 'checkbox' });
  const ok = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'デフォルトのDL先を変えますか？'),
    h('p', { class: 'small' }, 'デフォルトのDL先から取れなかったので、別の配布元から取った作品があります。こちらをデフォルトのDL先に変更しますか？'),
    h('ul', { class: 'dl' }, checks.map(({ it, box }) => h('li', {}, h('label', { class: 'check' }, box,
      h('span', {}, h('b', {}, it.name), `　${dlLabel(it.fellBack.from)} → ${dlLabel(it.fellBack.to)}`))))),
    h('label', { class: 'check small' }, stop, '次からこの確認を出さない（設定の「カタログ」で戻せます）'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, '変更しない'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, '選んだものを変更する'))));
  if (stop.checked) await setCatPrefs({ askDefault: false });
  if (!ok) return;
  let n = 0;
  for (const { it, box } of checks) if (box.checked) { await setDefaultUrl(it.work, it.fellBack.to.url); n++; }
  if (n) toast(`${n}件のデフォルトのDL先を変更しました`);
}

// ------------------------------------------------------------ 画面
const engOf = (it) => engine(it.engineId || S.batch.engineId);
const playOf = (it) => {
  if (it.material) return null;
  const eng = engOf(it);
  return eng && it.opened ? playability(it.opened.scenarios[it.pick], eng.kind) : null;
};
/** インストールに進めるもの */
const installable = (it) => it.include && it.status === 'ready' && it.ack && (it.material || playOf(it)?.ok || it.force);

export function viewBatch() {
  const b = S.batch;
  const count = (st) => b.items.filter((i) => i.status === st).length;
  const needRead = b.items.filter((i) => i.include && i.status === 'ready' && !i.ack);
  const ready = b.items.filter(installable);
  const fetchedAll = !b.running && !b.items.some((i) => i.status === 'wait' || i.status === 'fetch');
  // シナリオとして新しく入れるもの（まだ中身が分からないものも含む）。素材・スキンだけなら、エンジンの欄は出さない
  const live = (i) => !['error', 'failed', 'done'].includes(i.status);
  const hasNew = b.items.some((i) => !i.target && !i.material && live(i));
  const hasScenario = b.items.some((i) => !i.material && live(i));
  const mats = b.items.filter((i) => i.material && live(i));
  b.catState ||= {};
  const dest = destFields(b.engineId, { state: b.catState, name: null, idPrefix: 'batch' });
  b.catValue = dest.value;

  return h('div', { class: 'card stack batch', id: 'batch' },
    h('div', { class: 'row between' },
      h('h2', { style: 'margin:0' }, `${b.title}（${b.items.length}件）`),
      h('div', { class: 'row small' },
        ['ready', 'action', 'error', 'done'].map((st) => (count(st) ? h('span', { class: `badge ${STATUS[st][1]}` }, `${STATUS[st][0]} ${count(st)}`) : null)),
        b.running ? h('button', { class: 'btn sm', onclick: () => { b.stop = true; } }, '取得を止める') : null,
        !b.running && b.items.some((i) => i.status === 'wait') ? h('button', { class: 'btn sm', onclick: runFetch }, '続きを取得') : null,
        !b.running && !b.installing ? h('button', { class: 'btn ghost sm', onclick: () => { S.batch = null; render(); } }, b.done ? '閉じる' : 'やめる') : null)),
    safetyNote({ id: 'batch-safety' }),
    b.running ? h('p', { class: 'small muted', style: 'margin:0' }, '直接DLできるものから順に取ってきています。同意やDLキーが必要なものは「操作待ち」になります。') : null,
    h('div', { class: 'list' }, b.items.map(itemCard)),
    !b.done ? h('div', { class: 'card soft stack', style: 'margin:0' },
      h('h3', {}, '入れ先'),
      hasNew ? (S.engines.length ? h('div', { class: 'grid2' },
        h('label', { class: 'field' }, 'エンジン', engineSelect((v) => { b.engineId = v; b.catState = {}; }, true, b.engineId, 'batch-engine')),
        dest.cat,
      ) : h('p', { class: 'small muted' }, 'エンジンが未登録です。「設定」タブで登録してください。')) : null,
      mats.length ? h('div', { class: 'small stack', style: 'gap:4px' },
        [...new Set(mats.map((i) => i.matKind))].map((kind) => h('div', { class: 'row' },
          h('span', {}, `${KINDS[kind].label}（${mats.filter((i) => i.matKind === kind).length}件）は、${KINDS[kind].place}「${S.stash?.[kind]?.label || '未設定'}」に入れます（作品ごとの欄で、分類フォルダとフォルダ名を決められます）`),
          openBtn(S.stash?.[kind]?.ref, '置き場所を確認する')))) : null,
      hasNew && S.engines.length > 1 ? h('div', { class: 'row' },
        h('button', { class: 'btn sm', id: 'batch-assign', disabled: b.installing, onclick: () => { const n = assignEngines(b); toast(n ? `${n}件のエンジンを、形式に合わせて振り分けました` : '振り分けが変わる作品はありませんでした'); render(); } }, '形式に合わせてエンジンに振り分ける'),
        h('span', { class: 'small muted' }, 'Py仕様（WSN）→ CardWirthPy、Next仕様 → CardWirthNext、クラシック → 上で選んだエンジン。作品ごとに「エンジン」で変えることもできます（分類フォルダは同じ名前で作ります）')) : null,
      b.items.some((i) => i.target) ? h('p', { class: 'small muted', style: 'margin:0' }, '「更新」の作品は、今入っている場所に置き換えます（前のものはバックアップします）。') : null,
      S.archive.ref && ((hasScenario && S.archive.on) || mats.some((i) => S.stash?.[i.matKind]?.keepZip)) ? h('div', { class: 'row small muted' },
        h('span', {}, [
          hasScenario && S.archive.on ? `シナリオの元のzip・wsnは「${S.archive.label}」にも保存します` : '',
          ...[...new Set(mats.map((i) => i.matKind))].filter((k) => S.stash?.[k]?.keepZip).map((k) => `${KINDS[k].label}の元のzipは、その中の「${KINDS[k].zipSub}」に残します`),
        ].filter(Boolean).join('。') + '。'),
        openBtn(S.archive.ref, '保存場所を開く')) : null,
      b.installing ? h('div', { class: 'stack' },
        h('progress', { id: 'batch-prog', max: 1, value: 0 }),
        h('div', { id: 'batch-prog-text', class: 'small muted' }, '準備中…')) : null,
      h('div', { class: 'row' },
        needRead.length ? h('button', { class: 'btn', disabled: b.installing, onclick: readAll }, `Readme（利用規約）を順に確認（あと${needRead.length}件）`) : null,
        h('button', { class: 'btn primary', disabled: !ready.length || b.installing || (!S.engines.length && !ready.every((i) => i.material)) || !S.platform.canWriteFolders, onclick: installAll }, `まとめてインストール（${ready.length}件）`),
        !fetchedAll ? h('span', { class: 'small muted' }, '取得が終わっていないものは、あとから入れられます') : null,
        needRead.length ? h('span', { class: 'small muted' }, 'Readme（利用規約）を読んでいないものは入りません') : null))
      : h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => {
        // 素材・スキンだけなら、その置き場所の一覧を開く
        const done = b.items.filter((i) => i.status === 'done');
        S.mineView = done.length && done.every((i) => i.material) ? (done[0].matKind === 'skin' ? 'skin' : 'mat') : '';
        S.batch = null;
        goTab('mine');
      } }, '自分のフォルダ一覧を見る')));
}

function itemCard(it) {
  const [label, cls] = STATUS[it.status];
  const sc = it.opened?.scenarios[it.pick];
  const play = playOf(it);
  const eng = engOf(it);
  const editable = !S.batch.installing && it.status === 'ready';
  const fileIn = h('input', {
    type: 'file', accept: '.zip,.wsn,.cab,.lzh,.lha,.7z', hidden: true,
    onchange: async (ev) => { const f = ev.target.files[0]; if (f) { await analyze(it, new Uint8Array(await f.arrayBuffer()), f.name); render(); } },
  });
  const card = h('div', { class: `card batch-item ${it.status}`, 'data-batch-drop': it.status === 'action' ? '1' : null },
    h('div', { class: 'row between' },
      h('div', { class: 'row' },
        it.status === 'ready' ? h('input', { type: 'checkbox', checked: it.include, 'aria-label': `${it.name}を入れる`, disabled: !editable, onchange: (ev) => { it.include = ev.target.checked; render(); } }) : null,
        h('span', { class: 'item-title' }, it.name),
        h('span', { class: `badge ${cls}` }, label),
        it.target ? h('span', { class: 'badge update' }, '更新') : null,
        it.material ? h('span', { class: 'badge plain' }, KINDS[it.matKind]?.label || '素材') : null,
        sc && !it.material ? formatBadge(sc) : null),
      h('div', { class: 'row' },
        it.status === 'ready' && it.opened.readmes.length ? h('button', {
          class: 'btn sm', onclick: async () => { const r = await readmeModal(it.opened, it.name); if (r) { it.ack = true; render(); } },
        }, it.ack ? 'Readme ✓' : 'Readme（利用規約）を読む') : null,
        it.status === 'error' && it.work ? h('button', { class: 'btn sm', onclick: () => { it.status = 'wait'; if (!S.batch.running) runFetch(); else render(); } }, 'もう一度') : null,
        ['wait', 'error', 'action', 'ready'].includes(it.status) && !S.batch.installing ? h('button', { class: 'btn ghost sm', onclick: () => { S.batch.items = S.batch.items.filter((x) => x !== it); if (!S.batch.items.length) S.batch = null; render(); } }, '外す') : null)),
    h('div', { class: 'meta' }, [it.work?.author, it.work ? `ver ${it.work.version}` : '', it.zone?.referrerUrl || it.zone?.hostUrl ? `DL元：${(it.zone.referrerUrl || it.zone.hostUrl).replace(/^https?:\/\//, '').slice(0, 60)}` : '', it.used ? `取得元：${dlLabel(it.used)}` : '', it.opened ? `${it.opened.source.name}・${fmtSize(it.opened.source.size)}` : ''].filter(Boolean).join('・')),
    it.message ? h('div', { class: `small ${it.status === 'error' || it.status === 'failed' ? 'note bad' : 'muted'}`, id: `bi-msg-${it.id}` }, it.message) : null,
    it.opened && it.status !== 'done' ? execWarning(it.opened, { compact: true, disabled: !editable }) : null,
    it.opened && it.status === 'ready' ? contentsBox(it.opened, { id: `bi-contents-${it.id}` }) : null,
    it.status === 'done' && it.donePath ? h('div', { class: 'row' }, openBtn(it.donePath, '入れた場所を開く')) : null,
    it.fellBack && it.status !== 'done' ? h('div', { class: 'small muted' }, `デフォルトの「${dlLabel(it.fellBack.from)}」から取れなかったので、「${dlLabel(it.fellBack.to)}」から取りました。`) : null,
  );
  // 素材・スキン：入れ先の様子（もう入っているか・新しく入れるか）
  const destEl = h('div', { class: 'small dest-status', id: `bi-dest-${it.id}` });
  const updDest = () => {
    const ds = destStatus(it.opened, matOpts(it));
    destEl.className = `small dest-status note ${ds.level === 'ok' ? 'ok' : ds.level === 'warn' ? 'warn' : ds.level === 'bad' ? 'bad' : ''}`;
    destEl.replaceChildren(...[h('span', {}, ds.text), openBtn(ds.baseRef, '置き場所を確認する')].filter(Boolean));
  };
  if (it.status === 'ready' && it.material) {
    const k = KINDS[it.matKind];
    const cats = S.categories[k.id] || [];
    card.append(h('div', { class: 'row small', style: 'margin-top:6px' },
      h('label', { class: 'row' }, '入れ方', h('select', { disabled: !editable, 'aria-label': `${it.name}の入れ方`, onchange: (ev) => { it.matKind = ev.target.value; render(); } },
        Object.values(KINDS).map((x) => h('option', { value: x.key, selected: x.key === it.matKind ? 'selected' : null }, `${x.label}として（${x.place}）`)))),
      h('label', { class: 'row' }, '分類フォルダ', h('input', { type: 'text', list: `cats-${k.key}`, value: it.matCat, placeholder: it.matKind === 'skin' ? `空なら自動（${autoSkinCat(it.skin)}）` : '空なら直下', style: 'width:11em', disabled: !editable, oninput: (ev) => { it.matCat = ev.target.value; updDest(); } }),
        h('datalist', { id: `cats-${k.key}` }, cats.map((c) => h('option', { value: c })))),
      h('label', { class: 'row' }, 'フォルダ名', h('input', { type: 'text', value: it.folderName, disabled: !editable, oninput: (ev) => { it.folderName = ev.target.value; updDest(); } }))),
      destEl);
    updDest();
  } else if (it.status === 'ready') {
    if (it.opened.scenarios.length > 1) {
      card.append(h('label', { class: 'field small' }, `${it.opened.scenarios.length}本のシナリオが入っています。入れるもの`,
        h('select', { disabled: !editable, onchange: (ev) => { it.pick = Number(ev.target.value); it.folderName = it.target?.folderName || it.opened.scenarios[it.pick].folderName; render(); } },
          it.opened.scenarios.map((s, i) => h('option', { value: i, selected: i === it.pick ? 'selected' : null }, s.name)))));
    }
    card.append(h('div', { class: 'row small', style: 'margin-top:6px' },
      it.target
        ? h('span', { class: 'muted' }, `置き換える場所：${it.target.path}${it.engineId && it.engineId !== S.batch.engineId ? `（${engine(it.engineId)?.name || ''}）` : ''}`)
        : h('label', { class: 'row' }, 'フォルダ名', h('input', { type: 'text', value: it.folderName, disabled: !editable, oninput: (ev) => { it.folderName = ev.target.value; } })),
      !it.target && S.engines.length > 1 ? h('label', { class: 'row' }, 'エンジン', h('select', {
        disabled: !editable, 'aria-label': `${it.name}を入れるエンジン`,
        onchange: (ev) => { it.engineId = ev.target.value === S.batch.engineId ? null : ev.target.value; render(); },
      }, S.engines.map((e) => h('option', { value: e.id, selected: (it.engineId || S.batch.engineId) === e.id ? 'selected' : null }, e.name)))) : null,
      it.exact ? h('span', { class: 'badge ok' }, 'カタログのファイルと一致') : null,
      it.autoTags?.length ? h('span', { class: 'muted' }, `Readmeから見つけたタグ：${it.autoTags.join('・')}`) : null));
    if (play && !play.ok) {
      card.append(h('div', { class: 'note bad small', style: 'margin-top:6px' }, `${eng.name}：${play.reason}`,
        h('label', { class: 'check', style: 'margin-left:8px' }, h('input', { type: 'checkbox', checked: it.force, disabled: !editable, onchange: (ev) => { it.force = ev.target.checked; render(); } }), 'それでも入れる')));
    } else if (play?.level === 'caution') {
      card.append(h('div', { class: 'note warn small', style: 'margin-top:6px' }, play.reason));
    }
  }
  if (it.status === 'action') {
    const hd = itemHandler(it);
    card.append(h('div', { class: 'stack', style: 'margin-top:8px' },
      it.page ? pagePanel(it.page, hd, it.work) : null,
      it.inapp ? h('div', { class: 'row' },
        S.platform.canInAppBrowse ? h('button', { class: 'btn sm primary', onclick: () => inAppDownload(it.inapp.url, hd, it.inapp.why) }, 'アプリ内で開いてダウンロード') : null,
        h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(it.inapp.url) }, 'ブラウザで開く')) : null,
      it.blocked ? h('div', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(it.blocked) }, 'ページを開く'),
        S.platform.canInAppBrowse ? h('button', { class: 'btn sm', onclick: () => inAppDownload(it.blocked, hd) }, 'アプリ内で開いてダウンロード') : null) : null,
      h('div', { class: 'row small muted' }, 'DLしたファイルを、この欄にドロップするか', h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'ファイルを選ぶ'), fileIn)));
    card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
    card.addEventListener('dragleave', () => card.classList.remove('over'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('over');
      const f = e.dataTransfer.files?.[0];
      if (f) { await analyze(it, new Uint8Array(await f.arrayBuffer()), f.name); render(); }
    });
  }
  return card;
}

/** 素材・スキンの入れ方（作品の欄の値から） */
function matOpts(it) {
  return { kind: it.matKind, to: 'stash', cat: (it.matCat || '').trim() || (it.matKind === 'skin' ? autoSkinCat(it.skin) : ''), name: it.folderName || '', skin: it.matKind === 'skin' ? it.skin : null };
}

/** 形式に合わせてエンジンを決める（Py仕様→Py、Next仕様→Next、それ以外は全体で選んだエンジン） */
function assignEngines(b) {
  const byKind = (k) => S.engines.find((e) => e.kind === k)?.id || null;
  let n = 0;
  for (const it of b.items) {
    if (it.target || it.material || !it.opened || it.status !== 'ready') continue;
    const fmt = it.opened.scenarios[it.pick]?.format;
    const want = fmt === 'wsn' ? byKind('py') : fmt === 'next' ? byKind('next') : null;
    const next = want && want !== b.engineId ? want : null;
    if ((it.engineId || null) !== next) { it.engineId = next; n++; }
  }
  return n;
}

async function readAll() {
  for (const it of S.batch.items.filter((i) => i.include && i.status === 'ready' && !i.ack)) {
    const r = await readmeModal(it.opened, it.name, { next: true });
    if (!r) break;
    it.ack = true;
    render();
  }
  render();
}

async function installAll() {
  const b = S.batch;
  const items = b.items.filter(installable);
  const cat = b.catValue ? b.catValue() : '';
  b.cat = cat;
  // フォルダの許可は、ボタンを押した直後にまとめて聞く
  const dirs = new Map();
  for (const kind of new Set(items.filter((i) => i.material).map((i) => i.matKind))) {
    if (!(await stashDirOf(kind, true))) { toast(`${KINDS[kind].place}を使う許可がありませんでした`, { bad: true }); return; }
  }
  for (const id of new Set(items.filter((i) => !i.material).map((i) => i.engineId || b.engineId))) {
    const eng = engine(id);
    if (!eng) continue;
    const d = await ensureDir(eng);
    if (!d) return;
    dirs.set(id, d);
  }
  // バックアップ先を選んでいれば、その許可もここで聞いておく
  if (S.backupFolder?.ref && items.some((i) => i.target)) {
    try { await backupOpts('engine', items[0].engineId || b.engineId); } catch (e) { toast(e.message, { bad: true }); return; }
  }
  b.installing = true;
  render();
  const wd = watchdog('batch-prog-text');
  let okN = 0, ngN = 0;
  for (const [n, it] of items.entries()) {
    const eng = engOf(it);
    it.status = 'installing';
    it.message = '';
    render();
    const prog = (done, total, phase, name) => {
      wd.poke();
      const bar = document.getElementById('batch-prog');
      const t = document.getElementById('batch-prog-text');
      if (bar) { bar.max = items.length; bar.value = n + (total ? done / total : 0); }
      if (t) t.textContent = `${n + 1} / ${items.length} 本目「${it.name}」　${phase === 'backup' ? 'バックアップ中' : '書き込み中'} ${done}/${total}　${(name || '').split('/').pop()}`;
      busyText(`まとめてインストール中… ${n + 1}/${items.length}`);
    };
    if (it.material) {
      try {
        const r = await installNonScenario(it.opened, matOpts(it));
        it.status = 'done';
        it.donePath = r.full;
        it.message = `${r.where} の ${r.dest} に入れました${r.backup ? `（前のものは ${r.backup} に移しました）` : ''}${r.zip ? `（元のzipは ${r.zip} に）` : ''}`;
        okN++;
      } catch (e) {
        it.status = 'failed';
        it.message = e.message;
        ngN++;
      }
      render();
      continue;
    }
    try {
      const { plan, res, archived } = await installOpened({
        opened: it.opened, pick: it.pick, eng, dir: dirs.get(it.engineId || b.engineId),
        cat: it.target ? it.target.cat : cat, folderName: it.folderName.trim() || it.opened.scenarios[it.pick].folderName,
        version: it.work ? it.work.version : it.opened.scenarios[it.pick].versionGuess || '', versionSource: it.work ? (it.exact ? 'catalog' : 'dl') : 'guess', work: it.work, onProgress: prog,
        tags: it.autoTags || [],
      });
      it.status = 'done';
      it.donePath = eng?.ref && S.platform.kind === 'app' ? [eng.ref.replace(/[\\/]+$/, ''), ...plan.dest.split('/')].join('\\') : '';
      it.message = `${plan.dest} に入れました${res.backup ? `（前のものは ${res.backupShown} にバックアップ）` : ''}${archived ? `・zipも保存しました` : ''}`;
      it.opened = it.opened; // Readme表示用に残す
      okN++;
    } catch (e) {
      it.status = 'failed';
      it.message = /forbidden path/i.test(e.message) ? 'このフォルダを使う許可が足りません。「設定」でエンジンの「選び直す」を押してください' : e.message;
      ngN++;
    }
    render();
  }
  wd.stop();
  S.records = await store.records();
  b.installing = false;
  b.done = !b.items.some((i) => ['ready', 'action', 'wait', 'fetch', 'error'].includes(i.status));
  render();
  toast(`${okN}件を入れました${ngN ? `（入れられなかったもの ${ngN}件）` : ''}`, { ms: 8000, bad: !!ngN && !okN });
}

export { deliver };
