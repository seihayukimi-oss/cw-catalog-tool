// 「入れたいもの」（zip・wsn・cab・lzh・7z・フォルダ）を読み込んで、中身を分析する入口。

import { readZip, looksLikeZip, safeRelativePath, LIMITS } from './zip.js';
import { readLzh, looksLikeLzh } from './lzh.js';
import { readCab, looksLikeCab } from './cab.js';
import { read7z, looksLike7z } from './sevenzip.js';
import { analyzeFiles } from './scenario.js';
import { listFiles } from './fs.js';

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
export async function openArchive(bytes, fileName) {
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
    files = z.entries.map((e) => ({ path: e.path, size: e.size, read: async () => e.read() }));
    warnings = z.warnings;
    renamed = z.entries.filter((e) => !e.utf8Flag && /[^\x00-\x7f]/.test(e.originalName)).length;
  } else {
    const r = kind === 'cab' ? readCab(bytes) : kind === 'lzh' ? readLzh(bytes) : read7z(bytes);
    warnings = [...r.warnings];
    files = normalizeEntries(r.entries, warnings);
    if (kind !== '7z') renamed = r.entries.filter((e) => /[^\x00-\x7f]/.test(e.name)).length;
  }
  const analysis = await analyzeFiles(files, { sourceName: fileName });
  return {
    source: { kind: 'archive', format: kind, name: fileName, size: bytes.length, sha256: await sha256Hex(bytes), isWsn: kind === 'zip' && /\.wsn$/.test(lower) },
    bytes,
    files,
    nonUtf8Names: renamed,
    ...analysis,
    warnings: [...warnings, ...analysis.warnings],
  };
}

/** フォルダ（Dir）を分析する */
export async function openFolder(dir) {
  const files = await listFiles(dir);
  const analysis = await analyzeFiles(files, { sourceName: dir.name });
  return {
    source: { kind: 'folder', name: dir.name, size: files.reduce((a, f) => a + f.size, 0), sha256: '' },
    files,
    nonUtf8Names: 0,
    ...analysis,
  };
}
