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

// ------------------------------------------------------------ 安全のしくみ（取ってくるとき・設定・はじめに.txt と同じ内容）
/** 安全のしくみの説明（アプリ版とHTML版で少し違う） */
export function safetyItems(kind = S.platform.kind) {
  const app = kind === 'app';
  return [
    {
      title: 'URLやページを読むとき',
      body: app
        ? [
          'アプリ（Rust）が直接サイトと通信します。ブラウザのように、ページの中のスクリプト（プログラム）を動かすことはありません。',
          '読んだページは、そのまま表示せず、文章とダウンロードのリンク・同意のボタンだけを取り出して、文字として見せます（ページの見た目や広告は出しません）。',
          '同意ページやDLキーのページは、本人が「同意します」にチェックしたり、DLキーを入れたりしてからでないと送りません。',
          'サイトから受け取ったCookie（「同意した人」の目印など）は、アプリを開いている間だけメモリに置き、パソコンには保存しません。同じサイトにだけ送り返します。',
          '転送（リダイレクト）は10回まで、ファイルは2GBまで。http・https 以外のURLは読みません。',
        ]
        : [
          'ブラウザの中で動きます。ほかのサイトのファイルは、相手が許可していないとブラウザの決まりで読めないので、そのときは配布ページを開いて、落としたファイルをドロップしてもらいます。',
          'このHTMLファイルに入っているスクリプト以外は動かさない設定（CSP）にしています。',
        ],
    },
    {
      title: 'ダウンロードするとき',
      body: app
        ? [
          'ダウンロードしたものは、パソコンに書き込まず、メモリの中だけで受け取ります。',
          '中身を確かめて、「入れる」と決めたものだけを、入れ先（エンジンのScenarioフォルダ・素材やスキンの置き場所・zipの保存場所）に書き込みます。',
          'アプリ内ブラウザでサイトのボタンを押したときだけは、ブラウザの仕組みで一度 CWCatalog-data の中にファイルができますが、読んだらすぐ消します（開いたり実行したりはしません）。',
        ]
        : ['ダウンロードしたもの・ドロップしたものは、ブラウザのメモリの中で確かめ、「入れる」と決めたものだけを、選んだフォルダに書き込みます。'],
    },
    {
      title: '中身を確かめるとき',
      body: [
        'zip などの中のファイルは、名前と中身の頭を「読むだけ」です。開いたり実行したりはしません。',
        'シナリオ以外の実行ファイル（.exe .bat .cmd .vbs .ps1 .scr .lnk など。名前を変えたものも、中身の頭の「MZ」などの印で見分けます）があれば注意を出し、いつもは外して入れます。外したときは、元のzipも保存場所に残しません。',
        '入れる前に「中身の一覧」を見られます。テキストは、その場で文字として読めます。',
        '「../」のような危ないパス、異常に大きいもの・圧縮率のおかしいもの（zip爆弾）、壊れたファイル（CRCが合わない）は止めます。',
        app ? 'カタログの作品は「中身を見る」で、ダウンロードせずに目次（中のファイルの名前と大きさ）だけを読めます。ファイルの一部だけを読むので、中身はほとんど来ません。' : null,
      ].filter(Boolean),
    },
    app ? {
      title: 'リンクを確かめるとき',
      body: [
        '「リンクを確かめる」は、ファイルの頭の1バイトだけを頼んで、サイトが「ありません」と答えるか（404など）を見ます。ダウンロードはしません。',
        '同じサイトには、1件ずつ間をあけて確かめます（相手に負担をかけないため）。',
      ],
    } : null,
    app ? {
      title: 'アプリ内ブラウザ',
      body: [
        'ログインが要るサイトや、ボタンを押さないと落ちてこないサイトだけで使います。ここではページのスクリプトが動きます（ふつうのブラウザと同じです）。',
        'アプリ内ブラウザの窓は、アプリの機能（ファイル操作など）に一切触れられない設定です。',
        'ログインした状態は CWCatalog-data に残ります。人に渡すときは CWCatalog.exe だけを渡してください。',
      ],
    } : null,
    {
      title: 'できないこと（大事）',
      body: [
        'このアプリは、ウイルス対策ソフトではありません。入れたファイルは、Windowsのウイルス対策（Microsoft Defender など）が見張ります。',
        'http（暗号化されていない通信）のサイトから取るときは、途中で書き換えられる心配がゼロではありません。入れる前に、中身の一覧と実行ファイルの注意をよく見てください。',
      ],
    },
  ].filter(Boolean);
}

const itemList = (items) => items.map((it) => h('div', { class: 'stack', style: 'gap:2px' },
  h('b', {}, it.title),
  h('ul', { style: 'margin:0;padding-left:1.2em' }, it.body.map((t) => h('li', {}, t)))));

/** 設定に置く「安全のしくみ」 */
export function viewSafetySettings() {
  return h('div', { class: 'card stack small', id: 'safety-info' }, itemList(safetyItems()));
}

/** 取ってくるところに置く、短い説明（「くわしく」で全部） */
export function safetyNote({ url = '', id = null } = {}) {
  const app = S.platform.kind === 'app';
  return h('div', { class: 'small muted safety-note', id },
    '🛡 ',
    app ? 'アプリが直接サイトと通信し、ページのスクリプトは動かしません。ダウンロードしたものはパソコンに書き込まず、メモリの中で中身を確かめてから、入れるものだけを書き込みます。'
      : 'ブラウザの中で、ダウンロードしたものの中身を確かめてから、入れるものだけを選んだフォルダに書き込みます。',
    h('button', { class: 'btn ghost sm', onclick: showSafety }, 'くわしく'),
    /^http:\/\//i.test(url) ? h('div', { class: 'note warn', style: 'margin-top:4px' }, '⚠ このURLは http（暗号化されていない通信）です。途中で書き換えられる心配がゼロではないので、入れる前に中身の一覧と実行ファイルの注意をよく見てください。') : null);
}

export function showSafety() {
  return modal((close) => h('div', { class: 'stack', id: 'safety-modal' },
    h('h2', { style: 'margin:0' }, '取ってくるときの安全のしくみ'),
    h('div', { class: 'stack small' }, itemList(safetyItems())),
    h('p', { class: 'small muted', style: 'margin:0' }, '同じ説明は「設定」の「安全のしくみ」と、はじめに.txt にもあります。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる'))));
}
