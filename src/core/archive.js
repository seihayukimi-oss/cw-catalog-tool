// 「入れたいもの」（zip・wsn・フォルダ）を読み込んで、中身を分析する入口。

import { readZip, looksLikeZip } from './zip.js';
import { analyzeFiles } from './scenario.js';
import { listFiles } from './fs.js';

export async function sha256Hex(bytes) {
  const h = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * zip（.zip／.wsn）を分析する。
 * @param {Uint8Array} bytes
 * @param {string} fileName
 */
export async function openArchive(bytes, fileName) {
  const lower = fileName.toLowerCase();
  if (/\.(lzh|lha|cab|rar|7z)$/.test(lower)) {
    const ext = lower.split('.').pop();
    throw new Error(`.${ext} 形式はこの版では展開できません（アプリ版での対応予定）。zipに変換するか、展開したフォルダを入れてください`);
  }
  if (!looksLikeZip(bytes)) throw new Error('zipファイルではないようです');
  const { entries, warnings } = readZip(bytes);
  const files = entries.map((e) => ({ path: e.path, size: e.size, read: async () => e.read() }));
  const analysis = await analyzeFiles(files, { sourceName: fileName });
  const renamed = entries.filter((e) => !e.utf8Flag && /[^\x00-\x7f]/.test(e.originalName)).length;
  return {
    source: { kind: 'archive', name: fileName, size: bytes.length, sha256: await sha256Hex(bytes), isWsn: /\.wsn$/.test(lower) },
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
