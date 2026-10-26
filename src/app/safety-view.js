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
      'ファイル名とデータ先頭部分（ヘッダー）を読み取って検出しました（開いたり実行したりはしていません）。インストールしても、開かなければ動作しません。',
      allow ? null : '誤って開くことがないよう、インストール時は除外し、元のzipも保存先には残しません。'),
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
      res ? h('p', { class: 'small muted', style: 'margin:0' }, `${res.format}・${fmtSize(res.total)}・${res.entries.length}ファイル（目次情報のみを読み込みました。ファイル本体はダウンロードしていません）`) : null,
      exec.length ? h('div', { class: 'note bad' }, h('b', {}, EXEC_TITLE), h('ul', { class: 'small', style: 'margin:4px 0;padding-left:1.2em' }, exec.slice(0, 30).map((e) => h('li', {}, e.path)))) : null,
      res && !exec.length ? h('p', { class: 'note ok small', style: 'margin:0' }, 'ファイル名で確認したかぎり、実行ファイルは含まれていません（インストール時にデータ先頭部分（ヘッダー）も確認します）。') : null,
      res ? h('ul', { class: 'small contents-list', style: 'margin:0;padding-left:1.2em;max-height:360px;overflow:auto' },
        res.entries.slice(0, 2000).map((e) => h('li', {}, e.exec ? h('span', { class: 'badge bad' }, '⚠ 実行ファイル') : null, ' ', e.path, h('span', { class: 'muted' }, `　${fmtSize(e.size)}`)))) : null,
      !res ? h('p', { class: 'note warn small' }, why, h('br'), 'ダウンロードした場合も、データはPCに書き込まずに検証します。インストール前に「中身の一覧」と実行ファイルの警告を確認できます。') : null,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる')));
  });
}

// ------------------------------------------------------------ 安全のしくみ（取得画面の「詳細」・設定・はじめに.txt と同じ内容）
/** 安全のしくみの説明（アプリ版とHTML版で少し違う） */
export function safetyItems(kind = S.platform.kind) {
  const app = kind === 'app';
  return [
    {
      title: 'URL・ページの読み込み',
      body: app
        ? [
          'アプリが直接対象サイトと通信します。通常のブラウザのように、ページ内のスクリプト（JavaScript など）を実行することはありません。',
          '取得したページはそのまま表示せず、本文・ダウンロードリンク・同意ボタンなどの必要な情報だけを取り出して、テキストとして表示します（ページのレイアウトや広告は表示されません）。',
          '同意ページやDLキー入力ページでは、ご本人が「同意する」へのチェックやキーの入力を行った場合のみ送信します。',
          'サイトから受け取ったCookie（同意の識別用など）は、アプリの起動中のみメモリ上に保持し、PCには保存しません。同じサイトとの通信時のみ送り返します。',
          '転送（リダイレクト）は最大10回まで、ファイル容量は2GBまでに制限しています。http・https 以外のURLは読み込みません。',
        ]
        : [
          'お使いのブラウザの中で動作します。他のサイトのファイルは、相手のサイトが許可していない場合ブラウザの仕組み上取得できないため、その際は配布ページを開いてダウンロードしたファイルをドロップしていただきます。',
          'このHTMLファイルに含まれるスクリプト以外は実行しない設定（CSP）にしています。',
        ],
    },
    {
      title: 'ダウンロード',
      body: app
        ? [
          'ダウンロードしたデータは、PCのドライブへ直接書き込まず、まずメモリ（RAM）上でのみ受信します。',
          '内容を検証し、インストールが確定したデータのみを指定の保存先（エンジンのScenarioフォルダ・素材やスキンの置き場所・zipの保存場所）へ書き込みます。',
          'アプリ内ブラウザでダウンロードボタンを押した場合のみ、仕組み上 CWCatalog-data 内に一時ファイルが作成されますが、読み込み後ただちに削除します（開いたり実行したりはしません）。',
        ]
        : ['ダウンロード・ドロップしたファイルは、ブラウザのメモリ上で検証し、インストールが確定したデータのみを選択したフォルダへ書き込みます。'],
    },
    {
      title: 'ファイルの検証',
      body: [
        'zip などの内部ファイルは、ファイル名とデータ先頭部分（ヘッダー）の読み取りのみを行います。ファイルを開いたり実行したりすることは一切ありません。',
        'シナリオに含まれない実行ファイル（.exe .bat .cmd .vbs .ps1 .scr .lnk など）を検出した場合は警告を表示し、初期状態では除外してインストールします。拡張子が変更されている場合も、ファイル先頭の「MZ」等のヘッダー識別印で判別します。除外した場合は、元のzipファイルも保存先へ残しません。',
        'インストール前に「中身の一覧」を確認できます。テキストファイルはその場で内容を閲覧できます。',
        '「../」などを含む危険なパス、異常なサイズや圧縮率のファイル（zip爆弾）、破損したファイル（CRC不一致）は処理を中止します。',
        app ? 'カタログの作品は「中身を見る」で、ファイル本体をダウンロードせずに目次情報（ファイル構成とサイズ）のみを確認できます。読み込むのはファイルの一部（目次部分）だけで、保存もしません（ごく小さいファイルは全体を読み込む場合があります）。' : null,
      ].filter(Boolean),
    },
    app ? {
      title: 'リンク確認',
      body: [
        '「リンク確認」機能は、ファイルの先頭データ（ほんの1バイト）のみをリクエストし、サーバーの応答コード（404エラー等）を確認します。ファイル本体のダウンロードは行いません。',
        'サーバーの負荷を抑えるため、同じサイトへの確認は1件ずつ間隔を空けて行います。',
      ],
    } : null,
    app ? {
      title: 'アプリ内ブラウザ',
      body: [
        'ログインが必要なサイトや、ボタン操作をしないとダウンロードできないサイトでのみ使用します。ページ内のスクリプトは、通常のブラウザと同様に動作します。',
        'アプリ内ブラウザのウィンドウには、アプリ本体の機能（ファイル操作など）へアクセスする権限を一切与えていません。',
        'サイトのボタンでダウンロードが始まると、受信量を確認して画面右上に進捗を表示します（ファイルの大きさを確認するだけです）。',
        'ログイン状態（セッション）は CWCatalog-data 内に保持されます。他者へ配布・共有する場合は CWCatalog.exe 単体のみを渡してください。',
      ],
    } : null,
    {
      title: '免責・制限事項（重要）',
      body: [
        '本アプリはウイルス対策ソフトではありません。取り込んだファイルの監視は、Windows の標準セキュリティ（Microsoft Defender 等）に依存します。',
        '暗号化されていない通信（http）のサイトからダウンロードする場合、通信途中でデータが改ざんされるリスクが少なからず存在します。インストール前に「中身の一覧」と実行ファイルの警告の有無を必ずご確認ください。',
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

/** 取得画面に置く、短い説明（「詳細」で全部） */
export function safetyNote({ url = '', id = null } = {}) {
  const app = S.platform.kind === 'app';
  return h('div', { class: 'small muted safety-note', id },
    '🛡 ',
    app ? 'アプリが直接サイトと通信し、ページ内のスクリプトは実行しません。ダウンロードしたデータはPCに書き込まず、メモリ上で内容を検証してから、インストールするものだけを書き込みます。'
      : 'ブラウザの中で、ダウンロードしたデータの内容を検証してから、インストールするものだけを選択したフォルダへ書き込みます。',
    h('button', { class: 'btn ghost sm', onclick: showSafety }, '詳細'),
    /^http:\/\//i.test(url) ? h('div', { class: 'note warn', style: 'margin-top:4px' }, '⚠ このURLは http（暗号化されていない通信）です。通信途中でデータが改ざんされるリスクがあるため、インストール前に「中身の一覧」と実行ファイルの警告を必ずご確認ください。') : null);
}

export function showSafety() {
  return modal((close) => h('div', { class: 'stack', id: 'safety-modal' },
    h('h2', { style: 'margin:0' }, 'ダウンロード・インストール時の安全のしくみ'),
    h('div', { class: 'stack small' }, itemList(safetyItems())),
    h('p', { class: 'small muted', style: 'margin:0' }, '同じ説明は「設定」の「安全のしくみ」と、はじめに.txt にもあります。'),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, '閉じる'))));
}
