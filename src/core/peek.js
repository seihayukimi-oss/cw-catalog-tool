// ダウンロードせずに、配布ファイルの「目次」（中に入っているファイルの名前と大きさ）だけを読む。
// ファイルの一部（Range）だけを読むので、中身はパソコンにもメモリにもほとんど来ない。
// 目次は名前と大きさの一覧なので、読んでも何かが動くことはない。
// 対応：zip・wsn（後ろの目次）、cab（前の目次）、7z（前と後ろ）。lzh は目次が全体に散らばっているので読めない。

import { readZip, ZipNeedMore, LIMITS } from './zip.js';
import { readCab, looksLikeCab } from './cab.js';
import { list7zParts, looksLike7z } from './sevenzip.js';
import { archiveKind } from './archive.js';
import { safeRelativePath } from './zip.js';
import { isExecName } from './safety.js';

export class PeekUnsupported extends Error {}

const TAIL = 128 * 1024;
const MAX_CD = 16 * 1024 * 1024;

/**
 * @param {(r: {suffix?: number, start?: number, end?: number}) => Promise<{bytes: Uint8Array, partial: boolean, total: number, complete: boolean, contentType: string, fileName: string}>} fetchRange
 * @returns {Promise<{format: string, fileName: string, total: number, entries: {path: string, size: number, exec: boolean}[]}>}
 */
export async function peekArchive(fetchRange) {
  // まず頭を少し読んで、形式を見分ける（ページだったらここで終わり）
  const head = await fetchRange({ start: 0, end: 65535 });
  if (/text\/html/i.test(head.contentType) || /^\s*</.test(new TextDecoder().decode(head.bytes.subarray(0, 64)))) {
    throw new PeekUnsupported('配布ページ（ファイルそのものではないURL）なので、目次だけを読むことはできません');
  }
  // 小さいファイルは、頭を読んだだけで全部来ている
  if (head.partial && head.bytes.length >= head.total) head.complete = true;
  const kind = archiveKind(head.bytes);
  const total = head.partial ? head.total : head.bytes.length;
  const fileName = head.fileName;
  const done = (format, list) => ({
    format, fileName, total,
    entries: list
      .filter((e) => e.name && !e.name.endsWith('/'))
      .map((e) => ({ path: safeRelativePath(e.name) || e.name, size: e.size, exec: isExecName(e.name) })),
  });
  if (!kind) throw new PeekUnsupported('zip・wsn・cab・7z のファイルではないようです');
  if (kind === 'rar') throw new PeekUnsupported('.rar 形式は、このツールでは扱えません');
  if (kind === 'lzh') throw new PeekUnsupported('lzh は目次がファイル全体に散らばっているので、ダウンロードしないと中身を見られません');
  // サイトが「一部だけ」に対応していないと、頭から読むしかない
  const partOk = head.partial || head.complete;
  const whole = head.complete;
  if (!partOk) throw new PeekUnsupported('このサイトはファイルの一部だけを読むことに対応していないので、ダウンロードしないと中身を見られません');

  if (kind === 'zip') {
    if (whole) return done('zip', readZip(head.bytes).entries.map((e) => ({ name: e.path, size: e.size })));
    let from = Math.max(0, total - TAIL);
    for (let i = 0; i < 3; i++) {
      const t = await fetchRange({ start: from, end: total - 1 });
      if (!t.partial) throw new PeekUnsupported('このサイトはファイルの一部だけを読むことに対応していません');
      try {
        return done('zip', readZip(t.bytes, LIMITS, from).entries.map((e) => ({ name: e.path, size: e.size })));
      } catch (e) {
        if (!(e instanceof ZipNeedMore)) throw e;
        if (total - e.from > MAX_CD) throw new PeekUnsupported('目次が大きすぎるので、目次だけを読むことはできません');
        from = e.from;
      }
    }
    throw new PeekUnsupported('zipの目次を読めませんでした');
  }

  if (kind === 'cab' && looksLikeCab(head.bytes)) {
    const d = head.bytes;
    const u16 = (o) => d[o] | (d[o + 1] << 8);
    const u32 = (o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
    const need = Math.min(total, u32(16) + u16(28) * (16 + 300));
    let buf = d;
    if (need > d.length && !head.complete) {
      if (need > MAX_CD) throw new PeekUnsupported('目次が大きすぎるので、目次だけを読むことはできません');
      buf = (await fetchRange({ start: 0, end: need - 1 })).bytes;
    }
    return done('cab', readCab(buf).entries.map((e) => ({ name: e.name, size: e.size })));
  }

  if (kind === '7z' && looksLike7z(head.bytes)) {
    const get = async (start, end) => {
      if (end < head.bytes.length) return head.bytes.subarray(start, end + 1);
      if (head.complete) throw new PeekUnsupported('7zファイルが途中で切れています');
      const r = await fetchRange({ start, end });
      if (!r.partial) throw new PeekUnsupported('このサイトはファイルの一部だけを読むことに対応していません');
      return r.bytes;
    };
    return done('7z', await list7zParts(get));
  }
  throw new PeekUnsupported('このファイルの目次は読めませんでした');
}
