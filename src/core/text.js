// 文字コードまわり（Readmeの中身・zip内のファイル名）

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// WHATWG の shift_jis は実質 Windows-31J（CP932）。①②や髙・﨑も読める
const cp932Strict = new TextDecoder('shift_jis', { fatal: true });
const cp932Loose = new TextDecoder('shift_jis');
const utf16le = new TextDecoder('utf-16le');
const utf16be = new TextDecoder('utf-16be');

export const ENCODINGS = ['utf-8', 'shift_jis', 'utf-16le', 'utf-16be'];

/**
 * テキストの中身を、文字コードを判定しながら読む。
 * 順番：BOM → UTF-8(厳密) → CP932(厳密) → CP932(化けを承知で)
 * UTF-8を先に試すのは、UTF-8のファイルをCP932で読むとエラーにならずに化けるため。
 * @param {Uint8Array} bytes
 * @param {string} [force] 文字コードを指定して読み直すとき
 * @returns {{text: string, encoding: string, lossy: boolean}}
 */
export function decodeText(bytes, force) {
  if (force) {
    return { text: new TextDecoder(force).decode(bytes), encoding: force, lossy: false };
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: utf8Strict.decode(bytes.subarray(3)), encoding: 'utf-8', lossy: false };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: utf16le.decode(bytes.subarray(2)), encoding: 'utf-16le', lossy: false };
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: utf16be.decode(bytes.subarray(2)), encoding: 'utf-16be', lossy: false };
  }
  try {
    return { text: utf8Strict.decode(bytes), encoding: 'utf-8', lossy: false };
  } catch { /* 次へ */ }
  try {
    return { text: cp932Strict.decode(bytes), encoding: 'shift_jis', lossy: false };
  } catch { /* 次へ */ }
  return { text: cp932Loose.decode(bytes), encoding: 'shift_jis', lossy: true };
}

/**
 * zip内のファイル名を読む。
 * UTF-8の目印（汎用フラグのbit 11）があればUTF-8、無ければUTF-8→CP932の順に試す。
 * 最後にNFC正規化（Macで作ったzipの濁点分離対策）。
 */
export function decodeZipName(raw, utf8Flag) {
  let name;
  if (utf8Flag) {
    name = new TextDecoder('utf-8').decode(raw);
  } else {
    try {
      name = utf8Strict.decode(raw);
    } catch {
      name = cp932Loose.decode(raw);
    }
  }
  return name.normalize('NFC');
}

/**
 * UTF-8の名前をCP932として読んでしまった「化けた名前」を元に戻せるか試す。
 * 例：「闡嶺ｽ懈ｨｩ」→「著作権」。戻せなければ null。
 */
export function repairMojibake(name) {
  const bytes = encodeCp932(name);
  if (!bytes) return null;
  try {
    const fixed = utf8Strict.decode(bytes);
    // 元に戻した結果がASCIIだけなら、化けていなかったということ
    return /[^\x00-\x7f]/.test(fixed) && fixed !== name ? fixed.normalize('NFC') : null;
  } catch {
    return null;
  }
}

// --- CP932 へのエンコード（化け修復とファイル名チェック用） ---
let cp932Table = null;
function buildCp932Table() {
  // デコード表を総当たりで作って逆引きにする（初回だけ・数十ms）
  const map = new Map();
  for (let b = 0x20; b < 0x7f; b++) map.set(String.fromCharCode(b), [b]);
  for (let b = 0xa1; b <= 0xdf; b++) map.set(cp932Loose.decode(Uint8Array.of(b)), [b]);
  const leads = [];
  for (let b = 0x81; b <= 0x9f; b++) leads.push(b);
  for (let b = 0xe0; b <= 0xfc; b++) leads.push(b);
  for (const hi of leads) {
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue;
      const ch = cp932Loose.decode(Uint8Array.of(hi, lo));
      if (ch.length === 1 && ch !== '�' && !map.has(ch)) map.set(ch, [hi, lo]);
    }
  }
  return map;
}

/** 文字列をCP932のバイト列にする。表せない文字があれば null */
export function encodeCp932(str) {
  if (!cp932Table) cp932Table = buildCp932Table();
  const out = [];
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code < 0x20 && code !== 0x09) return null;
    const bytes = cp932Table.get(ch);
    if (!bytes) return null;
    out.push(...bytes);
  }
  return Uint8Array.from(out);
}

/** 1.50／Nextのフォルダ名に使えない（CP932で表せない）文字を返す */
export function nonCp932Chars(str) {
  if (!cp932Table) cp932Table = buildCp932Table();
  const bad = new Set();
  for (const ch of str) if (!cp932Table.has(ch)) bad.add(ch);
  return [...bad];
}

/** CP932の文字列（長さ付き）を読むときに使う */
export function decodeCp932(bytes) {
  return cp932Loose.decode(bytes);
}
