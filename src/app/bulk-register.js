// 個人用カタログに、何作品かをまとめて登録する。
//  ・配布ページのリンク一覧で選んだもの：ファイルを取ってきて中身から読む／取ってこないでリンクから推測する、を選べる
//  ・まとめてDLの一覧（配布ページから取ってきたもの）：取ってきた中身から読む
//  全部に共通で、移転先・移転前の配布ページと、作者さんのサイト・紹介ページを入れられる。
//  同じ作品（作品名＋作者）がもう個人用カタログにあるときは、DL先・紹介ページを足す（core/bulkentry.js）

import { openArchive } from '../core/archive.js';
import { workKey } from '../core/catalogs.js';
import { guessVersion } from '../core/scenario.js';
import { guessFromLink, urlLines, bulkEntry, mergeEntry } from '../core/bulkentry.js';
import { findTagsInOpened } from '../core/autotag.js';
import { readSkin } from '../core/skin.js';
import { S, busy, busyProgress } from './state.js';
import { h, toast, modal } from './ui.js';
import { ownSources, createOwn, saveOwnEntry, refreshStates } from './catalog-data.js';
import { fetchOnce, eachParallel } from './download.js';

const RATINGS = [['auto', '作品ごとに決める（Readme に R18・R15 とあれば、それにする）'], ['all', '全年齢'], ['r15', 'R15'], ['r18', 'R18（成人向け）']];

/** 個人用カタログにある同じ作品（作品名＋作者）と、それが入っているカタログ */
function ownHolders(key) {
  const out = [];
  for (const s of ownSources()) {
    const e = S.catalogs.get(s.id)?.entries.find((x) => workKey(x) === key);
    if (e) out.push({ s, e });
  }
  return out;
}

/** 取ってきたファイルの中身から、作品の情報を読む */
async function infoFromOpened(o) {
  const fileName = o.source?.name || '';
  const sc = o.scenarios[0];
  if (!sc) {
    const skin = await readSkin(o).catch(() => null);
    const base = (skin?.folderName || o.archiveName || fileName).replace(/\.[^.]+$/, '');
    return { type: skin ? 'skin' : 'material', name: base, version: guessVersion(base) || '', format: 'classic', fileName, sha256: o.source?.sha256 || '', note: skin ? 'スキン' : '素材' };
  }
  const tags = S.autoTag === false ? [] : await findTagsInOpened(o, sc).catch(() => []);
  return {
    type: 'scenario', name: sc.name, author: sc.author || '', version: sc.versionGuess || '',
    format: sc.format === 'none' ? 'classic' : sc.format, wsnVersion: sc.wsnVersion ?? null,
    description: sc.description || '', rating: tags.includes('R18') ? 'r18' : tags.includes('R15') ? 'r15' : 'all',
    fileName, sha256: o.source?.sha256 || '',
    note: o.scenarios.length > 1 ? `中に${o.scenarios.length}作品あり（1つ目を登録します）` : '',
  };
}

/** 全部に共通の情報を聞く */
async function askCommon({ count, pageUrl = '', canFetch = false }) {
  const own = ownSources();
  const preset = new Set(S.catPrefs.addTo === 'all' ? own.map((s) => s.id) : own.slice(0, 1).map((s) => s.id));
  const boxes = own.map((s) => ({ s, box: h('input', { type: 'checkbox', checked: preset.has(s.id) }) }));
  const fetchOn = h('input', { type: 'radio', name: 'bulk-mode', checked: true });
  const guessOn = h('input', { type: 'radio', name: 'bulk-mode' });
  const author = h('input', { type: 'text', placeholder: '空なら、作品ごと（ファイルの中身）から入れます' });
  const pages = h('textarea', { rows: 2, style: 'width:100%' });
  pages.value = pageUrl;
  const oldPages = h('textarea', { rows: 2, style: 'width:100%', placeholder: 'https://… （1行に1つ）' });
  const site = h('input', { type: 'url', placeholder: 'https://（作者さんのサイトのトップページ）' });
  const intro = h('textarea', { rows: 2, style: 'width:100%', placeholder: 'https://… （1行に1つ）' });
  const rating = h('select', { 'aria-label': '対象年齢' }, RATINGS.map(([k, l]) => h('option', { value: k }, l)));
  const err = h('p', { class: 'note bad small', style: 'display:none' });
  return modal((close) => {
    const submit = (ev) => {
      ev.preventDefault();
      try {
        const v = {
          fetch: canFetch && fetchOn.checked, author: author.value.trim(), rating: rating.value,
          pages: urlLines(pages.value), oldPages: urlLines(oldPages.value), intro: urlLines(intro.value), site: urlLines(site.value)[0] || '',
          ids: boxes.filter((b) => b.box.checked).map((b) => b.s.id),
        };
        if (own.length && !v.ids.length) throw new Error('入れる個人用カタログを1つ以上選んでください');
        close(v);
      } catch (e) { err.textContent = e.message; err.style.display = ''; }
    };
    return h('form', { class: 'stack entry-edit', onsubmit: submit },
      h('h2', {}, '個人用カタログにまとめて登録'),
      h('p', { style: 'margin:0' }, `${count}件を、個人用カタログに登録します。次の画面で、作品ごとの名前・バージョンを確かめてから保存します。`),
      canFetch ? h('div', { class: 'stack', style: 'gap:4px' },
        h('div', { class: 'small muted' }, '作品名・作者・バージョンの読み取り方'),
        h('label', { class: 'check' }, fetchOn, 'ファイルを取ってきて、中身から読む（正確。ファイルが多いと時間がかかります。インストールはしません）'),
        h('label', { class: 'check' }, guessOn, 'ファイルを取ってこないで、リンクの文字・ファイル名から推測する（速い。名前は手で直すことが多いです）')) : null,
      h('div', { class: 'small muted' }, '全部の作品に共通で入れるもの（空のままでもかまいません）'),
      h('label', { class: 'field' }, '作者名（全部同じ作者さんのとき）', author),
      h('label', { class: 'field' }, '配布ページ（移転先。新しい配布ページ・作者さんのページ。1行に1つ）', pages),
      h('label', { class: 'field' }, '移転前の配布ページ・DL先（「旧（移転済み）」として残します。1行に1つ）', oldPages),
      h('label', { class: 'field' }, '作者さんのサイト', site),
      h('label', { class: 'field' }, '紹介ページ（サイト内の作品紹介ページ、告知のノート、X・Misskey などの投稿URL。全部の作品に入れます。1行に1つ）', intro),
      h('label', { class: 'field' }, '対象年齢', rating),
      own.length ? h('div', {}, h('div', { class: 'small muted' }, '入れる個人用カタログ'), h('div', { class: 'row' }, boxes.map((b) => h('label', { class: 'check' }, b.box, b.s.name))))
        : h('p', { class: 'small muted', style: 'margin:0' }, '個人用カタログ「マイカタログ」を作って入れます。'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'DL先は、作品ごとのリンク → 配布ページ（移転先）→ 移転前の順に入れます。同じ作品（作品名＋作者）がもう個人用カタログにあるときは、DL先・紹介ページを足します（移転前に書いたDL先は「旧（移転済み）」にします。作者さんのサイトは、空のときだけ入れます）。'),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '次へ')));
  });
}

/** 作品ごとの名前・作者・バージョンを確かめて、保存する */
async function confirmAndSave(items, common) {
  const rows = items.map((it) => {
    const r = {
      it, on: h('input', { type: 'checkbox', checked: true, 'aria-label': `${it.name || it.url}を登録する` }),
      name: h('input', { type: 'text', value: it.name || '', 'aria-label': '作品名' }),
      author: h('input', { type: 'text', value: common.author || it.author || '', 'aria-label': '作者' }),
      version: h('input', { type: 'text', class: 'ver', value: it.version || '', 'aria-label': 'バージョン' }),
    };
    r.state = h('span', { class: 'small muted' });
    const mark = () => { r.state.textContent = ownHolders(workKey({ name: r.name.value, author: r.author.value })).length ? '登録あり：DL先を足します' : ''; };
    r.name.addEventListener('input', mark);
    r.author.addEventListener('input', mark);
    mark();
    return r;
  });
  const err = h('p', { class: 'note bad small', style: 'display:none' });
  const ok = await modal((close) => {
    const submit = (ev) => {
      ev.preventDefault();
      const chosen = rows.filter((r) => r.on.checked);
      if (!chosen.length) { err.textContent = '登録する作品を1つ以上選んでください'; err.style.display = ''; return; }
      const noName = chosen.find((r) => !r.name.value.trim());
      if (noName) { err.textContent = `作品名を入れてください（${noName.it.url}）`; err.style.display = ''; noName.name.focus(); return; }
      close(true);
    };
    return h('form', { class: 'stack entry-edit', onsubmit: submit },
      h('h2', {}, '登録する作品を確かめる'),
      h('p', { class: 'small muted', style: 'margin:0' }, '作品名・作者・バージョンは、ここで直せます。チェックを外したものは登録しません。'),
      h('ul', { class: 'dl bulk-list' }, rows.map((r) => h('li', { class: 'stack', style: 'gap:2px' },
        h('div', { class: 'row' }, r.on,
          h('label', { class: 'field grow' }, '作品名', r.name),
          h('label', { class: 'field' }, '作者', r.author),
          h('label', { class: 'field' }, 'バージョン', r.version)),
        h('div', { class: 'small muted', style: 'word-break:break-all' }, [r.it.url, r.it.note].filter(Boolean).join('　'), '　', r.state)))),
      err,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { type: 'button', class: 'btn', onclick: () => close(false) }, 'やめる'),
        h('button', { type: 'submit', class: 'btn primary' }, '登録する')));
  });
  if (!ok) return;
  const chosen = rows.filter((r) => r.on.checked);
  await busy('個人用カタログに登録', async () => {
    let ids = common.ids;
    if (!ids.length) ids = [(await createOwn('マイカタログ')).id];
    let added = 0, merged = 0;
    for (const r of chosen) {
      const rating = common.rating === 'auto' ? r.it.rating || 'all' : common.rating;
      const entry = bulkEntry({ ...r.it, name: r.name.value, author: r.author.value, version: r.version.value, rating }, common);
      const key = workKey(entry);
      const holders = ownHolders(key);
      if (holders.length) {
        await saveOwnEntry(mergeEntry(holders[0].e, entry), { origKey: key, targetIds: [...new Set([...ids, ...holders.map((x) => x.s.id)])] });
        merged++;
      } else {
        await saveOwnEntry(entry, { targetIds: ids });
        added++;
      }
    }
    await refreshStates();
    toast([added ? `${added}件を個人用カタログに登録しました` : '', merged ? `${merged}件は、登録済みの作品にDL先を足しました` : ''].filter(Boolean).join('。'), { ms: 9000 });
  });
}

/**
 * 配布ページのリンク一覧で選んだものを、まとめて登録する
 * @param {{url: string, title?: string}} st 読んだ配布ページ
 * @param {{url: string, text?: string}[]} links
 */
export async function bulkFromLinks(st, links) {
  const common = await askCommon({ count: links.length, pageUrl: st.folder ? '' : st.url, canFetch: true });
  if (!common) return;
  const items = links.map((l) => ({ url: l.url, ...guessFromLink(l), note: common.fetch ? '' : 'リンクから推測' }));
  if (common.fetch) {
    S.progressByCount = true;
    try {
      const got = await busy(`${items.length}件の中身を読んでいます`, async () => {
        let done = 0;
        busyProgress(0, `${items.length}件の中身を読んでいます… 0 / ${items.length}`);
        // 相手のサイトに負担をかけないよう、同時に3件まで
        await eachParallel(items, 3, async (it) => {
          const res = await fetchOnce(it.url).catch((e) => ({ kind: 'error', message: e.message }));
          if (res.kind === 'zip') {
            const info = await openArchive(res.bytes, res.fileName).then(infoFromOpened).catch(() => null);
            if (info) Object.assign(it, info);
            else it.note = '中身を読めなかったので、リンクから推測';
          } else it.note = '取ってこられなかったので、リンクから推測';
          done++;
          busyProgress(done / items.length, `${items.length}件の中身を読んでいます… ${done} / ${items.length}`);
        });
        return true;
      });
      if (!got) return;
    } finally {
      S.progressByCount = false;
    }
  }
  await confirmAndSave(items, common);
}

/**
 * まとめてDLの一覧（配布ページから取ってきたもの）を、まとめて登録する
 * @param {{srcUrl: string, opened: object}[]} batchItems
 * @param {string} pageUrl 取ってきた配布ページ
 */
export async function bulkFromBatch(batchItems, pageUrl = '') {
  if (!batchItems.length) { toast('登録できるものがありません', { bad: true }); return; }
  const common = await askCommon({ count: batchItems.length, pageUrl });
  if (!common) return;
  const items = [];
  for (const b of batchItems) items.push({ url: b.srcUrl, ...guessFromLink({ url: b.srcUrl }), ...await infoFromOpened(b.opened) });
  await confirmAndSave(items, common);
}
