// 中身に「カードワースのシナリオ・素材・スキン以外の、実行できるファイル」が入っていないかを調べる。
// 名前（拡張子）と、中身の頭（Windowsの実行ファイルの印「MZ」など）の両方で見る。
// 調べるだけで、ファイルを開いたり実行したりはしない。

/** 開くと動いてしまう（またはプログラムを動かせる）ファイルの拡張子 */
export const EXEC_EXT = [
  'exe', 'com', 'scr', 'pif', 'msi', 'msp', 'msix', 'appx', 'dll', 'sys', 'drv', 'ocx', 'cpl',
  'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1', 'psd1', 'hta', 'jar',
  'lnk', 'url', 'scf', 'reg', 'inf', 'msc', 'gadget', 'application', 'appref-ms', 'chm', 'iso', 'img', 'vhd', 'vhdx',
];
const EXEC_RE = new RegExp(`\\.(${EXEC_EXT.join('|').replace(/-/g, '\\-')})$`, 'i');

/** 名前どおりなら開いても動かない形（中身の頭は見なくてよい） */
const DATA_RE = /\.(bmp|png|jpe?g|gif|webp|ico|ogg|mp3|wav|mid|midi|xm|it|mod|s3m|wid|wsm|xml|txt|md|html?|css|ini|json|csv|log|ttf|otf|jpy1|jptx|jpdc)$/i;

/** 中身の頭が実行ファイルの印か（印の名前を返す） */
export function execSignature(b) {
  if (!b || b.length < 2) return '';
  if (b[0] === 0x4d && b[1] === 0x5a) return 'Windowsの実行ファイル（MZ）';
  if (b.length >= 4 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return '実行ファイル（ELF）';
  if (b.length >= 8 && [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00].every((x, i) => b[i] === x)) return 'ショートカット';
  return '';
}

/** 名前だけで実行ファイルとわかるか */
export function isExecName(path) {
  return EXEC_RE.test(String(path || ''));
}

/**
 * 実行できるファイルを探す。
 * @param {{path: string, size: number, read: () => Promise<Uint8Array>, head?: (n: number) => Uint8Array}[]} files
 * @param {{maxRead?: number}} opts 頭を見るために全部読むのは、この大きさまで（zip以外の形式）
 * @returns {Promise<{path: string, size: number, why: string}[]>}
 */
export async function findExecutables(files, { maxRead = 64 * 1024 * 1024 } = {}) {
  const out = [];
  for (const f of files || []) {
    const ext = /\.([^./]+)$/.exec(f.path)?.[1] || '';
    if (isExecName(f.path)) { out.push({ path: f.path, size: f.size, why: `.${ext.toLowerCase()} のファイル` }); continue; }
    if (DATA_RE.test(f.path) || !f.size) continue;
    let head = null;
    try {
      if (f.head) head = f.head(8);
      else if (f.size <= maxRead) head = (await f.read()).subarray(0, 8);
    } catch { head = null; }
    const sig = execSignature(head);
    if (sig) out.push({ path: f.path, size: f.size, why: `名前は .${ext || '（拡張子なし）'} ですが、中身は${sig}` });
  }
  return out;
}

/**
 * 実行ファイルを、入れるものから外す（opened.files から除く）。いつもはこうしておく。
 * Py の .wsn をそのまま置く方法や、zipのままの保存も、中に実行ファイルがあるので使わないようにする。
 * 外したものは覚えておき、includeExecutables で戻せる。
 */
export function excludeExecutables(opened) {
  const list = opened?.executables || [];
  if (opened?.execExcluded || (!list.length && !opened?.outerExecutables?.length)) return opened;
  const bad = new Set(list.map((x) => x.path));
  opened._execBackup = {
    files: opened.files,
    scen: (opened.scenarios || []).map((sc) => sc.files),
    isWsn: opened.source?.isWsn,
  };
  opened.files = opened.files.filter((f) => !bad.has(f.path));
  for (const sc of opened.scenarios || []) sc.files = (sc.files || []).filter((p) => !bad.has(p));
  if (opened.source) opened.source = { ...opened.source, isWsn: false };
  opened.execExcluded = true;
  return opened;
}

/** 外した実行ファイルを戻す（本人が「入れる」を選んだとき） */
export function includeExecutables(opened) {
  const b = opened?._execBackup;
  if (!b) return opened;
  opened.files = b.files;
  (opened.scenarios || []).forEach((sc, i) => { sc.files = b.scen[i] || sc.files; });
  if (opened.source) opened.source = { ...opened.source, isWsn: b.isWsn };
  opened.execExcluded = false;
  opened._execBackup = null;
  return opened;
}

/** 開いたものに実行ファイルの情報を付ける（openArchive・openFolder の結果に） */
export async function markExecutables(opened, extra = []) {
  opened.executables = await findExecutables(opened.files);
  // 外側の入れ物（zipの中のwsnを開いたとき）にだけ入っていたもの
  const inner = new Set(opened.executables.map((x) => x.path));
  opened.outerExecutables = (extra || []).filter((x) => !inner.has(x.path));
  return excludeExecutables(opened);
}
