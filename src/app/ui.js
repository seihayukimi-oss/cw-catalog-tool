// 画面づくりの小さな道具。文字は必ず textContent で入れる（Readmeやカタログの文字をHTMLとして解釈しない）。

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'href') { if (/^https?:\/\//.test(v)) el.setAttribute('href', v); }
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(msg, { bad = false, ms = 4500 } = {}) {
  let box = document.getElementById('toast');
  if (!box) { box = h('div', { id: 'toast', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), onclick: () => t.remove() }, msg);
  box.append(t);
  while (box.children.length > 2) box.firstChild.remove(); // 重なって画面を隠さないよう2件まで
  setTimeout(() => t.remove(), ms);
}

/** <dialog> を開いて、閉じたときの値を返す */
export function modal(build) {
  return new Promise((resolve) => {
    const dlg = h('dialog');
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.append(build(close));
    dlg.addEventListener('cancel', () => close(null));
    document.body.append(dlg);
    dlg.showModal();
  });
}

export const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : n >= 1024 ? `${Math.round(n / 1024)}KB` : `${n}B`);
export const fmtDate = (s) => (s ? new Date(s).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '');

export function formatBadge({ format, dataVersion, wsnVersion }) {
  if (format === 'wsn') return h('span', { class: 'badge wsn' }, `Py仕様${wsnVersion != null ? ` Wsn.${wsnVersion}` : ''}`);
  if (format === 'next') return h('span', { class: 'badge next' }, 'Next仕様');
  if (format === 'classic') return h('span', { class: 'badge classic' }, dataVersion != null && dataVersion < 4 ? `クラシック（旧版${dataVersion}）` : 'クラシック');
  return h('span', { class: 'badge plain' }, '形式不明');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 設定の「保存場所：［ 場所 ］」（場所を枠で囲む。最初から用意したフォルダには印を付ける）
 * @param {string} label 見出し（保存場所・置き場所）
 * @param {string} path 場所（空なら未設定）
 */
/** 一覧が空のときの知らせ（点線の枠で囲む。1行目に何がまだないか、2行目に小さく補足） */
export function emptyBox(main, sub = '') {
  return h('div', { class: 'empty-src' }, h('div', {}, main), sub ? h('div', { class: 'small muted' }, sub) : null);
}

export function placeField(label, path, auto = false, note = '') {
  return h('div', { class: 'place-field' },
    h('span', { class: 'place-label' }, `${label}：`),
    h('div', { class: 'place-box' },
      h('span', { class: `place-path${path ? '' : ' muted'}` }, path || '未設定'),
      auto && path ? h('span', { class: 'badge place-badge' }, '初期設定') : null),
    note ? h('span', { class: 'small muted place-note' }, note) : null);
}
