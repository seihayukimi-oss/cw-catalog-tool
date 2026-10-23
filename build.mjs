// ビルド：
//  dist/web/cw-catalog.html … HTML版（1ファイル。開くだけで動く）
//  dist/app/                 … アプリ版（Tauri）の画面
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const css = readFileSync('src/app/style.css', 'utf8');
const common = {
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['chrome110', 'edge110', 'firefox115', 'safari16'],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  legalComments: 'eof',
  write: false,
  charset: 'utf8',
};

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

function page({ script, scriptTag, csp }) {
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp ? `<meta http-equiv="Content-Security-Policy" content="${csp}">` : ''}
<meta name="referrer" content="no-referrer">
<title>CWカタログ</title>
<style>${css}</style>
</head>
<body>
<div id="app"><p style="padding:24px">読み込み中…</p></div>
${scriptTag ?? `<script>${script}</script>`}
</body>
</html>
`;
}

rmSync('dist', { recursive: true, force: true });

// --- HTML版 ---
{
  const out = await build({ ...common, entryPoints: ['src/entry-web.js'] });
  const script = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  // スクリプトはこのファイルに埋め込んだものだけ実行を許可（ハッシュで指定）。
  // 通信は、カタログ・ダウンロード・配布ページの読み込みだけ。
  const csp = [
    "default-src 'none'",
    `script-src 'sha256-${sha(script)}'`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'connect-src https: http:', // 個人サイトには http のものもあるため
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  mkdirSync('dist/web', { recursive: true });
  writeFileSync('dist/web/cw-catalog.html', page({ script, csp }));
  console.log('dist/web/cw-catalog.html', (script.length / 1024).toFixed(0) + 'KB');
}

// --- アプリ版の画面（CSPは tauri.conf.json 側で設定） ---
{
  const out = await build({ ...common, entryPoints: ['src/entry-tauri.js'] });
  mkdirSync('dist/app', { recursive: true });
  writeFileSync('dist/app/app.js', out.outputFiles[0].text);
  writeFileSync('dist/app/index.html', page({ scriptTag: '<script src="./app.js"></script>' }));
  console.log('dist/app/', (out.outputFiles[0].text.length / 1024).toFixed(0) + 'KB');
}
