// 整理・二重チェック：
//  ・Scenarioフォルダに、同じ作品が2つ以上入っていないか（エンジンごと）
//  ・zipの保存場所に、同じファイルが重なっていないか
//  ・保存場所にあるけれど、まだどのエンジンにも入れていない作品（積みシナ候補）
//  ・入れてあるけれど、保存場所に元のzipが無い作品
// 消したり動かしたりするのは、ボタンを押したときだけ（Scenarioの中のものは消さずに CWCatalog_backup へ移す）。

import { openArchive, sha256Hex } from '../core/archive.js';
import { moveToBackup } from '../core/install.js';
import { listFiles, removeAt } from '../core/fs.js';
import { normalizeName } from '../core/catalog.js';
import { S, render, busy, busyText, engine, dirOf, confirmBox } from './state.js';
import { store } from './store.js';
import { h, toast, fmtSize, fmtDate } from './ui.js';
import { archiveDirOf } from './add.js';
import { openLocalFiles } from './localfiles.js';
import { applyTags } from './tags.js';

const ARCH = /\.(zip|wsn|cab|lzh|lha|7z)$/i;
const MAX_OPEN = 300 * 1024 * 1024;
const keyOf = (name, author) => `${normalizeName(name)}|${normalizeName(author)}`;

export async function openTidy() {
  S.tidy = { running: true };
  render();
  const res = await busy('整理・二重チェック', analyze);
  S.tidy = res || null;
  render();
  document.getElementById('tidy')?.scrollIntoView?.({ block: 'start' });
}

async function analyze() {
  const recs = S.records.filter((r) => r.type !== 'bookmark' && !r.missing && r.name);
  // 1. Scenarioフォルダの二重
  const byEngine = new Map();
  for (const r of recs) {
    const k = `${r.engineId}::${keyOf(r.name, r.author)}`;
    if (!byEngine.has(k)) byEngine.set(k, []);
    byEngine.get(k).push(r);
  }
  const engineDup = [...byEngine.values()].filter((g) => g.length > 1)
    .map((g) => ({ engineId: g[0].engineId, name: g[0].name, author: g[0].author, recs: g.sort((a, b) => (a.path || '').localeCompare(b.path || '', 'ja')) }));

  // 2. zipの保存場所
  let zips = null;
  const errors = [];
  if (S.archive.ref) {
    const d = await archiveDirOf(true).catch(() => null);
    if (!d) errors.push('zipの保存場所を使う許可がありませんでした');
    else {
      const files = (await listFiles(d, '', 3)).filter((f) => ARCH.test(f.path));
      zips = [];
      for (const [i, f] of files.entries()) {
        busyText(`保存場所を調べています… ${i + 1}/${files.length}　${f.path.split('/').pop()}`);
        const z = { rel: f.path, size: f.size, sha: '', scenarios: [] };
        if (f.size <= MAX_OPEN) {
          try {
            const bytes = await f.read();
            z.sha = await sha256Hex(bytes);
            const o = await openArchive(bytes, f.path.split('/').pop());
            z.scenarios = o.scenarios.map((s) => ({ name: s.name, author: s.author }));
          } catch (e) { errors.push(`${f.path}：${e.message}`); }
        } else z.note = '大きいため中身は見ていません';
        zips.push(z);
      }
    }
  }
  let zipDup = [], notInstalled = [], noZip = [];
  if (zips) {
    const bySha = new Map();
    for (const z of zips) if (z.sha) { if (!bySha.has(z.sha)) bySha.set(z.sha, []); bySha.get(z.sha).push(z); }
    zipDup = [...bySha.values()].filter((g) => g.length > 1);
    const installed = new Set(recs.map((r) => keyOf(r.name, r.author)));
    const installedSha = new Set(recs.map((r) => r.sha256).filter(Boolean));
    notInstalled = zips.filter((z) => z.scenarios.length && !installedSha.has(z.sha) && !z.scenarios.some((s) => installed.has(keyOf(s.name, s.author))));
    const zipKeys = new Set(zips.flatMap((z) => z.scenarios.map((s) => keyOf(s.name, s.author))));
    const zipSha = new Set(zips.map((z) => z.sha).filter(Boolean));
    noZip = recs.filter((r) => r.engineId === S.engineId && !zipKeys.has(keyOf(r.name, r.author)) && !(r.sha256 && zipSha.has(r.sha256)));
  }
  const tsumi = recs.filter((r) => (r.tags || []).includes('積み'));
  return { at: new Date().toISOString(), engineDup, zips, zipDup, notInstalled, noZip, tsumi, errors };
}

export function viewTidy() {
  const t = S.tidy;
  if (t.running) return h('div', { class: 'card tidy', id: 'tidy' }, h('p', { class: 'small muted', style: 'margin:0' }, '調べています…'));
  const sec = (title, n, body, open = true) => h('details', { class: 'group', open: open && n > 0 ? true : null },
    h('summary', {}, h('span', { class: 'group-name' }, title), h('span', { class: `badge ${n ? 'update' : 'ok'}` }, n ? `${n}件` : 'なし')), body);
  const refresh = async () => { S.records = await store.records(); await openTidy(); };

  const dupBody = h('ul', { class: 'dl' }, t.engineDup.map((g) => h('li', { class: 'stack' },
    h('div', {}, h('b', {}, g.name), h('span', { class: 'small muted' }, `　${g.author}・${engine(g.engineId)?.name || ''}・${g.recs.length}か所`)),
    h('ul', { class: 'dl' }, g.recs.map((r) => h('li', {},
      h('span', { class: 'grow', style: 'word-break:break-all' }, r.path),
      h('span', { class: 'small muted' }, [r.version ? `ver ${r.version}` : '', r.installedAt ? `入れた日 ${fmtDate(r.installedAt)}` : ''].filter(Boolean).join('・')),
      h('button', {
        class: 'btn sm', onclick: async () => {
          if (!(await confirmBox(`「${r.path}」を、消さずに CWCatalog_backup フォルダへ移します。よろしいですか？`))) return;
          await busy('CWCatalog_backup へ移す', async () => {
            const d = await dirOf(r.engineId, true);
            if (!d) throw new Error('エンジンのフォルダに接続できませんでした');
            const dest = await moveToBackup(d, r.path);
            await store.deleteRecord(r.id);
            toast(`${r.path} を ${dest} に移しました`, { ms: 8000 });
          });
          await refresh();
        },
      }, 'CWCatalog_backup に移す')))))));

  const zipDupBody = h('ul', { class: 'dl' }, t.zipDup.map((g) => h('li', { class: 'stack' },
    h('div', { class: 'small muted' }, `中身がまったく同じファイル（${fmtSize(g[0].size)}）`),
    h('ul', { class: 'dl' }, g.map((z, i) => h('li', {},
      h('span', { class: 'grow', style: 'word-break:break-all' }, z.rel),
      i > 0 ? h('button', {
        class: 'btn sm danger', onclick: async () => {
          if (!(await confirmBox(`保存場所の「${z.rel}」を消します（同じ中身の「${g[0].rel}」は残ります）。よろしいですか？`))) return;
          await busy('重なったファイルを消す', async () => { const d = await archiveDirOf(true); await removeAt(d, z.rel); toast(`${z.rel} を消しました`); });
          await refresh();
        },
      }, 'こちらを消す') : h('span', { class: 'badge ok' }, '残す')))))));

  const chosen = new Set();
  const notBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'zipの保存場所にあるけれど、どのエンジンのScenarioにも入っていない作品です（積みシナ候補）。'),
    h('ul', { class: 'dl' }, t.notInstalled.map((z) => h('li', {},
      h('input', { type: 'checkbox', 'aria-label': `${z.rel}を選ぶ`, onchange: (ev) => { if (ev.target.checked) chosen.add(z); else chosen.delete(z); } }),
      h('span', { class: 'grow' }, h('b', {}, z.scenarios.map((s) => s.name).join('・')), h('span', { class: 'small muted' }, `　${z.scenarios[0].author}・${z.rel}・${fmtSize(z.size)}`))))),
    t.notInstalled.length ? h('div', { class: 'row' }, h('button', {
      class: 'btn primary sm', onclick: async () => {
        if (!chosen.size) { toast('入れる作品にチェックを付けてください', { bad: true }); return; }
        const files = await busy('ファイルを読み込み', async () => {
          const d = await archiveDirOf(true);
          const all = await listFiles(d, '', 3);
          const out = [];
          for (const z of chosen) {
            const f = all.find((x) => x.path === z.rel);
            if (f) out.push({ name: z.rel.split('/').pop(), bytes: await f.read() });
          }
          return out;
        });
        if (files?.length) await openLocalFiles(files);
      },
    }, '選んだものを入れる（シナリオをDLするタブへ）')) : null);

  const noZipBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, `「${engine()?.name || ''}」に入っているけれど、保存場所に元のzipが見当たらない作品です。入れ直したいときに困らないよう、取っておきたいものはDLし直して保存場所に置いてください。`),
    h('ul', { class: 'dl' }, t.noZip.map((r) => h('li', {}, h('span', { class: 'grow' }, h('b', {}, r.name), h('span', { class: 'small muted' }, `　${r.author}・${r.path}`))))));

  const tsumiBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, '「積み」タグを付けた作品です。遊び始めたら、選んで「タグを付ける」で「プレイ中」や「クリア」にしてください。'),
    h('ul', { class: 'dl' }, t.tsumi.map((r) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, r.name), h('span', { class: 'small muted' }, `　${r.author}・${engine(r.engineId)?.name || ''}`)),
      h('button', { class: 'btn ghost sm', onclick: async () => { await applyTags([r], ['プレイ中'], ['積み']); await refresh(); } }, 'プレイ中にする')))));

  return h('div', { class: 'card stack tidy', id: 'tidy' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, '整理・二重チェック'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, `調べた日時：${fmtDate(t.at)}`),
        h('button', { class: 'btn sm', onclick: refresh }, 'もう一度調べる'),
        h('button', { class: 'btn ghost sm', onclick: () => { S.tidy = null; render(); } }, '閉じる'))),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Scenarioフォルダは、最後に「読み取る」を押したときの内容で調べています。新しく入れたものがあれば、先に「読み取る」を押してください。'),
    sec('同じ作品が2つ以上入っている（Scenarioフォルダ）', t.engineDup.length, dupBody),
    t.zips ? sec(`保存場所で、同じファイルが重なっている（${S.archive.label}）`, t.zipDup.length, zipDupBody) : null,
    t.zips ? sec('保存場所にあるけれど、まだ入れていない（積みシナ候補）', t.notInstalled.length, notBody) : null,
    t.zips ? sec('入れてあるけれど、保存場所に元のzipが無い', t.noZip.length, noZipBody, false) : null,
    !t.zips ? h('p', { class: 'note small', style: 'margin:0' }, 'zipの保存場所を設定すると（「設定」→「zip・wsnの保存場所」）、保存場所の重なりや、まだ入れていない作品（積みシナ候補）も調べられます。') : null,
    sec('「積み」タグの作品', t.tsumi.length, tsumiBody, false),
    t.errors.length ? h('details', { class: 'small' }, h('summary', {}, `読めなかったもの ${t.errors.length}件`), h('ul', {}, t.errors.map((e) => h('li', {}, e)))) : null);
}
