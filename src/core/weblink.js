// URLから作品を取ってくるときの手助け：
//  ・HTMLの文字コード判定（Shift_JIS・EUC-JPの個人サイトも多いため）
//  ・ページの中から「ダウンロードのリンク」を探す
//  ・ファイル名の取り出し

const ARCHIVE_EXT = /\.(zip|wsn|cab|lzh|lha|7z|rar)$/i;
const DL_WORD = /(ダウンロード|ＤＬ|\bDL\b|download|配布|入手)/i;
// アップローダーなどのページにある、作品とは関係ないリンク
const NAV = /\/(ranking|upload|thumbnail|search|rss|inquire|signup|users|admin|login|rule|contact)(\/|$|\?)/i;

const decode = (bytes, enc) => { try { return new TextDecoder(enc).decode(bytes); } catch { return null; } };

/**
 * HTMLのバイト列を文字にする。順番：HTTPヘッダのcharset → <meta>のcharset → UTF-8 → Shift_JIS
 */
export function decodeHtml(bytes, contentType = '') {
  const norm = (c) => {
    c = (c || '').toLowerCase().replace(/["']/g, '');
    if (/^(shift[_-]?jis|sjis|x-sjis|windows-31j|cp932|ms932)$/.test(c)) return 'shift_jis';
    if (/^(euc-jp|x-euc-jp)$/.test(c)) return 'euc-jp';
    if (/^utf-?8$/.test(c)) return 'utf-8';
    return c || null;
  };
  let enc = norm((contentType.match(/charset=([\w-]+)/i) || [])[1]);
  if (!enc) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    enc = norm((head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1]);
  }
  if (enc) { const t = decode(bytes, enc); if (t != null) return t; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* 次へ */ }
  return new TextDecoder('shift_jis').decode(bytes);
}

const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");

/** ページのタイトル */
export function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? unescapeHtml(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}

/**
 * ページの中から、ダウンロードに関係しそうなリンクを探す。
 * @returns {{url: string, text: string, kind: 'file'|'page'}[]} file＝ファイルそのもの / page＝ダウンロードページらしいもの
 */
export function extractDownloadLinks(html, baseUrl) {
  const out = new Map();
  const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    let url;
    try { url = new URL(unescapeHtml(m[2]), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    url.hash = '';
    const text = unescapeHtml(m[3].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* そのまま */ }
    let kind = null;
    if (ARCHIVE_EXT.test(path)) kind = 'file';
    else if (NAV.test(url.pathname)) continue;
    else if (/\/(download|dl)(\/|$)/i.test(url.pathname) || DL_WORD.test(text)) kind = 'page';
    if (!kind) continue;
    const key = url.href;
    if (!out.has(key) || (kind === 'file' && out.get(key).kind !== 'file')) out.set(key, { url: key, text, kind });
  }
  // ファイルそのものを先に
  return [...out.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1)).slice(0, 30);
}

/** Content-Disposition やURLから、ファイル名を取り出す */
export function fileNameFrom(url, contentDisposition = '') {
  const star = contentDisposition.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* 次へ */ } }
  const plain = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/);
  if (plain) return plain[1].trim();
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last);
  } catch {
    return '';
  }
}

/** 終了が決まっているサイトなどの注意書き */
export function siteNotice(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return ''; }
  if (/(^|\.)getuploader\.com$|(^|\.)uploader\.jp$/.test(host)) {
    return '斧アップローダー（uploader.jp）は 2026年11月25日 23:59 で終了し、ファイルも削除されます。作者さんには、引っ越し先の案内をお願いしたいところです。';
  }
  return '';
}

// ------------------------------------------------------------ 同意してダウンロード（A）

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? unescapeHtml(m[1] ?? m[2] ?? m[3] ?? '') : null;
};

/**
 * ページの中の「ダウンロード」ボタン付きフォームを探す（斧アップローダーなどの同意ページ）。
 * 送信はしない。何を送るかを並べるだけ。
 * @returns {{action: string, method: 'GET'|'POST', fields: [string, string][], label: string, inputs: {name: string, type: string, label: string}[]}[]}
 */
export function extractDownloadForms(html, baseUrl) {
  const forms = [];
  for (const m of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const head = m[1], body = m[2];
    let action;
    try { action = new URL(attr(`<form ${head}>`, 'action') || baseUrl, baseUrl); } catch { continue; }
    if (!/^https?:$/.test(action.protocol)) continue;
    // 別のサイトへ送るフォーム（翻訳ボタンなど）は対象外
    if (new URL(baseUrl).hostname.split('.').slice(-2).join('.') !== action.hostname.split('.').slice(-2).join('.')) continue;
    const method = (attr(`<form ${head}>`, 'method') || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET';

    const fields = [];
    const inputs = [];
    let submit = null;
    // <button>…</button> と <input> を順番どおりに拾う
    for (const t of body.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>|<input\b([^>]*)>/gi)) {
      const isButton = t[1] !== undefined;
      const tag = isButton ? `<button ${t[1]}>` : `<input ${t[3]}>`;
      const type = (attr(tag, 'type') || (isButton ? 'submit' : 'text')).toLowerCase();
      const name = attr(tag, 'name');
      const value = attr(tag, 'value') ?? (isButton ? unescapeHtml(t[2].replace(/<[^>]+>/g, '')).trim() : '');
      if (type === 'submit' || type === 'image') {
        if (!submit && DL_WORD.test(value || '')) submit = { name, value };
      } else if (type === 'hidden') {
        if (name) fields.push([name, value]);
      } else if (['text', 'password', ''].includes(type) && name && attr(tag, 'readonly') == null) {
        inputs.push({ name, type: type === 'password' ? 'password' : 'text', label: attr(tag, 'placeholder') || name });
      }
    }
    if (!submit) continue;
    if (submit.name) fields.push([submit.name, submit.value]);
    forms.push({ action: action.href, method, fields, label: submit.value, inputs });
  }
  return forms;
}

/** <meta http-equiv="refresh" content="6;URL=…"> の行き先 */
export function metaRefreshUrl(html, baseUrl) {
  const m = html.match(/<meta[^>]+http-equiv\s*=\s*["']?refresh["']?[^>]*>/i);
  if (!m) return null;
  const c = attr(m[0], 'content') || '';
  const u = c.match(/url\s*=\s*['"]?([^'"]+)/i);
  if (!u) return null;
  try { return new URL(u[1].trim(), baseUrl).href; } catch { return null; }
}

/** 同意画面に出すための、ページの本文（タグを除いたもの） */
export function pageText(html, max = 4000) {
  const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, html])[1];
  return unescapeHtml(body
    .replace(/<(script|style|noscript|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t　]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim().slice(0, max);
}

/**
 * 紹介ページの「カード」情報（OGP）を取り出す。X・Misskey・ブログなどが用意している、
 * 題名・説明・画像の情報。無ければ <title> と description で代わりにする。
 * @returns {{title: string, description: string, image: string, site: string}}
 */
export function parseOgp(html, baseUrl) {
  const head = html.slice(0, 200000);
  const metas = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name)\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    const val = (tag.match(/\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i) || []).slice(1).find((x) => x != null);
    if (key && val != null && !(key.toLowerCase() in metas)) metas[key.toLowerCase()] = unescapeHtml(val).trim();
  }
  const pick = (...ks) => ks.map((k) => metas[k]).find((v) => v) || '';
  let image = pick('og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
  try { image = image ? new URL(image, baseUrl).href : ''; } catch { image = ''; }
  if (!/^https?:\/\//.test(image)) image = '';
  return {
    title: (pick('og:title', 'twitter:title') || pageTitle(html)).slice(0, 200),
    description: pick('og:description', 'twitter:description', 'description').slice(0, 1000),
    image,
    site: pick('og:site_name').slice(0, 100),
  };
}
