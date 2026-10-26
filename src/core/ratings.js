// シナリオラベル（ラベル）：対象年齢（R18・R15）と、注意のラベル（グロ・残酷描写・ホラー・性的な表現など）。
// 注意のラベルの種類は、共用カタログの content_labels で増やせる（アプリを更新しなくても新しいラベルが使える）。

export const RATINGS = ['all', 'r15', 'r18'];
export const RATING_NAME = { all: '全年齢', r15: 'R15', r18: 'R18' };

/** 最初から用意している注意のラベル */
export const DEFAULT_CONTENT_LABELS = [
  { id: 'gore', name: 'グロ・残酷描写' },
  { id: 'horror', name: 'ホラー' },
  { id: 'sexual', name: '性的な表現（R15相当）' },
];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

export const normRating = (v) => (RATINGS.includes(v) ? v : 'all');
export const normContent = (v) => [...new Set((Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && ID_RE.test(x)))].slice(0, 20);

/** カタログに書かれた注意のラベルの種類（管理人が増やしたもの）を整える */
export function sanitizeLabelDefs(list) {
  return (Array.isArray(list) ? list : [])
    .filter((d) => d && ID_RE.test(d.id || '') && typeof d.name === 'string' && d.name.trim())
    .slice(0, 50)
    .map((d) => ({ id: d.id, name: d.name.trim().slice(0, 30), ...(typeof d.description === 'string' && d.description.trim() ? { description: d.description.trim().slice(0, 200) } : {}) }));
}

/** 最初からのラベルと、カタログのラベルを合わせる（同じidならカタログの名前） */
export function mergeLabelDefs(...lists) {
  const map = new Map(DEFAULT_CONTENT_LABELS.map((d) => [d.id, d]));
  for (const l of lists) for (const d of l || []) map.set(d.id, d);
  return [...map.values()];
}

/** より厳しい対象年齢 */
export const stricter = (a, b) => (RATINGS.indexOf(normRating(b)) > RATINGS.indexOf(normRating(a)) ? normRating(b) : normRating(a));

/** Readme・説明文から、対象年齢を見つける（見つからなければ ''） */
export function findRating(text) {
  const t = String(text || '').normalize('NFKC');
  // 「R18ではありません」「R18要素なし」「非R18」のような書き方は数えない
  const hit = (re) => [...t.matchAll(re)].some((m) => {
    const before = t.slice(Math.max(0, m.index - 2), m.index);
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 12);
    return !/非|脱/.test(before) && !/^(?:的)?(?:な)?(?:要素|表現|描写)?(?:は|も)?(?:では|じゃ)?(?:ない|なし|無し|ありません|ございません|含みません|含まれません)/.test(after);
  });
  if (hit(/R[-‐ー ]?18(?![0-9])|18禁|十八禁|成人向け/gi)) return 'r18';
  if (hit(/R[-‐ー ]?15(?![0-9])|15禁/gi)) return 'r15';
  return '';
}
