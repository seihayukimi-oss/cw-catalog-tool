// JSのソースから、日本語を含む文字列（'…' "…" `…`）を行番号つきで取り出す（コメント・正規表現は飛ばす）
import { readFileSync } from 'node:fs';
const JP = /[぀-ヿ㐀-鿿！-｠]/;
export function extract(src) {
  const out = [];
  let i = 0, line = 1, prev = '';
  const n = src.length;
  const regexOk = () => /^$|[(,=:\[!&|?{};+\-*%<>~^]$|\b(return|typeof|case|in|of|delete|void|throw|new)$/.test(prev);
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '/' && regexOk()) {
      i++; let cls = false;
      while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
      i++; while (/[a-z]/i.test(src[i] || '')) i++; prev = 'x'; continue;
    }
    if (c === '"' || c === "'") {
      const start = line; let s = ''; i++;
      while (i < n && src[i] !== c) { if (src[i] === '\\') { s += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; } if (src[i] === '\n') line++; s += src[i++]; }
      i++; if (JP.test(s)) out.push({ line: start, text: s }); prev = 'x'; continue;
    }
    if (c === '`') {
      const start = line; let s = ''; i++;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') { s += src[i + 1] === 'n' ? '\n' : src[i + 1]; i += 2; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          let depth = 1, j = i + 2, expr = '';
          while (j < n && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; if (depth) expr += src[j]; if (src[j] === '\n') line++; j++; }
          s += `〔${expr.trim().slice(0, 40)}〕`; i = j; continue;
        }
        if (src[i] === '\n') line++; s += src[i++];
      }
      i++; if (JP.test(s)) out.push({ line: start, text: s }); prev = 'x'; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { let w = ''; while (i < n && /[A-Za-z0-9_$.]/.test(src[i])) w += src[i++]; prev = w; continue; }
    prev = c; i++;
  }
  return out;
}
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) for (const s of extract(readFileSync(process.argv[2], 'utf8'))) console.log(s.line, s.text);
