// 画面づくりの小さな道具。文字は必ず textContent で入れる（りどみやカタログの文字をHTMLとして解釈しない）。

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
