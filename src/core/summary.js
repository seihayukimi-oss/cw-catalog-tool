// シナリオの「目印」ファイルを読む。
//  ・クラシック／Next：Summary.wsm（バイナリ）
//  ・Py（WSN）：Summary.xml
// 判定基準は CardWirthPy の cw/binary/summary.py と同じ。

import { decodeCp932 } from './text.js';

export class SummaryError extends Error {}

/** データ版 → 形式 */
export function formatOfDataVersion(dv) {
  return dv === 7 ? 'next' : 'classic';
}

/**
 * Summary.wsm を読む。
 * 構造：画像（4バイト長＋本体）→ 名前 → 説明 → 作者 → 必要クーポン（各4バイト長＋CP932）
 *       → 必要クーポン数（4バイト）→ 開始エリアID（4バイト。ここでデータ版が分かる）
 * @param {Uint8Array} d
 */
export function parseSummaryWsm(d) {
  const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let p = 0;
  const need = (n) => {
    if (p + n > d.length) throw new SummaryError('Summary.wsm が途中で切れています');
  };
  const int32 = () => { need(4); const v = view.getInt32(p, true); p += 4; return v; };
  const chunk = () => {
    const len = int32();
    if (len < 0) throw new SummaryError('Summary.wsm の形式が正しくありません');
    need(len);
    const b = d.subarray(p, p + len);
    p += len;
    return b;
  };
  const str = () => {
    let b = chunk();
    while (b.length && b[b.length - 1] === 0) b = b.subarray(0, b.length - 1);
    return decodeCp932(b);
  };

  chunk(); // 画像
  const name = str();
  const description = str();
  const author = str();
  const requiredCoupons = str();
  const requiredCouponsNum = int32();
  const areaRaw = int32();

  let dataVersion, startAreaId;
  if (areaRaw <= 19999) { dataVersion = 0; startAreaId = areaRaw; }
  else if (areaRaw <= 39999) { dataVersion = 2; startAreaId = areaRaw - 20000; }
  else if (areaRaw <= 49999) { dataVersion = 4; startAreaId = areaRaw - 40000; }
  else { dataVersion = 7; startAreaId = areaRaw - 70000; } // 5〜6は存在しない

  return {
    kind: 'wsm',
    name,
    author,
    description: description.replace(/\r\n/g, '\n'),
    requiredCoupons,
    requiredCouponsNum,
    dataVersion,
    startAreaId,
    format: formatOfDataVersion(dataVersion),
  };
}

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Summary.xml（WSN）を読む。DOMを使わず、必要なタグだけを取り出す
 * （ブラウザでもNode.jsでも同じ結果になるように）。
 * @param {string} xml
 */
export function parseSummaryXml(xml) {
  const head = xml.match(/<Summary\b([^>]*)>/);
  if (!head) throw new SummaryError('Summary.xml の形式が正しくありません');
  const dv = head[1].match(/\bdataVersion\s*=\s*"(\d+)"/);
  const prop = (xml.match(/<Property>([\s\S]*?)<\/Property>/) || [, ''])[1];
  const tag = (t) => {
    const m = prop.match(new RegExp(`<${t}\\b[^>]*?(?:/>|>([\\s\\S]*?)</${t}>)`));
    return m && m[1] ? unescapeXml(m[1]) : '';
  };
  const level = prop.match(/<Level\b[^>]*\bmin="(\d+)"[^>]*\bmax="(\d+)"/);
  const type = prop.match(/<Type\b[^>]*>([^<]*)<\/Type>/);
  return {
    kind: 'xml',
    name: tag('Name'),
    author: tag('Author'),
    description: tag('Description').replace(/\\n/g, '\n'),
    dataVersion: dv ? parseInt(dv[1], 10) : 0, // Wsn.N の N
    levelMin: level ? parseInt(level[1], 10) : null,
    levelMax: level ? parseInt(level[2], 10) : null,
    skinType: type ? unescapeXml(type[1]) : '',
    format: 'wsn',
  };
}

/** Nextの暗号化（WDP）がかかったデータか */
export function isWdp(d) {
  return d.length >= 4 && d[0] === 0x57 && d[1] === 0x44 && d[2] === 0x50 && d[3] === 0x00;
}
