// LZH（.lzh・.lha）の展開。古いCardWirthのシナリオで使われていた形式。
// 対応：圧縮方式 -lh0-（無圧縮）・-lh5-・-lh6-・-lh7-、ヘッダのレベル 0・1・2。
// ファイル名はShift_JIS（CP932）が普通なので、zipと同じ読み直しをかける。

import { decodeZipName } from './text.js';

export class LzhError extends Error {}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

let crcTable = null;
export function crc16(data) {
  if (!crcTable) {
    crcTable = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
      crcTable[i] = c;
    }
  }
  let c = 0;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return c & 0xffff;
}

/** LZHらしいか（最初のヘッダに -lh?- などの方式名があるか） */
export function looksLikeLzh(d) {
  return d.length > 21 && d[2] === 0x2d && d[3] === 0x6c && (d[4] === 0x68 || d[4] === 0x7a) && d[6] === 0x2d;
}

/**
 * ヘッダのパス（区切りは \ ・ / ・ 0xFF のどれか）を、/ 区切りの文字にする。
 * Shift_JIS の2バイト目に 0x5C（\）が来る文字（「ソ」「表」など）を区切りと間違えないよう、
 * 先に文字として読み直してから、残った \ を区切りとして扱う。
 */
function pathFromBytes(bytes) {
  const b = Uint8Array.from(bytes, (x) => (x === 0xff ? 0x2f : x));
  return decodeZipName(b, false).replace(/\\/g, '/');
}

/**
 * LZHを読み、エントリの一覧を返す（中身はまだ展開しない）。
 * @returns {{entries: {name: string, size: number, csize: number, method: string, read: () => Uint8Array}[], warnings: string[]}}
 */
export function readLzh(d) {
  const entries = [];
  const warnings = [];
  let p = 0;
  for (let guard = 0; guard < 100000; guard++) {
    if (p >= d.length || d[p] === 0) break; // 終わり
    if (p + 22 > d.length) throw new LzhError('LZHのヘッダが途中で切れています');
    const level = d[p + 20];
    const method = String.fromCharCode(...d.subarray(p + 2, p + 7));
    if (!/^-(lh[0-7d]|lz[s45])-$/.test(method)) throw new LzhError(`LZHとして読めませんでした（${method}）`);
    let headerLen, csize, usize, nameBytes = null, dirBytes = null, crc = null, dataStart;
    if (level === 0 || level === 1) {
      headerLen = d[p] + 2;
      csize = u32(d, p + 7);
      usize = u32(d, p + 11);
      const nlen = d[p + 21];
      nameBytes = d.subarray(p + 22, p + 22 + nlen);
      crc = u16(d, p + 22 + nlen);
      dataStart = p + headerLen;
      if (level === 1) {
        // 拡張ヘッダ：基本ヘッダの最後の2バイトが最初の拡張ヘッダの大きさ。csize には拡張ヘッダの分も含まれる
        let q = p + headerLen - 2;
        let ext = u16(d, q);
        q += 2;
        while (ext) {
          if (q + ext > d.length) throw new LzhError('LZHの拡張ヘッダが壊れています');
          const type = d[q];
          const body = d.subarray(q + 1, q + ext - 2);
          if (type === 0x01) nameBytes = body;
          else if (type === 0x02) dirBytes = body;
          csize -= ext;
          const next = u16(d, q + ext - 2);
          q += ext;
          ext = next;
        }
        dataStart = q;
      }
    } else if (level === 2) {
      headerLen = u16(d, p);
      csize = u32(d, p + 7);
      usize = u32(d, p + 11);
      crc = u16(d, p + 21);
      let q = p + 24;
      let ext = u16(d, q);
      q += 2;
      while (ext) {
        if (q + ext > p + headerLen) throw new LzhError('LZHの拡張ヘッダが壊れています');
        const type = d[q];
        const body = d.subarray(q + 1, q + ext - 2);
        if (type === 0x01) nameBytes = body;
        else if (type === 0x02) dirBytes = body;
        const next = u16(d, q + ext - 2);
        q += ext;
        ext = next;
      }
      dataStart = p + headerLen;
    } else {
      throw new LzhError(`この形のLZH（ヘッダのレベル ${level}）には対応していません`);
    }
    if (dataStart + csize > d.length) throw new LzhError('LZHの中身が途中で切れています');
    const dir = dirBytes ? [...dirBytes] : [];
    while (dir.length && dir[dir.length - 1] === 0xff) dir.pop();
    const full = new Uint8Array([...(dir.length ? [...dir, 0xff] : []), ...(nameBytes || [])]);
    const name = pathFromBytes(full);
    const data = d.subarray(dataStart, dataStart + csize);
    p = dataStart + csize;
    if (method === '-lhd-' || name.endsWith('/')) continue; // フォルダ
    if (!['-lh0-', '-lh5-', '-lh6-', '-lh7-', '-lz4-'].includes(method)) {
      warnings.push(`対応していない圧縮方式のため無視しました（${method}）：${name}`);
      continue;
    }
    entries.push({
      name, size: usize, csize, method,
      read: () => {
        const out = method === '-lh0-' || method === '-lz4-' ? data.slice() : decodeLh(data, usize, method);
        if (out.length !== usize) throw new LzhError(`サイズが一致しません（${name}）`);
        if (crc != null && crc16(out) !== crc) throw new LzhError(`ファイルが壊れています（CRC不一致：${name}）`);
        return out;
      },
    });
  }
  return { entries, warnings };
}

// ------------------------------------------------------------ -lh5- / -lh6- / -lh7- の展開
const NC = 510; // 文字（256）＋長さ（254）
const NT = 19;
const TBIT = 5;
const CBIT = 9;

/**
 * 符号の長さから、16ビットの先読みで引ける表を作る（LHAの符号は「短い順・番号順」に割り当てる正準ハフマン）
 * @returns {{sym: Uint16Array, len: Uint8Array}}
 */
function makeTable(lens, n) {
  const sym = new Uint16Array(65536);
  const len = new Uint8Array(65536);
  const count = new Uint32Array(17);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  const start = new Uint32Array(18);
  for (let i = 1; i <= 16; i++) start[i + 1] = start[i] + (count[i] << (16 - i));
  if (start[17] !== 65536) throw new LzhError('LZHの中身が壊れています（符号表）');
  for (let s = 0; s < n; s++) {
    const l = lens[s];
    if (!l) continue;
    const a = start[l], b = a + (1 << (16 - l));
    sym.fill(s, a, b);
    len.fill(l, a, b);
    start[l] = b;
  }
  return { sym, len };
}

function decodeLh(src, size, method) {
  const dicbit = method === '-lh5-' ? 13 : method === '-lh6-' ? 15 : 16;
  const np = dicbit + 1;
  const pbit = method === '-lh5-' ? 4 : 5;
  const out = new Uint8Array(size);
  let ip = 0;
  // ビットの読み取り（16ビットの窓）
  let bitbuf = 0, subbitbuf = 0, bitcount = 0;
  const fillbuf = (n) => {
    bitbuf = (bitbuf << n) & 0xffff;
    while (n > bitcount) {
      n -= bitcount;
      bitbuf = (bitbuf | (subbitbuf << n)) & 0xffff;
      subbitbuf = ip < src.length ? src[ip++] : 0;
      bitcount = 8;
    }
    bitcount -= n;
    bitbuf = (bitbuf | (subbitbuf >>> bitcount)) & 0xffff;
    subbitbuf &= (1 << bitcount) - 1;
  };
  const getbits = (n) => {
    if (n === 0) return 0;
    const x = bitbuf >>> (16 - n);
    fillbuf(n);
    return x;
  };
  fillbuf(16);

  const ptLen = new Uint8Array(Math.max(NT, np) + 4);
  const cLen = new Uint8Array(NC);
  let ptTable, cTable, single = { pt: -1, c: -1 };

  const readPtLen = (nn, nbit, special) => {
    const n = getbits(nbit);
    if (n === 0) {
      single.pt = getbits(nbit);
      ptLen.fill(0);
      return;
    }
    single.pt = -1;
    if (n > nn) throw new LzhError('LZHの中身が壊れています（表の大きさ）');
    let i = 0;
    while (i < n) {
      let c = bitbuf >>> 13;
      if (c === 7) {
        let mask = 1 << 12;
        while (mask & bitbuf) { mask >>>= 1; c++; }
        if (c > 16) throw new LzhError('LZHの中身が壊れています（符号の長さ）');
      }
      fillbuf(c < 7 ? 3 : c - 3);
      ptLen[i++] = c;
      if (i === special) {
        let z = getbits(2);
        while (z-- > 0 && i < nn) ptLen[i++] = 0;
      }
    }
    while (i < nn) ptLen[i++] = 0;
    ptTable = makeTable(ptLen, nn);
  };

  const readCLen = () => {
    const n = getbits(CBIT);
    if (n === 0) {
      single.c = getbits(CBIT);
      cLen.fill(0);
      return;
    }
    single.c = -1;
    if (n > NC) throw new LzhError('LZHの中身が壊れています（表の大きさ）');
    let i = 0;
    while (i < n) {
      let c;
      if (single.pt >= 0) c = single.pt;
      else { c = ptTable.sym[bitbuf]; fillbuf(ptTable.len[bitbuf]); }
      if (c <= 2) {
        let z = c === 0 ? 1 : c === 1 ? getbits(4) + 3 : getbits(CBIT) + 20;
        while (z-- > 0 && i < NC) cLen[i++] = 0;
      } else {
        cLen[i++] = c - 2;
      }
    }
    while (i < NC) cLen[i++] = 0;
    cTable = makeTable(cLen, NC);
  };

  const decodeC = () => {
    if (single.c >= 0) return single.c;
    const s = cTable.sym[bitbuf];
    fillbuf(cTable.len[bitbuf]);
    return s;
  };
  const decodeP = () => {
    let j;
    if (single.pt >= 0) j = single.pt;
    else { j = ptTable.sym[bitbuf]; fillbuf(ptTable.len[bitbuf]); }
    return j === 0 ? 0 : (1 << (j - 1)) + getbits(j - 1);
  };

  let blocksize = 0;
  let pos = 0;
  while (pos < size) {
    if (blocksize === 0) {
      blocksize = getbits(16);
      readPtLen(NT, TBIT, 3);
      readCLen();
      readPtLen(np, pbit, -1);
      if (blocksize === 0) throw new LzhError('LZHの中身が壊れています（ブロック）');
    }
    blocksize--;
    const c = decodeC();
    if (c < 256) {
      out[pos++] = c;
    } else {
      let n = c - 256 + 3;
      const dist = decodeP() + 1;
      let from = pos - dist;
      while (n-- > 0 && pos < size) {
        out[pos++] = from >= 0 ? out[from] : 0x20; // 辞書の最初は空白で埋まっている決まり
        from++;
      }
    }
    if (ip > src.length + 4) throw new LzhError('LZHの中身が途中で切れています');
  }
  return out;
}
