// zip の読み書き。
// 読み込みは「中央ディレクトリ」を自前で解析して、ファイル名の生バイトと
// UTF-8フラグを確実に取る。展開（DEFLATE）だけ fflate に任せる。
// ネットから来たzipは信用しない前提で、サイズ・件数・パスを全部検査する。

import { inflateSync, zipSync, Inflate } from 'fflate';
import { decodeZipName } from './text.js';

export const LIMITS = {
  maxEntries: 20000,
  maxTotalUncompressed: 1536 * 1024 * 1024, // 1.5GB
  maxEntryUncompressed: 1024 * 1024 * 1024, // 1GB
  maxRatio: 1000, // 圧縮率がこれを超えるものは zip爆弾 とみなす
};

export class ZipError extends Error {}

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function u16(d, o) { return d[o] | (d[o + 1] << 8); }
function u32(d, o) { return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0; }
function u64(d, o) {
  const lo = u32(d, o), hi = u32(d, o + 4);
  if (hi > 0x1fffff) throw new ZipError('サイズが大きすぎます');
  return hi * 0x100000000 + lo;
}

let crcTable = null;
export function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zipかどうか（先頭がローカルヘッダか、空zipのEOCD） */
export function looksLikeZip(d) {
  return d.length >= 4 && (u32(d, 0) === SIG_LOC || u32(d, 0) === SIG_EOCD);
}

function findEocd(d) {
  const min = Math.max(0, d.length - 22 - 0xffff);
  for (let i = d.length - 22; i >= min; i--) {
    if (u32(d, i) === SIG_EOCD) return i;
  }
  throw new ZipError('zipファイルとして読めませんでした（終端が見つかりません）');
}

// --- パスの安全チェック ---
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WIN_BAD = /[<>:"|?*\u0000-\u001f]/g;

/**
 * zip内のパスを安全な相対パスにする。危険なら null。
 * ・\ は / にそろえる ・先頭の / やドライブ名は拒否 ・.. は拒否
 * ・Windowsで使えない文字は全角に置き換え ・末尾の . や空白は削る
 */
export function safeRelativePath(path) {
  const p = path.replace(/\\/g, '/');
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const parts = [];
  for (let seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    seg = seg.replace(WIN_BAD, (c) => {
      const map = { '<': '＜', '>': '＞', ':': '：', '"': '”', '|': '｜', '?': '？', '*': '＊' };
      return map[c] || '_';
    }).replace(/[. ]+$/, '');
    if (!seg) return null;
    if (WIN_RESERVED.test(seg)) seg = '_' + seg;
    parts.push(seg);
  }
  return parts.length ? parts.join('/') : null;
}

/** 後ろの一部だけでは目次が足りないとき（どこから読めばよいかを持つ） */
export class ZipNeedMore extends ZipError {
  constructor(from) { super('zipの目次がもっと前から始まっています'); this.from = from; }
}

/**
 * zipを読み、エントリの一覧を返す（中身はまだ展開しない）。
 * @param {Uint8Array} d
 * @param {number} base d がファイルのどこから始まるか（後ろの一部だけを読んだとき。中身は展開できない）
 * @returns {{entries: ZipEntry[], warnings: string[]}}
 */
export function readZip(d, limits = LIMITS, base = 0) {
  const warnings = [];
  const eocd = findEocd(d);
  let count = u16(d, eocd + 10);
  let cdSize = u32(d, eocd + 12);
  let cdOffset = u32(d, eocd + 16);

  // ZIP64
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 && base > 0) throw new ZipNeedMore(Math.max(0, base - 64 * 1024));
    if (loc < 0 || u32(d, loc) !== SIG_EOCD64_LOC) throw new ZipError('ZIP64の情報が壊れています');
    const e64 = u64(d, loc + 8);
    if (e64 < base) throw new ZipNeedMore(e64);
    if (e64 - base + 56 > d.length || u32(d, e64 - base) !== SIG_EOCD64) throw new ZipError('ZIP64の情報が壊れています');
    count = u64(d, e64 - base + 32);
    cdSize = u64(d, e64 - base + 40);
    cdOffset = u64(d, e64 - base + 48);
  }
  if (count > limits.maxEntries) throw new ZipError(`ファイル数が多すぎます（${count}件）`);
  if (cdOffset < base) throw new ZipNeedMore(cdOffset);
  if (cdOffset - base + cdSize > d.length) throw new ZipError('zipの目次が壊れています');

  const entries = [];
  let total = 0;
  let p = cdOffset - base;
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    if (p + 46 > d.length || u32(d, p) !== SIG_CEN) throw new ZipError('zipの目次が壊れています');
    const flags = u16(d, p + 8);
    const method = u16(d, p + 10);
    const crc = u32(d, p + 16);
    let csize = u32(d, p + 20);
    let usize = u32(d, p + 24);
    const nlen = u16(d, p + 28), xlen = u16(d, p + 30), clen = u16(d, p + 32);
    let localOffset = u32(d, p + 42);
    const rawName = d.subarray(p + 46, p + 46 + nlen);
    const extra = d.subarray(p + 46 + nlen, p + 46 + nlen + xlen);

    // ZIP64 の拡張情報
    if (usize === 0xffffffff || csize === 0xffffffff || localOffset === 0xffffffff) {
      for (let x = 0; x + 4 <= extra.length;) {
        const id = u16(extra, x), sz = u16(extra, x + 2);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = u64(extra, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(extra, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(extra, q); q += 8; }
        }
        x += 4 + sz;
      }
    }

    const utf8Flag = (flags & 0x0800) !== 0;
    const name = decodeZipName(rawName, utf8Flag);
    const isDir = name.endsWith('/') || name.endsWith('\\');
    p += 46 + nlen + xlen + clen;

    if (isDir) continue;
    if (flags & 0x0001) throw new ZipError(`パスワード付きのzipには対応していません（${name}）`);
    if (method !== 0 && method !== 8) throw new ZipError(`対応していない圧縮方式です（${name}）`);

    const safe = safeRelativePath(name);
    if (!safe) {
      warnings.push(`危険なパスのため無視しました：${name}`);
      continue;
    }
    const key = safe.toLowerCase();
    if (seen.has(key)) {
      warnings.push(`同じ名前のファイルが重複していたため後のものを無視しました：${safe}`);
      continue;
    }
    seen.add(key);

    if (usize > limits.maxEntryUncompressed) throw new ZipError(`大きすぎるファイルがあります（${safe}）`);
    // 真っ白なBMPなど小さいファイルは高圧縮率になりがちなので、大きいものだけ検査
    if (usize > 50 * 1024 * 1024 && csize > 0 && usize / csize > limits.maxRatio) {
      throw new ZipError(`異常な圧縮率のファイルがあります（${safe}）`);
    }
    total += usize;
    if (total > limits.maxTotalUncompressed) throw new ZipError('展開後のサイズが大きすぎます');

    entries.push(new ZipEntry(base ? null : d, { path: safe, originalName: name, utf8Flag, method, crc, csize, usize, localOffset }));
  }
  return { entries, warnings };
}

export class ZipEntry {
  constructor(data, info) {
    this._d = data;
    Object.assign(this, info);
    this.size = info.usize;
  }

  /** 圧縮されたままの中身 */
  _comp() {
    const d = this._d;
    if (!d) throw new ZipError('目次だけを読んだので、中身はまだありません');
    const o = this.localOffset;
    if (o + 30 > d.length || u32(d, o) !== SIG_LOC) throw new ZipError(`zipの中身が壊れています（${this.path}）`);
    const start = o + 30 + u16(d, o + 26) + u16(d, o + 28);
    if (start + this.csize > d.length) throw new ZipError(`zipの中身が壊れています（${this.path}）`);
    return d.subarray(start, start + this.csize);
  }

  /** 中身の頭だけを取り出す（全部は展開しない。実行ファイルかどうかを見るため） */
  head(n = 16) {
    const comp = this._comp();
    if (this.method === 0) return comp.slice(0, n);
    const parts = [];
    let got = 0;
    const inf = new Inflate((chunk) => { if (got < n) { parts.push(chunk); got += chunk.length; } });
    try {
      for (let o = 0; o < comp.length && got < n; o += 4096) inf.push(comp.subarray(o, o + 4096), o + 4096 >= comp.length);
    } catch { return new Uint8Array(0); }
    const out = new Uint8Array(Math.min(n, got));
    let o = 0;
    for (const c of parts) { if (o >= out.length) break; out.set(c.subarray(0, out.length - o), o); o += c.length; }
    return out;
  }

  /** 中身を展開して返す（CRCとサイズも検証する） */
  read() {
    const d = this._d;
    if (!d) throw new ZipError('目次だけを読んだので、中身はまだありません');
    const o = this.localOffset;
    if (o + 30 > d.length || u32(d, o) !== SIG_LOC) throw new ZipError(`zipの中身が壊れています（${this.path}）`);
    const start = o + 30 + u16(d, o + 26) + u16(d, o + 28);
    if (start + this.csize > d.length) throw new ZipError(`zipの中身が壊れています（${this.path}）`);
    const comp = d.subarray(start, start + this.csize);
    let out;
    if (this.method === 0) {
      out = comp.slice();
    } else {
      out = new Uint8Array(this.usize);
      try {
        out = inflateSync(comp, { out });
      } catch {
        throw new ZipError(`zipの中身を展開できませんでした（${this.path}）`);
      }
    }
    if (out.length !== this.usize) throw new ZipError(`サイズが一致しません（${this.path}）`);
    if (crc32(out) !== this.crc) throw new ZipError(`ファイルが壊れています（CRC不一致：${this.path}）`);
    return out;
  }
}

/**
 * zipを作る（WebCardWirth用の書き出しなど）。ファイル名はUTF-8で、目印も付ける。
 * @param {{path: string, data: Uint8Array}[]} files
 */
export function writeZip(files) {
  const tree = {};
  for (const f of files) tree[f.path] = [f.data, { level: /\.(png|jpe?g|ogg|mp3|zip|wsn)$/i.test(f.path) ? 0 : 6 }];
  return zipSync(tree);
}
