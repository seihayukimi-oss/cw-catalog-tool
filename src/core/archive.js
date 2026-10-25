// 「入れたいもの」（zip・wsn・cab・lzh・7z・フォルダ）を読み込んで、中身を分析する入口。

import { readZip, looksLikeZip, safeRelativePath, LIMITS } from './zip.js';
import { readLzh, looksLikeLzh } from './lzh.js';
import { readCab, looksLikeCab } from './cab.js';
import { read7z, looksLike7z } from './sevenzip.js';
import { analyzeFiles } from './scenario.js';
import { listFiles } from './fs.js';
import { markExecutables } from './safety.js';

export async function sha256Hex(bytes) {
  const h = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 中身の先頭から、圧縮ファイルの種類を見分ける。分からなければ null */
export function archiveKind(d) {
  if (!d || d.length < 8) return null;
  if (looksLikeZip(d)) return 'zip';
  if (looksLikeCab(d)) return 'cab';
  if (looksLike7z(d)) return '7z';
  if (looksLikeLzh(d)) return 'lzh';
  if (d[0] === 0x52 && d[1] === 0x61 && d[2] === 0x72 && d[3] === 0x21) return 'rar';
  return null;
}

/**
 * 各形式の読み取り結果を、zipと同じ形にそろえる（危ないパス・重なり・大きさを調べる）
 * @param {{name: string, size: number, read: () => Uint8Array}[]} list
 */
function normalizeEntries(list, warnings, limits = LIMITS) {
  if (list.length > limits.maxEntries) throw new Error(`ファイル数が多すぎます（${list.length}件）`);
  const seen = new Set();
  const out = [];
  let total = 0;
  for (const e of list) {
    if (!e.name || e.name.endsWith('/')) continue;
    const safe = safeRelativePath(e.name);
    if (!safe) { warnings.push(`危険なパスのため無視しました：${e.name}`); continue; }
    const key = safe.toLowerCase();
    if (seen.has(key)) { warnings.push(`同じ名前のファイルが重複していたため後のものを無視しました：${safe}`); continue; }
    seen.add(key);
    if (e.size > limits.maxEntryUncompressed) throw new Error(`大きすぎるファイルがあります（${safe}）`);
    total += e.size;
    if (total > limits.maxTotalUncompressed) throw new Error('展開後の合計が大きすぎます');
    out.push({ path: safe, size: e.size, read: async () => e.read(), originalName: e.name, utf8Flag: true });
  }
  return out;
}

/**
 * zip（.zip／.wsn）・cab・lzh・7z を分析する。
 * @param {Uint8Array} bytes
 * @param {string} fileName
 */
export async function openArchive(bytes, fileName, depth = 0) {
  const lower = fileName.toLowerCase();
  const kind = archiveKind(bytes);
  if (kind === 'rar' || /\.rar$/.test(lower)) throw new Error('.rar 形式はこのツールでは展開できません。展開してからフォルダを入れるか、zipに変換してください');
  if (!kind) {
    if (/\.(zip|wsn|cab|lzh|lha|7z)$/.test(lower)) throw new Error(`${fileName} は壊れているか、${lower.split('.').pop()}の形になっていないようです`);
    throw new Error('zip・wsn・cab・lzh・7z のファイルではないようです');
  }
  let files, warnings = [], renamed = 0;
  if (kind === 'zip') {
    const z = readZip(bytes);
    files = z.entries.map((e) => ({ path: e.path, size: e.size, read: async () => e.read(), head: (n) => e.head(n) }));
    warnings = z.warnings;
    renamed = z.entries.filter((e) => !e.utf8Flag && /[^\x00-\x7f]/.test(e.originalName)).length;
  } else {
    const r = kind === 'cab' ? readCab(bytes) : kind === 'lzh' ? readLzh(bytes) : read7z(bytes);
    warnings = [...r.warnings];
    files = normalizeEntries(r.entries, warnings);
    if (kind !== '7z') renamed = r.entries.filter((e) => /[^\x00-\x7f]/.test(e.name)).length;
  }
  const analysis = await analyzeFiles(files, { sourceName: fileName });
  const sha256 = await sha256Hex(bytes);
  const opened = {
    source: { kind: 'archive', format: kind, name: fileName, size: bytes.length, sha256, isWsn: kind === 'zip' && /\.wsn$/.test(lower) },
    bytes,
    files,
    nonUtf8Names: renamed,
    ...analysis,
    warnings: [...warnings, ...analysis.warnings],
  };
  if (opened.scenarios.length || depth > 0) return depth > 0 ? opened : markExecutables(opened);
  const outerExec = (await markExecutables(opened)).executables;
  const inner = await openInner(opened);
  return inner ? markExecutables(inner, outerExec) : opened;
}

const INNER = /\.(wsn|zip|cab|lzh|lha|7z)$/i;

/**
 * 入れ物の中に、さらに wsn・zip などが入っているとき（BOOTHの「zipの中にwsn」など）は、中のものを開く。
 * 1つだけなら、そのまま中身として扱う（.wsn ならPyでは展開せずに置ける）。
 * いくつもあるときは、それぞれをフォルダに見立てて、まとめて1つの中身にする。
 * 保存場所に残すのは、DLした外側のファイルのまま。
 */
async function openInner(outer) {
  const inners = outer.files.filter((f) => INNER.test(f.path));
  if (!inners.length || inners.length > 30) return null;
  const opened = [];
  for (const f of inners) {
    try {
      const o = await openArchive(await f.read(), f.path.split('/').pop(), 1);
      if (o.scenarios.length) opened.push({ f, o });
    } catch (e) {
      outer.warnings.push(`${f.path} を開けませんでした：${e.message}`);
    }
  }
  if (!opened.length) return null;
  const note = `${outer.source.name} の中の ${opened.map((x) => x.f.path.split('/').pop()).join('・')} を開きました`;
  const keep = { archiveBytes: outer.bytes, archiveName: outer.source.name };
  if (opened.length === 1) {
    const { o } = opened[0];
    return {
      ...o, ...keep,
      // カタログとの照合は、配布されている外側のファイルで
      source: { ...o.source, sha256: outer.source.sha256, innerSha256: o.source.sha256, outer: { name: outer.source.name, size: outer.source.size } },
      nonUtf8Names: outer.nonUtf8Names + o.nonUtf8Names,
      warnings: [note, ...outer.warnings, ...o.warnings],
    };
  }
  const files = [];
  for (const { f, o } of opened) {
    const dir = f.path.replace(/\.[^./]+$/, '');
    for (const x of o.files) files.push({ ...x, path: `${dir}/${x.path}` });
  }
  const analysis = await analyzeFiles(files, { sourceName: outer.source.name });
  return {
    ...outer, ...keep, files, ...analysis,
    warnings: [note, ...outer.warnings, ...analysis.warnings],
  };
}

/** フォルダ（Dir）を分析する */
export async function openFolder(dir) {
  const files = await listFiles(dir);
  const analysis = await analyzeFiles(files, { sourceName: dir.name });
  return markExecutables({
    source: { kind: 'folder', name: dir.name, size: files.reduce((a, f) => a + f.size, 0), sha256: '' },
    files,
    nonUtf8Names: 0,
    ...analysis,
  });
}
