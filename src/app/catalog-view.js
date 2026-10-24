// 「カタログ」タブ：共用・個人用カタログの管理、作品の一覧・紹介・DL、個人用カタログへの登録と編集。

import { ENGINE_KINDS } from '../core/catalog.js';
import { chooseDownloads, statusOf, ageRoleOf, introKind, INTRO_LABEL, workKey, KIND_LABEL } from '../core/catalogs.js';
import { decodeHtml, parseOgp } from '../core/weblink.js';
import { S, render, busy, rerenderList, confirmBox } from './state.js';
import { h, toast, modal, fmtDate, formatBadge } from './ui.js';
import {
  addShared, importList, createOwn, removeSource, setEnabled, setHidden, refreshSource, saveSources, exportSource,
  saveOwnEntry, ownSources, sourceById, setDefaultUrl, defaultUrlOf, setCatPrefs, refreshStates,
} from './catalog-data.js';
import { downloadWork, downloadFrom, dlLabel } from './download.js';
import { startBatch } from './batch.js';

const LV = { verified: ['確認済み', 'ok'], expected: ['動くはず', 'warn'], no: ['非対応', 'bad'], unknown: ['未確認', 'plain'] };
const AGE = { new: '新', old: '旧（移転済み）', closed: '終了' };
const ROLE = { normal: '通常', mirror: '予備' };

// ------------------------------------------------------------ 一覧
function filteredWorks() {
  if (!S.combined) return [];
  const q = S.filter.cat.normalize('NFKC').toLowerCase();
  return S.combined.works.filter((w) => {
    if (S.filter.catSource && !w.refs.some((r) => r.sourceId === S.filter.catSource)) return false;
    if (!S.filter.showHidden && (S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden)) return false;
    if (S.filter.catEngine && !['verified', 'expected'].includes(w.compat?.[S.filter.catEngine])) return false;
    return !q || `${w.name} ${w.author} ${w.tags.join(' ')} ${w.description || ''}`.normalize('NFKC').toLowerCase().includes(q);
  });
}
const filtering = () => !!(S.filter.cat.trim() || S.filter.catEngine || S.filter.catSource);

export function viewCatalog() {
  const hasAny = !!S.combined;
  const manage = viewManage(!hasAny || S.manageOpen);
  if (!hasAny) {
    return h('div', {}, manage,
      h('div', { class: 'card soft small' },
        h('p', { style: 'margin:0' }, 'まだ作品がありません。'),
        h('ul', { style: 'margin:6px 0 0;padding-left:1.2em' },
          h('li', {}, '共用カタログ：作者さんが登録したカタログのURL（index.json）を追加します'),
          h('li', {}, '個人用カタログ：有志の方のDL一覧を読み込むか、「＋作品を登録」で自分で作品を足します')),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => editEntry({}) }, '＋作品を登録（個人用）'))));
  }

  const works = filteredWorks();
  const filters = h('div', { class: 'card stack' },
    h('div', { class: 'row' },
      h('input', { type: 'search', class: 'grow', id: 'cat-q', placeholder: '作品名・作者・タグ・紹介文で検索', value: S.filter.cat, oninput: (ev) => { S.filter.cat = ev.target.value; rerenderList('cat-body', viewCatalog); } }),
      h('button', { class: 'btn', onclick: () => editEntry({}) }, '＋作品を登録（個人用）')),
    h('div', { class: 'row' },
      h('select', { 'aria-label': 'カタログ', onchange: (ev) => { S.filter.catSource = ev.target.value; render(); } },
        h('option', { value: '' }, 'すべてのカタログ'),
        S.sources.filter((s) => s.enabled).map((s) => h('option', { value: s.id, selected: S.filter.catSource === s.id ? 'selected' : null }, `${KIND_LABEL[s.kind]}：${s.name}`))),
      h('select', { 'aria-label': 'エンジン', onchange: (ev) => { S.filter.catEngine = ev.target.value; render(); } },
        [['', 'すべてのエンジン'], ['cw150', '1.50で遊べる'], ['next', 'Nextで遊べる'], ['py', 'Pyで遊べる']].map(([v, l]) => h('option', { value: v, selected: S.filter.catEngine === v ? 'selected' : null }, l))),
      h('label', { class: 'check small' }, h('input', { type: 'checkbox', checked: S.filter.showHidden, onchange: (ev) => { S.filter.showHidden = ev.target.checked; render(); } }), '候補から外したものも表示')));

  return h('div', {}, manage, filters, h('div', { id: 'cat-body' }, batchBar(works), viewList(works)));
}

function batchBar(works) {
  const sel = S.combined.works.filter((w) => S.selected.has(w.key));
  const visibleSel = works.filter((w) => S.selected.has(w.key)).length;
  return h('div', { class: 'card batch-bar row', id: 'batch-bar' },
    h('span', { class: 'small' }, `${works.length}件${filtering() ? '（検索結果）' : ''}`),
    filtering() && works.length ? h('button', { class: 'btn primary sm', onclick: () => startBatch(works.map((work) => ({ work })), '検索結果をまとめてDL') }, `検索結果${works.length}件をまとめてDL`) : null,
    h('button', { class: 'btn sm', disabled: !works.length || visibleSel === works.length, onclick: () => { works.forEach((w) => S.selected.add(w.key)); render(); } }, '表示中をすべて選ぶ'),
    sel.length ? h('button', { class: 'btn primary sm', onclick: () => { startBatch(sel.map((work) => ({ work })), '選んだ作品をまとめてDL'); S.selected.clear(); } }, `選んだ${sel.length}件をまとめてDL`) : null,
    sel.length ? h('button', { class: 'btn ghost sm', onclick: () => { S.selected.clear(); render(); } }, '選択を解除') : null);
}

function viewList(works) {
  const owned = new Map(S.records.filter((r) => r.workKey).map((r) => [r.workKey, r]));
  return h('div', { class: 'list', id: 'cat-list' }, works.length ? works.map((w) => workCard(w, owned.get(w.key))) : h('p', { class: 'empty' }, '見つかりませんでした'));
}

/** 長い紹介文は折りたたんで、「すべて表示」で開けるようにする */
export function descBlock(text) {
  const t = text.replace(/^\n+|\s+$/g, '');
  const long = t.split('\n').length > 5 || t.length > 180;
  const box = h('div', { class: 'desc' + (long ? '' : ' full') }, t);
  if (!long) return box;
  const btn = h('button', { class: 'btn ghost sm', onclick: () => { const open = box.classList.toggle('full'); btn.textContent = open ? 'たたむ' : 'すべて表示'; } }, 'すべて表示');
  return h('div', {}, box, btn);
}

function workCard(w, mine) {
  const order = chooseDownloads(w, defaultUrlOf(w));
  const def = order[0] || null;
  const inOwn = w.refs.some((r) => r.kind === 'own');
  const hiddenHere = S.filter.catSource ? w.hiddenIn.has(S.filter.catSource) : w.hidden;
  const sel = h('input', {
    type: 'checkbox', checked: S.selected.has(w.key), 'aria-label': `${w.name}を選ぶ`,
    onchange: (ev) => { if (ev.target.checked) S.selected.add(w.key); else S.selected.delete(w.key); document.getElementById('batch-bar')?.replaceWith(batchBar(filteredWorks())); },
  });
  return h('div', { class: `card work${hiddenHere ? ' hidden-work' : ''}` },
    h('div', { class: 'row between' },
      h('div', { class: 'row' }, sel, h('span', { class: 'item-title' }, w.name), formatBadge({ format: w.format, wsnVersion: w.wsn_version }),
        mine ? h('span', { class: `badge ${mine.state === 'update' ? 'update' : 'ok'}` }, mine.state === 'update' ? `入っている版 ${mine.version}→${w.version}` : 'フォルダにあり') : null,
        hiddenHere ? h('span', { class: 'badge plain' }, '候補から外しています') : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary sm', disabled: !def, onclick: () => downloadWork(w) }, 'ダウンロード'),
        h('button', { class: 'btn sm', onclick: () => editEntry({ work: w }) }, inOwn ? '編集' : '個人用カタログへ'),
        h('button', { class: 'btn ghost sm', onclick: () => toggleHidden(w, !hiddenHere) }, hiddenHere ? '候補に戻す' : '候補から外す'))),
    h('div', { class: 'meta' }, [w.author, `ver ${w.version}`, w.updated].filter(Boolean).join('・'),
      h('span', { class: 'row', style: 'display:inline-flex;margin-left:8px;gap:4px' }, w.refs.map((r) => h('span', { class: `badge src ${r.kind}` }, r.sourceName)))),
    h('div', { class: 'row', style: 'margin:6px 0' },
      ['cw150', 'next', 'py'].map((k) => h('span', { class: `badge ${LV[w.compat?.[k] || 'unknown'][1]}` }, `${ENGINE_KINDS[k].short}：${LV[w.compat?.[k] || 'unknown'][0]}`)),
      w.convert === 'forbidden' ? h('span', { class: 'badge bad' }, '変換NG') : null,
      w.tags.map((t) => h('span', { class: 'tag' }, `#${t}`))),
    w.description ? descBlock(w.description) : null,
    introBlock(w),
    h('div', { class: 'small muted', style: 'margin-top:8px' }, 'DL先'),
    h('ul', { class: 'dl' }, w.downloads.map((d) => {
      const { age, role } = ageRoleOf(d.status);
      const isDef = def && d.url === def.url;
      return h('li', { class: d.status },
        isDef ? h('span', { class: 'badge ok', title: '「ダウンロード」を押すと、ここから取ります' }, '★デフォルト') : null,
        h('span', {}, dlLabel(d)),
        h('span', { class: 'badge plain' }, d.kind === 'direct' ? '直接DL' : 'ページ経由'),
        h('span', { class: `badge ${age === 'new' ? 'plain' : age === 'closed' ? 'bad' : 'plain'}` }, `${AGE[age]}${age === 'closed' && d.until ? ` ${d.until}` : ''}`),
        h('span', { class: 'badge plain' }, ROLE[role]),
        d.note ? h('span', { class: 'small muted' }, d.note) : null,
        d.status !== 'closed' ? h('button', { class: 'btn sm', onclick: () => downloadFrom(w, d) }, 'ここから取る') : null,
        d.status !== 'closed' && !isDef ? h('button', { class: 'btn ghost sm', onclick: async () => { await setDefaultUrl(w, d.url); toast(`「${dlLabel(d)}」をデフォルトのDL先にしました`); render(); } }, 'デフォルトにする') : null);
    })));
}

async function toggleHidden(w, hide) {
  const ids = S.filter.catSource ? [S.filter.catSource] : null;
  await setHidden(w, hide, ids);
  await refreshStates();
  S.selected.delete(w.key);
  toast(hide ? `「${w.name}」を候補から外しました（「候補から外したものも表示」で戻せます）` : `「${w.name}」を候補に戻しました`);
  render();
}

// ------------------------------------------------------------ 紹介ページ（HP・X・Misskeyなど）
function introBlock(w) {
  if (!w.intro.length) return null;
  const loaded = w.intro.some((i) => S.ogp.has(i.url));
  return h('div', { class: 'intro' },
    h('div', { class: 'row small' }, h('span', { class: 'muted' }, '紹介'),
      w.intro.map((i) => h('button', { class: 'btn ghost sm', title: i.url, onclick: () => S.platform.openUrl(i.url) },
        h('span', { class: 'badge plain' }, INTRO_LABEL[introKind(i.url)]), i.label || i.url.replace(/^https?:\/\//, '').slice(0, 40))),
      !loaded ? h('button', { class: 'btn sm', onclick: () => loadIntros(w) }, '紹介を見る') : null),
    loaded ? h('div', { class: 'intro-cards' }, w.intro.map((i) => ogpCard(i))) : null);
}

function ogpCard(i) {
  const o = S.ogp.get(i.url);
  if (!o) return null;
  if (o.status === 'loading') return h('div', { class: 'ogp small muted' }, '読み込み中…');
  if (o.status !== 'ok') {
    return h('div', { class: 'ogp small muted' },
      o.status === 'blocked' ? 'HTML版では、このサイトの紹介を読み込めません（ブラウザの制限）。' : `紹介を読み込めませんでした${o.message ? `（${o.message}）` : ''}。`,
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(i.url) }, '開いて見る'));
  }
  return h('div', { class: 'ogp' },
    o.img ? h('img', { src: o.img, alt: '', loading: 'lazy' }) : null,
    h('div', { class: 'ogp-text' },
      h('div', { class: 'small muted' }, [INTRO_LABEL[introKind(i.url)], o.site].filter(Boolean).join('・')),
      h('b', {}, o.title || i.url),
      o.description ? h('div', { class: 'small' }, o.description) : null,
      h('button', { class: 'btn ghost sm', onclick: () => S.platform.openUrl(i.url) }, '開く')));
}

async function loadIntros(w) {
  for (const i of w.intro) if (!S.ogp.has(i.url)) S.ogp.set(i.url, { status: 'loading' });
  render();
  for (const i of w.intro) {
    if (S.ogp.get(i.url)?.status !== 'loading') continue;
    S.ogp.set(i.url, await fetchOgp(i.url));
    render();
  }
}

async function fetchOgp(url) {
  try {
    const r = await S.platform.fetchResource(url, { headers: { Accept: 'text/html' } });
    if (r.blocked) return { status: 'blocked' };
    const og = parseOgp(decodeHtml(r.bytes, r.contentType), r.finalUrl || url);
    if (!og.title && !og.description) return { status: 'none', message: '紹介の情報が見つかりませんでした' };
    let img = '';
    if (og.image) {
      const ir = await S.platform.fetchResource(og.image).catch(() => null);
      const type = ir?.contentType?.split(';')[0] || '';
      if (ir && !ir.blocked && /^image\/(png|jpe?g|gif|webp|avif)$/i.test(type) && ir.bytes.length < 5 * 1024 * 1024) {
        img = URL.createObjectURL(new Blob([ir.bytes], { type }));
      }
    }
    return { status: 'ok', ...og, img };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// ------------------------------------------------------------ カタログの管理
export function viewManage(open) {
  if (!open) {
    const n = S.sources.length;
    return h('div', { class: 'card row between manage-closed' },
      h('span', { class: 'small' }, `カタログ ${n}件（共用 ${S.sources.filter((s) => s.kind === 'shared').length}・個人用 ${S.sources.filter((s) => s.kind !== 'shared').length}）・候補に含めているもの ${S.sources.filter((s) => s.enabled).length}件`),
      h('button', { class: 'btn sm', onclick: () => { S.manageOpen = true; render(); } }, 'カタログの管理'));
  }
  const shared = S.sources.filter((s) => s.kind === 'shared');
  const personal = S.sources.filter((s) => s.kind !== 'shared');
  const sharedUrl = h('input', { type: 'url', class: 'grow', placeholder: 'https://…/index.json', id: 'shared-url' });
  const listUrl = h('input', { type: 'url', class: 'grow', placeholder: 'DL一覧のURL（.json）', id: 'list-url' });
  const fileIn = h('input', {
    type: 'file', accept: '.json,application/json', style: 'display:none', id: 'list-file',
    onchange: async (ev) => {
      const f = ev.target.files[0];
      if (!f) return;
      await busy('DL一覧を読み込み', async () => {
        const src = await importList({ json: JSON.parse(await f.text()), fileName: f.name });
        await refreshStates();
        toast(`「${src.name}」を個人用カタログとして読み込みました（${src.count}件）`);
      });
    },
  });
  const after = async (fn, msg) => busy('カタログ', async () => { const r = await fn(); await refreshStates(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); });

  return h('div', { class: 'card stack manage', id: 'manage' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, 'カタログの管理'),
      S.combined ? h('button', { class: 'btn ghost sm', onclick: () => { S.manageOpen = false; render(); } }, 'たたむ') : null),
    h('p', { class: 'small muted', style: 'margin:0' }, '「候補に含める」を外したカタログの作品は、一覧・更新チェック・まとめてDLに出なくなります。'),

    h('h3', {}, '共用カタログ', h('span', { class: 'small muted', style: 'font-weight:normal;margin-left:8px' }, '作者さんが登録フォームから登録した作品のカタログ')),
    shared.length ? h('div', { class: 'src-list' }, shared.map((s) => sourceRow(s, after))) : h('p', { class: 'small muted', style: 'margin:0' }, 'まだありません。'),
    h('div', { class: 'row' }, sharedUrl,
      h('button', {
        class: 'btn primary', onclick: () => {
          const u = sharedUrl.value.trim();
          if (!/^https:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
          after(() => addShared(u), (src) => `「${src.name}」を追加しました（${src.count}件）`);
        },
      }, '共用カタログを追加'),
      !S.sources.some((s) => s.url === 'sample') ? h('button', { class: 'btn ghost', onclick: () => after(() => addShared('sample', 'サンプル'), 'サンプルのカタログを追加しました') }, 'サンプル') : null),

    h('h3', {}, '個人用カタログ', h('span', { class: 'small muted', style: 'font-weight:normal;margin-left:8px' }, '自分で作るカタログと、有志の方のDL一覧。いくつでも持てます')),
    personal.length ? h('div', { class: 'src-list' }, personal.map((s) => sourceRow(s, after))) : null,
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: async () => { const name = await askName('新しい個人用カタログ', ''); if (name) after(() => createOwn(name), `「${name}」を作りました`); } }, '新しく作る'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, 'DL一覧を読み込む（ファイル）'), fileIn),
    h('div', { class: 'row' }, listUrl,
      h('button', {
        class: 'btn', onclick: () => {
          const u = listUrl.value.trim();
          if (!/^https?:\/\//.test(u)) { toast('https:// から始まるURLを入れてください', { bad: true }); return; }
          after(() => importList({ url: u }), (src) => `「${src.name}」を読み込みました（${src.count}件）`);
        },
      }, 'URLから読み込む')),

    h('h3', {}, '登録とDLの設定'),
    prefsBlock());
}

/** 「作品を個人用カタログに登録するとき」「デフォルトのDL先が使えないとき」の設定（設定タブにも出す） */
export function prefsBlock() {
  const radio = (v, label) => h('label', { class: 'check' },
    h('input', { type: 'radio', name: 'addTo', value: v, checked: S.catPrefs.addTo === v, onchange: () => setCatPrefs({ addTo: v }).then(render) }), label);
  return h('div', { class: 'stack small' },
    h('div', {}, h('div', { class: 'muted' }, '作品を個人用カタログに登録するとき'),
      h('div', { class: 'row' }, radio('all', 'すべての個人用カタログに入れる'), radio('choose', '入れるカタログを毎回選ぶ'))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.catPrefs.askDefault, onchange: (ev) => setCatPrefs({ askDefault: ev.target.checked }) }),
      'デフォルトのDL先から取れず、別の配布元から取ったとき「こちらをデフォルトのDL先に変更しますか？」と聞く'));
}

function sourceRow(s, after) {
  const hidden = (s.hidden || []).length;
  const kindLabel = s.kind === 'own' ? '自分で作成' : s.kind === 'sub' ? `読み込み${s.url ? '（URL）' : '（ファイル）'}` : s.url === 'sample' ? 'サンプル' : 'URL';
  return h('div', { class: `src-row${s.enabled ? '' : ' off'}` },
    h('label', { class: 'check', title: '外すと、このカタログの作品は候補に出なくなります' },
      h('input', { type: 'checkbox', checked: s.enabled, 'aria-label': `${s.name}を候補に含める`, onchange: (ev) => after(() => setEnabled(s, ev.target.checked)) }), '候補に含める'),
    h('div', { class: 'grow' },
      h('div', { class: 'row' },
        h('b', {}, s.name), h('span', { class: 'badge plain' }, kindLabel)),
      h('div', { class: 'meta' }, [`${s.count || 0}件`, hidden ? `外した作品 ${hidden}件` : '', s.loadedAt ? `読み込み ${fmtDate(s.loadedAt)}` : '', s.url && s.url !== 'sample' ? s.url : s.fileName || ''].filter(Boolean).join('・'))),
    h('div', { class: 'row' },
      s.url ? h('button', { class: 'btn sm', onclick: () => after(() => refreshSource(s), (changed) => (changed ? `「${s.name}」を取り直しました（${s.count}件）` : '変わっていませんでした')) }, '取り直す') : null,
      s.kind !== 'shared' ? h('button', { class: 'btn sm', onclick: () => exportList(s) }, 'DL一覧として書き出す') : null,
      s.kind === 'sub' ? h('button', { class: 'btn sm', onclick: async () => { const name = await askName('自分用にコピー', `${s.name}（コピー）`); if (name) after(() => createOwn(name, s), `「${name}」を作りました。こちらは自由に直せます`); } }, 'コピーして自分用に') : null,
      h('button', { class: 'btn ghost sm', onclick: async () => { const name = await askName('名前を変える', s.name); if (name) { s.name = name; s.renamed = true; await saveSources(); after(async () => {}); } } }, '名前'),
      h('button', {
        class: 'btn ghost sm danger', onclick: async () => {
          const warn = s.kind === 'own' ? `「${s.name}」と、そこに登録した作品（${s.count || 0}件）を消します。先に「DL一覧として書き出す」で残しておくこともできます。よろしいですか？` : `「${s.name}」を外します。よろしいですか？`;
          if (await confirmBox(warn)) after(() => removeSource(s), `「${s.name}」を外しました`);
        },
      }, '削除')));
}

async function exportList(s) {
  const json = exportSource(s);
  const safe = s.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'dl-list';
  await S.platform.saveFile(`${safe}.json`, new TextEncoder().encode(JSON.stringify(json, null, 2)));
  toast(`${json.entries.length}件を「${safe}.json」に書き出しました。受け取った人は「DL一覧を読み込む」で使えます`, { ms: 9000 });
}

function askName(title, value) {
  return modal((close) => {
    const inp = h('input', { type: 'text', value, style: 'width:100%' });
    setTimeout(() => inp.focus(), 0);
    return h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); close(inp.value.trim().slice(0, 60) || null); } },
      h('h2', {}, title), h('label', { class: 'field' }, 'カタログの名前', inp),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '決定')));
  });
}

// ------------------------------------------------------------ 個人用カタログへの登録・編集
const COMPAT_BY_FORMAT = {
  classic: { cw150: 'expected', next: 'expected', py: 'expected' },
  next: { cw150: 'no', next: 'expected', py: 'unknown' },
  wsn: { cw150: 'no', next: 'no', py: 'expected' },
};

/**
 * 作品を個人用カタログに登録する・直す。
 * @param {{work?: object, prefill?: {work?: object, entry?: object}}} args
 */
export async function editEntry({ work = null, prefill = null } = {}) {
  work = work || prefill?.work || null;
  if (!ownSources().length) await createOwn('マイカタログ');
  const ownRef = work?.refs.find((r) => r.kind === 'own');
  const base = ownRef?.entry || (work ? { ...work.refs[0].entry, downloads: work.downloads, intro: work.intro, tags: work.tags } : prefill?.entry) || {};
  const origKey = ownRef ? work.key : '';
  const inOwn = new Set(work ? work.refs.filter((r) => r.kind === 'own').map((r) => r.sourceId) : []);
  const preset = inOwn.size ? inOwn : new Set(S.catPrefs.addTo === 'all' ? ownSources().map((s) => s.id) : []);
  const curDefault = work ? defaultUrlOf(work) || chooseDownloads(work)[0]?.url || '' : '';

  const v = await modal((close) => {
    const f = {
      name: h('input', { type: 'text', value: base.name || '', required: true }),
      author: h('input', { type: 'text', value: base.author || '' }),
      version: h('input', { type: 'text', class: 'ver', value: base.version || '' }),
      updated: h('input', { type: 'date', value: base.updated || '' }),
      format: h('select', {}, [['classic', 'クラシック（1.50・Next・Py）'], ['next', 'Next仕様'], ['wsn', 'Py仕様（WSN）']].map(([k, l]) => h('option', { value: k, selected: (base.format || 'classic') === k ? 'selected' : null }, l))),
      tags: h('input', { type: 'text', value: (base.tags || []).join('、'), placeholder: '探索、短編（「、」か「,」で区切る）' }),
      description: h('textarea', { rows: 4, style: 'width:100%' }),
    };
    f.description.value = base.description || '';
    const intros = (base.intro || []).map((i) => ({ ...i }));
    const dls = (base.downloads || []).map((d) => ({ ...ageRoleOf(d.status), url: d.url, label: d.label || '', kind: d.kind || 'page', note: d.note || '', until: d.until || '' }));
    let def = curDefault || dls[0]?.url || '';

    const introBox = h('div', { class: 'stack' });
    const drawIntros = () => introBox.replaceChildren(
      ...intros.map((i, n) => h('div', { class: 'row edit-row' },
        h('span', { class: 'badge plain' }, INTRO_LABEL[introKind(i.url)]),
        h('input', { type: 'url', class: 'grow', value: i.url, placeholder: 'https://（作者さんのサイト・X・Misskeyの投稿など）', 'aria-label': '紹介ページのURL', oninput: (ev) => { i.url = ev.target.value.trim(); } }),
        h('input', { type: 'text', value: i.label, placeholder: '表示名（任意）', style: 'width:9em', oninput: (ev) => { i.label = ev.target.value; } }),
        h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': '消す', onclick: () => { intros.splice(n, 1); drawIntros(); } }, '×'))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { intros.push({ url: '', label: '' }); drawIntros(); } }, '＋紹介ページ'));
    drawIntros();

    const dlBox = h('div', { class: 'stack' });
    const sel = (opts, val, on, label) => h('select', { 'aria-label': label, onchange: (ev) => on(ev.target.value) }, Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: k === val ? 'selected' : null }, l)));
    const drawDls = () => dlBox.replaceChildren(
      ...dls.map((d, n) => h('div', { class: 'edit-dl' },
        h('div', { class: 'row' },
          h('label', { class: 'check small', title: '「ダウンロード」を押したときに、ここから取ります' },
            h('input', { type: 'radio', name: 'def-dl', checked: def === d.url && !!d.url, onchange: () => { def = d.url; } }), 'デフォルト'),
          h('input', { type: 'url', class: 'grow', value: d.url, placeholder: 'https://（zipのURL、または配布ページ）', 'aria-label': 'DL先のURL', oninput: (ev) => { const was = def === d.url; d.url = ev.target.value.trim(); if (was) def = d.url; } }),
          h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': '消す', onclick: () => { dls.splice(n, 1); drawDls(); } }, '×')),
        h('div', { class: 'row small' },
          h('input', { type: 'text', value: d.label, placeholder: '名前（例：作者サイト、斧）', style: 'width:11em', oninput: (ev) => { d.label = ev.target.value; } }),
          sel({ page: '配布ページ', direct: '直接DL（zipそのもの）' }, d.kind, (x) => { d.kind = x; }, '種類'),
          sel({ new: '新（今の配布先）', old: '旧（移転済み）', closed: '終了' }, d.age, (x) => { d.age = x; }, '新旧'),
          sel({ normal: '通常', mirror: '予備' }, d.role, (x) => { d.role = x; }, '通常・予備'),
          h('input', { type: 'text', value: d.note, placeholder: 'メモ（DLキーはりどみ参照 など）', class: 'grow', oninput: (ev) => { d.note = ev.target.value; } })))),
      h('button', { type: 'button', class: 'btn sm', onclick: () => { dls.push({ url: '', label: '', kind: 'page', age: 'new', role: 'normal', note: '', until: '' }); drawDls(); } }, '＋DL先'));
    drawDls();

    const targets = ownSources().map((s) => ({ s, box: h('input', { type: 'checkbox', checked: preset.has(s.id) }) }));
    const err = h('p', { class: 'note bad small', style: 'display:none' });
    const submit = (ev) => {
      ev.preventDefault();
      const fail = (m) => { err.textContent = m; err.style.display = ''; };
      const name = f.name.value.trim();
      if (!name) return fail('作品名を入れてください');
      const badUrl = [...intros.map((i) => i.url), ...dls.map((d) => d.url)].find((u) => u && !/^https?:\/\/\S+$/.test(u));
      if (badUrl) return fail(`URLは https:// から始まるものにしてください：${badUrl}`);
      const ids = targets.filter((t) => t.box.checked).map((t) => t.s.id);
      if (!ids.length && !inOwn.size) return fail('入れる個人用カタログを1つ以上選んでください');
      const format = f.format.value;
      const entry = {
        id: base.id && /^p\d+$/.test(base.id) ? base.id : 'p00000',
        owner: base.owner || '', type: base.type || 'scenario', name, author: f.author.value.trim(), version: f.version.value.trim(),
        updated: f.updated.value || '', format, wsn_version: format === 'wsn' ? base.wsn_version ?? null : null,
        compat: base.format === format && base.compat ? base.compat : COMPAT_BY_FORMAT[format], convert: base.convert || 'self',
        downloads: dls.filter((d) => d.url).map((d) => ({ label: d.label.trim(), url: d.url, kind: d.kind, status: statusOf(d.age, d.role), until: d.until, note: d.note.trim() })),
        file: base.file || {}, readme: base.readme || '', level: base.level || null,
        tags: f.tags.value.split(/[、,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 30),
        description: f.description.value.trim(), requires: [], related: [], links: base.links || [],
        intro: intros.filter((i) => i.url).map((i) => ({ url: i.url, label: i.label.trim() })),
      };
      close({ entry, ids, def });
    };

    return h('form', { class: 'stack entry-edit', onsubmit: submit },
      h('h2', {}, origKey ? '個人用カタログの作品を直す' : '個人用カタログに登録'),
      work && !origKey ? h('p', { class: 'small muted', style: 'margin:0' }, '共用カタログ・読み込んだDL一覧の作品をコピーして、個人用カタログに入れます。元のカタログは変わりません。') : null,
      h('div', { class: 'grid2' },
        h('label', { class: 'field' }, '作品名', f.name),
        h('label', { class: 'field' }, '作者', f.author),
        h('label', { class: 'field' }, 'バージョン', f.version),
        h('label', { class: 'field' }, '更新日', f.updated),
        h('label', { class: 'field' }, '形式', f.format),
        h('label', { class: 'field' }, 'タグ', f.tags)),
      h('label', { class: 'field' }, '紹介文', f.description),
      h('div', {}, h('div', { class: 'small muted' }, '紹介ページ（DLの前に見てもらう、作者さんのサイト・X・Misskeyなど）'), introBox),
      h('div', {}, h('div', { class: 'small muted' }, 'DL先（「デフォルト」にしたところから先に取ります。取れなければ、新→予備→旧の順に試します）'), dlBox),
      h('div', {}, h('div', { class: 'small muted' }, `入れる個人用カタログ${inOwn.size ? '（チェックを外すと、そのカタログから抜けます）' : ''}`),
        h('div', { class: 'row' }, targets.map((t) => h('label', { class: 'check' }, t.box, t.s.name)))),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '保存')));
  });
  if (!v) return;
  await busy('保存中', async () => {
    await saveOwnEntry(v.entry, { origKey, targetIds: v.ids });
    const key = workKey(v.entry);
    const w = S.combined?.byKey.get(key);
    if (w && v.def && v.entry.downloads.some((d) => d.url === v.def)) await setDefaultUrl(w, v.def);
    await refreshStates();
    toast(v.ids.length ? `「${v.entry.name}」を${v.ids.map((id) => sourceById(id)?.name).join('・')}に保存しました` : `「${v.entry.name}」を個人用カタログから外しました`);
  });
}
