// 整理・二重チェック：
//  ・Scenarioフォルダに、同じ作品が2つ以上入っていないか（エンジンごと）
//  ・zipの保存場所に、同じファイルが重なっていないか・同じ作品の古い版がないか
//  ・保存場所にあるけれど、まだどのエンジンにも入れていない作品（積みシナ候補）
//  ・入れてあるけれど、保存場所に元のzipが無い作品
// 動かしたり消したりするのは、ボタンを押して、確認の一覧で「整理する」を押したときだけ。
// 「バックアップを用意する」（最初からオン）なら、消さずに CWCatalog_backup フォルダへ移す。
// 除外したグループ・作品・ファイルは、整理のときに触らない（除外は覚えておく）。

import { openArchive, sha256Hex } from '../core/archive.js';
import { moveToBackup, BACKUP_DIR } from '../core/install.js';
import { listFiles, removeAt } from '../core/fs.js';
import { normalizeName, compareVersions } from '../core/catalog.js';
import { S, render, busy, busyText, engine, dirOf } from './state.js';
import { store } from './store.js';
import { h, toast, modal, fmtSize, fmtDate } from './ui.js';
import { archiveDirOf } from './add.js';
import { openLocalFiles } from './localfiles.js';
import { applyTags } from './tags.js';
import { isStashId, showLog } from './materials.js';
import { backupOpts, backupPlace, backupFull } from './backup.js';

const ARCH = /\.(zip|wsn|cab|lzh|lha|7z)$/i;
const MAX_OPEN = 300 * 1024 * 1024;
const keyOf = (name, author) => `${normalizeName(name)}|${normalizeName(author)}`;
const recKey = (r) => `rec:${r.id}`;
const zipKey = (z) => `zip:${z.rel}`;
const verOf = (r) => r.version || r.versionGuess || '';

// ------------------------------------------------------------ 除外（覚えておく）
async function loadExclude() {
  S.tidyEx = { keys: [], ...((await store.get('tidyExclude')) || {}) };
}
const isEx = (k) => !!S.tidyEx?.keys.includes(k);
async function toggleEx(k) {
  S.tidyEx.keys = isEx(k) ? S.tidyEx.keys.filter((x) => x !== k) : [...S.tidyEx.keys, k];
  await store.set('tidyExclude', S.tidyEx);
  S.tidy?.sel.delete(k);
  render();
}

// ------------------------------------------------------------ 調べる
export async function openTidy() {
  await loadExclude();
  const keepBackup = S.tidy?.backup ?? true;
  S.tidy = { running: true };
  render();
  const res = await busy('整理・二重チェック', analyze);
  S.tidy = res ? { ...res, sel: new Set(), backup: keepBackup } : null;
  render();
  document.getElementById('tidy')?.scrollIntoView?.({ block: 'start' });
}

/** 新しい版を先に（版→入れた日→場所の順で比べる） */
function newerFirst(a, b) {
  return compareVersions(verOf(b), verOf(a)) || String(b.installedAt || '').localeCompare(String(a.installedAt || '')) || (a.path || '').localeCompare(b.path || '', 'ja');
}

async function analyze() {
  const recs = S.records.filter((r) => r.type !== 'bookmark' && !isStashId(r.engineId) && !r.missing && r.name);
  // 1. Scenarioフォルダの二重（同じ場所の記録＝zipの中の複数シナリオは1つに数える）
  const byEngine = new Map();
  for (const r of recs) {
    const k = `dup:${r.engineId}::${keyOf(r.name, r.author)}`;
    if (!byEngine.has(k)) byEngine.set(k, new Map());
    byEngine.get(k).set(r.path, r);
  }
  const engineDup = [...byEngine.entries()].filter(([, m]) => m.size > 1)
    .map(([key, m]) => { const g = [...m.values()].sort(newerFirst); return { key, engineId: g[0].engineId, name: g[0].name, author: g[0].author, recs: g, sameVer: compareVersions(verOf(g[0]), verOf(g[1])) === 0 }; });

  // 2. zipの保存場所（バックアップの中は見ない）
  let zips = null;
  const errors = [];
  if (S.archive.ref) {
    const d = await archiveDirOf(true).catch(() => null);
    if (!d) errors.push('zipの保存場所を使う許可がありませんでした');
    else {
      const files = (await listFiles(d, '', 3)).filter((f) => ARCH.test(f.path) && !f.path.startsWith(`${BACKUP_DIR}/`));
      zips = [];
      for (const [i, f] of files.entries()) {
        busyText(`保存場所を調べています… ${i + 1}/${files.length}　${f.path.split('/').pop()}`);
        const z = { rel: f.path, size: f.size, sha: '', scenarios: [] };
        if (f.size <= MAX_OPEN) {
          try {
            const bytes = await f.read();
            z.sha = await sha256Hex(bytes);
            const o = await openArchive(bytes, f.path.split('/').pop());
            z.scenarios = o.scenarios.map((s) => ({ name: s.name, author: s.author, version: s.versionGuess || '' }));
          } catch (e) { errors.push(`${f.path}：${e.message}`); }
        } else z.note = 'ファイルサイズが大きいため、内容は照合していません';
        zips.push(z);
      }
    }
  }
  let zipDup = [], zipOld = [], notInstalled = [], noZip = [];
  if (zips) {
    // 中身がまったく同じファイル
    const bySha = new Map();
    for (const z of zips) if (z.sha) { if (!bySha.has(z.sha)) bySha.set(z.sha, []); bySha.get(z.sha).push(z); }
    zipDup = [...bySha.entries()].filter(([, g]) => g.length > 1)
      .map(([sha, g]) => ({ key: `zipdup:${sha}`, files: g.sort((a, b) => a.rel.length - b.rel.length || a.rel.localeCompare(b.rel, 'ja')) }));
    // 同じ作品の、中身の違うファイル（古い版かもしれない）。1本だけ入っているzipで比べる
    const single = [...bySha.values()].map((g) => g[0]).filter((z) => z.scenarios.length === 1);
    const byWork = new Map();
    for (const z of single) {
      const k = keyOf(z.scenarios[0].name, z.scenarios[0].author);
      if (!byWork.has(k)) byWork.set(k, []);
      byWork.get(k).push(z);
    }
    zipOld = [...byWork.entries()].filter(([, g]) => g.length > 1).map(([k, g]) => {
      const files = g.sort((a, b) => compareVersions(b.scenarios[0].version, a.scenarios[0].version) || a.rel.localeCompare(b.rel, 'ja'));
      return { key: `zipold:${k}`, name: files[0].scenarios[0].name, author: files[0].scenarios[0].author, files, decided: compareVersions(files[0].scenarios[0].version, files[1].scenarios[0].version) > 0 };
    });
    const installed = new Set(recs.map((r) => keyOf(r.name, r.author)));
    const installedSha = new Set(recs.map((r) => r.sha256).filter(Boolean));
    notInstalled = zips.filter((z) => z.scenarios.length && !installedSha.has(z.sha) && !z.scenarios.some((s) => installed.has(keyOf(s.name, s.author))));
    const zipKeys = new Set(zips.flatMap((z) => z.scenarios.map((s) => keyOf(s.name, s.author))));
    const zipSha = new Set(zips.map((z) => z.sha).filter(Boolean));
    noZip = recs.filter((r) => r.engineId === S.engineId && !zipKeys.has(keyOf(r.name, r.author)) && !(r.sha256 && zipSha.has(r.sha256)));
  }
  const tsumi = recs.filter((r) => (r.tags || []).includes('積み'));
  return { at: new Date().toISOString(), engineDup, zips, zipDup, zipOld, notInstalled, noZip, tsumi, errors };
}

// ------------------------------------------------------------ 動かす先の表示
const isApp = () => S.platform.kind === 'app';
const disp = (rel) => (isApp() ? rel.replace(/\//g, '\\') : rel);
/** エンジンのバックアップ先（表示用） */
export const engineBackupPlace = (engineId) => backupPlace('engine', engineId);
const archiveBackupPlace = () => backupPlace('zip');
const placeOf = (it) => (it.kind === 'rec' ? engineBackupPlace(it.rec.engineId) : archiveBackupPlace());
const labelOf = (it) => (it.kind === 'rec' ? `${engine(it.rec.engineId)?.name || ''}：${disp(it.rec.path)}` : `保存場所：${disp(it.z.rel)}`);

// ------------------------------------------------------------ 動かす・消す
/**
 * @param {{kind:'rec'|'zip', rec?:object, z?:object}[]} list
 * @returns {Promise<string[]>} 結果の記録
 */
async function perform(list, backup) {
  const log = [];
  const dirs = new Map();
  const dirFor = async (it) => {
    const k = it.kind === 'rec' ? it.rec.engineId : '__zip';
    if (!dirs.has(k)) dirs.set(k, it.kind === 'rec' ? await dirOf(k, true) : await archiveDirOf(true));
    const d = dirs.get(k);
    if (!d) throw new Error(it.kind === 'rec' ? 'エンジンのフォルダに接続できませんでした' : 'zipの保存場所を使う許可がありませんでした');
    return d;
  };
  for (const [i, it] of list.entries()) {
    busyText(`整理しています… ${i + 1}/${list.length}`);
    const rel = it.kind === 'rec' ? it.rec.path : it.z.rel;
    try {
      const d = await dirFor(it);
      if (backup) {
        const kind = it.kind === 'rec' ? 'engine' : 'zip';
        const eid = it.kind === 'rec' ? it.rec.engineId : '';
        const dest = await moveToBackup(d, rel, { anywhere: it.kind === 'zip', ...(await backupOpts(kind, eid)) });
        log.push(`移動　${labelOf(it)}\n　　→ ${backupFull(kind, eid, dest)}`);
      } else {
        await removeAt(d, rel);
        log.push(`削除　${labelOf(it)}`);
      }
      if (it.kind === 'rec') {
        for (const r of S.records.filter((x) => x.engineId === it.rec.engineId && x.path === rel)) await store.deleteRecord(r.id);
      }
    } catch (e) {
      log.push(`失敗　${labelOf(it)}：${e.message}`);
    }
  }
  S.records = await store.records();
  return log;
}

/** 確認の一覧を見せてから整理する */
async function confirmAndRun(title, plan, keeps = []) {
  const t = S.tidy;
  if (!plan.length) { toast('整理対象のファイルはありません（除外設定中のファイルは対象外です）'); return; }
  const backupBox = h('input', { type: 'checkbox', checked: t.backup, 'aria-label': 'バックアップを用意する' });
  const places = [...new Set(plan.map(placeOf))];
  const warn = h('p', { class: 'note bad small', style: 'margin:0', hidden: t.backup }, 'バックアップを作成しない場合、整理したファイルは復元できません（ごみ箱にも移動されません）。');
  backupBox.addEventListener('change', () => { warn.hidden = backupBox.checked; });
  const ok = await modal((close) => h('div', { class: 'stack' },
    h('h2', {}, title),
    h('label', { class: 'check' }, backupBox, '整理時にバックアップを作成します（削除せず CWCatalog_backup フォルダへ移動します）。'),
    h('div', { class: 'small' }, '移動先：', h('ul', { style: 'margin:2px 0 0;padding-left:1.2em' }, places.map((p) => h('li', { style: 'word-break:break-all' }, p)))),
    warn,
    keeps.length ? h('div', {}, h('div', { class: 'small muted' }, `残すもの（${keeps.length}件）`), h('pre', { class: 'readme log' }, keeps.join('\n'))) : null,
    h('div', {}, h('div', { class: 'small muted' }, `移動対象（${plan.length}件）`), h('pre', { class: 'readme log', id: 'tidy-plan' }, plan.map((it) => `・${labelOf(it)}${it.why ? `　（${it.why}）` : ''}`).join('\n'))),
    h('div', { class: 'row', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'やめる'),
      h('button', { class: 'btn primary', onclick: () => close(true) }, 'この内容で整理する'))));
  if (!ok) return;
  t.backup = backupBox.checked;
  const log = await busy('整理する', () => perform(plan, t.backup));
  if (!log) return;
  await showLog(`整理しました（${plan.length}件）`, log);
  await openTidy();
}

/** 「最新版のみ残してフォルダを整理する」の内容を作る */
function planLatest(t) {
  const plan = [], keeps = [];
  for (const g of t.engineDup) {
    if (isEx(g.key)) continue;
    const [keep, ...rest] = g.recs;
    const drop = rest.filter((r) => !isEx(recKey(r)));
    if (!drop.length) continue;
    keeps.push(`・${engine(g.engineId)?.name || ''}：${disp(keep.path)}${verOf(keep) ? `（ver ${verOf(keep)}）` : ''}`);
    for (const r of drop) plan.push({ kind: 'rec', rec: r, why: `${g.name} の${g.sameVer ? '同じ版' : '古い版'}${verOf(r) ? ` ver ${verOf(r)}` : ''}` });
  }
  for (const g of t.zipDup) {
    if (isEx(g.key)) continue;
    const [keep, ...rest] = g.files;
    const drop = rest.filter((z) => !isEx(zipKey(z)));
    if (!drop.length) continue;
    keeps.push(`・保存場所：${disp(keep.rel)}`);
    for (const z of drop) plan.push({ kind: 'zip', z, why: `「${disp(keep.rel)}」と中身が同じ` });
  }
  const dupSet = new Set(plan.filter((p) => p.kind === 'zip').map((p) => p.z.rel));
  for (const g of t.zipOld || []) {
    if (isEx(g.key) || !g.decided) continue;
    const [keep, ...rest] = g.files;
    const drop = rest.filter((z) => !isEx(zipKey(z)) && !dupSet.has(z.rel));
    if (!drop.length) continue;
    keeps.push(`・保存場所：${disp(keep.rel)}（ver ${keep.scenarios[0].version}）`);
    for (const z of drop) plan.push({ kind: 'zip', z, why: `${g.name} の古い版${z.scenarios[0].version ? ` ver ${z.scenarios[0].version}` : ''}` });
  }
  return { plan, keeps };
}

// ------------------------------------------------------------ 画面
export function viewTidy() {
  const t = S.tidy;
  if (t.running) return h('div', { class: 'card tidy', id: 'tidy' }, h('p', { class: 'small muted', style: 'margin:0' }, '照合中…'));
  const refresh = async () => { S.records = await store.records(); await openTidy(); };
  const items = new Map(); // 選べるもの key → {kind, rec|z}
  const sec = (title, n, body, open = true, id = '') => h('details', { class: 'group', open: open && n > 0 ? true : null, id: id || null },
    h('summary', {}, h('span', { class: 'group-name' }, title), h('span', { class: `badge ${n ? 'update' : 'ok'}` }, n ? `${n}件` : 'なし')), body);
  const exBtn = (k, what) => h('button', { class: `btn ghost sm${isEx(k) ? ' on' : ''}`, 'aria-pressed': isEx(k) ? 'true' : 'false', title: isEx(k) ? '除外を解除し、再び整理対象に含めます' : '整理・二重チェックの対象から外します', onclick: () => toggleEx(k) }, isEx(k) ? `除外中（${what}）・戻す` : `${what}を除外`);
  const pickBox = (k, it, label, disabled = false) => {
    items.set(k, it);
    return h('input', { type: 'checkbox', checked: t.sel.has(k), disabled: disabled || isEx(k), 'aria-label': `${label}を選ぶ`, onchange: (ev) => { if (ev.target.checked) t.sel.add(k); else t.sel.delete(k); document.getElementById('tidy-selbar')?.replaceWith(selBar()); } });
  };
  const moveOne = (it) => h('button', { class: 'btn sm', onclick: () => confirmAndRun('1件を整理する', [it]) }, t.backup ? 'CWCatalog_backup へ移動' : '削除する');

  // Scenarioフォルダの二重
  const nDup = t.engineDup.filter((g) => !isEx(g.key)).length;
  const dupBody = h('div', { class: 'stack' },
    t.engineDup.length ? h('p', { class: 'small muted', style: 'margin:0' }, '各作品の最上段が、最も新しいバージョン（不明な場合は導入日時）です。「最新版のみ残してフォルダを整理する」を実行すると、このファイルが残ります。') : null,
    h('ul', { class: 'dl' }, t.engineDup.map((g) => h('li', { class: `stack${isEx(g.key) ? ' excluded' : ''}` },
      h('div', { class: 'row' }, h('b', {}, g.name), h('span', { class: 'small muted grow' }, `${g.author}・${engine(g.engineId)?.name || ''}・${g.recs.length}箇所`), exBtn(g.key, 'この作品')),
      h('ul', { class: 'dl' }, g.recs.map((r, i) => {
        const k = recKey(r);
        const it = { kind: 'rec', rec: r };
        return h('li', { class: isEx(k) ? 'excluded' : null },
          i > 0 ? pickBox(k, it, r.path, isEx(g.key)) : h('span', { class: 'badge ok' }, '残す'),
          h('span', { class: 'grow', style: 'word-break:break-all' }, disp(r.path)),
          h('span', { class: 'small muted' }, [verOf(r) ? `ver ${verOf(r)}` : '版不明', r.installedAt ? `導入日 ${fmtDate(r.installedAt)}` : ''].filter(Boolean).join('・')),
          exBtn(k, 'これ'),
          i > 0 && !isEx(k) && !isEx(g.key) ? moveOne(it) : null);
      }))))));

  // 保存場所：中身が同じファイル
  const nZipDup = t.zipDup.filter((g) => !isEx(g.key)).length;
  const zipDupBody = h('ul', { class: 'dl' }, t.zipDup.map((g) => h('li', { class: `stack${isEx(g.key) ? ' excluded' : ''}` },
    h('div', { class: 'row' }, h('span', { class: 'small muted grow' }, `内容が完全に一致するファイル（サイズ：${fmtSize(g.files[0].size)}）`), exBtn(g.key, 'このグループ')),
    h('ul', { class: 'dl' }, g.files.map((z, i) => {
      const k = zipKey(z);
      const it = { kind: 'zip', z };
      return h('li', { class: isEx(k) ? 'excluded' : null },
        i > 0 ? pickBox(k, it, z.rel, isEx(g.key)) : h('span', { class: 'badge ok' }, '残す'),
        h('span', { class: 'grow', style: 'word-break:break-all' }, disp(z.rel)),
        exBtn(k, 'これ'),
        i > 0 && !isEx(k) && !isEx(g.key) ? moveOne(it) : null);
    })))));

  // 保存場所：同じ作品の古い版
  const nZipOld = (t.zipOld || []).filter((g) => !isEx(g.key)).length;
  const zipOldBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, '同一作品の異なるファイルです。ファイル名からバージョンが判別できないものは、自動整理の対象外となります。'),
    h('ul', { class: 'dl' }, (t.zipOld || []).map((g) => h('li', { class: `stack${isEx(g.key) ? ' excluded' : ''}` },
      h('div', { class: 'row' }, h('b', {}, g.name), h('span', { class: 'small muted grow' }, `${g.author}・${g.files.length}ファイル${g.decided ? '' : '・新旧の判別ができません'}`), exBtn(g.key, 'この作品')),
      h('ul', { class: 'dl' }, g.files.map((z, i) => {
        const k = zipKey(z);
        const it = { kind: 'zip', z };
        return h('li', { class: isEx(k) ? 'excluded' : null },
          i > 0 || !g.decided ? pickBox(k, it, z.rel, isEx(g.key)) : h('span', { class: 'badge ok' }, '残す'),
          h('span', { class: 'grow', style: 'word-break:break-all' }, disp(z.rel)),
          h('span', { class: 'small muted' }, `${z.scenarios[0].version ? `ver ${z.scenarios[0].version}` : '版不明'}・${fmtSize(z.size)}`),
          exBtn(k, 'これ'));
      }))))));

  const chosen = new Set();
  const notList = t.notInstalled.filter((z) => !isEx(zipKey(z)));
  const notBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'zip・wsn保存フォルダに存在しますが、いずれのエンジンのScenarioフォルダにも導入されていない作品です（積みシナ候補）。'),
    h('ul', { class: 'dl' }, t.notInstalled.map((z) => h('li', { class: isEx(zipKey(z)) ? 'excluded' : null },
      h('input', { type: 'checkbox', disabled: isEx(zipKey(z)), 'aria-label': `${z.rel}を入れるものに選ぶ`, onchange: (ev) => { if (ev.target.checked) chosen.add(z); else chosen.delete(z); } }),
      h('span', { class: 'grow' }, h('b', {}, z.scenarios.map((s) => s.name).join('・')), h('span', { class: 'small muted' }, `　${z.scenarios[0].author}・${disp(z.rel)}・${fmtSize(z.size)}`)),
      exBtn(zipKey(z), 'これ')))),
    notList.length ? h('div', { class: 'row' }, h('button', {
      class: 'btn primary sm', onclick: async () => {
        if (!chosen.size) { toast('導入する作品を選択してください', { bad: true }); return; }
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
    }, '選択した作品を導入する（「DLする」タブへ移動）')) : null);

  const noZipList = t.noZip.filter((r) => !isEx(recKey(r)));
  const noZipBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, `「${engine()?.name || ''}」のScenarioフォルダに導入済みですが、zip・wsn保存フォルダ内に元の入手ファイル（zip/wsn/cab/lzh/7z等）が見つかりません。再導入に備え、必要な作品は再ダウンロードして配置することをお勧めします。`),
    h('ul', { class: 'dl' }, t.noZip.map((r) => h('li', { class: isEx(recKey(r)) ? 'excluded' : null }, h('span', { class: 'grow' }, h('b', {}, r.name), h('span', { class: 'small muted' }, `　${r.author}・${disp(r.path)}`)), exBtn(recKey(r), 'これ')))));

  const tsumiBody = h('div', { class: 'stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, '「積み」タグが設定されている作品です。プレイを開始した作品は、選択メニューの「タグを付ける」から「プレイ中」や「クリア」へ変更してください。'),
    h('ul', { class: 'dl' }, t.tsumi.map((r) => h('li', {},
      h('span', { class: 'grow' }, h('b', {}, r.name), h('span', { class: 'small muted' }, `　${r.author}・${engine(r.engineId)?.name || ''}`)),
      h('button', { class: 'btn ghost sm', onclick: async () => { await applyTags([r], ['プレイ中'], ['積み']); await refresh(); } }, 'プレイ中にする')))));

  // 選んだものをまとめて
  const selBar = () => {
    const list = [...t.sel].filter((k) => items.has(k) && !isEx(k)).map((k) => items.get(k));
    return h('div', { class: 'row tidy-selbar', id: 'tidy-selbar' },
      h('span', { class: 'small' }, `選択中：${list.length}件`),
      h('button', { class: 'btn sm', disabled: !list.length, onclick: () => confirmAndRun(`選んだ${list.length}件を整理する`, list) }, t.backup ? '選択した作品を CWCatalog_backup へ移動' : '選択した作品を削除'),
      list.length ? h('button', { class: 'btn ghost sm', onclick: () => { t.sel.clear(); render(); } }, '選択を解除') : null);
  };

  const latest = planLatest(t);
  const backupBox = h('input', { type: 'checkbox', checked: t.backup, 'aria-label': '整理するときバックアップを用意する', onchange: (ev) => { t.backup = ev.target.checked; render(); } });
  const places = [...new Set([...t.engineDup.map((g) => engineBackupPlace(g.engineId)), ...(t.zips && (t.zipDup.length || t.zipOld?.length) ? [archiveBackupPlace()] : [])])];

  const sections = h('div', { class: 'stack' },
    sec('Scenarioフォルダ内で作品が重複しています', nDup, dupBody, true, 'tidy-dup'),
    t.zips ? sec(`zip・wsn保存フォルダ内でファイルが重複しています（${S.archive.label}）`, nZipDup, zipDupBody, true, 'tidy-zipdup') : null,
    t.zips ? sec('zip・wsn保存フォルダ内に別バージョンの同一作品があります', nZipOld, zipOldBody, true, 'tidy-zipold') : null);

  return h('div', { class: 'card stack tidy', id: 'tidy' },
    h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, '整理・二重チェック'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, `確認日時：${fmtDate(t.at)}`),
        h('button', { class: 'btn sm', onclick: refresh }, '再確認'),
        h('button', { class: 'btn ghost sm', onclick: () => { S.tidy = null; render(); } }, '閉じる'))),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Scenarioフォルダは、直近で「読み取る」を実行した時点のデータで照合しています。新たにファイルを追加・削除した場合は、あらかじめ「読み取る」を実行してください。'),
    h('div', { class: 'card soft stack', style: 'margin:0' },
      h('label', { class: 'check' }, backupBox, '整理時にバックアップを作成します（削除せず CWCatalog_backup フォルダへ移動します）。'),
      t.backup
        ? (places.length ? h('div', { class: 'small' }, '移動先：', h('ul', { style: 'margin:2px 0 0;padding-left:1.2em' }, places.map((p) => h('li', { style: 'word-break:break-all' }, p)))) : null)
        : h('p', { class: 'note bad small', style: 'margin:0' }, 'バックアップを作成しない場合、整理したファイルは復元できません（ごみ箱にも移動されません）。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', id: 'tidy-latest', disabled: !latest.plan.length, onclick: () => confirmAndRun('最新版のみ残してフォルダを整理する', latest.plan, latest.keeps) },
          `最新版のみ残してフォルダを整理する（${latest.plan.length}件）`),
        h('span', { class: 'small muted' }, '実行前に、残すファイルと移動するファイルの一覧を表示します。除外設定した作品は処理対象外です。')),
      selBar()),
    sections,
    t.zips ? sec('zip・wsn保存フォルダに未導入の作品があります（積みシナ候補）', notList.length, notBody) : null,
    t.zips ? sec('Scenarioフォルダに導入済みですが、元のzipファイルがありません', noZipList.length, noZipBody, false) : null,
    !t.zips ? h('p', { class: 'note small', style: 'margin:0' }, '「設定 ＞ zip・wsnの保存場所」を設定すると、zip・wsn保存フォルダ内の重複や未導入作品（積みシナ候補）も自動検出できます。') : null,
    sec('「積み」タグが設定されている作品', t.tsumi.length, tsumiBody, false),
    S.tidyEx.keys.length ? h('div', { class: 'row small' }, h('span', { class: 'muted' }, `除外しているもの：${S.tidyEx.keys.length}件`),
      h('button', { class: 'btn ghost sm', onclick: async () => { S.tidyEx.keys = []; await store.set('tidyExclude', S.tidyEx); render(); } }, '除外をすべてやめる')) : null,
    t.errors.length ? h('details', { class: 'small' }, h('summary', {}, `読めなかったもの ${t.errors.length}件`), h('ul', {}, t.errors.map((e) => h('li', {}, e)))) : null);
}
