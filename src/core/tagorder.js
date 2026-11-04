// タグの一覧の並び順（「自分のフォルダ一覧」のタグ）
//  ・対象レベルのタグ（Lv3以上・Lv5以下）が新しく増えたときは、最初はいちばん後ろに入れる。もうレベルのタグがあれば、
//    そのまとまり（いちばん後ろのもの）の中に、「以上」の小さい数字から → 「以下」の小さい数字から、の順に入れる（もうあるタグの場所は動かさない）
//  ・「タグを自動で整える」：店シナ → 読み物 → 人数 → 人数専用 → シナリオの長さ → 戦闘・Lv → そのほか、の順に並べる

const KANJI = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 壱: 1, 弐: 2 };
const num = (s) => { const t = String(s || '').normalize('NFKC'); return /\d/.test(t) ? parseInt(t, 10) : KANJI[t] ?? 99; };

const LV_RE = /^Lv(\d{1,2})(以上|以下)$/;
/** 対象レベルのタグか（Lv3以上・Lv5以下） */
export const isLevelTag = (t) => LV_RE.test(String(t || '').normalize('NFKC'));
/** レベルのタグの並べ方：以上（小さい順）→ 以下（小さい順） */
const levelKey = (t) => { const m = LV_RE.exec(String(t).normalize('NFKC')); return m ? (m[2] === '以上' ? 0 : 1000) + Number(m[1]) : 9999; };

/**
 * タグを一覧に足す。対象レベルのタグは、いちばん後ろにあるレベルのタグのまとまりの中に、決まった順で入れる
 * @returns {string[]} 新しい一覧（もうあれば、そのまま）
 */
export function insertTag(list, t) {
  if (list.includes(t)) return list;
  if (!isLevelTag(t)) return [...list, t];
  // レベルのタグがまだ無ければ、いちばん後ろへ
  let end = -1;
  for (let i = list.length - 1; i >= 0; i--) if (isLevelTag(list[i])) { end = i + 1; break; }
  if (end < 0) return [...list, t];
  // あれば、いちばん後ろにあるレベルのタグのまとまりの中へ。新しいタグだけを入れる（今ある順は崩さない）
  let start = end;
  while (start > 0 && isLevelTag(list[start - 1])) start--;
  const block = list.slice(start, end);
  // 自分以下のもので、いちばん後ろにあるものの次（無ければ、まとまりの先頭）
  let last = -1;
  block.forEach((x, i) => { if (levelKey(x) <= levelKey(t)) last = i; });
  const pos = start + last + 1;
  return [...list.slice(0, pos), t, ...list.slice(pos)];
}

/** 「タグを自動で整える」の分け方（小さいほど前） */
function groupOf(t) {
  const s = String(t || '').normalize('NFKC');
  if (/店/.test(s)) return 1; // 店シナ・店・プライベート店
  if (/読み物|読みもの/.test(s)) return 2;
  if (/人専用$/.test(s)) return 4; // 人数専用
  if (/人(用|以上|以下|推奨|から)$|少人数|ソロ/.test(s)) return 3; // 人数
  if (/^(短編|中編|長編)$/.test(s)) return 5; // シナリオの長さ
  if (/戦闘|^Lv/.test(s)) return 6; // 戦闘・対象レベル
  return 7; // そのほか
}
function keyIn(t, g) {
  const s = String(t).normalize('NFKC');
  if (g === 3 || g === 4) {
    const m = /^(\d+|[一二三四五六七八九十壱弐])人(用|以上|以下|推奨|から|専用)?$/.exec(s);
    if (m) return num(m[1]) * 10 + ({ 専用: 0, 用: 1, 以上: 2, から: 2, 以下: 3, 推奨: 4 }[m[2]] ?? 5);
    return 999;
  }
  if (g === 5) return { 短編: 0, 中編: 1, 長編: 2 }[s] ?? 9;
  if (g === 6) {
    if (/^戦闘(あり|有り)$/.test(s)) return 0;
    if (/^戦闘(なし|無し)$/.test(s)) return 1;
    if (/戦闘/.test(s)) return 2;
    if (isLevelTag(s)) return 10 + levelKey(s);
    const r = /^Lv(\d{1,2})\D+(\d{1,2})$/.exec(s); // 前の形（Lv3-5）
    if (r) return 5000 + Number(r[1]) * 100 + Number(r[2]);
    return 9000; // Lv無・Lv低 など
  }
  return 0;
}

/**
 * タグを自動で整える：先頭に残すタグ（後で遊ぶ・プレイ中・クリア・お気に入り）のあとに、
 * 店シナ → 読み物 → 人数 → 人数専用 → シナリオの長さ → 戦闘・Lv → そのほか の順で並べる。
 * 同じまとまりの中は、数字の小さい順など。「そのほか」は今の順のまま
 */
export function arrangeTags(list, keepFirst = []) {
  const first = keepFirst.filter((t) => list.includes(t));
  const rest = list.filter((t) => !first.includes(t));
  const withIdx = rest.map((t, i) => ({ t, i, g: groupOf(t) }));
  withIdx.sort((a, b) => a.g - b.g || (a.g === 7 ? a.i - b.i : keyIn(a.t, a.g) - keyIn(b.t, b.g) || a.i - b.i));
  return [...first, ...withIdx.map((x) => x.t)];
}
