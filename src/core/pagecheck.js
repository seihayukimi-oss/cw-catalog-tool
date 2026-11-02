// カタログ外の作品（ブックマーク）の配布ページが変わったかを見る。
// ページ全体を比べるとアクセスカウンターや広告で毎回「変化あり」になるので、
// ページ内の配布ファイルらしいリンク・ファイル名だけを取り出して比べる。

const ARCHIVE = /[^\s"'<>()]+\.(?:zip|wsn|cab|lzh|lha|7z|rar)(?=[\s"'<>?#)]|$)/gi;

/** HTMLから配布ファイルらしい名前を取り出す（重複なし・並べ替え済み） */
export function extractArchiveNames(html) {
  const names = new Set();
  for (const m of html.matchAll(ARCHIVE)) {
    let n = m[0];
    try { n = decodeURIComponent(n); } catch { /* そのまま */ }
    n = n.split(/[/\\=]/).pop();
    if (n.length <= 200) names.add(n);
  }
  return [...names].sort();
}

/**
 * 前回と比べる。
 * @returns {{changed: boolean, added: string[], removed: string[], snapshot: string[], mode: 'files'|'text'}}
 */
export function comparePage(html, prev) {
  const names = extractArchiveNames(html);
  if (names.length) {
    const before = new Set(prev?.mode === 'files' ? prev.snapshot : []);
    const added = names.filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !names.includes(n));
    return { changed: !!prev && (added.length > 0 || removed.length > 0), added, removed, snapshot: names, mode: 'files' };
  }
  // ファイル名が見つからないページは、タグを除いた本文の大まかな指紋で比べる
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const fp = [String(text.length >> 6)];
  return { changed: !!prev && prev.mode === 'text' && prev.snapshot[0] !== fp[0], added: [], removed: [], snapshot: fp, mode: 'text' };
}
