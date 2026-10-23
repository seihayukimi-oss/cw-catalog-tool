// インストールとバックアップ、WebCardWirth用の書き出し。

import { dirAt, existsAt, writeAt, removeAt } from './fs.js';
import { safeRelativePath, writeZip } from './zip.js';
import { nonCp932Chars } from './text.js';
import { playability } from './catalog.js';

export const BACKUP_DIR = 'CWCatalog_backup';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');

/**
 * インストールの計画を立てる（まだ書き込まない）。
 * @param {object} opened openArchive／openFolder の結果
 * @param {number} index 何番目のシナリオを入れるか
 * @param {{kind: string, maxWsn?: number}} engine
 * @param {string} category Scenario の下の分類フォルダ（'' ならScenario直下）
 */
export function planInstall(opened, index, engine, category = '', { folderName } = {}) {
  const sc = opened.scenarios[index];
  if (!sc) throw new Error('インストールするシナリオが見つかりません');
  const play = playability(sc, engine.kind, engine);
  const cat = category ? safeRelativePath(category) : '';
  if (category && !cat) throw new Error('分類フォルダの名前が正しくありません');
  const name = safeRelativePath(folderName || sc.folderName);
  if (!name || name.includes('/')) throw new Error('フォルダ名が正しくありません');

  const base = ['Scenario', cat].filter(Boolean).join('/');
  const warnings = [];

  // Py＋.wsnでトップがシナリオなら、解凍せずにファイルのまま置ける
  const passthrough = engine.kind === 'py' && opened.source.isWsn && sc.root === '' && opened.bytes;
  let dest, files;
  if (passthrough) {
    const fileName = safeRelativePath(opened.source.name);
    dest = `${base}/${fileName}`;
    files = [{ rel: dest, read: async () => opened.bytes }];
  } else {
    dest = `${base}/${name}`;
    const prefix = sc.root ? sc.root + '/' : '';
    files = opened.files
      .filter((f) => sc.files.includes(f.path))
      .map((f) => ({ rel: `${dest}/${f.path.slice(prefix.length)}`, read: f.read, size: f.size }));
  }

  // 1.50／Nextは古い文字コード（CP932）なので、表せない文字があると読めないことがある
  if (engine.kind === 'cw150' || engine.kind === 'next') {
    const bad = new Set();
    for (const f of files) for (const ch of nonCp932Chars(f.rel)) bad.add(ch);
    if (bad.size) warnings.push(`1.50／Nextで扱えない可能性のある文字がファイル名にあります：${[...bad].join(' ')}`);
  }
  return { scenario: sc, play, dest, files, passthrough: !!passthrough, warnings };
}

/**
 * 計画どおりに書き込む。すでに同じ場所にあれば、バックアップしてから置き換える。
 * @param {import('./fs.js').Dir} engineRoot エンジンのフォルダ（Scenarioの親）
 * @returns {{path: string, backup: string|null, written: number}}
 */
/**
 * フォルダを何度も探し直さないよう、途中のフォルダを覚えておく。
 * 同じフォルダを同時に作ろうとしてぶつからないよう、作りかけも共有する。
 */
function dirCache(root) {
  const cache = new Map([['', Promise.resolve(root)]]);
  const get = (rel) => {
    if (!cache.has(rel)) {
      const i = rel.lastIndexOf('/');
      const parent = i < 0 ? '' : rel.slice(0, i);
      const name = rel.slice(i + 1);
      cache.set(rel, get(parent).then((d) => d.dir(name, { create: true })));
    }
    return cache.get(rel);
  };
  return get;
}

/** いくつかを同時に進める（ブラウザ版は1ファイルごとに安全チェックが入って遅いため） */
async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

/** フォルダの中のファイルを全部並べる（バックアップ用） */
async function listTree(dir, prefix = '') {
  const out = [];
  for (const e of await dir.entries()) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.kind === 'dir') out.push(...(await listTree(await dir.dir(e.name), p)));
    else out.push({ rel: p, dir, name: e.name });
  }
  return out;
}

/**
 * 計画どおりに書き込む。すでに同じ場所にあれば、バックアップしてから置き換える。
 * @param {import('./fs.js').Dir} engineRoot エンジンのフォルダ（Scenarioの親）
 * @param {{onProgress?: (done: number, total: number, phase: 'backup'|'write', name: string) => void, concurrency?: number}} opts
 * @returns {{path: string, backup: string|null, written: number}}
 */
export async function performInstall(engineRoot, plan, { onProgress, concurrency = 6 } = {}) {
  let backup = null;
  const getDir = dirCache(engineRoot);
  const exists = await existsAt(engineRoot, plan.dest);
  if (exists) {
    backup = `${BACKUP_DIR}/${stamp()}_${plan.dest.split('/').pop()}`;
    if (exists === 'dir') {
      const src = await dirAt(engineRoot, plan.dest);
      const files = await listTree(src);
      let done = 0;
      await pool(files, concurrency, async (f) => {
        const rel = `${backup}/${f.rel}`;
        const i = rel.lastIndexOf('/');
        const d = await getDir(rel.slice(0, i));
        await d.writeFile(rel.slice(i + 1), await f.dir.readFile(f.name));
        onProgress?.(++done, files.length, 'backup', f.rel);
      });
    } else {
      const segs = plan.dest.split('/');
      const name = segs.pop();
      const d = await dirAt(engineRoot, segs.join('/'));
      await writeAt(engineRoot, `${backup}/${name}`, await d.readFile(name));
    }
    await removeAt(engineRoot, plan.dest);
  }
  let done = 0;
  await pool(plan.files, concurrency, async (f) => {
    const i = f.rel.lastIndexOf('/');
    const d = await getDir(f.rel.slice(0, i));
    await d.writeFile(f.rel.slice(i + 1), await f.read());
    onProgress?.(++done, plan.files.length, 'write', f.rel);
  });
  return { path: plan.dest, backup, written: done };
}

/**
 * WebCardWirth用のzipを作る。
 * ファイル名を正しく読み直したうえでUTF-8で書き、シナリオをzipのトップの1フォルダにまとめる。
 * .wsn でトップがシナリオのものは、そのまま返す。
 */
export async function exportForWeb(opened, index) {
  const sc = opened.scenarios[index];
  if (opened.source.isWsn && sc.root === '' && opened.bytes) {
    return { fileName: opened.source.name, data: opened.bytes };
  }
  const prefix = sc.root ? sc.root + '/' : '';
  const files = [];
  for (const f of opened.files) {
    if (!sc.files.includes(f.path)) continue;
    files.push({ path: `${sc.folderName}/${f.path.slice(prefix.length)}`, data: await f.read() });
  }
  return { fileName: `${sc.folderName}.zip`, data: writeZip(files) };
}
