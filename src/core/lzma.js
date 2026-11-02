// LZMA・LZMA2 の展開（7z で使う）。LZMA SDK の参考実装（LzmaSpec.cpp）と同じ手順。
// 出力の大きさが分かっている前提で、出力の配列をそのまま辞書（さかのぼって写す元）として使う。

export class LzmaError extends Error {}

const PROB_INIT = 1024;
const TOP = 0x1000000;

class Range {
  constructor(buf, pos, end) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
    this.range = 0xffffffff;
    this.code = 0;
    const b = this.byte();
    for (let i = 0; i < 4; i++) this.code = ((this.code << 8) | this.byte()) >>> 0;
    if (b !== 0 || this.code === this.range) throw new LzmaError('LZMAの中身が壊れています');
  }
  byte() {
    if (this.pos >= this.end) { this.pos++; return 0; }
    return this.buf[this.pos++];
  }
  norm() {
    if (this.range < TOP) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.byte()) >>> 0;
    }
  }
  bit(probs, i) {
    const v = probs[i];
    const bound = (this.range >>> 11) * v;
    let b;
    if (this.code < bound) {
      probs[i] = v + ((2048 - v) >>> 5);
      this.range = bound >>> 0;
      b = 0;
    } else {
      probs[i] = v - (v >>> 5);
      this.code = (this.code - bound) >>> 0;
      this.range = (this.range - bound) >>> 0;
      b = 1;
    }
    this.norm();
    return b;
  }
  direct(n) {
    let res = 0;
    while (n-- > 0) {
      this.range >>>= 1;
      let b = 0;
      if (this.code >= this.range) { this.code = (this.code - this.range) >>> 0; b = 1; }
      res = ((res << 1) | b) >>> 0;
      this.norm();
    }
    return res;
  }
  tree(probs, off, bits) {
    let m = 1;
    for (let i = 0; i < bits; i++) m = (m << 1) + this.bit(probs, off + m);
    return m - (1 << bits);
  }
  reverse(probs, off, bits) {
    let m = 1, sym = 0;
    for (let i = 0; i < bits; i++) {
      const b = this.bit(probs, off + m);
      m = (m << 1) + b;
      sym |= b << i;
    }
    return sym;
  }
}

/** 長さの符号（通常・繰り返しで2組） */
class LenCoder {
  constructor() { this.p = new Uint16Array(2 + 16 * 8 * 2 + 256); this.reset(); }
  reset() { this.p.fill(PROB_INIT); }
  decode(rc, posState) {
    // [0]=choice [1]=choice2 [2..129]=low [130..257]=mid [258..513]=high
    if (rc.bit(this.p, 0) === 0) return rc.tree(this.p, 2 + posState * 8, 3);
    if (rc.bit(this.p, 1) === 0) return 8 + rc.tree(this.p, 130 + posState * 8, 3);
    return 16 + rc.tree(this.p, 258, 8);
  }
}

/** LZMAの展開の状態（LZMA2では、チャンクをまたいで引き継ぐ） */
export class LzmaDecoder {
  constructor(out) {
    this.out = out; // 出力（＝辞書）
    this.pos = 0;
    this.dictStart = 0; // LZMA2 の辞書リセットの位置
  }
  setProps(propByte) {
    if (propByte >= 9 * 5 * 5) throw new LzmaError('LZMAの設定が正しくありません');
    this.lc = propByte % 9;
    propByte = (propByte / 9) | 0;
    this.lp = propByte % 5;
    this.pb = (propByte / 5) | 0;
    this.lit = new Uint16Array(0x300 << (this.lc + this.lp));
  }
  resetState() {
    this.lit.fill(PROB_INIT);
    this.isMatch = new Uint16Array(12 << 4).fill(PROB_INIT);
    this.isRep = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG0 = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG1 = new Uint16Array(12).fill(PROB_INIT);
    this.isRepG2 = new Uint16Array(12).fill(PROB_INIT);
    this.isRep0Long = new Uint16Array(12 << 4).fill(PROB_INIT);
    this.posSlot = new Uint16Array(4 << 6).fill(PROB_INIT);
    this.posDec = new Uint16Array(1 + 114).fill(PROB_INIT);
    this.align = new Uint16Array(16).fill(PROB_INIT);
    this.len = new LenCoder();
    this.repLen = new LenCoder();
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
  }
  getByte(dist) { return this.out[this.pos - dist]; }

  /**
   * 1つのLZMAの流れを展開する。
   * @param {number} limit ここまで書いたら止まる（out の位置）
   * @param {boolean} allowEnd 終わりの印があってもよいか
   */
  run(rc, limit, allowEnd = true) {
    const out = this.out;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    while (this.pos < limit) {
      const posState = this.pos & pbMask;
      let st = this.state;
      if (rc.bit(this.isMatch, (st << 4) + posState) === 0) {
        // 文字
        const prev = this.pos > this.dictStart ? out[this.pos - 1] : 0;
        const litState = ((this.pos & lpMask) << this.lc) + (prev >>> (8 - this.lc));
        const base = 0x300 * litState;
        let sym = 1;
        if (st >= 7) {
          let mb = this.getByte(this.rep0 + 1);
          do {
            const mbit = (mb >>> 7) & 1;
            mb <<= 1;
            const b = rc.bit(this.lit, base + ((1 + mbit) << 8) + sym);
            sym = (sym << 1) | b;
            if (mbit !== b) break;
          } while (sym < 0x100);
        }
        while (sym < 0x100) sym = (sym << 1) | rc.bit(this.lit, base + sym);
        out[this.pos++] = sym - 0x100;
        this.state = st < 4 ? 0 : st < 10 ? st - 3 : st - 6;
        continue;
      }
      let len;
      if (rc.bit(this.isRep, st) !== 0) {
        if (this.pos === this.dictStart) throw new LzmaError('LZMAの中身が壊れています');
        if (rc.bit(this.isRepG0, st) === 0) {
          if (rc.bit(this.isRep0Long, (st << 4) + posState) === 0) {
            this.state = st < 7 ? 9 : 11;
            out[this.pos] = out[this.pos - this.rep0 - 1];
            this.pos++;
            continue;
          }
        } else {
          let dist;
          if (rc.bit(this.isRepG1, st) === 0) dist = this.rep1;
          else {
            if (rc.bit(this.isRepG2, st) === 0) dist = this.rep2;
            else { dist = this.rep3; this.rep3 = this.rep2; }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.repLen.decode(rc, posState);
        this.state = st < 7 ? 8 : 11;
      } else {
        this.rep3 = this.rep2; this.rep2 = this.rep1; this.rep1 = this.rep0;
        len = this.len.decode(rc, posState);
        this.state = st < 7 ? 7 : 10;
        // 距離
        const lenState = len > 3 ? 3 : len;
        const slot = rc.tree(this.posSlot, lenState << 6, 6);
        let dist;
        if (slot < 4) dist = slot;
        else {
          const nd = (slot >>> 1) - 1;
          dist = ((2 | (slot & 1)) << nd) >>> 0;
          if (slot < 14) dist += rc.reverse(this.posDec, dist - slot, nd);
          else {
            dist = (dist + ((rc.direct(nd - 4) << 4) >>> 0)) >>> 0;
            dist = (dist + rc.reverse(this.align, 0, 4)) >>> 0;
          }
        }
        if (dist === 0xffffffff) {
          // 終わりの印
          if (!allowEnd) throw new LzmaError('LZMAの中身が壊れています（終わりの印）');
          return true;
        }
        this.rep0 = dist;
      }
      len += 2;
      if (this.rep0 >= this.pos - this.dictStart) throw new LzmaError('LZMAの中身が壊れています（参照先）');
      if (this.pos + len > limit) throw new LzmaError('LZMAの中身が壊れています（長さ）');
      let from = this.pos - this.rep0 - 1;
      for (let i = 0; i < len; i++) out[this.pos++] = out[from++];
    }
    return false;
  }
}

/** 7z の LZMA（設定5バイト：方式＋辞書の大きさ） */
export function lzmaDecode(input, props, outSize) {
  if (!props || props.length < 5) throw new LzmaError('LZMAの設定がありません');
  const out = new Uint8Array(outSize);
  const dec = new LzmaDecoder(out);
  dec.setProps(props[0]);
  dec.resetState();
  const rc = new Range(input, 0, input.length);
  dec.run(rc, outSize, true);
  if (dec.pos !== outSize) throw new LzmaError('LZMAの中身が途中で終わっています');
  return out;
}

/** LZMA2（チャンクの並び） */
export function lzma2Decode(input, outSize) {
  const out = new Uint8Array(outSize);
  const dec = new LzmaDecoder(out);
  let p = 0;
  let needProps = true, needDictReset = true;
  for (;;) {
    if (p >= input.length) throw new LzmaError('LZMA2の中身が途中で切れています');
    const control = input[p++];
    if (control === 0x00) break;
    if (control === 0x01 || control === 0x02) {
      // 無圧縮のチャンク
      if (control === 0x01) { dec.dictStart = dec.pos; needDictReset = false; } else if (needDictReset) throw new LzmaError('LZMA2の中身が壊れています');
      const size = ((input[p] << 8) | input[p + 1]) + 1;
      p += 2;
      if (p + size > input.length || dec.pos + size > outSize) throw new LzmaError('LZMA2の中身が壊れています');
      out.set(input.subarray(p, p + size), dec.pos);
      dec.pos += size;
      p += size;
      continue;
    }
    if (control < 0x80) throw new LzmaError('LZMA2の中身が壊れています');
    const unpacked = ((control & 0x1f) << 16) + (input[p] << 8) + input[p + 1] + 1;
    const packed = (input[p + 2] << 8) + input[p + 3] + 1;
    p += 4;
    const mode = (control >>> 5) & 3;
    if (mode === 3) { dec.dictStart = dec.pos; needDictReset = false; } else if (needDictReset) throw new LzmaError('LZMA2の中身が壊れています');
    if (mode >= 2) { dec.setProps(input[p++]); needProps = false; } else if (needProps) throw new LzmaError('LZMA2の中身が壊れています');
    if (mode >= 1) dec.resetState();
    if (p + packed > input.length || dec.pos + unpacked > outSize) throw new LzmaError('LZMA2の中身が壊れています');
    const rc = new Range(input, p, p + packed);
    dec.run(rc, dec.pos + unpacked, false);
    p += packed;
  }
  if (dec.pos !== outSize) throw new LzmaError('LZMA2の中身が途中で終わっています');
  return out;
}
