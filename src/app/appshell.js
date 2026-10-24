// アプリ版（ポータブル版）だけの機能：
//  ・文字の大きさ（Ctrl＋＋／Ctrl＋－／Ctrl＋0・Ctrl＋ホイール）と、F11で全画面
//  ・起動したとき：前の版からの引き継ぎのお知らせ・更新の確認（設定でオン・オフ）・渡されたファイルやリンクを開く
//  ・設定タブの「アプリの更新」「Windowsとのつなぎこみ」「ポータブル版について」

import { S, render, busy, goTab, APP_VERSION, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, modal, fmtDate } from './ui.js';
import { openArchive } from '../core/archive.js';
import { openSource } from './add.js';
import { openLocalFiles } from './localfiles.js';
import { askInstallLink } from './download.js';

const RELEASES = 'https://github.com/seihayukimi-oss/cw-catalog-tool/releases';
const ZOOMS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];

// ------------------------------------------------------------ 文字の大きさ・全画面
export async function setupShell() {
  if (S.platform.kind !== 'app') return;
  S.zoom = (await store.get('uiZoom')) || 1;
  applyZoom();
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'F11') { ev.preventDefault(); S.platform.toggleFullscreen?.(); return; }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key === '+' || ev.key === '=' || ev.key === ';') { ev.preventDefault(); stepZoom(1); }
    else if (ev.key === '-') { ev.preventDefault(); stepZoom(-1); }
    else if (ev.key === '0') { ev.preventDefault(); setZoom(1); }
  });
  window.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    stepZoom(ev.deltaY < 0 ? 1 : -1);
  }, { passive: false });
}

function applyZoom() {
  document.documentElement.style.zoom = String(S.zoom || 1);
}
function stepZoom(d) {
  const i = ZOOMS.findIndex((z) => Math.abs(z - (S.zoom || 1)) < 0.01);
  setZoom(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? 3 : i) + d))]);
}
export async function setZoom(z) {
  S.zoom = z;
  applyZoom();
  await store.set('uiZoom', z);
  const el = document.getElementById('zoom-now');
  if (el) el.textContent = `${Math.round(z * 100)}%`;
}

// ------------------------------------------------------------ 起動したとき
export async function startShell() {
  if (S.platform.kind !== 'app') return;
  const info = await S.platform.portableInfo?.().catch(() => null);
  S.portable = info;
  if (info?.migrated) toast(`${info.migrated}。エンジンのフォルダに「接続」できないときは、「設定」で「選び直す」を押してください`, { ms: 12000 });
  if (info && !info.besideExe) toast(`このフォルダには記録を置けないので、${info.dataDir} に置いています。CWCatalog.exe は、書き込めるフォルダ（例：D:\\ゲーム\\CWCatalog）に置くのがおすすめです`, { ms: 14000 });

  // Windowsへの登録をしていて、exe を別のフォルダに動かしていたら、登録先を直す
  const st = await S.platform.assocStatus?.().catch(() => null);
  if (st?.registered && st.moved) {
    await S.platform.assocRegister().then(() => toast('CWCatalog.exe の場所が変わったので、Windowsへの登録を新しい場所に直しました')).catch(() => {});
  }

  // 渡されたファイル・リンク
  S.platform.onOpenArgs?.((list) => openArgs(list));
  const first = await S.platform.takeOpenArgs?.();
  if (first?.length) await openArgs(first);

  if ((await store.get('autoUpdateCheck', true)) !== false) setTimeout(() => checkSelf(false), 3000);
}

/** ダブルクリック・右クリック・cwcatalog:// から渡されたものを開く */
async function openArgs(list) {
  const links = list.filter((a) => /^cwcatalog:/i.test(a));
  const files = list.filter((a) => !/^cwcatalog:/i.test(a));
  if (files.length) {
    goTab('add');
    const got = await busy('ファイルを読み込み', () => Promise.all(files.map((p) => S.platform.readPath(p))));
    if (got) await openLocalFiles(got);
  }
  for (const l of links.slice(0, 1)) {
    let u;
    try { u = new URL(l); } catch { toast('リンクの形が正しくありません', { bad: true }); continue; }
    // cwcatalog://install?url=…&name=… ／ cwcatalog://entry?id=e00012
    const params = u.searchParams;
    const kind = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
    await askInstallLink({
      url: kind.startsWith('install') ? (params.get('url') || '').trim() : '',
      entryId: kind.startsWith('entry') ? (params.get('id') || params.get('entry') || '').trim() : '',
      name: (params.get('name') || '').slice(0, 100),
    });
  }
}

// ------------------------------------------------------------ 更新
export async function checkSelf(manual) {
  try {
    const u = await S.platform.checkSelfUpdate(APP_VERSION);
    await store.set('lastSelfCheck', new Date().toISOString());
    if (!u) { if (manual) toast('最新の版です'); render(); return; }
    const ok = await modal((close) => h('div', { class: 'stack' },
      h('h2', {}, `新しい版 ${u.version} があります`),
      h('p', { class: 'small muted', style: 'margin:0' }, `今の版：${APP_VERSION}`),
      u.notes ? h('pre', { class: 'readme' }, u.notes) : null,
      u.keyConfigured
        ? h('p', { class: 'small muted', style: 'margin:0' }, '「更新する」を押すと、新しい CWCatalog.exe をダウンロードして、署名（本物かどうか）を確かめてから入れ替え、起動し直します。記録（CWCatalog-data）はそのまま残ります。')
        : h('p', { class: 'note warn small', style: 'margin:0' }, 'この版は自動では入れ替えられません。GitHubのリリースのページから新しい CWCatalog.exe を取ってきて、今の CWCatalog.exe と置き換えてください。'),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(false) }, 'あとで'),
        !u.keyConfigured ? h('button', { class: 'btn primary', onclick: () => { S.platform.openUrl(RELEASES); close(false); } }, 'リリースのページを開く') : null,
        u.keyConfigured ? h('button', { class: 'btn primary', onclick: () => close(true) }, '更新する') : null)));
    if (ok) await busy('新しい版をダウンロード中', () => u.install());
  } catch (e) {
    if (manual) toast(`更新を確認できませんでした：${e.message}`, { bad: true });
  }
}

// ------------------------------------------------------------ 設定タブ
export function viewAppSettings() {
  if (S.platform.kind !== 'app') return null;
  return h('div', {},
    h('h2', {}, 'アプリの更新'),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('span', { class: 'grow' }, `今の版：${APP_VERSION}`),
        h('button', { class: 'btn', onclick: () => busy('更新を確認', () => checkSelf(true)) }, '更新を確認')),
      autoCheckBox(),
      h('p', { class: 'small muted', style: 'margin:0' }, '確認は GitHub のリリースを見に行くだけです。入れ替えるのは、「更新する」を押したときだけです。')),

    h('h2', {}, '表示'),
    h('div', { class: 'card stack' },
      h('div', { class: 'row' },
        h('span', {}, '文字の大きさ'),
        h('button', { class: 'btn sm', onclick: () => stepZoom(-1) }, '小さく'),
        h('b', { id: 'zoom-now' }, `${Math.round((S.zoom || 1) * 100)}%`),
        h('button', { class: 'btn sm', onclick: () => stepZoom(1) }, '大きく'),
        h('button', { class: 'btn ghost sm', onclick: () => setZoom(1) }, '元に戻す'),
        h('button', { class: 'btn sm', onclick: () => S.platform.toggleFullscreen() }, '全画面（F11）')),
      h('p', { class: 'small muted', style: 'margin:0' }, 'Ctrl＋＋／Ctrl＋－／Ctrl＋マウスホイールでも変えられます（Ctrl＋0で元の大きさ）。窓の大きさと位置は、次に起動したときも同じになります。')),

    h('h2', {}, 'Windowsとのつなぎこみ'),
    viewAssoc(),

    h('h2', {}, 'ポータブル版について'),
    h('div', { class: 'card small stack' },
      S.portable ? h('p', { style: 'margin:0' }, `記録の置き場所：${S.portable.dataDir}`) : null,
      h('ul', { style: 'margin:0;padding-left:1.2em' },
        h('li', {}, 'インストールは要りません。CWCatalog.exe と、横にできる「CWCatalog-data」フォルダ（設定・記録・アプリ内ブラウザのログイン状態）で全部です。'),
        h('li', {}, 'やめるときは、上の「Windowsとのつなぎこみ」を登録していたら「登録を外す」を押してから、フォルダごと消してください。'),
        h('li', {}, '人に渡すときは、CWCatalog.exe だけを渡してください（CWCatalog-data にはログインの状態も入っています）。'),
        h('li', {}, '「C:\\Program Files」の中には置かないでください（Windowsの決まりで、記録の保存や更新ができません）。'))));
}

function autoCheckBox() {
  const box = h('input', { type: 'checkbox', 'aria-label': '起動したときに新しい版がないか確認する' });
  store.get('autoUpdateCheck', true).then((v) => { box.checked = v !== false; });
  box.addEventListener('change', () => store.set('autoUpdateCheck', box.checked));
  return h('label', { class: 'check' }, box, '起動したときに、新しい版がないか確認する');
}

function viewAssoc() {
  const card = h('div', { class: 'card stack' }, h('p', { class: 'small muted', style: 'margin:0' }, '読み込み中…'));
  S.platform.assocStatus().then((st) => {
    if (!st.supported) { card.replaceChildren(h('p', { class: 'small muted', style: 'margin:0' }, 'Windowsだけの機能です。')); return; }
    card.replaceChildren(
      h('p', { style: 'margin:0' }, '登録すると、次のことができるようになります。'),
      h('ul', { class: 'small', style: 'margin:0;padding-left:1.2em' },
        h('li', {}, '.wsn を「プログラムから開く」でCWカタログを選べる（いつもこれで開くかは、初めて開くときにWindowsが聞きます）'),
        h('li', {}, 'zip・wsn・cab・lzh・7z の右クリックに「CWカタログで開く」が出る（Windows 11では「その他のオプションを確認」の中）'),
        h('li', {}, '作者さんのサイトの「CWカタログで入れる」から、このアプリが直接開く（取ってくる前に必ず確認します）')),
      h('p', { class: 'small muted', style: 'margin:0' }, '書き込むのは、Windowsの「自分のユーザー用」の場所だけです。管理者の許可は要りません。exe を別のフォルダに動かしたら、次に起動したとき自動で直します。'),
      h('div', { class: 'row' },
        h('span', { class: `badge ${st.registered ? 'ok' : 'plain'}` }, st.registered ? '登録済み' : '未登録'),
        h('button', { class: 'btn', onclick: () => busy('Windowsに登録', async () => { await S.platform.assocRegister(); toast('登録しました'); }) }, st.registered ? '登録し直す' : '登録する'),
        st.registered ? h('button', {
          class: 'btn ghost danger', onclick: async () => {
            if (!(await confirmBox('Windowsへの登録を外します。よろしいですか？'))) return;
            await busy('登録を外す', async () => { await S.platform.assocUnregister(); toast('登録を外しました'); });
          },
        }, '登録を外す') : null));
  }).catch((e) => card.replaceChildren(h('p', { class: 'note bad small' }, `状態を読めませんでした：${e.message || e}`)));
  return card;
}

export { openArchive, openSource, fmtDate, RELEASES };
