// 中身の安全の表示：実行ファイルの注意・中身の一覧（入れる前に見られる）・テキストをその場で読む・
// ダウンロードせずに目次だけ読む。
// どれも名前と中身を「読むだけ」で、ファイルを開いたり実行したりはしない。

import { S, render, busy } from './state.js';
import { h, toast, modal, fmtSize } from './ui.js';
import { excludeExecutables, includeExecutables } from '../core/safety.js';
import { peekArchive, PeekUnsupported } from '../core/peek.js';
import { decodeText } from '../core/text.js';

export const EXEC_TITLE = '⚠ 注意！このファイルには、カードワースのシナリオ以外の実行ファイルが入っています';
const TEXT_RE = /\.(txt|md|ini|xml|csv|log|html?)$/i;

/**
 * 実行ファイルの注意（入っていなければ null）。
 * @param {object} o openArchive の結果
 * @param {{compact?: boolean, disabled?: boolean, onChange?: () => void}} opts
 */
export function execWarning(o, { compact = false, disabled = false, onChange = render } = {}) {
  const inner = o?.executables || [];
  const outer = o?.outerExecutables || [];
  if (!inner.length && !outer.length) return null;
  const allow = !o.execExcluded;
  const box = h('input', {
    type: 'checkbox', checked: allow, disabled, id: compact ? null : 'exec-allow',
    onchange: (ev) => { if (ev.target.checked) includeExecutables(o); else excludeExecutables(o); onChange(); },
  });
  const list = h('ul', { class: 'small exec-list', style: 'margin:4px 0;padding-left:1.2em' },
    [...inner, ...outer].slice(0, 30).map((x) => h('li', {}, h('b', {}, x.path), `（${x.why}・${fmtSize(x.size || 0)}）`, outer.includes(x) ? '　※外側のファイルの中。入れるものには入りません' : null)),
    inner.length + outer.length > 30 ? h('li', {}, `ほか ${inner.length + outer.length - 30}件`) : null);
  return h('div', { class: 'note bad stack', id: compact ? null : 'exec-warn', style: 'margin:6px 0' },
    h('b', {}, EXEC_TITLE),
    compact ? h('details', {}, h('summary', { class: 'small' }, `${inner.length + outer.length}件`), list) : list,
    h('p', { class: 'small', style: 'margin:0' },
      '名前と中身の頭を見て見つけました（開いたり実行したりはしていません）。入れても、開かなければ動きません。',
      allow ? null : '間違えて開かないよう、入れるときは外し、元のzipも保存場所には残しません。'),
    inner.length ? h('label', { class: 'check small' }, box, '実行ファイルも入れる（作者さんが用意した道具だと分かっているときだけ）') : null);
}

/** 中身の一覧（入れる前に見られる。テキストはその場で読める） */
export function contentsBox(o, { id = 'contents' } = {}) {
  const all = o?._execBackup?.files || o?.files || [];
  if (!all.length) return null;
  const exec = new Set([...(o.executables || [])].map((x) => x.path));
  const box = h('details', { class: 'small', id },
    h('summary', {}, `中身の一覧（${all.length}ファイル${exec.size ? `・⚠ 実行ファイル ${exec.size}件` : ''}）`));
  box.addEventListener('toggle', () => {
    if (!box.open || box.dataset.loaded) return;
    box.dataset.loaded = '1';
    const rows = all.slice(0, 2000).map((f) => {
      const bad = exec.has(f.path);
      const left = !o.execExcluded || !bad;
      return h('li', { class: bad ? 'exec' : '' },
        bad ? h('span', { class: 'badge bad' }, '⚠ 実行ファイル') : null, ' ',
        TEXT_RE.test(f.path) && !bad ? h('button', { class: 'btn ghost sm', title: 'その場で読む', onclick: () => textModal(f) }, f.path) : h('span', {}, f.path),
        h('span', { class: 'muted' }, `　${fmtSize(f.size || 0)}${left ? '' : '・入れません'}`));
    });
    box.append(h('ul', { class: 'contents-list', style: 'margin:4px 0;padding-left:1.2em;max-height:320px;overflow:auto' }, rows,
      all.length > 2000 ? h('li', { class: 'muted' }, `ほか ${all.length - 2000}件`) : null));
  });
  return box;
}

/** テキストのファイルを、その場で読む（文字として表示するだけ） */
export async function textModal(f) {
  let bytes;
  try { bytes = await f.read(); } catch (e) { toast(`読めませんでした：${e.message}`, { bad: true }); return; }
  await modal((close) => {
    const pre = h('pre', { class: 'readme', id: 'text-modal' });
    let enc = '';
    const show = () => { pre.textContent = decodeText(bytes, enc || undefined).text; };
    show();
    return h('div', { class: 'stack' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0;word-break:break-all' }, f.path.split('/').pop()),
        h('select', { 'aria-label': '文字コード', onchange: (ev) => { enc = ev.target.value; show(); } },
          [['', '自動'], ['utf-8', 'UTF-8'], ['shift_jis', 'Shift_JIS'], ['utf-16le', 'UTF-16']].map(([v, l]) => h('option', { value: v }, l)))),
      pre,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる')));
  });
}

/**
 * ダウンロードせずに、配布ファイルの目次（中のファイルの名前と大きさ）だけを見る。
 * ファイルそのもののURL（zip・wsn・cab・7z）のときだけ。配布ページのURLでは見られない。
 */
export async function peekModal(url, title = '') {
  if (!S.platform.fetchRange) { toast('中身の目次を見るのは、アプリ版だけです', { bad: true }); return; }
  let res = null, why = '';
  await busy('目次を読んでいます', async () => {
    try {
      res = await peekArchive((r) => S.platform.fetchRange(url, r));
    } catch (e) {
      if (e instanceof PeekUnsupported) why = e.message;
      else if (e?.status === 404 || e?.status === 410) why = 'ファイルが見つかりませんでした（リンク切れのようです）';
      else why = `読めませんでした：${e.message || e}`;
    }
  });
  await modal((close) => {
    const exec = res ? res.entries.filter((e) => e.exec) : [];
    return h('div', { class: 'stack', id: 'peek-modal' },
      h('h2', { style: 'margin:0' }, `${title || res?.fileName || 'ファイル'} の中身`),
      res ? h('p', { class: 'small muted', style: 'margin:0' }, `${res.format}・${fmtSize(res.total)}・${res.entries.length}ファイル（目次だけを読みました。ダウンロードはしていません）`) : null,
      exec.length ? h('div', { class: 'note bad' }, h('b', {}, EXEC_TITLE), h('ul', { class: 'small', style: 'margin:4px 0;padding-left:1.2em' }, exec.slice(0, 30).map((e) => h('li', {}, e.path)))) : null,
      res && !exec.length ? h('p', { class: 'note ok small', style: 'margin:0' }, '名前で見たかぎり、実行ファイルは入っていません（入れるときに中身の頭も確かめます）。') : null,
      res ? h('ul', { class: 'small contents-list', style: 'margin:0;padding-left:1.2em;max-height:360px;overflow:auto' },
        res.entries.slice(0, 2000).map((e) => h('li', {}, e.exec ? h('span', { class: 'badge bad' }, '⚠ 実行ファイル') : null, ' ', e.path, h('span', { class: 'muted' }, `　${fmtSize(e.size)}`)))) : null,
      !res ? h('p', { class: 'note warn small' }, why, h('br'), 'ダウンロードしても、中身はパソコンに書き込まずに確かめます。入れる前に「中身の一覧」と実行ファイルの注意を見られます。') : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる')));
  });
}
