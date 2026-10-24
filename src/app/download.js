// 作品を取ってくる：URLから／配布ページから（同意してDL・アプリ内ブラウザ）／カタログの配布元から。
// 配布元が複数あるときは、デフォルトのDL先 → 現役 → 予備 → 旧 の順に試す。

import { openArchive } from '../core/archive.js';
import { chooseDownloads } from '../core/catalogs.js';
import { decodeHtml, extractDownloadLinks, extractDownloadForms, metaRefreshUrl, pageText, pageTitle, siteNotice } from '../core/weblink.js';
import { looksLikeZip } from '../core/zip.js';
import { S, render, busy, goTab } from './state.js';
import { h, toast, modal } from './ui.js';
import { defaultUrlOf, setDefaultUrl, setCatPrefs } from './catalog-data.js';
import { openSource } from './add.js';

export const dlLabel = (d) => d.label || d.url.replace(/^https?:\/\//, '').split('/')[0];

/**
 * URLを1回読んでみる。
 * @returns {Promise<{kind:'zip', bytes, fileName} | {kind:'page', st} | {kind:'blocked', url} | {kind:'error', message} | {kind:'other'}>}
 */
export async function fetchOnce(url, opts) {
  let r;
  try { r = await S.platform.fetchResource(url, opts); } catch (e) { return { kind: 'error', url, message: e.message || String(e) }; }
  return classify(r, url);
}

function classify(r, url) {
  if (r.blocked) return { kind: 'blocked', url };
  if (looksLikeZip(r.bytes)) {
    const name = r.fileName && /\.(zip|wsn)$/i.test(r.fileName) ? r.fileName : `${r.fileName || 'download'}.zip`;
    return { kind: 'zip', bytes: r.bytes, fileName: name, url: r.finalUrl || url };
  }
  const head = new TextDecoder('latin1').decode(r.bytes.subarray(0, 512)).trimStart();
  if (/html/i.test(r.contentType) || head.startsWith('<')) {
    const html = decodeHtml(r.bytes, r.contentType);
    return {
      kind: 'page',
      st: {
        url, finalUrl: r.finalUrl, title: pageTitle(html),
        links: extractDownloadLinks(html, r.finalUrl), forms: extractDownloadForms(html, r.finalUrl),
        text: pageText(html, 3000), notice: siteNotice(r.finalUrl),
      },
    };
  }
  return { kind: 'other', url };
}

/**
 * 結果の受け取り方（ひとつずつDLするときと、まとめてDLするときで変える）
 * @typedef {{got: (bytes: Uint8Array, fileName: string, url?: string) => any, page: (st: object) => any, blocked: (url: string) => any, error: (url: string, message: string) => any}} Handler
 */

/** ひとつずつDLするときの受け取り方：「シナリオをDLする」タブに出す */
export function singleHandler(work = null) {
  return {
    got: (bytes, fileName, url) => { S.urlState = null; S.lastUrl = url || S.lastUrl; return openSource(async () => openArchive(bytes, fileName), work); },
    page: (st) => { S.urlState = { ...st, status: 'page', work }; S.tab = 'add'; render(); },
    blocked: async (url) => { S.urlState = { url, status: 'blocked', notice: siteNotice(url), work }; S.tab = 'add'; render(); await S.platform.openUrl(url); },
    error: (url, message) => { S.urlState = { url, status: 'error', message, work }; S.tab = 'add'; render(); },
  };
}

export function deliver(res, hd) {
  switch (res.kind) {
    case 'zip': return hd.got(res.bytes, res.fileName, res.url);
    case 'page': return hd.page(res.st);
    case 'blocked': return hd.blocked(res.url);
    case 'error': return hd.error(res.url, res.message);
    default: toast('zip・wsnのファイルでも、ページでもないようです', { bad: true }); return null;
  }
}

/** URLから取ってくる（「URLから」の欄・リンクの「取ってくる」） */
export async function fetchFromUrl(url, work = null, hd = singleHandler(work)) {
  const res = await busy('読み込み中', () => fetchOnce(url));
  if (!res) return;
  if (res.kind === 'zip' || res.kind === 'page') S.lastUrl = url;
  return deliver(res, hd);
}

/**
 * カタログの作品を、使える配布元から順に試して取ってくる。
 * 使えない（読み込めない）配布元は飛ばして次へ。ブラウザの制限で読めないのは「使えない」ではないので、そこで止める。
 * @returns {{res, used, failed: {d, message}[], first}}
 */
export async function tryDownloads(work, { onTry } = {}) {
  const list = chooseDownloads(work, defaultUrlOf(work));
  if (!list.length) return { res: { kind: 'none' }, used: null, failed: [], first: null };
  const failed = [];
  for (const d of list) {
    onTry?.(d);
    const res = await fetchOnce(d.url);
    if (res.kind === 'error' || res.kind === 'other') { failed.push({ d, message: res.message || 'zip・wsnではありませんでした' }); continue; }
    return { res, used: d, failed, first: list[0] };
  }
  const last = failed[failed.length - 1];
  return { res: { kind: 'error', url: last.d.url, message: failed.map((f) => `${dlLabel(f.d)}：${f.message}`).join(' ／ ') }, used: null, failed, first: list[0] };
}

/** 作品の「ダウンロード」ボタン：デフォルトのDL先から。だめなら別の配布元から取って、デフォルトを変えるか聞く */
export async function downloadWork(work) {
  const out = await busy(`「${work.name}」を取得中`, () => tryDownloads(work));
  if (!out) return;
  if (out.res.kind === 'none') { toast('この作品には、今DLできる配布元がありません', { bad: true }); return; }
  if (out.used && out.failed.length) await askSwitchDefault(work, out.first, out.used, out.failed[0].message);
  if (out.res.kind === 'zip' || out.res.kind === 'page') S.lastUrl = out.used.url;
  return deliver(out.res, singleHandler(work));
}

/** 指定した配布元だけから取る */
export async function downloadFrom(work, d) {
  return fetchFromUrl(d.url, work);
}

/** 「こちらをデフォルトのDL先に変更しますか？」（設定で出さないようにもできる） */
export async function askSwitchDefault(work, from, to, why = '') {
  if (!S.catPrefs.askDefault || !from || !to || from === to) return false;
  const stop = h('input', { type: 'checkbox' });
  const yes = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'デフォルトのDL先を変えますか？'),
    h('p', {}, `「${work.name}」は、デフォルトのDL先「${dlLabel(from)}」から取れなかったので、「${dlLabel(to)}」から取りました。`),
    why ? h('p', { class: 'small muted' }, `取れなかった理由：${why}`) : null,
    h('p', { style: 'margin:0' }, 'こちらをデフォルトのDL先に変更しますか？'),
    h('label', { class: 'check small' }, stop, '次からこの確認を出さない（設定の「カタログ」で戻せます）'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, '変更しない'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, '変更する'))));
  if (stop.checked) await setCatPrefs({ askDefault: false });
  if (yes) { await setDefaultUrl(work, to.url); toast(`「${dlLabel(to)}」をデフォルトのDL先にしました`); }
  return !!yes;
}

// ------------------------------------------------------------ 同意してダウンロード（A）・アプリ内ブラウザ（B）
/**
 * A：ページのダウンロードフォームを、本人が同意したあとに送信して、zipまで取ってくる。
 * 送信後のページに本物のファイルへのリンクや自動移動があれば、それも1〜2回たどる。
 */
export async function agreeAndDownload(st, form, values, hd) {
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
      if (!next) break;
      r = await S.platform.fetchResource(next, { headers: { Referer: r.finalUrl } });
    }
    return r;
  });
  if (!res) return;
  if (res.blocked) return hd.blocked(st.url);
  if (looksLikeZip(res.bytes)) return deliver(classify(res, st.url), hd);
  toast('同意のあとにファイルが見つかりませんでした。DLキーが違うか、ページの作りが変わったのかもしれません。ページを開いて確かめてください', { bad: true, ms: 9000 });
}

/** B：アプリ内ブラウザで配布ページを開き、本人がサイトのボタンを押して落ちてきたファイルを受け取る */
export async function inAppDownload(url, hd) {
  if (!S.platform.canInAppBrowse) { await S.platform.openUrl(url); return; }
  toast('配布ページを別の窓で開きました。サイトのダウンロードボタンを押すと、ここに取り込みます', { ms: 9000 });
  const got = await busy('アプリ内ブラウザで待っています', () => S.platform.openInAppBrowser(url));
  if (!got) return;
  if (!looksLikeZip(got.bytes)) { toast(`${got.fileName} はzip・wsnではないようです`, { bad: true }); return; }
  return hd.got(got.bytes, got.fileName || 'download.zip', url);
}

/** 同意画面：ページの文章（規約など）を見せて、本人が同意したら送信する */
export function viewAgree(st, hd) {
  const form = st.forms[0];
  // 画面を描き直しても、入れたDLキーや同意のチェックが消えないよう、ページの情報に覚えておく
  st.values ||= {};
  const keyInputs = form.inputs.map((i) => h('label', { class: 'field' }, i.label === i.name ? `入力欄（${i.name}）` : i.label,
    h('input', { type: i.type, 'data-name': i.name, autocomplete: 'off', value: st.values[i.name] || '', oninput: (ev) => { st.values[i.name] = ev.target.value; } })));
  const check = h('input', { type: 'checkbox', checked: !!st.agreed });
  const btn = h('button', { class: 'btn primary sm', disabled: !st.agreed }, `同意して${form.label || 'ダウンロード'}`);
  check.addEventListener('change', () => { st.agreed = check.checked; btn.disabled = !check.checked; });
  btn.addEventListener('click', () => {
    const values = {};
    for (const l of keyInputs) { const inp = l.querySelector('input'); values[inp.dataset.name] = inp.value; }
    agreeAndDownload(st, form, values, hd);
  });
  return h('div', { class: 'card soft stack', style: 'margin:0' },
    h('div', {}, h('b', {}, 'このページは、内容に同意してからダウンロードする形式です')),
    h('pre', { class: 'readme', style: 'max-height:220px' }, st.text || '（本文を読み取れませんでした。「ブラウザで開く」で確かめてください）'),
    keyInputs,
    h('label', { class: 'check' }, check, 'ページの内容・規約を読んで、同意します'),
    h('div', { class: 'row' }, btn,
      S.platform.kind === 'web' ? h('span', { class: 'small muted' }, '※ HTML版では、多くのサイトでブラウザの制限により送信できません（アプリ版なら取れます）') : null));
}

/** 配布ページを読んだ結果（同意フォーム・リンク一覧・アプリ内ブラウザ） */
export function pagePanel(st, hd, work = null) {
  const inApp = S.platform.canInAppBrowse
    ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, hd) }, 'アプリ内で開いてダウンロード')
    : null;
  return h('div', { class: 'stack small' },
    h('div', {}, h('b', {}, st.title || st.url)),
    st.notice ? h('div', { class: 'note warn' }, st.notice) : null,
    st.forms?.length ? viewAgree(st, hd) : null,
    st.links.length ? h('div', {}, `ダウンロードらしいリンクが ${st.links.length}件 ありました`) : (!st.forms?.length ? h('div', {}, 'ダウンロードのリンクは見つかりませんでした') : null),
    st.links.length ? h('ul', { class: 'dl' }, st.links.map((l) => h('li', {},
      h('span', { class: 'badge plain' }, l.kind === 'file' ? 'ファイル' : 'ページ'),
      h('span', { class: 'grow', style: 'word-break:break-all' }, l.text || l.url),
      h('button', { class: 'btn sm', onclick: () => fetchFromUrl(l.url, work, hd) }, '取ってくる'),
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(l.url) }, '開く')))) : null,
    h('div', { class: 'row' }, inApp, h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ブラウザで開く')));
}

// ------------------------------------------------------------ URLから
export function viewUrlBox() {
  const input = h('input', { type: 'url', class: 'grow', id: 'url-in', placeholder: '作品のzipのURL、または配布ページのURL', value: S.urlState?.url || '' });
  const go = () => {
    const u = input.value.trim();
    if (!/^https?:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
    fetchFromUrl(u);
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go(); });
  const st = S.urlState;
  const hd = singleHandler(st?.work || null);
  let detail = null;
  if (st?.status === 'blocked') {
    detail = h('div', { class: 'note warn small' },
      `このサイトは、ブラウザから直接読み込めない設定になっています（他のサイトのファイルは、相手が許可していないとブラウザが読ませない仕組みです。${S.platform.kind === 'web' ? 'アプリ版なら取れます' : ''}）。ページを開いたので、そこでダウンロードしたファイルを上にドロップしてください。`,
      st.notice ? h('div', { style: 'margin-top:6px' }, st.notice) : null,
      h('div', { class: 'row', style: 'margin-top:6px' }, h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ページをもう一度開く')));
  } else if (st?.status === 'error') {
    detail = h('div', { class: 'note bad small' }, `読み込めませんでした：${st.message}`,
      h('div', { class: 'row', style: 'margin-top:6px' },
        S.platform.canInAppBrowse ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, hd) }, 'アプリ内で開いてダウンロード') : null,
        h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ブラウザで開く')));
  } else if (st?.status === 'page') {
    detail = pagePanel(st, hd, st.work);
  }
  return h('div', { class: 'card stack' },
    h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'URLから'), input, h('button', { class: 'btn', onclick: go }, '取ってくる')),
    st?.work ? h('div', { class: 'small muted' }, `カタログの「${st.work.name}」を取得中`) : null,
    detail);
}

// ------------------------------------------------------------ サイトからの「CWカタログで入れる」リンク
/**
 * 作者さんのサイトに置いたリンク（…/cw-catalog.html#install=<zipのURL>&name=<作品名>）から開かれたとき、
 * 取ってくる前に必ず確認する。勝手にダウンロード・インストールはしない。
 * 作品IDで頼むこともできる：#entry=e00012（そのIDの作品が載ったカタログを読み込んでいるとき）
 */
export async function handleInstallLink() {
  const params = new URLSearchParams((location.hash || '').slice(1) || location.search.slice(1));
  const url = (params.get('install') || '').trim();
  const entryId = (params.get('entry') || '').trim();
  if (!url && !entryId) return;
  // 読み込み直したときにもう一度聞かないよう、アドレスから消す（テスト用の印は残す）
  const keep = location.hash.includes('dev-opfs') ? '#dev-opfs' : '';
  try { history.replaceState(null, '', location.pathname + location.search.replace(/[?&](install|entry|name)=[^&]*/g, '') + keep); } catch { /* file:// などで使えなくても続ける */ }

  let work = null;
  if (entryId) {
    work = S.combined?.works.find((w) => w.refs.some((r) => r.entry.id === entryId && r.kind === 'shared')) || null;
    if (!work) { toast(`作品ID ${entryId} が共用カタログに見つかりませんでした。「カタログ」タブで共用カタログを読み込んでから、もう一度リンクを押してください`, { bad: true, ms: 10000 }); return; }
  }
  if (url && !/^https?:\/\//.test(url)) { toast('リンクのURLが正しくありません', { bad: true }); return; }
  const target = url || chooseDownloads(work, defaultUrlOf(work))[0]?.url;
  if (!target) { toast('この作品には、今DLできる配布元がありません', { bad: true }); return; }
  let host = '';
  try { host = new URL(target).hostname; } catch { /* 上で検査済み */ }
  const name = work?.name || (params.get('name') || '').slice(0, 100);

  const ok = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'このシナリオを取ってきますか？'),
    name ? h('div', { class: 'item-title' }, name) : null,
    work ? h('div', { class: 'meta' }, `${work.author}・ver ${work.version}・カタログの作品 ${entryId}`) : null,
    h('div', { class: 'note' }, h('div', { class: 'small muted' }, '取得先'), h('b', {}, host), h('div', { class: 'small', style: 'word-break:break-all' }, target)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'リンクを押したサイトから、取り込みを頼まれました。取ってきたあとに中身とりどみを表示するので、入れるかどうかはそこで決められます。知らないサイトからの場合は「やめる」を押してください。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, '取ってくる'))));
  if (!ok) return;
  goTab('add');
  if (work) return downloadWork(work);
  return fetchFromUrl(target);
}

/** 作者さん向け：サイトに貼る「CWカタログで入れる」リンクを作る */
export function viewLinkMaker() {
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
