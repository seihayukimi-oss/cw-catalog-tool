// 7z（.7z）の展開。
// 対応：無圧縮・LZMA・LZMA2・Deflate、x86の前処理（BCJ）、圧縮された目次。
// 非対応（分かるように止める）：パスワード付き・BZip2・PPMd・BCJ2 など。
// ファイル名は必ずUnicode（UTF-16）なので、文字化けの心配はない。

import { inflateSync } from 'fflate';
import { lzmaDecode, lzma2Decode } from './lzma.js';
import { crc32 } from './zip.js';

export class SevenZipError extends Error {}

const SIG = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
export function looksLike7z(d) {
  return d.length > 32 && SIG.every((b, i) => d[i] === b);
}

const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const u64 = (d, o) => u32(d, o) + u32(d, o + 4) * 0x100000000;

const ID = {
  End: 0x00, Header: 0x01, ArchiveProperties: 0x02, AdditionalStreamsInfo: 0x03, MainStreamsInfo: 0x04, FilesInfo: 0x05,
  PackInfo: 0x06, UnPackInfo: 0x07, SubStreamsInfo: 0x08, Size: 0x09, CRC: 0x0a, Folder: 0x0b, CodersUnPackSize: 0x0c,
  NumUnPackStream: 0x0d, EmptyStream: 0x0e, EmptyFile: 0x0f, Anti: 0x10, Name: 0x11, WinAttributes: 0x15, EncodedHeader: 0x17, Dummy: 0x19,
};

class Reader {
  constructor(d, p = 0) { this.d = d; this.p = p; }
  byte() { if (this.p >= this.d.length) throw new SevenZipError('7zの目次が途中で切れています'); return this.d[this.p++]; }
  num() {
    const first = this.byte();
    let mask = 0x80, value = 0;
    for (let i = 0; i < 8; i++) {
      if ((first & mask) === 0) return value + (first & (mask - 1)) * 2 ** (8 * i);
      value += this.byte() * 2 ** (8 * i);
      mask >>>= 1;
    }
    return value;
  }
  u32() { const v = u32(this.d, this.p); this.p += 4; return v; }
  bytes(n) { if (this.p + n > this.d.length) throw new SevenZipError('7zの目次が途中で切れています'); const b = this.d.subarray(this.p, this.p + n); this.p += n; return b; }
  bits(n) {
    const out = [];
    let mask = 0, b = 0;
    for (let i = 0; i < n; i++) {
      if (mask === 0) { b = this.byte(); mask = 0x80; }
      out.push((b & mask) !== 0);
      mask >>>= 1;
    }
    return out;
  }
  defined(n) {
    const all = this.byte();
    return all ? new Array(n).fill(true) : this.bits(n);
  }
  digests(n) {
    const def = this.defined(n);
    return def.map((x) => (x ? this.u32() : null));
  }
}

function readPackInfo(r) {
  const packPos = r.num();
  const n = r.num();
  let sizes = [], crcs = [];
  for (;;) {
    const id = r.num();
    if (id === ID.End) break;
    if (id === ID.Size) sizes = Array.from({ length: n }, () => r.num());
    else if (id === ID.CRC) crcs = r.digests(n);
    else throw new SevenZipError('7zの目次が読めません（PackInfo）');
  }
  return { packPos, sizes, crcs };
}

function readFolder(r) {
  const numCoders = r.num();
  const coders = [];
  let totalIn = 0, totalOut = 0;
  for (let i = 0; i < numCoders; i++) {
    const flag = r.byte();
    if (flag & 0x80) throw new SevenZipError('この7zの作りには対応していません（代わりの方式）');
    const id = [...r.bytes(flag & 0x0f)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const nIn = flag & 0x10 ? r.num() : 1;
    const nOut = flag & 0x10 ? r.num() : 1;
    const props = flag & 0x20 ? r.bytes(r.num()) : null;
    coders.push({ id, nIn, nOut, props, inBase: totalIn, outBase: totalOut });
    totalIn += nIn;
    totalOut += nOut;
  }
  const bind = [];
  for (let i = 0; i < totalOut - 1; i++) bind.push({ inIndex: r.num(), outIndex: r.num() });
  const numPacked = totalIn - bind.length;
  let packed = [];
  if (numPacked === 1) {
    for (let i = 0; i < totalIn; i++) if (!bind.some((b) => b.inIndex === i)) { packed = [i]; break; }
  } else {
    packed = Array.from({ length: numPacked }, () => r.num());
  }
  return { coders, bind, packed, totalOut, unpackSizes: [], crc: null };
}

function readUnpackInfo(r) {
  if (r.num() !== ID.Folder) throw new SevenZipError('7zの目次が読めません（Folder）');
  const n = r.num();
  if (r.byte() !== 0) throw new SevenZipError('この7zの作りには対応していません（外部の目次）');
  const folders = Array.from({ length: n }, () => readFolder(r));
  if (r.num() !== ID.CodersUnPackSize) throw new SevenZipError('7zの目次が読めません（UnPackSize）');
  for (const f of folders) f.unpackSizes = Array.from({ length: f.totalOut }, () => r.num());
  for (;;) {
    const id = r.num();
    if (id === ID.End) break;
    if (id === ID.CRC) { const c = r.digests(n); folders.forEach((f, i) => { f.crc = c[i]; }); } else throw new SevenZipError('7zの目次が読めません（UnPackInfo）');
  }
  return folders;
}

/** フォルダ（圧縮のまとまり）の、最後に出てくる大きさ */
function folderSize(f) {
  for (let i = f.totalOut - 1; i >= 0; i--) if (!f.bind.some((b) => b.outIndex === i)) return f.unpackSizes[i];
  return 0;
}

function readSubStreams(r, folders) {
  const nums = folders.map(() => 1);
  let id = r.num();
  if (id === ID.NumUnPackStream) { folders.forEach((_, i) => { nums[i] = r.num(); }); id = r.num(); }
  const sizes = [];
  const hasSizes = id === ID.Size;
  folders.forEach((f, i) => {
    if (nums[i] === 0) return;
    let sum = 0;
    for (let j = 1; j < nums[i]; j++) {
      const s = hasSizes ? r.num() : 0;
      sizes.push(s);
      sum += s;
    }
    sizes.push(folderSize(f) - sum);
  });
  if (hasSizes) id = r.num();
  // CRC：フォルダに1つだけでフォルダのCRCがあるものは、そちらを使う
  const crcs = [];
  let unknown = 0;
  folders.forEach((f, i) => { if (!(nums[i] === 1 && f.crc != null)) unknown += nums[i]; });
  let digests = null;
  for (;;) {
    if (id === ID.End) break;
    if (id === ID.CRC) digests = r.digests(unknown);
    else throw new SevenZipError('7zの目次が読めません（SubStreamsInfo）');
    id = r.num();
  }
  let k = 0;
  folders.forEach((f, i) => {
    if (nums[i] === 1 && f.crc != null) crcs.push(f.crc);
    else for (let j = 0; j < nums[i]; j++) crcs.push(digests ? digests[k++] : null);
  });
  return { nums, sizes, crcs };
}

function readStreamsInfo(r) {
  let pack = null, folders = [], sub = null;
  for (;;) {
    const id = r.num();
    if (id === ID.End) break;
    if (id === ID.PackInfo) pack = readPackInfo(r);
    else if (id === ID.UnPackInfo) folders = readUnpackInfo(r);
    else if (id === ID.SubStreamsInfo) sub = readSubStreams(r, folders);
    else throw new SevenZipError('7zの目次が読めません（StreamsInfo）');
  }
  if (!sub) sub = { nums: folders.map(() => 1), sizes: folders.map(folderSize), crcs: folders.map((f) => f.crc) };
  return { pack, folders, sub };
}

// ------------------------------------------------------------ 展開
const METHOD = { '00': 'copy', '030101': 'lzma', '21': 'lzma2', '040108': 'deflate', '03030103': 'bcj' };
const UNSUPPORTED = { '06f10701': 'パスワード付きの7z', '040202': 'BZip2で圧縮された7z', '030401': 'PPMdで圧縮された7z', '0303011b': 'BCJ2の前処理をした7z', '040109': 'Deflate64で圧縮された7z', '03': 'Deltaの前処理をした7z' };

function x86Decode(data) {
  const allowed = [1, 1, 1, 0, 1, 0, 0, 0];
  const bitNum = [0, 1, 2, 2, 3, 3, 3, 3];
  const ms = (b) => b === 0 || b === 0xff;
  const size = data.length;
  if (size < 5) return data;
  const ip = 5;
  let pos = 0, prevPos = -1, prevMask = 0;
  const limit = size - 4;
  for (;;) {
    while (pos < limit && (data[pos] & 0xfe) !== 0xe8) pos++;
    if (pos >= limit) break;
    const d = pos - prevPos;
    if (d > 3) prevMask = 0;
    else {
      prevMask = (prevMask << (d - 1)) & 7;
      if (prevMask !== 0) {
        const b = data[pos + 4 - bitNum[prevMask]];
        if (!allowed[prevMask] || ms(b)) {
          prevPos = pos;
          prevMask = ((prevMask << 1) & 7) | 1;
          pos++;
          continue;
        }
      }
    }
    prevPos = pos;
    if (ms(data[pos + 4])) {
      let src = ((data[pos + 4] << 24) | (data[pos + 3] << 16) | (data[pos + 2] << 8) | data[pos + 1]) >>> 0;
      let dest;
      for (;;) {
        dest = (src - (ip + pos)) >>> 0;
        if (prevMask === 0) break;
        const index = bitNum[prevMask] * 8;
        const b = (dest >>> (24 - index)) & 0xff;
        if (!ms(b)) break;
        src = (dest ^ ((2 ** (32 - index)) - 1)) >>> 0;
      }
      data[pos + 4] = ~(((dest >>> 24) & 1) - 1) & 0xff;
      data[pos + 3] = (dest >>> 16) & 0xff;
      data[pos + 2] = (dest >>> 8) & 0xff;
      data[pos + 1] = dest & 0xff;
      pos += 5;
    } else {
      prevMask = ((prevMask << 1) & 7) | 1;
      pos++;
    }
  }
  return data;
}

/** フォルダを展開する（圧縮の方式をつないだもの） */
function decodeFolder(d, f, packStart, packSizes) {
  for (const c of f.coders) {
    if (UNSUPPORTED[c.id]) throw new SevenZipError(`${UNSUPPORTED[c.id]}には対応していません`);
    if (!METHOD[c.id]) throw new SevenZipError(`この7zの圧縮方式（${c.id}）には対応していません`);
    if (c.nOut !== 1) throw new SevenZipError('この7zの作りには対応していません');
  }
  // 入力の流れ i が、どこから来るか：まとめて圧縮されたデータか、別の方式の出力か
  const packOffsets = [];
  let o = packStart;
  for (const s of packSizes) { packOffsets.push(o); o += s; }
  const memo = new Map();
  const outOf = (outIndex) => {
    if (memo.has(outIndex)) return memo.get(outIndex);
    const ci = f.coders.findIndex((c) => outIndex >= c.outBase && outIndex < c.outBase + c.nOut);
    const c = f.coders[ci];
    const inputs = [];
    for (let k = 0; k < c.nIn; k++) {
      const inIndex = c.inBase + k;
      const b = f.bind.find((x) => x.inIndex === inIndex);
      if (b) inputs.push(outOf(b.outIndex));
      else {
        const pi = f.packed.indexOf(inIndex);
        if (pi < 0) throw new SevenZipError('7zの目次が壊れています');
        const start = packOffsets[pi];
        if (start + packSizes[pi] > d.length) throw new SevenZipError('7zの中身が途中で切れています');
        inputs.push(d.subarray(start, start + packSizes[pi]));
      }
    }
    const size = f.unpackSizes[outIndex];
    if (size > 1024 * 1024 * 1024) throw new SevenZipError('7zの中身が大きすぎます');
    let out;
    const m = METHOD[c.id];
    if (m === 'copy') out = inputs[0].slice(0, size);
    else if (m === 'lzma') out = lzmaDecode(inputs[0], c.props, size);
    else if (m === 'lzma2') out = lzma2Decode(inputs[0], size);
    else if (m === 'deflate') {
      try { out = inflateSync(inputs[0], { out: new Uint8Array(size) }); } catch { throw new SevenZipError('7zの中身を展開できませんでした（Deflate）'); }
    } else if (m === 'bcj') out = x86Decode(inputs[0].slice(0, size));
    if (out.length !== size) throw new SevenZipError('7zの中身の大きさが合いません');
    memo.set(outIndex, out);
    return out;
  };
  const final = Array.from({ length: f.totalOut }, (_, i) => i).find((i) => !f.bind.some((b) => b.outIndex === i));
  const out = outOf(final);
  if (f.crc != null && crc32(out) !== f.crc) throw new SevenZipError('7zの中身が壊れています（CRC不一致）');
  return out;
}

/** 目次（とその前の圧縮のまとまり）を読む */
function readArchive(d) {
  if (!looksLike7z(d)) throw new SevenZipError('7zファイルではないようです');
  const nextOff = u64(d, 12), nextSize = u64(d, 20), nextCrc = u32(d, 28);
  const hs = 32 + nextOff;
  if (hs + nextSize > d.length) throw new SevenZipError('7zファイルが途中で切れています');
  let header = d.subarray(hs, hs + nextSize);
  if (crc32(header) !== nextCrc) throw new SevenZipError('7zの目次が壊れています（CRC不一致）');
  for (let guard = 0; guard < 4; guard++) {
    const r = new Reader(header);
    const id = r.num();
    if (id === ID.Header) return parseHeader(r, d);
    if (id !== ID.EncodedHeader) throw new SevenZipError('7zの目次が読めません');
    // 目次そのものが圧縮されている
    const si = readStreamsInfo(r);
    const f = si.folders[0];
    if (!f || !si.pack) throw new SevenZipError('7zの目次が読めません');
    header = decodeFolder(d, f, 32 + si.pack.packPos, si.pack.sizes.slice(0, f.packed.length));
  }
  throw new SevenZipError('7zの目次が読めません');
}

function parseHeader(r, d) {
  let streams = null;
  let id = r.num();
  if (id === ID.ArchiveProperties) {
    for (;;) { const t = r.num(); if (t === ID.End) break; r.bytes(r.num()); }
    id = r.num();
  }
  if (id === ID.AdditionalStreamsInfo) { readStreamsInfo(r); id = r.num(); }
  if (id === ID.MainStreamsInfo) { streams = readStreamsInfo(r); id = r.num(); }
  const files = [];
  if (id === ID.FilesInfo) {
    const n = r.num();
    for (let i = 0; i < n; i++) files.push({ name: '', emptyStream: false, emptyFile: false, dir: false });
    let emptyStreams = [];
    for (;;) {
      const t = r.num();
      if (t === ID.End) break;
      const size = r.num();
      const end = r.p + size;
      if (t === ID.EmptyStream) {
        emptyStreams = r.bits(n);
        emptyStreams.forEach((b, i) => { files[i].emptyStream = b; });
      } else if (t === ID.EmptyFile) {
        const idx = files.map((f, i) => (f.emptyStream ? i : -1)).filter((i) => i >= 0);
        r.bits(idx.length).forEach((b, k) => { files[idx[k]].emptyFile = b; });
      } else if (t === ID.Name) {
        if (r.byte() !== 0) throw new SevenZipError('この7zの作りには対応していません（外部の名前）');
        const raw = r.bytes(end - r.p);
        let k = 0, s = 0;
        for (let i = 0; i + 1 < raw.length && k < n; i += 2) {
          if (raw[i] === 0 && raw[i + 1] === 0) {
            files[k++].name = new TextDecoder('utf-16le').decode(raw.subarray(s, i)).normalize('NFC');
            s = i + 2;
          }
        }
      } else if (t === ID.WinAttributes) {
        const def = r.defined(n);
        if (r.byte() !== 0) throw new SevenZipError('この7zの作りには対応していません');
        def.forEach((x, i) => { if (x) { const a = r.u32(); if (a & 0x10) files[i].dir = true; } });
      }
      r.p = end;
    }
  }
  // ファイルと、展開した流れを対応させる
  const entries = [];
  const warnings = [];
  if (!streams) {
    for (const f of files) if (!f.dir && f.emptyStream) entries.push({ name: f.name.replace(/\\/g, '/'), size: 0, read: () => new Uint8Array(0) });
    return { entries, warnings };
  }
  const { folders, pack, sub } = streams;
  // フォルダごとの、まとめて圧縮されたデータの位置
  let pi = 0, off = 32 + pack.packPos;
  const folderPack = folders.map((f) => {
    const sizes = pack.sizes.slice(pi, pi + f.packed.length);
    const start = off;
    pi += f.packed.length;
    off += sizes.reduce((a, b) => a + b, 0);
    return { start, sizes, cache: null };
  });
  let si = 0, fi = 0, inFolder = 0, offInFolder = 0;
  for (const f of files) {
    const name = f.name.replace(/\\/g, '/');
    if (f.emptyStream) {
      // 中身の無いファイル（中身も無く「空のファイル」でもないものはフォルダ）
      if (f.emptyFile && !f.dir) entries.push({ name, size: 0, read: () => new Uint8Array(0) });
      continue;
    }
    while (fi < folders.length && inFolder >= sub.nums[fi]) { fi++; inFolder = 0; offInFolder = 0; }
    if (fi >= folders.length) throw new SevenZipError('7zの目次が壊れています');
    const size = sub.sizes[si], crc = sub.crcs[si];
    const folder = folders[fi], fp = folderPack[fi], start = offInFolder;
    si++; inFolder++; offInFolder += size;
    if (f.dir) continue;
    entries.push({
      name, size,
      read: () => {
        if (!fp.cache) fp.cache = decodeFolder(d, folder, fp.start, fp.sizes);
        const out = fp.cache.slice(start, start + size);
        if (out.length !== size) throw new SevenZipError(`7zの中身が壊れています（${name}）`);
        if (crc != null && crc32(out) !== crc) throw new SevenZipError(`ファイルが壊れています（CRC不一致：${name}）`);
        return out;
      },
    });
  }
  return { entries, warnings };
}

/**
 * 7zを読み、エントリの一覧を返す（中身はまだ展開しない）。
 * @returns {{entries: {name: string, size: number, read: () => Uint8Array}[], warnings: string[]}}
 */
export function read7z(d) {
  return readArchive(d);
}

/**
 * 7zの目次だけを、ファイルの一部を読みながら取り出す（中身は展開しない）。
 * @param {(start: number, end: number) => Promise<Uint8Array>} get ファイルの start〜end（end を含む）を読む
 * @returns {Promise<{name: string, size: number}[]>}
 */
export async function list7zParts(get) {
  const top = await get(0, 31);
  if (!looksLike7z(new Uint8Array([...top, 0]))) throw new SevenZipError('7zファイルではないようです');
  const nextOff = u64(top, 12), nextSize = u64(top, 20), nextCrc = u32(top, 28);
  if (nextSize > 16 * 1024 * 1024) throw new SevenZipError('7zの目次が大きすぎます');
  let header = await get(32 + nextOff, 32 + nextOff + nextSize - 1);
  if (header.length !== nextSize || crc32(header) !== nextCrc) throw new SevenZipError('7zの目次が壊れています（CRC不一致）');
  for (let guard = 0; guard < 4; guard++) {
    const r = new Reader(header);
    const id = r.num();
    if (id === ID.Header) return parseHeader(r, null).entries.map((e) => ({ name: e.name, size: e.size }));
    if (id !== ID.EncodedHeader) throw new SevenZipError('7zの目次が読めません');
    const si = readStreamsInfo(r);
    const f = si.folders[0];
    if (!f || !si.pack) throw new SevenZipError('7zの目次が読めません');
    const sizes = si.pack.sizes.slice(0, f.packed.length);
    const sum = sizes.reduce((a, b) => a + b, 0);
    if (sum > 16 * 1024 * 1024) throw new SevenZipError('7zの目次が大きすぎます');
    const packed = await get(32 + si.pack.packPos, 32 + si.pack.packPos + sum - 1);
    header = decodeFolder(packed, f, 0, sizes);
  }
  throw new SevenZipError('7zの目次が読めません');
}
