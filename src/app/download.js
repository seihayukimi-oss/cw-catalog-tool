// 作品を取ってくる：URLから／配布ページから（同意・DLキー・アプリ内ブラウザ）／カタログの配布元から。
// 配布元が複数あるときは、デフォルトのDL先 → 現役 → 予備 → 旧 の順に試す。
//  ・Google ドライブ・OneDrive の共有リンクは、直接DLのURLに直して取る
//  ・BOOTH・note・Notion・Privatter+ などは、アプリ内ブラウザで本人が押す
//  ・同意やDLキーのページは、ツールの画面で同意してもらう（2段階のページにも対応）。サイトごとに「同意を覚える」こともできる

import { markLink } from './linkcheck.js';
import { r18On, r18Guide } from './ratings-view.js';
import { safetyNote } from './safety-view.js';
import { zipSync } from 'fflate';
import { openArchive, archiveKind, sha256Hex } from '../core/archive.js';
import { chooseDownloads } from '../core/catalogs.js';
import { decodeHtml, extractDownloadLinks, extractDownloadForms, extractDriveFolder, metaRefreshUrl, pageText, pageTitle, siteNotice, oneTimeNext } from '../core/weblink.js';
import { fetchUrlFor, inAppSite, expiresAt, driveId } from '../core/urls.js';
import { S, render, busy, busyText, busyProgress, goTab, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, modal, fmtDate } from './ui.js';
import { defaultUrlOf, setDefaultUrl, setCatPrefs } from './catalog-data.js';
import { openSource } from './add.js';

export const dlLabel = (d) => d.label || d.url.replace(/^https?:\/\//, '').split('/')[0];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const PAGES_URL = 'https://seihayukimi-oss.github.io/cw-catalog-tool/cw-catalog.html';

/**
 * URLを1回読んでみる。
 * @param {object} [ctx] dl＝カタログの配布元（DLキーを使う）
 * @returns {Promise<{kind:'zip', bytes, fileName} | {kind:'page', st} | {kind:'inapp', url, site, why} | {kind:'blocked', url} | {kind:'error', message} | {kind:'other'}>}
 */
export async function fetchOnce(url, opts, ctx = {}) {
  const ia = inAppSite(url);
  if (ia && !opts?.method) return { kind: 'inapp', url, ...ia };
  const ex = expiresAt(url);
  if (ex instanceof Date && ex < new Date()) return { kind: 'error', url, message: `期限切れのURLです（${fmtDate(ex)}まで）` };
  const f = fetchUrlFor(url);
  let r;
  try { r = await S.platform.fetchResource(f.url, ctx.onProgress ? { ...(opts || {}), onProgress: ctx.onProgress } : opts); } catch (e) {
    const dead = e?.status === 404 || e?.status === 410;
    if (dead && !opts?.method) await markLink(url, 'dead', e.status);
    return { kind: 'error', url, message: `${f.note ? `${f.note}：` : ''}${dead ? 'ファイルが見つかりませんでした（✖ リンク切れのようです）' : e.message || String(e)}` };
  }
  if (!opts?.method && S.linkCheck?.[url]?.state && S.linkCheck[url].state !== 'ok') await markLink(url, 'ok', 200);
  let res = classify(r, url);
  // ワンタイムURLのサイト（firestorage など）：クッションページ → ダウンロードページ → ファイル と、順にたどる
  for (let hop = 0; hop < 4 && res.kind === 'page'; hop++) {
    const next = oneTimeNext(res.st.html || '', r.finalUrl || url);
    if (!next) break;
    try { r = await S.platform.fetchResource(next, { headers: { Referer: r.finalUrl || url }, ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}) }); } catch (e) { return { kind: 'error', url, message: `ワンタイムURLのページをたどれませんでした：${e.message}` }; }
    res = classify(r, url);
  }
  // Google ドライブの「大きいのでウイルススキャンできません。それでもダウンロードしますか？」は、作者さんの規約ではないので、そのまま進む
  if (res.kind === 'page' && /(^|\.)drive\.usercontent\.google\.com$/.test(hostOf(r.finalUrl)) && res.st.forms.length) {
    const r2 = await submitForm(res.st.forms[0], {}, r.finalUrl).catch(() => null);
    const c2 = r2 && classify(r2, url);
    if (c2?.kind === 'zip') return c2;
  }
  if (res.kind === 'page') {
    res.st.dl = ctx.dl || null;
    // Google ドライブのフォルダは、中のファイルを並べる
    if (driveId(url)?.kind === 'folder') {
      res.st.links = extractDriveFolder(res.st.html || '');
      res.st.forms = [];
      res.st.title = res.st.title || 'Google ドライブのフォルダ';
      res.st.folder = true;
    }
    delete res.st.html;
  }
  return res;
}

const ARCHIVE_EXT = { zip: 'zip', cab: 'cab', lzh: 'lzh', '7z': '7z', rar: 'rar' };

function classify(r, url) {
  if (r.blocked) return { kind: 'blocked', url };
  const ak = archiveKind(r.bytes);
  if (ak) {
    const name = r.fileName && /\.(zip|wsn|cab|lzh|lha|7z|rar)$/i.test(r.fileName) ? r.fileName : `${r.fileName || 'download'}.${ARCHIVE_EXT[ak]}`;
    return { kind: 'zip', bytes: r.bytes, fileName: name, url: r.finalUrl || url };
  }
  const head = new TextDecoder('latin1').decode(r.bytes.subarray(0, 512)).trimStart();
  if (/html/i.test(r.contentType) || head.startsWith('<')) {
    const html = decodeHtml(r.bytes, r.contentType);
    return {
      kind: 'page',
      st: {
        url, finalUrl: r.finalUrl, title: pageTitle(html), html,
        links: extractDownloadLinks(html, r.finalUrl), forms: extractDownloadForms(html, r.finalUrl),
        text: pageText(html, 3000), notice: siteNotice(r.finalUrl),
      },
    };
  }
  return { kind: 'other', url, bytes: r.bytes, fileName: r.fileName || '' };
}

/**
 * 結果の受け取り方（ひとつずつDLするときと、まとめてDLするときで変える）
 * @typedef {{got: Function, page: Function, blocked: Function, error: Function, inapp?: Function}} Handler
 */

/** ひとつずつDLするときの受け取り方：「シナリオ・素材・スキンをDLする」タブに出す */
export function singleHandler(work = null) {
  return {
    got: (bytes, fileName, url) => { S.urlState = null; S.lastUrl = url || S.lastUrl; return openSource(async () => openArchive(bytes, fileName), work); },
    page: (st) => { S.urlState = { ...st, status: 'page', work }; S.tab = 'add'; render(); },
    blocked: async (url) => { S.urlState = { url, status: 'blocked', notice: siteNotice(url), work }; S.tab = 'add'; render(); await S.platform.openUrl(url); },
    error: (url, message) => { S.urlState = { url, status: 'error', message, work }; S.tab = 'add'; render(); },
    inapp: async (res) => {
      S.lastUrl = res.url;
      S.urlState = { url: res.url, status: 'inapp', site: res.site, why: res.why, work };
      S.tab = 'add';
      render();
      if (S.platform.canInAppBrowse) return inAppDownload(res.url, singleHandler(work), res.why);
      await S.platform.openUrl(res.url);
    },
  };
}

export async function deliver(res, hd) {
  switch (res.kind) {
    case 'zip': return hd.got(res.bytes, res.fileName, res.url);
    case 'page':
      if (await tryAutoAgree(res.st, hd)) return null;
      return hd.page(res.st);
    case 'inapp': return hd.inapp ? hd.inapp(res) : inAppDownload(res.url, hd, res.why);
    case 'blocked': return hd.blocked(res.url);
    case 'error': return hd.error(res.url, res.message);
    default: toast('zip・wsn などのファイルでも、ページでもないようです', { bad: true }); return null;
  }
}

/** URLから取ってくる（「URLから」の欄・リンクの「取ってくる」） */
export async function fetchFromUrl(url, work = null, hd = singleHandler(work), ctx = {}) {
  const res = await busy('読み込み中', () => fetchOnce(url, undefined, ctx));
  if (!res) return;
  if (res.kind === 'zip' || res.kind === 'page') S.lastUrl = url;
  return deliver(res, hd);
}

/**
 * カタログの作品を、使える配布元から順に試して取ってくる。
 * 使えない（読み込めない・期限切れ）配布元は飛ばして次へ。ブラウザの制限で読めないのは「使えない」ではないので、そこで止める。
 * @returns {{res, used, failed: {d, message}[], first}}
 */
export async function tryDownloads(work, { onTry, onProgress } = {}) {
  const list = chooseDownloads(work, defaultUrlOf(work));
  if (!list.length) return { res: { kind: 'none' }, used: null, failed: [], first: null };
  const failed = [];
  for (const d of list) {
    onTry?.(d);
    const res = await fetchOnce(d.url, undefined, { dl: d, onProgress });
    if (res.kind === 'error' || res.kind === 'other') { failed.push({ d, message: res.message || 'zip・wsnではありませんでした' }); continue; }
    return { res, used: d, failed, first: list[0] };
  }
  const last = failed[failed.length - 1];
  return { res: { kind: 'error', url: last.d.url, message: failed.map((f) => `${dlLabel(f.d)}：${f.message}`).join(' ／ ') }, used: null, failed, first: list[0] };
}

/** 作品の「ダウンロード」ボタン：デフォルトのDL先から。だめなら別の配布元から取って、デフォルトを変えるか聞く */
/**
 * R18 の作品は、アプリの中ではダウンロードせず、配布元をお使いのブラウザで開く（配布元の年齢確認・ログインをそのまま通る）。
 * 設定でR18がOFFなら、案内だけ出す。R18 でなければ false（ふつうに取る）
 */
export async function r18External(work, d = null) {
  if (work?.rating !== 'r18') return false;
  if (!r18On()) { await r18Guide(work.name); return true; }
  const target = d || chooseDownloads(work, defaultUrlOf(work))[0];
  if (!target) { toast('この作品には、今開ける配布元がありません', { bad: true }); return true; }
  toast('R18作品のため、お使いのブラウザで配布元ページを開きます。ダウンロードしたファイルは「シナリオ・素材・スキンをDLする」タブの「『ダウンロード』から選ぶ」で追加してください', { ms: 12000 });
  await S.platform.openUrl(target.url);
  return true;
}

export async function downloadWork(work) {
  if (await r18External(work)) return;
  const out = await busy(`「${work.name}」を取得中`, () => tryDownloads(work));
  if (!out) return;
  if (out.res.kind === 'none') { toast('この作品には、今DLできる配布元がありません', { bad: true }); return; }
  if (out.used && out.failed.length) await askSwitchDefault(work, out.first, out.used, out.failed[0].message);
  if (out.res.kind === 'zip' || out.res.kind === 'page') S.lastUrl = out.used.url;
  return deliver(out.res, singleHandler(work));
}

/** 指定した配布元だけから取る */
export async function downloadFrom(work, d) {
  if (await r18External(work, d)) return;
  return fetchFromUrl(d.url, work, singleHandler(work), { dl: d });
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

// ------------------------------------------------------------ 同意を覚える
export async function loadConsents() {
  S.consents = (await store.get('consents')) || {};
}

/** 規約や注意書きの文章の「指紋」。ダウンロード数などの変わる数字は入れない */
async function consentHash(st) {
  const lines = (st.text || '').split('\n')
    .filter((l) => /規約|同意|禁止|注意|責任|ダウンロードした時点|みなします|terms|agree/i.test(l))
    .map((l) => l.normalize('NFKC').replace(/\s+/g, '').replace(/\d+/g, '#'));
  const base = lines.length ? lines.join('\n') : `${st.forms?.[0]?.label || ''}|${new URL(st.forms?.[0]?.action || st.url).pathname.replace(/\d+/g, '#')}`;
  return sha256Hex(new TextEncoder().encode(base));
}

async function rememberConsent(st) {
  const host = hostOf(st.finalUrl || st.url);
  const hash = await consentHash(st);
  const rec = S.consents[host] || { hashes: [], at: '' };
  if (!rec.hashes.includes(hash)) rec.hashes = [...rec.hashes, hash].slice(-10);
  rec.at = new Date().toISOString();
  S.consents[host] = rec;
  await store.set('consents', S.consents);
}

/** 入力欄に入れる値。DLキーが分からない欄があれば null（本人に入れてもらう） */
function fillValues(form, st) {
  const v = {};
  const key = st.dl?.dlkey || '';
  for (const i of form.inputs) {
    if (st.values?.[i.name]) v[i.name] = st.values[i.name];
    else if (key && (form.inputs.length === 1 || i.type === 'password')) v[i.name] = key;
    else return null;
  }
  return v;
}

/** 同意を覚えているサイトで、規約の文章が前と同じなら、そのまま同意して取る */
export async function tryAutoAgree(st, hd) {
  if (!st.forms?.length || st.noAuto) return false;
  const rec = S.consents?.[hostOf(st.finalUrl || st.url)];
  if (!rec) return false;
  const hash = await consentHash(st);
  if (!rec.hashes.includes(hash)) { st.consentChanged = true; return false; }
  const values = fillValues(st.forms[0], st);
  if (!values) return false;
  st.auto = true;
  await agreeAndDownload(st, st.forms[0], values, hd);
  return true;
}

// ------------------------------------------------------------ 同意してダウンロード（A）・アプリ内ブラウザ（B）
/** ページのフォームを送る（GETならアドレスに付けて、POSTなら本文で） */
function submitForm(form, values, referer) {
  const body = new URLSearchParams([...form.fields, ...Object.entries(values)]);
  if (form.method === 'POST') {
    return S.platform.fetchResource(form.action, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: referer } });
  }
  const u = new URL(form.action);
  for (const [k, v] of body) u.searchParams.set(k, v);
  return S.platform.fetchResource(u.href, { headers: { Referer: referer } });
}

/**
 * A：ページのダウンロードフォームを、本人が同意したあとに送信して、zipまで取ってくる。
 * 送信後のページに本物のファイルへのリンクや自動移動があれば、それも1〜2回たどる。
 * 送信後に、また同意（またはDLキー）のページが出たら、続けて同意画面を出す（DLキー → 同意 → ファイル の2段階など）。
 */
export async function agreeAndDownload(st, form, values, hd) {
  if (st.remember) await rememberConsent(st);
  const res = await busy(st.auto ? '同意を覚えているサイトなので、そのまま取得中' : '同意して取得中', async () => {
    let r = await submitForm(form, values, st.finalUrl || st.url);
    for (let hop = 0; hop < 2 && r && !r.blocked && !archiveKind(r.bytes); hop++) {
      const html = decodeHtml(r.bytes, r.contentType);
      if (extractDownloadForms(html, r.finalUrl).length) break; // 次の同意画面
      const next = extractDownloadLinks(html, r.finalUrl).find((l) => l.kind === 'file')?.url || metaRefreshUrl(html, r.finalUrl);
      if (!next) break;
      r = await S.platform.fetchResource(next, { headers: { Referer: r.finalUrl } });
    }
    return r;
  });
  if (!res) return;
  if (res.blocked) return hd.blocked(st.url);
  const c = classify(res, st.url);
  if (c.kind === 'zip') return deliver(c, hd);
  if (c.kind === 'page' && c.st.forms.length && (st.step || 1) < 4) {
    const next = { ...c.st, dl: st.dl, step: (st.step || 1) + 1, url: st.url, remember: !!st.remember, agreed: false, values: {} };
    delete next.html;
    next.stepNote = form.kind === 'key' ? 'DLキーが通りました。続けて、次の画面の内容に同意してください。' : '続けて、次の画面の内容に同意してください。';
    if (await tryAutoAgree(next, hd)) return;
    return hd.page(next);
  }
  if (st.auto) {
    // 覚えていた同意で取れなかったら、本人に見てもらう
    st.auto = false;
    st.noAuto = true;
    toast('覚えていた同意では取れなかったので、ページの内容を表示します', { ms: 6000 });
    return hd.page(st);
  }
  toast(form.kind === 'key' ? 'ファイルが見つかりませんでした。DLキーが違うのかもしれません。もう一度確かめてください' : '同意のあとにファイルが見つかりませんでした。ページの作りが変わったのかもしれません。ページを開いて確かめてください', { bad: true, ms: 9000 });
}

/** B：アプリ内ブラウザで配布ページを開き、本人がサイトのボタンを押して落ちてきたファイルを受け取る */
export async function inAppDownload(url, hd, why = '') {
  if (!S.platform.canInAppBrowse) { await S.platform.openUrl(url); return; }
  toast(`${why ? `${why}。` : ''}配布ページを別の窓（アプリ内ブラウザ）で開きました。サイトのダウンロードボタンを押すと、ここに取り込みます。ログイン状態はこのPCに残すだけで、入力した内容やログイン情報をCWカタログが読み取ることはありません`, { ms: 12000 });
  const got = await busy('アプリ内ブラウザで待っています', () => S.platform.openInAppBrowser(url));
  if (!got) return;
  if (got.directUrl) {
    // Google ドライブのダウンロードは、アプリ内ブラウザでは受け取らずに、ここから直接取る
    toast('Google ドライブのファイルなので、アプリから直接取ってきます');
    return fetchFromUrl(got.directUrl, null, hd);
  }
  if (!archiveKind(got.bytes)) { toast(`${got.fileName} はzip・wsn などのファイルではないようです`, { bad: true }); return; }
  return hd.got(got.bytes, got.fileName || 'download.zip', url);
}

/** 同意画面：ページの文章（規約など）を見せて、本人が同意したら送信する */
export function viewAgree(st, hd) {
  const form = st.forms[0];
  const isKey = form.kind === 'key';
  // 画面を描き直しても、入れたDLキーや同意のチェックが消えないよう、ページの情報に覚えておく
  st.values ||= {};
  let prefilled = false;
  if (st.dl?.dlkey) {
    for (const i of form.inputs) {
      if (!st.values[i.name] && (form.inputs.length === 1 || i.type === 'password')) { st.values[i.name] = st.dl.dlkey; prefilled = true; }
    }
  }
  const keyInputs = form.inputs.map((i) => h('label', { class: 'field' }, i.label === i.name ? (isKey ? 'DLキー' : `入力欄（${i.name}）`) : i.label,
    h('input', { type: i.type, 'data-name': i.name, autocomplete: 'off', value: st.values[i.name] || '', oninput: (ev) => { st.values[i.name] = ev.target.value; } })));
  const check = h('input', { type: 'checkbox', checked: !!st.agreed });
  const remember = h('input', { type: 'checkbox', checked: !!st.remember, onchange: (ev) => { st.remember = ev.target.checked; } });
  const btn = h('button', { class: 'btn primary sm', disabled: !st.agreed }, isKey ? `同意して${form.label || '認証'}` : `同意して${form.label || 'ダウンロード'}`);
  check.addEventListener('change', () => { st.agreed = check.checked; btn.disabled = !check.checked; });
  btn.addEventListener('click', () => {
    const values = {};
    for (const l of keyInputs) { const inp = l.querySelector('input'); values[inp.dataset.name] = inp.value; }
    agreeAndDownload(st, form, values, hd);
  });
  return h('div', { class: 'card soft stack', style: 'margin:0' },
    st.stepNote ? h('div', { class: 'note ok' }, st.stepNote) : null,
    st.consentChanged ? h('div', { class: 'note warn' }, '前に「同意を覚える」にしたときと、規約・注意書きの文章が変わっています。読み直してください。') : null,
    h('div', {}, h('b', {}, isKey ? 'このページは、DLキー（パスワード）を入れてからダウンロードする形式です' : 'このページは、内容に同意してからダウンロードする形式です')),
    h('pre', { class: 'readme', style: 'max-height:220px' }, st.text || '（本文を読み取れませんでした。「ブラウザで開く」で確かめてください）'),
    keyInputs,
    prefilled ? h('div', { class: 'small muted' }, '個人用カタログに登録したDLキーを入れてあります') : null,
    h('label', { class: 'check' }, check, 'ページの内容・規約を読んで、同意します'),
    h('label', { class: 'check small' }, remember, `このサイト（${hostOf(st.finalUrl || st.url)}）の同意を覚える（規約の文章が変わったら、もう一度聞きます）`),
    h('div', { class: 'row' }, btn,
      S.platform.kind === 'web' ? h('span', { class: 'small muted' }, '※ HTML版では、多くのサイトでブラウザの制限により送信できません（アプリ版なら取れます）') : null));
}

/** フォルダの中を移動する（Google ドライブのフォルダ）。戻る・進むができるように、たどった順を覚えておく */
async function openSubFolder(st, link) {
  const res = await busy('フォルダを開いています', () => fetchOnce(link.url));
  if (!res) return;
  if (res.kind !== 'page' || !res.st.folder) { toast('フォルダを開けませんでした', { bad: true }); return; }
  const nav = st.nav || (st.nav = { list: [{ url: st.url, title: st.title, links: st.links }], at: 0 });
  nav.list = nav.list.slice(0, nav.at + 1);
  nav.list.push({ url: link.url, title: res.st.title && res.st.title !== 'Google ドライブのフォルダ' ? res.st.title : link.text, links: res.st.links });
  goNav(st, nav.list.length - 1);
}
function goNav(st, i) {
  const n = st.nav;
  if (!n || i < 0 || i >= n.list.length) return;
  n.at = i;
  Object.assign(st, { url: n.list[i].url, title: n.list[i].title, links: n.list[i].links });
  st.pick = new Set();
  render();
}

/** 同時に何件かずつ処理する（Google ドライブなどで、たくさんのファイルを速く取るため） */
export async function eachParallel(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; await fn(list[k], k); }
  }));
}
const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 80) || '無題';

/** Google ドライブのフォルダの中を、下のフォルダまでたどってファイルを並べる（path＝フォルダの中での場所） */
async function listFolderTree(st, onStep) {
  const out = [];
  const seen = new Set();
  const walk = async (links, prefix, depth) => {
    for (const l of links) {
      if (l.type === 'folder') {
        if (depth >= 6 || seen.has(l.url) || out.length > 3000) continue;
        seen.add(l.url);
        onStep?.(`${prefix}${l.text}`);
        const res = await fetchOnce(l.url);
        if (res.kind === 'page' && res.st.folder) await walk(res.st.links, `${prefix}${safeName(l.text)}/`, depth + 1);
      } else out.push({ ...l, path: `${prefix}${safeName(l.text)}` });
    }
  };
  await walk(st.links, '', 0);
  return out;
}

/**
 * 選んだファイルをまとめて取ってくる（同時に6件ずつ）。
 * zipなどはそのまま「まとめてDL」の一覧へ。そうでないファイル（画像・音など）は、フォルダの形のまま1つのzipにまとめて素材（スキン）として入れる
 * @param {{url, text, path?}[]} links
 */
async function fetchPicked(st, hd, links, { title = '' } = {}) {
  if (links.length === 1 && !title) return fetchFromUrl(links[0].url, null, hd, { dl: st.dl });
  S.progressByCount = true;
  let got;
  try {
    got = await busy(`${links.length}件を取ってきています`, async () => {
      const archives = [], loose = [], failed = [];
      let done = 0;
      busyProgress(0, `${links.length}件を取ってきています… 0 / ${links.length}`);
      await eachParallel(links, 6, async (l) => {
        const res = await fetchOnce(l.url, undefined, { dl: st.dl }).catch((e) => ({ kind: 'error', message: e.message }));
        if (res.kind === 'zip') archives.push({ name: res.fileName, bytes: res.bytes, path: l.path, url: l.url });
        else if (res.kind === 'other' && res.bytes?.length) loose.push({ name: res.fileName || l.text, bytes: res.bytes, path: l.path });
        else failed.push(l.path || l.text || l.url);
        done++;
        busyProgress(done / links.length, `${links.length}件を取ってきています… ${done} / ${links.length}（${Math.floor((done / links.length) * 100)}%）`);
      });
      return { archives, loose, failed };
    });
  } finally {
    S.progressByCount = false;
  }
  if (!got) return;
  const files = [...got.archives];
  if (got.loose.length) {
    const base = safeName(title || st.title || '素材');
    const tree = {};
    for (const f of got.loose) {
      // フォルダごとに取ったときは、中の場所のまま。ファイルを選んだときは、名前だけ
      const rel = f.path ? f.path.split('/').slice(0, -1).concat(safeName(f.name)).join('/') : safeName(f.name);
      tree[`${base}/${rel}`] = f.bytes;
    }
    files.push({ name: `${base}.zip`, bytes: zipSync(tree, { level: 0 }) });
  }
  if (got.failed.length) toast(`取れなかったもの ${got.failed.length}件：${got.failed.slice(0, 3).join('、')}${got.failed.length > 3 ? ' …' : ''}`, { bad: true, ms: 9000 });
  if (!files.length) return;
  const { startLocalBatch } = await import('./batch.js');
  await startLocalBatch(files, title ? `「${title}」をまるごと入れる` : `選んだ${links.length}件を入れる`, { pageUrl: st.folder ? '' : st.url });
  if (got.loose.length) toast(`zipなどではないファイル ${got.loose.length}件は、フォルダの形のまま1つにまとめました（素材・スキンとして入れられます）`, { ms: 9000 });
}

/** フォルダをまるごと（下のフォルダも）取ってくる */
async function fetchWholeFolder(st, hd) {
  const list = await busy('フォルダの中を調べています', () => listFolderTree(st, (p) => busyText(`フォルダの中を調べています… ${p}`)));
  if (!list) return;
  if (!list.length) { toast('このフォルダには、取ってこられるファイルがありませんでした', { bad: true }); return; }
  const ok = await confirmBox(`「${st.title}」の中のファイル ${list.length}件を、フォルダの形のまま取ってきます。よろしいですか？`, { yes: '取ってくる', no: 'やめる' });
  if (!ok) return;
  return fetchPicked(st, hd, list, { title: st.title || 'フォルダ' });
}

/** 配布ページを読んだ結果（同意フォーム・リンク一覧・アプリ内ブラウザ） */
export function pagePanel(st, hd, work = null) {
  const inApp = S.platform.canInAppBrowse
    ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, hd) }, 'アプリ内で開いてダウンロード')
    : null;
  st.pick ||= new Set();
  const pickable = (l) => (st.folder ? l.type !== 'folder' : l.kind === 'file');
  const files = st.links.filter(pickable);
  const nav = st.nav;
  const selBar = () => {
    const chosen = files.filter((l) => st.pick.has(l.url));
    return h('div', { class: 'row pick-bar', id: 'pick-bar' },
      h('span', {}, `選んだもの：${chosen.length}件`),
      h('button', { class: 'btn sm', disabled: st.pick.size === files.length, onclick: () => { files.forEach((l) => st.pick.add(l.url)); render(); } }, 'ファイルをすべて選ぶ'),
      chosen.length ? h('button', { class: 'btn ghost sm', onclick: () => { st.pick.clear(); render(); } }, '選択を解除') : null,
      h('button', { class: 'btn primary sm', disabled: !chosen.length, onclick: () => fetchPicked(st, hd, chosen) }, `選んだ${chosen.length}件を取ってくる`),
      h('button', { class: 'btn sm', disabled: !chosen.length, title: '作品名・バージョンを読んで、個人用カタログにまとめて登録します（インストールはしません）', onclick: async () => (await import('./bulk-register.js')).bulkFromLinks(st, chosen) }, `選んだ${chosen.length}件を個人用カタログに登録`));
  };
  const navBar = st.folder && nav && nav.list.length > 1 ? h('div', { class: 'row folder-nav' },
    h('button', { class: 'btn sm', disabled: nav.at === 0, 'aria-label': '前のフォルダに戻る', onclick: () => goNav(st, nav.at - 1) }, '← 戻る'),
    h('button', { class: 'btn sm', disabled: nav.at >= nav.list.length - 1, 'aria-label': '次のフォルダに進む', onclick: () => goNav(st, nav.at + 1) }, '進む →'),
    nav.at > 0 ? h('button', { class: 'btn ghost sm', onclick: () => goNav(st, 0) }, '↑ 最初のフォルダ') : null,
    h('span', { class: 'small muted crumbs' }, nav.list.slice(0, nav.at + 1).map((x, i) => [i ? ' ／ ' : '', i < nav.at ? h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); goNav(st, i); } }, `📁 ${x.title}`) : h('b', {}, `📁 ${x.title}`)]))) : null;
  const row = (l) => {
    const isFolder = st.folder && l.type === 'folder';
    const canPick = pickable(l);
    return h('li', { class: isFolder ? 'is-folder' : canPick ? 'is-file' : null },
      canPick ? h('input', { type: 'checkbox', checked: st.pick.has(l.url), 'aria-label': `${l.text || l.url}を選ぶ`, onchange: (ev) => { if (ev.target.checked) st.pick.add(l.url); else st.pick.delete(l.url); document.getElementById('pick-bar')?.replaceWith(selBar()); } }) : null,
      h('span', { class: 'kind-icon', 'aria-hidden': 'true' }, isFolder ? '📁' : canPick ? '📄' : '🔗'),
      h('span', { class: `badge ${isFolder ? 'folder' : l.kind === 'file' ? 'ok' : 'plain'}` }, isFolder ? 'フォルダ' : l.kind === 'file' ? 'ファイル（zipなど）' : st.folder ? 'ファイル' : 'ページ'),
      h('span', { class: 'grow', style: 'word-break:break-all' }, l.text || l.url),
      isFolder
        ? h('button', { class: 'btn sm', onclick: () => openSubFolder(st, l) }, 'フォルダを開く ▶')
        : h('button', { class: 'btn sm', onclick: () => fetchFromUrl(l.url, work, hd, { dl: st.dl }) }, '取ってくる'),
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(l.url) }, '開く'));
  };
  return h('div', { class: 'stack small' },
    h('div', {}, h('b', {}, st.folder ? `📁 ${st.title || st.url}` : st.title || st.url)),
    st.notice ? h('div', { class: 'note warn' }, st.notice) : null,
    st.forms?.length ? viewAgree(st, hd) : null,
    navBar,
    st.folder && st.links.length ? h('div', { class: 'row' },
      h('button', { class: 'btn primary sm', onclick: () => fetchWholeFolder(st, hd) }, `📁 このフォルダをまるごと取ってくる（下のフォルダも）`),
      h('span', { class: 'small muted' }, 'フォルダの形のまま取ってきます。画像・音などは1つにまとめて、素材・スキンとして入れられます')) : null,
    st.links.length ? h('div', {}, st.folder ? `フォルダの中に ${st.links.length}件 ありました（フォルダ ${st.links.filter((l) => l.type === 'folder').length}・ファイル ${files.length}）` : `ダウンロードらしいリンクが ${st.links.length}件 ありました`) : (!st.forms?.length ? h('div', {}, st.folder ? 'フォルダの中身を読み取れませんでした（空のフォルダか、共有の設定が「リンクを知っている全員」になっていないのかもしれません）' : 'ダウンロードのリンクは見つかりませんでした') : null),
    st.links.length ? h('ul', { class: 'dl link-list' }, st.links.map(row)) : null,
    files.length > 1 ? selBar() : null,
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
  } else if (st?.status === 'inapp') {
    detail = h('div', { class: 'note warn small' },
      `${st.why}。`,
      S.platform.canInAppBrowse ? 'アプリ内ブラウザで開くので、サイトのダウンロードボタンを押してください（ログインが要るサイトは、初回だけログインしてください）。アプリ内ブラウザではページのスクリプトが動きますが、アプリの機能（ファイル操作など）には触れられない設定です。ログインで先に進めないときは、お使いのブラウザでダウンロードして、上の「『ダウンロード』から選ぶ」で追加してください。' : 'ページを開いたので、そこでダウンロードしたファイルを上にドロップしてください。',
      h('div', { class: 'row', style: 'margin-top:6px' },
        S.platform.canInAppBrowse ? h('button', { class: 'btn sm', onclick: () => inAppDownload(st.url, hd) }, 'アプリ内でもう一度開く') : null,
        h('button', { class: 'btn sm', onclick: () => S.platform.openUrl(st.url) }, 'ブラウザで開く')));
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
    safetyNote({ url: st?.url || '', id: 'safety-note' }),
    detail);
}

// ------------------------------------------------------------ サイトからの「CWカタログで入れる」リンク
/**
 * 作者さんのサイトに置いたリンク（…/cw-catalog.html#install=<zipのURL>&name=<作品名>）から開かれたとき。
 * アプリ版では cwcatalog://install?url=…&name=… から。取ってくる前に必ず確認する。勝手にダウンロード・インストールはしない。
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
  return askInstallLink({ url, entryId, name: (params.get('name') || '').slice(0, 100) });
}

export async function askInstallLink({ url, entryId, name }) {
  let work = null;
  if (entryId) {
    work = S.combined?.works.find((w) => w.refs.some((r) => r.entry.id === entryId && r.kind === 'shared')) || null;
    if (!work) { toast(`作品ID ${entryId} が共用カタログに見つかりませんでした。「カタログ」タブで共用カタログを読み込んでから、もう一度リンクを押してください`, { bad: true, ms: 10000 }); return; }
  }
  // R18 の作品へのリンク：OFFなら案内、ONなら配布元をブラウザで開く
  const named = !work && name ? S.combined?.works.find((w) => w.name === name && w.rating === 'r18') : null;
  if ((work || named)?.rating === 'r18') { await r18External(work || named, url ? { url } : null); return; }
  if (url && !/^https?:\/\/\S+$/.test(url)) { toast('リンクのURLが正しくありません', { bad: true }); return; }
  if (url.length > 2000) { toast('リンクのURLが長すぎます', { bad: true }); return; }
  const target = url || chooseDownloads(work, defaultUrlOf(work))[0]?.url;
  if (!target) { toast('この作品には、今DLできる配布元がありません', { bad: true }); return; }
  const host = hostOf(target);
  name = work?.name || name;
  const appLink = `cwcatalog://install?url=${encodeURIComponent(target)}${name ? `&name=${encodeURIComponent(name)}` : ''}`;

  const ok = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, 'このシナリオを取ってきますか？'),
    name ? h('div', { class: 'item-title' }, name) : null,
    work ? h('div', { class: 'meta' }, `${work.author}・ver ${work.version}・カタログの作品 ${entryId}`) : null,
    h('div', { class: 'note' }, h('div', { class: 'small muted' }, '取得先'), h('b', {}, host), h('div', { class: 'small', style: 'word-break:break-all' }, target)),
    h('p', { class: 'small muted', style: 'margin:0' }, 'リンクを押したサイトから、取り込みを頼まれました。取ってきたあとに中身とReadmeを表示するので、入れるかどうかはそこで決められます。知らないサイトからの場合は「やめる」を押してください。'),
    S.platform.kind === 'web' && !entryId ? h('p', { class: 'small muted', style: 'margin:0' }, 'アプリ版（ポータブル版）を持っていて「Windows設定との連携」を登録していれば、「アプリで開く」でアプリから取れます（同意ページなども取れます）。') : null,
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
      S.platform.kind === 'web' && !entryId ? h('button', { class: 'btn', onclick: () => { location.href = appLink; close(false); } }, 'アプリで開く') : null,
      h('button', { class: 'btn primary', onclick: () => close(true) }, '取ってくる'))));
  if (!ok) return;
  goTab('add');
  if (work) return downloadWork(work);
  return fetchFromUrl(target);
}

/** 作者さん向け：作品ページに置く「CWカタログで入れる」リンク（ボタン）を作る */
export function viewLinkMaker() {
  const base = /^https:/.test(location.protocol) && /github\.io$/.test(location.hostname) ? location.origin + location.pathname : PAGES_URL;
  const urlIn = h('input', { type: 'url', class: 'grow', placeholder: '作品のzipのURL（または配布ページのURL）', 'aria-label': '作品のURL' });
  const nameIn = h('input', { type: 'text', placeholder: '作品名（確認画面に出ます）', 'aria-label': '作品名' });
  const linkOut = h('input', { type: 'text', readonly: true, class: 'grow mono', 'aria-label': 'Xなどに貼るURL', placeholder: '（上にURLを入れると、ここにできます）' });
  const htmlOut = h('textarea', { rows: 2, readonly: true, class: 'mono', 'aria-label': 'ホームページに貼るHTML', placeholder: '（上にURLを入れると、ここにできます）' });
  const tryBtn = h('button', { class: 'btn sm', disabled: true }, '試しに押してみる');
  const make = () => {
    const u = urlIn.value.trim();
    const ok = /^https?:\/\/\S+$/.test(u);
    tryBtn.disabled = !ok;
    if (!ok) { linkOut.value = ''; htmlOut.value = ''; return; }
    const link = `${base}#install=${encodeURIComponent(u)}${nameIn.value.trim() ? `&name=${encodeURIComponent(nameIn.value.trim())}` : ''}`;
    const esc = (x) => x.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    linkOut.value = link;
    htmlOut.value = `<a href="${esc(link)}" target="_blank" rel="noopener">CWカタログで入れる</a>`;
  };
  urlIn.addEventListener('input', make);
  nameIn.addEventListener('input', make);
  tryBtn.addEventListener('click', () => askInstallLink({ url: urlIn.value.trim(), entryId: '', name: nameIn.value.trim().slice(0, 100) }));
  const copy = (el, what) => h('button', {
    class: 'btn sm', onclick: async () => {
      if (!el.value) return;
      try { await navigator.clipboard.writeText(el.value); } catch { el.select(); document.execCommand?.('copy'); }
      toast(`${what}をコピーしました`);
    },
  }, 'コピー');
  // 個人用カタログ・共用カタログの作品から選ぶ
  const works = (S.combined?.works || []).filter((w) => w.downloads.some((d) => d.status !== 'closed'));
  const pick = works.length ? h('select', {
    'aria-label': 'カタログの作品から選ぶ',
    onchange: (ev) => {
      const w = works[Number(ev.target.value)];
      if (!w) return;
      const d = chooseDownloads(w, defaultUrlOf(w))[0];
      urlIn.value = d?.url || '';
      nameIn.value = w.name;
      make();
    },
  }, h('option', { value: '' }, 'カタログの作品から選ぶ（任意）'), works.map((w, i) => h('option', { value: i }, `${w.name}（${w.author}）`))) : null;

  return h('div', { class: 'card stack link-maker' },
    h('p', { style: 'margin:0' }, '作者さんのサイトやWikiの作品ページに、「CWカタログで入れる」ボタンを置けます。遊ぶ人がそれを押すと、ダウンロード・展開・フォルダ探しをしなくても、CWカタログが作品を取り込みます。'),
    h('pre', { class: 'readme', style: 'max-height:none' }, '作品ページ\n  宵に降る光 ver1.02\n  [ダウンロード]  [CWカタログで入れる] ← これを作ります\n\n押すと → CWカタログが開く →「このシナリオを取ってきますか？」→ Readmeを見て → インストール'),
    h('div', { class: 'small muted' }, '① 作品のURLと作品名を入れる'),
    pick,
    h('div', { class: 'row' }, urlIn, nameIn),
    h('div', { class: 'small muted' }, '② できたものをコピーして、自分のサイトに貼る'),
    h('label', { class: 'field' }, 'X・Misskey・掲示板などに貼るURL', h('div', { class: 'row' }, linkOut, copy(linkOut, 'URL'))),
    h('label', { class: 'field' }, 'ホームページ（HTML）に貼るボタン', h('div', { class: 'row' }, htmlOut, copy(htmlOut, 'HTML'))),
    h('div', { class: 'row' }, tryBtn, h('span', { class: 'small muted' }, '遊ぶ人から見た確認画面を、ここで見られます（「やめる」を押せば何もしません）')),
    h('p', { class: 'small muted', style: 'margin:0' }, '※ リンクを押すと、まずHTML版が開きます。アプリ版（ポータブル版）を持っていて「Windows設定との連携」を登録している人は、確認画面の「アプリで開く」からアプリで取れます。HTML版だけで直接取ってこられるのは、読み込みを許可しているサイト（GitHub Pages など）に置いたファイルだけです。'));
}

// ------------------------------------------------------------ 設定：同意を覚えているサイト
export function viewConsents() {
  const hosts = Object.entries(S.consents || {}).sort((a, b) => (b[1].at || '').localeCompare(a[1].at || ''));
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, '同意画面で「このサイトの同意を覚える」にしたサイトです。規約・注意書きの文章が前と同じなら、まとめてDLのときも止まらずに取ってきます（文章が変わったら、もう一度聞きます）。Readmeの確認は、今までどおり必ず出ます。'),
    hosts.length ? h('ul', { class: 'dl' }, hosts.map(([host, rec]) => h('li', {},
      h('b', {}, host), h('span', { class: 'small muted grow' }, rec.at ? `覚えた日時：${fmtDate(rec.at)}` : ''),
      h('button', {
        class: 'btn ghost sm danger', onclick: async () => {
          if (!(await confirmBox(`「${host}」の同意を忘れます。次からは、また同意画面が出ます。よろしいですか？`))) return;
          delete S.consents[host];
          await store.set('consents', S.consents);
          render();
        },
      }, '取り消す')))) : h('p', { class: 'small muted', style: 'margin:0' }, 'まだありません。'));
}
