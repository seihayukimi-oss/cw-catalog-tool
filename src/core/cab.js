// CAB（.cab）の展開。CardWirthのエディタでCAB保存したシナリオは、LZX（窓21ビット）で圧縮されている。
// 対応：無圧縮・MSZIP・LZX（窓15〜21ビット）。分割されたCAB（複数ファイルにまたがるもの）は非対応。
// LZX の展開は、libmspack（lzxd.c）と同じ手順で作っている。

import { inflateSync } from 'fflate';
import { decodeZipName } from './text.js';

export class CabError extends Error {}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export function looksLikeCab(d) {
  return d.length > 36 && d[0] === 0x4d && d[1] === 0x53 && d[2] === 0x43 && d[3] === 0x46; // MSCF
}

/**
 * CABを読み、エントリの一覧を返す（中身はまだ展開しない）。
 * @returns {{entries: {name: string, size: number, read: () => Uint8Array}[], warnings: string[]}}
 */
export function readCab(d) {
  if (!looksLikeCab(d)) throw new CabError('CABファイルではないようです');
  const coffFiles = u32(d, 16);
  const cFolders = u16(d, 26);
  const cFiles = u16(d, 28);
  const flags = u16(d, 30);
  if (flags & 0x0003) throw new CabError('複数のファイルに分割されたCABには対応していません');
  let p = 36;
  let cbFolderRes = 0, cbDataRes = 0;
  if (flags & 0x0004) {
    const cbHeader = u16(d, 36);
    cbFolderRes = d[38];
    cbDataRes = d[39];
    p = 40 + cbHeader;
  }
  const folders = [];
  for (let i = 0; i < cFolders; i++) {
    if (p + 8 > d.length) throw new CabError('CABの目次が壊れています');
    folders.push({ start: u32(d, p), blocks: u16(d, p + 4), comp: u16(d, p + 6), cache: null });
    p += 8 + cbFolderRes;
  }
  const entries = [];
  const warnings = [];
  p = coffFiles;
  for (let i = 0; i < cFiles; i++) {
    if (p + 16 > d.length) throw new CabError('CABの目次が壊れています');
    const size = u32(d, p);
    const off = u32(d, p + 4);
    const iFolder = u16(d, p + 8);
    const attr = u16(d, p + 14);
    let e = p + 16;
    while (e < d.length && d[e] !== 0) e++;
    const raw = d.subarray(p + 16, e);
    p = e + 1;
    // 0x80：名前がUTF-8。そうでなければShift_JIS（CP932）など
    const name = decodeZipName(raw, (attr & 0x80) !== 0).replace(/\\/g, '/');
    if (iFolder >= 0xfffd) { warnings.push(`分割されたCABの続きのファイルのため無視しました：${name}`); continue; }
    const folder = folders[iFolder];
    if (!folder) throw new CabError('CABの目次が壊れています');
    entries.push({
      name, size,
      read: () => {
        if (!folder.cache) folder.cache = decodeFolder(d, folder, cbDataRes);
        if (off + size > folder.cache.length) throw new CabError(`CABの中身が壊れています（${name}）`);
        return folder.cache.slice(off, off + size);
      },
    });
  }
  return { entries, warnings };
}

/** フォルダ（圧縮のまとまり）を全部展開する */
function decodeFolder(d, folder, cbDataRes) {
  const blocks = [];
  let total = 0, p = folder.start;
  for (let i = 0; i < folder.blocks; i++) {
    if (p + 8 > d.length) throw new CabError('CABの中身が途中で切れています');
    const cb = u16(d, p + 4);
    const ub = u16(d, p + 6);
    const s = p + 8 + cbDataRes;
    if (s + cb > d.length) throw new CabError('CABの中身が途中で切れています');
    blocks.push({ data: d.subarray(s, s + cb), size: ub });
    total += ub;
    p = s + cb;
  }
  if (total > 1024 * 1024 * 1024) throw new CabError('CABの中身が大きすぎます');
  const type = folder.comp & 0x0f;
  const out = new Uint8Array(total);
  if (type === 0) {
    let o = 0;
    for (const b of blocks) { out.set(b.data.subarray(0, b.size), o); o += b.size; }
    return out;
  }
  if (type === 1) {
    // MSZIP：ブロックごとに「CK」＋deflate。前のブロックの内容を辞書として使う
    let o = 0;
    for (const b of blocks) {
      if (b.data[0] !== 0x43 || b.data[1] !== 0x4b) throw new CabError('CABの中身が壊れています（MSZIP）');
      let part;
      try {
        part = inflateSync(b.data.subarray(2), { out: new Uint8Array(b.size), dictionary: o ? out.subarray(Math.max(0, o - 32768), o) : undefined });
      } catch { throw new CabError('CABの中身を展開できませんでした（MSZIP）'); }
      out.set(part.subarray(0, b.size), o);
      o += b.size;
    }
    return out;
  }
  if (type === 3) {
    const wbits = (folder.comp >> 8) & 0x1f;
    if (wbits < 15 || wbits > 21) throw new CabError('CABの中身が壊れています（LZXの窓の大きさ）');
    const input = new Uint8Array(blocks.reduce((a, b) => a + b.data.length, 0));
    let o = 0;
    for (const b of blocks) { input.set(b.data, o); o += b.data.length; }
    return lzxDecode(input, total, wbits);
  }
  throw new CabError(type === 2 ? 'Quantum圧縮のCABには対応していません' : 'このCABの圧縮方式には対応していません');
}

// ------------------------------------------------------------ LZX
const FRAME = 32768;
const NUM_CHARS = 256;
const PRETREE_NUM = 20;
const SECONDARY_LENGTHS = 249;
const EXTRA_BITS = new Uint8Array(52);
const POSITION_BASE = new Uint32Array(52);
{
  for (let i = 0, j = 0; i < 51; i += 2) {
    EXTRA_BITS[i] = j;
    EXTRA_BITS[i + 1] = j;
    if (i !== 0 && j < 17) j++;
  }
  for (let i = 0, j = 0; i < 51; i++) {
    POSITION_BASE[i] = j;
    j += 1 << EXTRA_BITS[i];
  }
}

/** 符号の長さから、16ビットの先読みで引ける表を作る（正準ハフマン：短い順・番号順）。全部0なら null */
function lzxTable(lens, n) {
  const count = new Uint32Array(17);
  let any = false;
  for (let i = 0; i < n; i++) { if (lens[i] > 16) throw new CabError('CABの中身が壊れています（LZXの符号）'); count[lens[i]]++; if (lens[i]) any = true; }
  if (!any) return null;
  count[0] = 0;
  const next = new Uint32Array(18);
  for (let i = 1; i <= 16; i++) next[i + 1] = next[i] + (count[i] << (16 - i));
  if (next[17] !== 65536) {
    // 符号が1つだけのときなど、表が埋まらない作りも許す（使われない場所は 0 のまま）
    if (next[17] > 65536) throw new CabError('CABの中身が壊れています（LZXの符号表）');
  }
  const sym = new Uint16Array(65536);
  const len = new Uint8Array(65536);
  for (let s = 0; s < n; s++) {
    const l = lens[s];
    if (!l) continue;
    const a = next[l], b = a + (1 << (16 - l));
    sym.fill(s, a, b);
    len.fill(l, a, b);
    next[l] = b;
  }
  return { sym, len };
}

export function lzxDecode(input, outSize, wbits) {
  const numOffsets = wbits === 20 ? 42 : wbits === 21 ? 50 : wbits << 1;
  const mainElements = NUM_CHARS + (numOffsets << 3);
  const win = new Uint8Array(outSize); // 展開した内容（E8変換の前）
  const out = new Uint8Array(outSize);
  const mainLen = new Uint8Array(mainElements);
  const lengthLen = new Uint8Array(SECONDARY_LENGTHS);
  const preLen = new Uint8Array(PRETREE_NUM);
  const alignedLen = new Uint8Array(8);
  let mainT = null, lengthT = null, alignedT = null;

  // ビットの読み取り：16ビットのリトルエンディアンの語を、上のビットから読む
  let ip = 0, bitbuf = 0, bitsLeft = 0;
  const word = () => {
    const w = (ip + 1 < input.length ? input[ip] | (input[ip + 1] << 8) : ip < input.length ? input[ip] : 0);
    ip += 2;
    return w;
  };
  const ensure = (n) => {
    while (bitsLeft < n) {
      bitbuf = (bitbuf | (word() << (16 - bitsLeft))) >>> 0;
      bitsLeft += 16;
    }
  };
  const peek = (n) => bitbuf >>> (32 - n);
  const remove = (n) => { bitbuf = n === 32 ? 0 : (bitbuf << n) >>> 0; bitsLeft -= n; };
  const bits = (n) => {
    if (n === 0) return 0;
    ensure(n); // n は17まで（32ビットの入れ物に収まる）
    const v = peek(n);
    remove(n);
    return v;
  };
  const huff = (t) => {
    if (!t) throw new CabError('CABの中身が壊れています（LZXの空の符号表）');
    ensure(16);
    const k = bitbuf >>> 16;
    const l = t.len[k];
    if (!l) throw new CabError('CABの中身が壊れています（LZXの符号）');
    remove(l);
    return t.sym[k];
  };
  const readLengths = (lens, first, last) => {
    for (let x = 0; x < PRETREE_NUM; x++) preLen[x] = bits(4);
    const pre = lzxTable(preLen, PRETREE_NUM);
    for (let x = first; x < last;) {
      let z = huff(pre);
      if (z === 17) { let y = bits(4) + 4; while (y-- && x < last) lens[x++] = 0; }
      else if (z === 18) { let y = bits(5) + 20; while (y-- && x < last) lens[x++] = 0; }
      else if (z === 19) {
        let y = bits(1) + 4;
        z = huff(pre);
        z = lens[x] - z;
        if (z < 0) z += 17;
        while (y-- && x < last) lens[x++] = z;
      } else {
        z = lens[x] - z;
        if (z < 0) z += 17;
        lens[x++] = z;
      }
    }
  };

  // 先頭：E8変換に使う大きさ
  let intelFilesize = 0, intelStarted = false;
  if (bits(1)) intelFilesize = ((bits(16) << 16) | bits(16)) | 0;

  let R0 = 1, R1 = 1, R2 = 1;
  let blockType = 0, blockRemaining = 0, blockLength = 0;
  let pos = 0, frame = 0;
  const wsize = 1 << wbits;

  while (pos < outSize) {
    const frameEnd = Math.min(pos + FRAME, outSize);
    let todo = frameEnd - pos;
    while (todo > 0) {
      while (blockRemaining === 0) {
        // 奇数の長さの無圧縮ブロックのあとは、1バイトの詰め物がある
        if (blockType === 3 && (blockLength & 1)) ip++;
        blockType = bits(3);
        blockRemaining = blockLength = (bits(16) << 8) | bits(8);
        if (blockType === 2) {
          for (let i = 0; i < 8; i++) alignedLen[i] = bits(3);
          alignedT = lzxTable(alignedLen, 8);
        }
        if (blockType === 1 || blockType === 2) {
          readLengths(mainLen, 0, 256);
          readLengths(mainLen, 256, mainElements);
          mainT = lzxTable(mainLen, mainElements);
          if (!mainT) throw new CabError('CABの中身が壊れています（LZX）');
          if (mainLen[0xe8]) intelStarted = true;
          readLengths(lengthLen, 0, SECONDARY_LENGTHS);
          lengthT = lzxTable(lengthLen, SECONDARY_LENGTHS);
        } else if (blockType === 3) {
          intelStarted = true;
          // バイト単位にそろえる：1〜16ビットを読み捨てる
          // （ここでは残りのビットは必ず今の語の残りなので、それを捨てる。残りが0なら1語まるごと捨てる）
          if (bitsLeft === 0) ensure(16);
          bitsLeft = 0; bitbuf = 0;
          const rd = () => { const v = input[ip] | (input[ip + 1] << 8) | (input[ip + 2] << 16) | (input[ip + 3] << 24); ip += 4; return v >>> 0; };
          R0 = rd(); R1 = rd(); R2 = rd();
        } else {
          throw new CabError('CABの中身が壊れています（LZXのブロックの種類）');
        }
        if (ip > input.length + 8) throw new CabError('CABの中身が途中で切れています');
      }
      let run = Math.min(blockRemaining, todo);
      todo -= run;
      blockRemaining -= run;
      if (blockType === 3) {
        if (ip + run > input.length) throw new CabError('CABの中身が途中で切れています');
        win.set(input.subarray(ip, ip + run), pos);
        ip += run;
        pos += run;
        continue;
      }
      while (run > 0) {
        let main = huff(mainT);
        if (main < NUM_CHARS) {
          win[pos++] = main;
          run--;
          continue;
        }
        main -= NUM_CHARS;
        let matchLen = main & 7;
        if (matchLen === 7) matchLen += huff(lengthT);
        matchLen += 2;
        let off = main >>> 3;
        if (off > 2) {
          const extra = off >= 36 ? 17 : EXTRA_BITS[off];
          if (blockType === 1) {
            off = POSITION_BASE[off] - 2 + bits(extra);
          } else {
            off = POSITION_BASE[off] - 2;
            if (extra > 3) {
              off += bits(extra - 3) << 3;
              off += huff(alignedT);
            } else if (extra === 3) {
              off += huff(alignedT);
            } else if (extra > 0) {
              off += bits(extra);
            } else {
              off = 1;
            }
          }
          R2 = R1; R1 = R0; R0 = off;
        } else if (off === 0) {
          off = R0;
        } else if (off === 1) {
          off = R1; R1 = R0; R0 = off;
        } else {
          off = R2; R2 = R0; R0 = off;
        }
        if (off > pos || off > wsize || off === 0) throw new CabError('CABの中身が壊れています（LZXの参照先）');
        if (pos + matchLen > outSize) throw new CabError('CABの中身が壊れています（LZXの長さ）');
        let from = pos - off;
        for (let i = 0; i < matchLen; i++) win[pos++] = win[from++];
        run -= matchLen;
      }
      // 最後の一致が、決めた長さをはみ出したら、その分を次のブロックから引く
      if (run < 0) {
        if (-run > blockRemaining) throw new CabError('CABの中身が壊れています（LZXのはみ出し）');
        blockRemaining -= -run;
        todo -= -run;
      }
    }
    if (pos !== frameEnd) throw new CabError('CABの中身が壊れています（LZXのフレーム）');
    // フレームの区切りで、16ビットにそろえる
    if (bitsLeft > 0) ensure(16);
    if (bitsLeft & 15) remove(bitsLeft & 15);

    // E8変換（x86の機械語のための前処理）を元に戻す
    const start = frame * FRAME;
    const size = frameEnd - start;
    out.set(win.subarray(start, frameEnd), start);
    if (intelStarted && intelFilesize && frame < 32768 && size > 10) {
      let curpos = start;
      for (let i = start, end = frameEnd - 10; i < end;) {
        if (out[i++] !== 0xe8) { curpos++; continue; }
        const abs = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16) | (out[i + 3] << 24);
        if (abs >= -curpos && abs < intelFilesize) {
          const rel = abs >= 0 ? abs - curpos : abs + intelFilesize;
          out[i] = rel & 0xff; out[i + 1] = (rel >>> 8) & 0xff; out[i + 2] = (rel >>> 16) & 0xff; out[i + 3] = (rel >>> 24) & 0xff;
        }
        i += 4;
        curpos += 5;
      }
    }
    frame++;
  }
  return out;
}
