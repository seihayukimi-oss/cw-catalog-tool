// 素材・スキンなど（シナリオではないもの）：
//  ・「素材の置き場所」（自分で選んだフォルダ）に、分類フォルダを分けて入れる（実際のファイルも分かれる）
//  ・自分のフォルダ一覧で「素材の置き場所」を選ぶと、入っているものを一覧にして、タグ付け・分類フォルダへの移動ができる
// シナリオも、選んで「分類フォルダへ移す」で、Scenario の中の分類フォルダ（例：Scenario/_店）へ動かせる。

import { installMaterial, moveWithin } from '../core/install.js';
import { BACKUP_DIR } from '../core/install.js';
import { S, render, busy, dirOf, engine, rerenderList } from './state.js';
import { store, recordId } from './store.js';
import { h, toast, modal, fmtDate } from './ui.js';
import { applyCatalog } from './catalog-data.js';
import { tagEditor, tagChips, pickTags, applyTags, addTagName } from './tags.js';

export const MAT = '__mat';

export async function loadMaterials() {
  S.materials = { ref: null, label: '', ...((await store.get('materials')) || {}) };
  if (S.materials.ref) S.materialsDir = await S.platform.openFolder(S.materials.ref).catch(() => null);
}

export async function materialsDirOf(ask = true) {
  if (S.materialsDir) return S.materialsDir;
  if (!S.materials?.ref) return null;
  const d = await S.platform.openFolder(S.materials.ref, { ask });
  if (d) S.materialsDir = d;
  return d;
}

export async function pickMaterialsFolder(useOpfs = false) {
  return busy('素材の置き場所を選ぶ', async () => {
    const p = useOpfs ? await S.platform.opfsFolder('test-materials') : await S.platform.pickFolder({ title: '素材・スキンなどを置くフォルダを選んでください', id: 'cw-materials' });
    S.materials = { ref: p.ref, label: p.label };
    S.materialsDir = p.dir;
    await store.set('materials', S.materials);
    toast(`素材は「${p.label}」に入れるようにしました`);
    await scanMaterials(true);
  });
}

/** 素材の置き場所の分類フォルダ（1段目のフォルダ） */
async function categoriesOf(d) {
  return (await d.entries()).filter((e) => e.kind === 'dir' && e.name !== BACKUP_DIR).map((e) => e.name).sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 素材の置き場所を読み取る：1段目＝分類フォルダ、その中のフォルダ・ファイル＝1つの素材（分類が無いものは1段目のもの） */
export async function scanMaterials(quiet = false) {
  const d = await materialsDirOf(true);
  if (!d) throw new Error('素材の置き場所を使う許可がありませんでした');
  const old = new Map(S.records.filter((r) => r.engineId === MAT).map((r) => [r.id, r]));
  const items = [];
  const cats = await categoriesOf(d);
  const now = new Date().toISOString();
  const push = (path, kind) => {
    const id = recordId(MAT, path);
    const prev = old.get(id) || {};
    old.delete(id);
    items.push({ tags: [], ...prev, id, engineId: MAT, type: 'material', path, name: path.split('/').pop(), author: '', format: 'none', kind, missing: false, seenAt: now });
  };
  for (const e of await d.entries()) {
    if (e.kind === 'file') push(e.name, 'file');
  }
  for (const c of cats) {
    const sub = await d.dir(c);
    const ents = await sub.entries();
    // 中に素材らしいフォルダ・ファイルがあれば分類フォルダ、空なら空の分類
    for (const e of ents) push(`${c}/${e.name}`, e.kind);
  }
  const missing = [...old.values()].map((r) => ({ ...r, missing: true }));
  await store.putRecords([...items, ...missing]);
  S.records = await store.records();
  S.categories[MAT] = cats;
  await store.set('categories', S.categories);
  S.materials.lastScan = now;
  await store.set('materials', S.materials);
  if (!quiet) toast(`素材 ${items.length}件を読み取りました${missing.length ? `（見つからないもの ${missing.length}件）` : ''}`);
}


/** 「シナリオをDLする」タブで、シナリオではないものを開いたときの欄 */
export function viewMaterialInstall(o) {
  const card = h('div', { class: 'card stack' },
    h('h3', {}, 'シナリオではないようです（スキン・素材・効果音など）'),
    h('p', { class: 'small muted', style: 'margin:0' }, 'Summary.wsm・Summary.xml が無いので、シナリオとしては入れられません。素材・スキンなどとして、「素材の置き場所」に分類フォルダを分けて入れられます。'));
  if (!S.materials?.ref) {
    card.append(h('div', { class: 'row' },
      S.platform.canWriteFolders ? h('button', { class: 'btn primary', onclick: () => pickMaterialsFolder().then(render) }, '素材の置き場所を決める') : h('span', { class: 'small muted' }, 'このブラウザでは、フォルダに入れられません。'),
      location.hash.includes('dev-opfs') && S.platform.opfsFolder ? h('button', { class: 'btn', id: 'dev-opfs-materials', onclick: () => pickMaterialsFolder(true).then(render) }, 'テスト用（素材）') : null));
    return card;
  }
  const cats = S.categories[MAT] || [];
  // 入力は o に覚えておく（ほかの処理で画面が描き直されても消えないように）
  const m = o.mat || (o.mat = { cat: '', newCat: '', name: (o.archiveName || o.source.name).replace(/\.[^.]+$/, ''), asArc: false });
  const catSel = h('select', { id: 'mat-cat', 'aria-label': '分類フォルダ', onchange: (ev) => { m.cat = ev.target.value; newCat.hidden = m.cat !== '__new'; } },
    h('option', { value: '' }, '（素材の置き場所の直下）'), cats.map((c) => h('option', { value: c, selected: m.cat === c ? 'selected' : null }, c)), h('option', { value: '__new', selected: m.cat === '__new' ? 'selected' : null }, '新しい分類フォルダ…'));
  const newCat = h('input', { type: 'text', id: 'mat-newcat', value: m.newCat, placeholder: '新しい分類フォルダの名前（例：スキン、効果音、立ち絵）', hidden: m.cat !== '__new', oninput: (ev) => { m.newCat = ev.target.value; } });
  const nameIn = h('input', { type: 'text', id: 'mat-name', value: m.name, 'aria-label': 'フォルダ名', oninput: (ev) => { m.name = ev.target.value; } });
  const asArc = h('input', { type: 'checkbox', checked: m.asArc, 'aria-label': 'zipのまま置く', onchange: (ev) => { m.asArc = ev.target.checked; pick.hidden = m.asArc; } });
  m.skip ||= new Set();
  const pick = filePicker(o, m);
  pick.hidden = m.asArc;
  card.append(
    h('div', { class: 'grid2' },
      h('label', { class: 'field' }, '分類フォルダ', catSel, newCat),
      h('label', { class: 'field' }, 'フォルダ名', nameIn)),
    o.source.kind === 'archive' ? h('label', { class: 'check small' }, asArc, '展開せずに、zipなどのまま置く') : null,
    pick,
    h('div', { class: 'row' },
      h('button', {
        class: 'btn primary', onclick: async () => {
          const cat = m.cat === '__new' ? m.newCat.trim() : m.cat;
          const chosen = o.files.filter((f) => !m.skip.has(f.path));
          if (!m.asArc && !chosen.length) { toast('入れるファイルを1つ以上選んでください', { bad: true }); return; }
          if (m.cat === '__new' && !cat) { toast('新しい分類フォルダの名前を入れてください', { bad: true }); return; }
          if (o.readmes?.length && !o.matAck) {
            const { readmeModal } = await import('./add.js');
            if (!(await readmeModal(o, o.source.name))) return;
            o.matAck = true;
          }
          await busy('素材の置き場所に入れる', async () => {
            const d = await materialsDirOf(true);
            if (!d) throw new Error('素材の置き場所を使う許可がありませんでした');
            const r = await installMaterial(d, m.asArc ? o : { ...o, files: chosen }, { category: cat, folderName: m.name.trim(), asArchive: m.asArc });
            await scanMaterials(true);
            toast(`「${S.materials.label}」の ${r.dest} に入れました（${m.asArc ? 'zipのまま' : `${r.written}ファイル`}）`, { ms: 8000 });
            S.opened = null;
          });
        },
      }, '素材の置き場所に入れる'),
      h('span', { class: 'small muted' }, `入れ先：${S.materials.label}${o.readmes?.length ? '（入れる前に Readme（利用規約）を確認します）' : ''}`)));
  return card;
}

/** 素材のどのファイルを入れるか選ぶ欄（最初は全部。フォルダごとにも選べる） */
function filePicker(o, m) {
  const groups = new Map();
  for (const f of o.files) {
    const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  const count = h('span', { class: 'small muted' });
  const upd = () => { count.textContent = `${o.files.length - m.skip.size} / ${o.files.length} ファイルを入れます`; };
  upd();
  const box = h('div', { class: 'file-pick' });
  const draw = () => {
    box.replaceChildren(...[...groups].map(([dir, fs]) => {
      const allOn = fs.every((f) => !m.skip.has(f.path));
      const someOn = fs.some((f) => !m.skip.has(f.path));
      const head = h('input', { type: 'checkbox', checked: allOn, 'aria-label': `フォルダ「${dir || '（いちばん上）'}」をまとめて選ぶ`, onchange: (ev) => { fs.forEach((f) => (ev.target.checked ? m.skip.delete(f.path) : m.skip.add(f.path))); draw(); upd(); } });
      head.indeterminate = someOn && !allOn;
      return h('div', {},
        h('div', { class: 'dir row' }, head, `📁 ${dir || '（いちばん上）'}`, h('span', { class: 'small muted' }, `${fs.length}件`)),
        fs.map((f) => h('label', { class: 'small' },
          h('input', { type: 'checkbox', checked: !m.skip.has(f.path), 'aria-label': `${f.path}を入れる`, onchange: (ev) => { if (ev.target.checked) m.skip.delete(f.path); else m.skip.add(f.path); draw(); upd(); } }),
          `📄 ${f.path.split('/').pop()}`)));
    }));
  };
  draw();
  return h('details', { class: 'small', open: o.files.length <= 30 ? true : null },
    h('summary', {}, '入れるファイルを選ぶ　', count),
    h('div', { class: 'row', style: 'margin:6px 0' },
      h('button', { class: 'btn sm', onclick: () => { m.skip.clear(); draw(); upd(); } }, 'すべて選ぶ'),
      h('button', { class: 'btn ghost sm', onclick: () => { o.files.forEach((f) => m.skip.add(f.path)); draw(); upd(); } }, 'すべて外す')),
    box);
}

/**
 * 選んだもの（シナリオ・素材）を、分類フォルダへ動かす（実際のファイルを動かす）
 * @param {object[]} recs 同じ入れ物（同じエンジン、または素材の置き場所）の記録
 */
export async function moveToCategory(recs) {
  const isMat = recs[0].engineId === MAT;
  const base = isMat ? '' : 'Scenario';
  const cats = S.categories[recs[0].engineId] || [];
  const target = await modal((close) => {
    const newIn = h('input', { type: 'text', class: 'grow', placeholder: '新しい分類フォルダの名前' });
    return h('div', { class: 'stack' },
      h('h2', {}, `${recs.length}件を分類フォルダへ移す`),
      h('p', { class: 'small muted', style: 'margin:0' }, `${isMat ? '素材の置き場所' : 'Scenario フォルダ'}の中で、実際のフォルダやファイルを動かします（宿の冒険の記録などには影響しません）。`),
      h('div', { class: 'stack menu-list' },
        h('button', { class: 'btn', onclick: () => close({ cat: '' }) }, isMat ? '（素材の置き場所の直下）' : '（Scenario の直下）'),
        cats.map((c) => h('button', { class: 'btn', onclick: () => close({ cat: c }) }, c))),
      h('div', { class: 'row' }, newIn, h('button', { class: 'btn primary', onclick: () => { const n = newIn.value.trim(); if (n) close({ cat: n }); } }, '新しく作って移す')),
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn', onclick: () => close(null) }, 'やめる')));
  });
  if (!target) return;
  await busy('分類フォルダへ移す', async () => {
    const d = isMat ? await materialsDirOf(true) : await dirOf(recs[0].engineId, true);
    if (!d) throw new Error('フォルダに接続できませんでした');
    const toDir = [base, target.cat].filter(Boolean).join('/');
    const log = [];
    const byPath = new Map();
    for (const r of recs) { if (!byPath.has(r.path)) byPath.set(r.path, []); byPath.get(r.path).push(r); }
    let moved = 0;
    for (const [path, group] of byPath) {
      try {
        const dest = await moveWithin(d, path, toDir);
        if (dest === path) continue;
        for (const r of group) {
          const nr = { ...r, id: recordId(r.engineId, dest, r.inner || ''), path: dest };
          if (!isMat) Object.assign(nr, applyCatalog(nr));
          await store.deleteRecord(r.id);
          await store.putRecord(nr);
        }
        moved++;
        log.push(`${path} → ${dest}`);
      } catch (e) {
        log.push(`${path}：${e.message}`);
      }
    }
    S.records = await store.records();
    if (target.cat && !cats.includes(target.cat)) {
      S.categories[recs[0].engineId] = [...cats, target.cat].sort();
      await store.set('categories', S.categories);
    }
    S.mineSel.clear();
    await showLog(`分類フォルダへ移しました（${moved}件）`, log);
  });
}

/** 結果の記録を見せる窓 */
export function showLog(title, lines) {
  return modal((close) => h('div', { class: 'stack' },
    h('h2', {}, title),
    lines.length ? h('pre', { class: 'readme log' }, lines.join('\n')) : h('p', { class: 'small muted' }, '動かしたものはありません'),
    h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'btn primary', onclick: () => close(true) }, '閉じる'))));
}

export const materialsLabel = () => (S.materials?.label ? `素材の置き場所（${S.materials.label}）` : '素材の置き場所');

// ------------------------------------------------------------ 設定タブ
export function viewMaterialsSettings(dev) {
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'スキン・素材・効果音など、シナリオではないものを入れるフォルダです。中に「分類フォルダ」（例：スキン、効果音）を作って分けられます。エンジンのScenarioフォルダとは別の場所を選んでください。'),
    h('div', { class: 'row' },
      h('span', { class: 'grow small muted' }, S.materials?.ref ? `素材の置き場所：${S.materials.label}${S.materialsDir ? '' : '（次に使うとき許可を聞きます）'}` : '素材の置き場所：未設定'),
      S.platform.canWriteFolders ? h('button', { class: 'btn sm', onclick: () => pickMaterialsFolder().then(render) }, S.materials?.ref ? '置き場所を変える' : '置き場所を選ぶ') : null,
      dev ? h('button', { class: 'btn sm', id: 'dev-opfs-materials-set', onclick: () => pickMaterialsFolder(true).then(render) }, 'テスト用（素材）') : null),
    !S.platform.canWriteFolders ? h('p', { class: 'note warn small', style: 'margin:0' }, 'このブラウザでは、素材の置き場所の登録はできません。') : null);
}

// ------------------------------------------------------------ 自分のフォルダ一覧（素材の置き場所を選んだとき）
export function viewMaterialsMine(makeSel) {
  const q = S.filter.mine.normalize('NFKC').toLowerCase();
  const mine = S.records.filter((r) => r.engineId === MAT);
  let recs = mine.filter((r) => !q || `${r.name} ${r.path} ${(r.tags || []).join(' ')}`.normalize('NFKC').toLowerCase().includes(q));
  const allRecs = recs;
  const tg = S.filter.mineTag || '';
  if (tg) recs = recs.filter((r) => (tg === '__none' ? !(r.tags || []).length : (r.tags || []).includes(tg)));
  recs.sort((a, b) => (a.path || '').localeCompare(b.path || '', 'ja'));
  const sel = recs.filter((r) => S.mineSel.has(r.id));

  const head = h('div', { class: 'card' },
    h('div', { class: 'row' },
      makeSel(),
      S.materials?.ref
        ? h('button', { class: 'btn', onclick: () => busy('素材を読み取る', () => scanMaterials()) }, '読み取る')
        : h('button', { class: 'btn primary', onclick: () => pickMaterialsFolder().then(render) }, '素材の置き場所を決める'),
      S.materials?.ref ? h('button', { class: 'btn ghost sm', onclick: () => pickMaterialsFolder().then(render) }, '置き場所を変える') : null),
    h('div', { class: 'row', style: 'margin-top:10px' },
      h('input', { type: 'search', class: 'grow', placeholder: '名前・分類・タグで絞り込み', value: S.filter.mine, oninput: (ev) => { S.filter.mine = ev.target.value; rerenderList('mine-body', () => viewMaterialsMine(makeSel)); } })),
    h('p', { class: 'small muted', style: 'margin:8px 0 0' },
      S.materials?.ref ? `素材の置き場所：${S.materials.label}${S.materials.lastScan ? `／最後に読み取った日時：${fmtDate(S.materials.lastScan)}／${mine.length}件` : ''}` : 'スキン・素材などは「シナリオをDLする」タブで開くと、ここ（素材の置き場所）に分類して入れられます。'),
    tagChips(allRecs));

  const selBar = recs.length ? h('div', { class: 'card batch-bar', id: 'mine-bar' },
    h('div', { class: 'row' },
      h('span', { class: 'small' }, `${recs.length}件${q || tg ? '（絞り込み中）' : ''}`),
      h('button', { class: 'btn sm', disabled: sel.length === recs.length, onclick: () => { recs.forEach((r) => S.mineSel.add(r.id)); render(); } }, '表示中をすべて選ぶ'),
      sel.length ? h('button', { class: 'btn ghost sm', onclick: () => { S.mineSel.clear(); render(); } }, '選択を解除') : null),
    sel.length ? h('div', { class: 'row sel-actions' },
      h('b', { class: 'small' }, `選んだ${sel.length}件に：`),
      h('button', { class: 'btn primary sm', onclick: async () => { const t = await pickTags(`${sel.length}件にタグを付ける`); if (t?.length) { await applyTags(sel, t, []); render(); } } }, 'タグを付ける'),
      h('button', { class: 'btn sm', onclick: async () => { const present = [...new Set(sel.flatMap((r) => r.tags || []))]; const t = await pickTags(`${sel.length}件からタグを外す`, { mode: 'remove', present }); if (t?.length) { await applyTags(sel, [], t); render(); } } }, 'タグを外す'),
      h('button', { class: 'btn sm', onclick: async () => { const ok = sel.filter((r) => !r.missing); if (ok.length) await moveToCategory(ok); render(); } }, '分類フォルダへ移す')) : null) : null;

  // 分類フォルダごとにまとめる
  const groups = new Map();
  for (const r of recs) {
    const c = r.path.includes('/') ? r.path.split('/')[0] : '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(r);
  }
  const list = h('div', { class: 'list', id: 'mine-list' }, recs.length
    ? [...groups].map(([c, rs]) => h('details', { class: 'group', open: true },
      h('summary', {}, h('span', { class: 'group-name' }, c || '（分類なし）'), h('span', { class: 'badge plain' }, `${rs.length}件`)),
      rs.map(materialCard)))
    : h('p', { class: 'empty' }, mine.length ? '見つかりませんでした' : S.materials?.ref ? 'まだ記録がありません。「読み取る」を押してください' : 'まだ素材の置き場所が決まっていません'));
  return h('div', {}, head, h('div', { id: 'mine-body' }, selBar, list));
}

function materialCard(r) {
  const save = async (patch) => { Object.assign(r, patch); await store.putRecord(r); S.records = await store.records(); render(); };
  const fav = (r.tags || []).includes('お気に入り');
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('input', { type: 'checkbox', checked: S.mineSel.has(r.id), 'aria-label': `${r.name}を選ぶ`, onchange: (ev) => { if (ev.target.checked) S.mineSel.add(r.id); else S.mineSel.delete(r.id); render(); } }),
      h('button', {
        class: `btn star${fav ? ' on' : ''}`, 'aria-label': `${r.name}をお気に入りにする`, 'aria-pressed': fav ? 'true' : 'false', title: '「お気に入り」タグを付ける・外す',
        onclick: async () => { await addTagName('お気に入り'); await save({ tags: fav ? r.tags.filter((t) => t !== 'お気に入り') : [...(r.tags || []), 'お気に入り'] }); },
      }, fav ? '★' : '☆'),
      h('span', { class: 'item-title' }, r.name),
      h('span', { class: 'badge plain' }, r.kind === 'dir' ? 'フォルダ' : 'ファイル'),
      r.missing ? h('span', { class: 'badge bad' }, '見つからない') : null,
      r.missing ? h('button', { class: 'btn ghost danger sm', onclick: async () => { await store.deleteRecord(r.id); S.records = await store.records(); render(); } }, '記録を消す') : null),
    h('div', { class: 'meta' }, r.path),
    h('div', { class: 'row', style: 'margin-top:6px' }, tagEditor(r, save)));
}
