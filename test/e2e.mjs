// HTML版をブラウザで動かす試験。フォルダ選択ダイアログは自動操作できないので、
// ブラウザ内の保存領域（OPFS）を「エンジンのフォルダ」として使う（#dev-opfs）。
// 実行：CW_FIXTURES=... node test/e2e.mjs <出力フォルダ>
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const FX = process.env.CW_FIXTURES;
// 作品名・作者名は書かない。試験に使う実物のファイル（CW_FIXTURES）から読む
const { openArchive } = await import('../src/core/archive.js');
const readFx = (n) => openArchive(new Uint8Array(readFileSync(join(FX, n))), n);
const CLO = await readFx('classic_cp932.zip');
const CL = CLO.scenarios[0]; // クラシック（name・folderName）
const NX = (await readFx('next_nested.zip')).scenarios[0]; // Next（二重フォルダ）
const WS = (await readFx('alice.wsn')).scenarios[0]; // Py（WSN）
const CB = existsSync(join(FX, 'maigo.cab')) ? (await readFx('maigo.cab')).scenarios[0] : null; // CAB（あれば）
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// クラシックの Summary.wsm と .wid（既存シナリオ・店テスト・道具入りの見本に使う）
const CL_WSM = await CLO.files.find((f) => /(^|\/)Summary\.wsm$/i.test(f.path)).read();
const CL_WID_FILE = CLO.files.find((f) => /\.wid$/i.test(f.path));
const CL_WID = await CL_WID_FILE.read();
const CL_WID_NAME = CL_WID_FILE.path.split('/').pop();
const OUT = process.argv[2] || '.';
const exe = readdirSync('/opt/pw-browsers').filter((d) => d.startsWith('chromium-')).flatMap((d) => [`/opt/pw-browsers/${d}/chrome-linux64/chrome`, `/opt/pw-browsers/${d}/chrome-linux/chrome`]).find(existsSync);

const html = readFileSync('dist/web/cw-catalog.html');
// 配布ページの見本（Shift_JISの個人サイトを想定）。zipへの相対リンクと、uploader.jp へのリンク、関係ないリンクを置く
const sjis = new TextDecoder('shift_jis');
const pageHtml = Buffer.from(`<html><head><meta charset="Shift_JIS"><title>${CL.name} - 見本サイト</title></head><body>
  <a href="files/dl.zip">${CL.folderName}.zip</a>
  <a href="https://ux.getuploader.com/sample_account/download/12">uploader.jp の配布ページ</a>
  <a href="/about">作者について</a></body></html>`, 'utf8');
const pageSjis = new Uint8Array(await (await import('node:child_process')).execFileSync('iconv', ['-f', 'utf-8', '-t', 'cp932'], { input: pageHtml }));
// ファイルの一部だけ（Range）にも答える
const sendRange = (req, res, buf) => {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m) return res.end(buf);
  let start = m[1] === '' ? Math.max(0, buf.length - Number(m[2])) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? buf.length - 1 : Math.min(buf.length - 1, Number(m[2]));
  res.statusCode = 206;
  res.setHeader('content-range', `bytes ${start}-${end}/${buf.length}`);
  return res.end(buf.subarray(start, end + 1));
};
const ranges = [];
const server = createServer((req, res) => {
  if (req.url === '/files/dl.zip') {
    res.setHeader('content-type', 'application/zip');
    res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${CL.folderName}.zip`)}`);
    if (req.headers.range) ranges.push(req.headers.range);
    return sendRange(req, res, readFileSync(join(FX, 'classic_cp932.zip')));
  }
  if (req.url === '/page.html') { res.setHeader('content-type', 'text/html'); return res.end(pageSjis); }
  if (req.url === '/multi.html') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('<html><head><title>まとめ置き場</title></head><body><a href="files/dl.zip">サンプル店.zip</a> <a href="files/alice.wsn">テスト冒険譚.wsn</a> <a href="/about">作者について</a></body></html>'); }
  if (req.url === '/files/alice.wsn') { res.setHeader('content-type', 'application/octet-stream'); return res.end(readFileSync(join(FX, 'alice.wsn'))); }
  // uploader.jpと同じ流れの見本：①同意ボタンのページ（Cookieと合言葉）→ ②本物のリンクと自動移動 → ③ファイル
  if (req.url === '/axe/download/12' && req.method === 'GET') {
    res.setHeader('set-cookie', 'uploader=sess123; Path=/');
    res.setHeader('content-type', 'text/html; charset=UTF-8');
    return res.end(`<html><body><nav><a href="/axe/ranking">ランキング</a></nav>
      <p>ファイルをダウンロードするには「ダウンロード」ボタンを押下してください。ダウンロードした時点で利用規約に同意したものとみなします。</p>
      <form method="POST" onsubmit="download()" name="agree"><input type="hidden" name="token" value="tok-42"><input type="submit" value="ダウンロード" name="yes"></form></body></html>`);
  }
  if (req.url === '/axe/download/12' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => { b += c; });
    return req.on('end', () => {
      const ok = new URLSearchParams(b).get('token') === 'tok-42' && /uploader=sess123/.test(req.headers.cookie || '');
      res.setHeader('content-type', 'text/html; charset=UTF-8');
      res.end(ok ? `<html><head><meta http-equiv="refresh" content="6;URL=/axe/g/tok-42/12/${encodeURIComponent('サンプル店')}.zip"></head><body><a href="/axe/g/tok-42/12/${encodeURIComponent('サンプル店')}.zip">Download Now</a></body></html>` : '<p>エラー</p>');
    });
  }
  // DLキー → 同意 → ファイル の2段階（uploader.jp のDLキー付きと同じ流れの見本）
  if (req.url === '/keyup/6' && req.method === 'GET') {
    res.setHeader('set-cookie', 'ku=s1; Path=/');
    res.setHeader('content-type', 'text/html; charset=UTF-8');
    return res.end('<html><body><p>ダウンロードパスワードを入力して「認証」ボタンを押下してください。</p><form method="POST"><input type="password" name="password"><input type="submit" value="認証"></form></body></html>');
  }
  if (req.url === '/keyup/6' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => { b += c; });
    return req.on('end', () => {
      const q = new URLSearchParams(b);
      res.setHeader('content-type', 'text/html; charset=UTF-8');
      if (!/ku=s1/.test(req.headers.cookie || '')) return res.end('<p>エラー</p>');
      if (q.get('token') === 't2') return res.end('<html><head><meta http-equiv="refresh" content="3;URL=/keyup/g/t2/water.zip"></head><body>まもなく始まります</body></html>');
      if (q.get('password') === 'mizu') return res.end('<html><body><p>このファイルの利用規約（サンプル続編）に同意してからダウンロードしてください。</p><form method="POST"><input type="hidden" name="token" value="t2"><input type="submit" name="yes" value="ダウンロード"></form></body></html>');
      return res.end('<html><body><p>パスワードが違います</p><form method="POST"><input type="password" name="password"><input type="submit" value="認証"></form></body></html>');
    });
  }
  if (req.url.startsWith('/keyup/g/t2/')) { res.setHeader('content-type', 'application/zip'); return res.end(readFileSync(join(FX, 'next_nested.zip'))); }
  if (req.url === '/missing.zip') { res.statusCode = 404; return res.end('not found'); }
  if (req.url === '/intro.html') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end('<html><head><title>x</title><meta property="og:title" content="サンプル店の紹介ページ"><meta property="og:description" content="サンプル店で遊ぶ短編です"><meta property="og:image" content="/intro.png"></head><body></body></html>');
  }
  if (req.url === '/intro.png') { res.setHeader('content-type', 'image/png'); return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')); }
  if (req.url.startsWith('/axe/g/tok-42/')) { res.setHeader('content-type', 'application/octet-stream'); return res.end(readFileSync(join(FX, 'classic_cp932.zip'))); }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
}).listen(8767);
// 別のサイト（読み込みの許可を出していない）
const other = createServer((req, res) => { res.setHeader('content-type', 'application/zip'); res.end(readFileSync(join(FX, 'classic_cp932.zip'))); }).listen(8768);

// 試験環境（Linux）の文字設定がUTF-8でないと、日本語名のフォルダが一覧に出ないため指定する
const browser = await chromium.launch({ executablePath: exe, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'ok  ' : 'NG  '} ${name}${extra ? ' … ' + extra : ''}`); };

async function run(colorScheme, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  // 別サイトを読みに行って断られるのは想定どおりなので除く（試験環境は外部に出られないので、その失敗も除く）
  page.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED|ERR_TUNNEL_CONNECTION_FAILED|localhost:8768/.test(m.text()) && !/missing\.zip/.test(m.location()?.url || '')) errors.push(m.text()); });
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERR', e.message); });
  await page.goto('http://localhost:8767/#dev-opfs');

  // OPFS にエンジンのフォルダを用意（Next・既存シナリオ1本・分類フォルダ）
  const seed = {
    'CardWirthNext.exe': [1],
    'Scenario/_サンプル分類/.keep': [],
    'Scenario/既存/Summary.wsm': [...CL_WSM],
    [`Scenario/既存/${CL_WID_NAME}`]: [...CL_WID],
  };
  await page.evaluate(async (seed) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('test-engine', { recursive: true }).catch(() => {});
    await root.removeEntry('test-archive', { recursive: true }).catch(() => {});
    await root.removeEntry('test-materials', { recursive: true }).catch(() => {});
    await root.removeEntry('test-backup', { recursive: true }).catch(() => {});
    await root.removeEntry('test-skins', { recursive: true }).catch(() => {});
    await root.removeEntry('test-pick-material', { recursive: true }).catch(() => {});
    await root.removeEntry('test-pick-archive', { recursive: true }).catch(() => {});
    const eng = await root.getDirectoryHandle('test-engine', { create: true });
    for (const [path, bytes] of Object.entries(seed)) {
      const parts = path.split('/');
      const name = parts.pop();
      let d = eng;
      for (const p of parts) d = await d.getDirectoryHandle(p, { create: true });
      const w = await (await d.getFileHandle(name, { create: true })).createWritable();
      await w.write(new Uint8Array(bytes)); await w.close();
    }
  }, seed);

  // 0. 更新したあと、最初の1回だけ「変わったところ」を版ごとに出す（初めて使うときは出さない）
  ok('初めて使うときは「変わったところ」を出さない', !(await page.locator('#whats-new').count()));
  await page.evaluate(() => new Promise((res, rej) => { const r = indexedDB.open('cw-catalog-tool'); r.onsuccess = () => { const t = r.result.transaction('kv', 'readwrite'); t.objectStore('kv').put({ k: 'seenVersion', v: '0.4.0' }); t.oncomplete = () => { r.result.close(); res(); }; t.onerror = rej; }; }));
  await page.reload();
  await page.locator('#whats-new').waitFor();
  ok('更新したあと、変わったところを版ごとに出す', (await page.locator('#whats-new .changelog-entry').count()) >= 2 && await page.locator('#whats-new [data-version="0.4.1"]').isVisible());
  if (width > 600) await page.locator('#whats-new').screenshot({ path: join(OUT, `whatsnew-${colorScheme}.png`) }).catch(() => {});
  await page.locator('#whats-new').getByRole('button', { name: 'OK' }).click();
  await page.locator('#whats-new').waitFor({ state: 'detached' });
  await page.waitForTimeout(300); // 「見た」の記録を書き終えるまで
  await page.reload();
  await page.getByRole('tab', { name: '設定' }).waitFor();
  await page.waitForTimeout(500);
  ok('OKを押したら、もう出さない', !(await page.locator('#whats-new').count()));

  // 1. 設定 → テスト用エンジンを登録（自動で読み取り）
  await page.getByRole('tab', { name: '設定' }).click();
  await page.locator('#dev-opfs').click();
  await page.getByText(/件を読み取りました/).waitFor();
  await page.getByRole('tab', { name: /自分のフォルダ一覧/ }).click();
  ok('既存シナリオの読み取り', await page.getByText(CL.name).isVisible());
  ok('名前から版を推測（既存フォルダには版表記なし）', !(await page.getByText(/推測「/).count()));

  // 2. 入れる：Next（二重フォルダ）を _サンプル分類 に
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  ok('取得画面に、安全のしくみの短い説明', /内容を検証してから/.test(await page.locator('#safety-note').textContent()));
  await page.locator('#safety-note').getByRole('button', { name: '詳細' }).click();
  ok('「詳細」で安全のしくみを全部見られる', await page.locator('#safety-modal').getByText('免責・制限事項（重要）').isVisible() && await page.locator('#safety-modal').getByText(/ウイルス対策ソフトではありません/).isVisible());
  if (width > 600) await page.locator('#safety-modal').screenshot({ path: join(OUT, `safety-${colorScheme}.png`) }).catch(() => {});
  await page.locator('#safety-modal').getByRole('button', { name: '閉じる' }).click();
  await page.locator('#url-in').fill('http://localhost:8767/missing.zip');
  await page.getByRole('button', { name: '取ってくる' }).click();
  await page.locator('#safety-note .note.warn').waitFor();
  ok('http のURLには注意を出す', /暗号化されていない通信/.test(await page.locator('#safety-note').textContent()));
  await page.locator('#url-in').fill('');
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(FX, 'next_nested.zip'));
  await page.getByText(NX.name, { exact: true }).first().waitFor();
  ok('Next仕様と判定', await page.locator('.badge.next').first().isVisible());
  ok('UTF-8の目印なしの名前を読み直し', await page.getByText(/文字コードを判定して読み直しました/).isVisible());
  ok('版の推測 1.00', (await page.locator('#dest-ver').inputValue()) === '1.00');
  await page.locator('#dest-cat').selectOption('_サンプル分類');
  await page.getByRole('button', { name: 'インストール' }).click();
  await page.getByText(new RegExp(`を Scenario/_サンプル分類/${esc(NX.name)} に入れました`)).waitFor();
  ok('Nextをインストール', true);

  // 3. 入れる：クラシック（CP932のReadme）→ Readme確認が必要
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(FX, 'classic_cp932.zip'));
  await page.locator('#readme-view').waitFor();
  await page.waitForFunction(() => document.getElementById('readme-view')?.textContent.includes('髙﨑'));
  ok('CP932のReadme（①・髙﨑）', true, await page.locator('#readme-enc').textContent());
  ok('Readmeを読むまでインストール不可', await page.getByRole('button', { name: 'インストール' }).isDisabled());
  if (width > 600) await page.screenshot({ path: join(OUT, `add-${colorScheme}.png`), fullPage: true });
  await page.getByLabel('Readme（利用規約）を読みました').check();
  await page.getByRole('button', { name: 'インストール' }).click();
  await page.getByText(new RegExp(`${esc(CL.folderName)} に入れました`)).waitFor();

  // 4. 同じものをもう一度 → バックアップ
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(FX, 'classic_cp932.zip'));
  await page.getByLabel('Readme（利用規約）を読みました').check();
  await page.getByRole('button', { name: 'インストール' }).click();
  await page.getByText(/にバックアップ/).waitFor();
  ok('再インストールでバックアップ', true);

  // 5. Py仕様（.wsn）をNextへ → 遊べない警告
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(FX, 'alice.wsn'));
  await page.getByText(WS.name, { exact: true }).first().waitFor();
  ok('Py仕様をNextに入れようとすると警告', await page.getByText(/CardWirthPyでしか遊べません/).isVisible());
  ok('警告時はインストール不可', await page.getByRole('button', { name: 'インストール' }).isDisabled());
  const rdAck = page.getByLabel('Readme（利用規約）を読みました');
  if (await rdAck.count()) await rdAck.check();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'WebCardWirth用に書き出す' }).click()]);
  ok('WebCardWirth用の書き出し', dl.suggestedFilename() === 'alice.wsn', dl.suggestedFilename());

  // 6. 危険なzip
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(FX, 'zipslip.zip'));
  await page.getByText(/注意 3件/).waitFor();
  ok('危険なパスの警告', true);

  // 6b. URLから：配布ページ → リンクを見つけて取ってくる
  await page.locator('#url-in').fill('http://localhost:8767/page.html');
  await page.locator('#url-in').press('Enter');
  await page.getByText(/ダウンロードらしいリンクが 2件/).waitFor();
  ok('Shift_JISのページのタイトル', await page.getByText(`${CL.name} - 見本サイト`).isVisible());
  await page.locator('.dl li', { hasText: `${CL.folderName}.zip` }).getByRole('button', { name: '取ってくる' }).click();
  await page.locator('.item-title', { hasText: `${CL.folderName}.zip` }).waitFor();
  ok('URLから取ってきたzipを分析（ファイル名も取得）', true);
  if (width > 600) await page.screenshot({ path: join(OUT, `url-${colorScheme}.png`), fullPage: true });
  // uploader.jp のページは自動で取らずにページを開く
  const [pop1] = await Promise.all([page.waitForEvent('popup'), (async () => { await page.locator('#url-in').fill('https://ux.getuploader.com/sample_account/download/12'); await page.locator('#url-in').press('Enter'); })()]);
  await pop1.close();
  ok('uploader.jp のページは注意を出してページを開く', await page.getByText(/2026年11月25日/).first().isVisible());
  // 許可を出していない別サイト → ページを開く
  const [pop2] = await Promise.all([page.waitForEvent('popup'), (async () => { await page.locator('#url-in').fill('http://localhost:8768/x.zip'); await page.locator('#url-in').press('Enter'); })()]);
  await pop2.close();
  ok('読み込めないサイトは説明してページを開く', await page.getByText(/ブラウザから直接読み込めない設定/).isVisible());

  // 6b2. 同意してダウンロード（uploader.jp と同じ流れの見本）
  await page.locator('#url-in').fill('http://localhost:8767/axe/download/12');
  await page.locator('#url-in').press('Enter');
  await page.getByText('このページは、内容に同意してからダウンロードする形式です').waitFor();
  ok('同意画面にページの文章を表示', await page.getByText(/利用規約に同意したものとみなします/).isVisible());
  const agreeBtn = page.getByRole('button', { name: '同意してダウンロード' });
  ok('同意のチェックまで押せない', await agreeBtn.isDisabled());
  if (width > 600) await page.locator('#url-in').locator('xpath=ancestor::div[contains(@class,"card")][1]').screenshot({ path: join(OUT, `agree-box-${colorScheme}.png`) }).catch(() => {});
  await page.getByLabel('ページの内容・規約を読んで、同意します').check();
  await agreeBtn.click();
  await page.locator('.item-title', { hasText: 'サンプル店.zip' }).waitFor();
  ok('同意→合言葉とCookieを送信→本物のリンクをたどってzipを取得', await page.getByText(CL.name, { exact: true }).first().isVisible());
  if (width > 600) await page.screenshot({ path: join(OUT, `agree-${colorScheme}.png`), fullPage: true });

  // 6b3. DLキー → 同意 → ファイル の2段階。サイトの同意を覚える
  await page.locator('#url-in').fill('http://localhost:8767/keyup/6');
  await page.locator('#url-in').press('Enter');
  await page.getByText('このページは、DLキー（パスワード）を入れてからダウンロードする形式です').waitFor();
  await page.getByLabel('DLキー', { exact: true }).fill('mizu');
  await page.getByLabel('ページの内容・規約を読んで、同意します').check();
  await page.getByLabel(/このサイト（localhost）の同意を覚える/).check();
  await page.getByRole('button', { name: '同意して認証' }).click();
  await page.getByText('DLキーが通りました。続けて、次の画面の内容に同意してください。').waitFor();
  ok('DLキーのあとの同意画面を続けて出す', await page.getByText(/利用規約（サンプル続編）/).isVisible());
  await page.getByLabel('ページの内容・規約を読んで、同意します').check();
  await page.getByRole('button', { name: '同意してダウンロード' }).click();
  await page.getByText(NX.name, { exact: true }).first().waitFor();
  ok('DLキー→同意→ファイルの2段階で取得', true);

  // 6b4. LZH・CAB を開く（CABは CardWirth のエディタで作った実物）
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles(join(process.cwd(), 'test/fixtures/sample.lzh'));
  await page.locator('.item-title', { hasText: 'sample.lzh' }).waitFor();
  ok('LZHを開ける（日本語の名前）', await page.getByText(/シナリオではないようです/).isVisible());
  if (existsSync(join(FX, 'maigo.cab'))) {
    await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: `${CB.name}.CAB`, mimeType: 'application/octet-stream', buffer: readFileSync(join(FX, 'maigo.cab')) });
    await page.getByText(CB.name, { exact: true }).first().waitFor();
    ok('CAB（LZX）のシナリオを開ける', await page.locator('.badge.classic').first().isVisible());
    const ack = page.getByLabel('Readme（利用規約）を読みました');
    if (await ack.count()) await ack.check();
    await page.locator('#dest-cat').selectOption('');
    await page.getByRole('button', { name: 'インストール' }).click();
    await page.getByText(new RegExp(`${esc(CB.name)} に入れました`)).waitFor();
    ok('CABのシナリオをインストール', true);
    await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  }

  // 6b5. 複数のファイルを選ぶと、まとめて入れる
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles([join(FX, 'classic_cp932.zip'), join(FX, 'alice.wsn')]);
  await page.getByText('選んだファイルをまとめて入れる（2件）').waitFor();
  await page.locator('#batch .batch-item').nth(1).getByText('準備OK').waitFor();
  ok('複数のファイルをまとめて入れる準備', (await page.locator('#batch .batch-item', { hasText: '準備OK' }).count()) === 2);
  await page.locator('#batch').getByRole('button', { name: 'やめる' }).click();

  // 6b6. ページのファイルを複数選んで取ってくる
  await page.locator('#url-in').fill('http://localhost:8767/multi.html');
  await page.locator('#url-in').press('Enter');
  await page.getByText('ダウンロードらしいリンクが', { exact: false }).waitFor();
  if (width > 600) await page.locator('.link-list').locator('..').screenshot({ path: join(OUT, `links-${colorScheme}.png`) }).catch(() => {});
  ok('ファイルとページを見分けて表示', await page.locator('.link-list li.is-file').count() === 2 && await page.locator('.link-list .badge', { hasText: 'ファイル（zipなど）' }).count() === 2);
  await page.getByRole('button', { name: 'ファイルをすべて選ぶ' }).click();
  await page.getByRole('button', { name: '選んだ2件を取ってくる' }).click();
  await page.getByText('選んだ2件を入れる（2件）').waitFor();
  await page.locator('#batch .batch-item').nth(1).getByText('準備OK').waitFor();
  ok('選んだファイルをまとめて取ってくる', (await page.locator('#batch .batch-item', { hasText: '準備OK' }).count()) === 2);
  await page.locator('#batch').getByRole('button', { name: 'やめる' }).click();
  await page.locator('#url-in').fill('');

  // 6c. サイトの「CWカタログで入れる」リンクから開かれた場合：確認してから取ってくる
  const link = `http://localhost:8767/#dev-opfs&install=${encodeURIComponent('http://localhost:8767/files/dl.zip')}&name=${encodeURIComponent(CL.name)}`;
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.goto(link);
  await p2.getByText('このシナリオを取ってきますか？').waitFor();
  ok('リンクから開くと確認が出る（取得先を表示）', await p2.locator('dialog b', { hasText: 'localhost' }).isVisible());
  ok('リンクの情報はアドレスから消える', !(await p2.evaluate(() => location.hash.includes('install='))));
  if (width > 600) await p2.screenshot({ path: join(OUT, `link-${colorScheme}.png`) });
  await p2.getByRole('button', { name: '取ってくる' }).click();
  await p2.locator('.item-title', { hasText: `${CL.folderName}.zip` }).waitFor();
  ok('確認後に取ってきて分析', true);
  await p2.close();

  // 7. カタログ：共用（サンプル）を追加
  await page.getByRole('tab', { name: 'カタログ' }).click();
  ok('作品が無いときはカタログの管理が開いている', await page.locator('#manage').isVisible());
  await page.getByRole('button', { name: '＋ カタログを追加' }).click();
  await page.getByRole('button', { name: 'サンプルを入れる' }).click();
  await page.getByText('サンプルの森').first().waitFor();
  ok('サンプルカタログ表示（旧・終了の配布元）', await page.getByText('uploader.jp（移転前）').isVisible());
  ok('DL先に新旧・通常予備・デフォルトの印', (await page.locator('.dl li', { hasText: 'GitHub Releases' }).getByText('★デフォルト').count()) === 1 && (await page.locator('.dl li', { hasText: '作者サイト' }).first().getByText('予備').count()) === 1);

  // 7b. 個人用カタログに作品を登録（デフォルトのDL先は取れないURL・紹介ページつき）
  const addWork = async (name, dls, intro) => {
    await page.getByRole('button', { name: '＋作品を登録（個人用）' }).click();
    const dlg = page.locator('dialog');
    await dlg.getByLabel('作品名').fill(name);
    await dlg.getByLabel('作者', { exact: true }).fill('テスト作者');
    await dlg.getByLabel('バージョン').fill('1.01');
    if (intro) { await dlg.getByRole('button', { name: '＋紹介ページ' }).click(); await dlg.getByLabel('紹介ページのURL').fill(intro); }
    for (const [i, d] of dls.entries()) {
      await dlg.getByRole('button', { name: '＋DL先' }).click();
      const row = dlg.locator('.edit-dl').nth(i);
      await row.getByLabel('DL先のURL').fill(d.url);
      await row.getByPlaceholder('名前（例：作者サイト、uploader.jp）').fill(d.label);
      await row.getByLabel('種類').selectOption(d.kind);
      if (d.def) await row.getByLabel('デフォルト').check();
      if (d.dlkey) await row.getByLabel('DLキー', { exact: true }).fill(d.dlkey);
    }
    ok(`登録先の個人用カタログは最初から選ばれている（${name}）`, await dlg.getByLabel('マイカタログ').isChecked());
    if (width > 600 && intro) await dlg.screenshot({ path: join(OUT, `edit-${colorScheme}.png`) });
    await dlg.getByRole('button', { name: '保存' }).click();
    await page.getByText(new RegExp(`「${name}」をマイカタログに保存しました`)).waitFor();
  };
  await addWork(CL.name, [
    { url: 'http://localhost:8767/missing.zip', label: '旧サイト', kind: 'direct', def: true },
    { url: 'http://localhost:8767/files/dl.zip', label: '新サイト', kind: 'direct' },
  ], 'http://localhost:8767/intro.html');
  await addWork('サンプル店のuploader版', [{ url: 'http://localhost:8767/axe/download/12', label: 'uploader.jp', kind: 'page' }]);
  const birdCard = page.locator('.card.work', { has: page.locator('.item-title', { hasText: new RegExp(`^${esc(CL.name)}$`) }) });
  ok('個人用の作品に★デフォルト（選んだDL先）', (await birdCard.locator('.dl li', { hasText: '旧サイト' }).getByText('★デフォルト').count()) === 1);

  // 7c. 紹介ページのカード（DLの前に、どんな作品か見られる）
  await birdCard.getByRole('button', { name: '紹介を見る' }).click();
  await birdCard.getByText('サンプル店の紹介ページ').waitFor();
  ok('紹介ページの題名・説明・画像', await birdCard.getByText('サンプル店で遊ぶ短編です').isVisible() && (await birdCard.locator('.ogp img').count()) === 1);

  // 7c2. ダウンロードせずに中身（目次）を見る・リンク切れを確かめる
  ranges.length = 0;
  await birdCard.locator('.dl li', { hasText: '新サイト' }).getByRole('button', { name: '中身を見る' }).click();
  const peek = page.locator('#peek-modal');
  await peek.waitFor();
  ok('ダウンロードせずに目次だけ読む（ファイルの一部だけ）', /目次情報のみを読み込みました/.test(await peek.textContent()) && ranges.length >= 1 && ranges.every((r) => /^bytes=/.test(r)), ranges.join(','));
  ok('目次に、中のファイルの名前が出る', await peek.getByText(/Summary\.wsm/).first().isVisible());
  if (width > 600) await peek.screenshot({ path: join(OUT, `peek-${colorScheme}.png`) }).catch(() => {});
  await peek.getByRole('button', { name: '閉じる' }).click();
  await birdCard.locator('.dl li', { hasText: '旧サイト' }).getByRole('button', { name: 'リンクを確かめる' }).click();
  await page.getByText(/1件を確かめました：✖ リンク切れ 1件/).waitFor();
  ok('リンク切れの印（作品とDL先）', await birdCard.locator('.item-title ~ .link-dead').isVisible() && await birdCard.locator('.dl li', { hasText: '旧サイト' }).locator('.link-dead').isVisible());
  ok('生きているDL先は「リンクあり」', !(await birdCard.locator('.dl li', { hasText: '新サイト' }).locator('.link-dead').count()));

  // 7d. 検索したら「検索結果を一括ダウンロード」
  await page.locator('#cat-q').fill('テスト作者'); // 作者名で探す（この時点では2件）
  await page.getByRole('button', { name: '検索結果2件を一括ダウンロード' }).waitFor();
  ok('検索結果を一括ダウンロードのボタン', true);
  if (width > 600) await page.screenshot({ path: join(OUT, `catalog-${colorScheme}.png`), fullPage: true });
  await page.locator('#cat-q').fill('');

  // 7e. zipの保存場所（テスト用）を設定
  await page.getByRole('tab', { name: '設定' }).click();
  await page.locator('#dev-opfs-archive').click();
  await page.getByText(/に保存するようにしました/).waitFor();
  ok('zipの保存場所を設定するとオンになる', await page.getByLabel('インストールしたときにzipも保存する').isChecked());

  // 8. 選んで一括ダウンロード：1つ目はデフォルトが取れず別の配布元から、2つ目は同意ページで操作待ち
  await page.getByRole('tab', { name: 'カタログ' }).click();
  await page.getByLabel(`${CL.name}を選ぶ`).check();
  await page.getByLabel('サンプル店のuploader版を選ぶ').check();
  await page.locator('.sel-actions').getByRole('button', { name: '一括ダウンロード' }).click();
  await page.getByText('デフォルトのDL先を変えますか？').waitFor();
  ok('取れなかったら別の配布元から取り、デフォルトを変えるか聞く', await page.locator('dialog').getByText('旧サイト → 新サイト').isVisible());
  await page.getByRole('button', { name: '選んだものを変更する' }).click();
  const bItems = page.locator('#batch .batch-item');
  const bird = bItems.filter({ hasText: new RegExp(`^${esc(CL.name)}`) }), axe = bItems.filter({ hasText: 'サンプル店のuploader版' });
  ok('直接DLは自動で準備OK', await bird.getByText('準備OK').isVisible());
  ok('同意ページは操作待ち', await axe.getByText('操作待ち', { exact: true }).isVisible());
  if (width > 600) await page.screenshot({ path: join(OUT, `batch-${colorScheme}.png`), fullPage: true });
  await axe.getByLabel('ページの内容・規約を読んで、同意します').check();
  await axe.getByRole('button', { name: '同意してダウンロード' }).click();
  await axe.getByText('準備OK').waitFor();
  ok('操作待ちで同意→準備OK', true);
  await axe.locator('input[type=text]').fill('サンプル店2');
  ok('Readmeを読むまで入らない', await page.getByRole('button', { name: 'まとめてインストール（0件）' }).isDisabled());
  await page.getByRole('button', { name: /Readme（利用規約）を順に確認（あと2件）/ }).click();
  await page.getByRole('button', { name: 'Readme（利用規約）を読みました・次へ' }).click();
  await page.getByRole('button', { name: 'Readme（利用規約）を読みました・次へ' }).click();
  await page.getByRole('button', { name: 'まとめてインストール（2件）' }).click();
  await page.getByText('2件を入れました').waitFor();
  ok('まとめてインストール', await axe.getByText('Scenario/サンプル店2 に入れました').isVisible());
  if (width > 600) await page.screenshot({ path: join(OUT, `batch-done-${colorScheme}.png`), fullPage: true });

  // 8b. DLキーを登録した作品は、同意を覚えているサイトなら止まらずに取れる
  await page.getByRole('tab', { name: 'カタログ' }).click();
  await addWork('サンプル続編', [{ url: 'http://localhost:8767/keyup/6', label: 'おまけuploader', kind: 'page', dlkey: 'mizu' }]);
  ok('DLキーありの印', await page.locator('.card.work', { hasText: 'サンプル続編' }).getByText('DLキーあり').isVisible());
  await page.getByLabel('サンプル続編を選ぶ').check();
  await page.locator('.sel-actions').getByRole('button', { name: '一括ダウンロード' }).click();
  await page.locator('#batch .batch-item', { hasText: 'サンプル続編' }).getByText('準備OK').waitFor();
  ok('登録したDLキーと覚えた同意で、止まらずに取得', !(await page.locator('#batch .badge', { hasText: '操作待ち' }).count()));
  await page.locator('#batch').getByRole('button', { name: 'やめる' }).click();

  // 9. デフォルトが変わった／候補から外す
  await page.getByRole('tab', { name: 'カタログ' }).click();
  ok('デフォルトのDL先が新サイトに変わった', (await birdCard.locator('.dl li', { hasText: '新サイト' }).getByText('★デフォルト').count()) === 1);
  await page.locator('.card.work', { hasText: 'サンプルの塔（Py版）' }).getByRole('button', { name: '候補から外す' }).click();
  await page.getByText(/を候補から外しました/).waitFor();
  ok('候補から外すと一覧から消える', !(await page.locator('.item-title', { hasText: 'サンプルの塔（Py版）' }).count()));
  await page.getByLabel('候補から外したものも表示').check();
  ok('「外したものも表示」で見える', await page.locator('.item-title', { hasText: 'サンプルの塔（Py版）' }).isVisible());

  // 9a. 一時保留中の作品（いつもは出さない → 表示して選んで拾う）・出典・入れない作者
  const cave = page.locator('.card.work', { has: page.locator('.item-title', { hasText: 'サンプルの洞窟' }) });
  ok('一時保留中の作品は、いつもは出さない', !(await cave.count()) && /一時保留中の作品（1件）を表示/.test(await page.locator('#show-held').locator('..').textContent()));
  await page.locator('#show-held').check();
  await cave.waitFor();
  ok('表示すると「一時保留中の作品」の印・改変版の印', await cave.locator('.held').isVisible() && await cave.getByText('改変版').isVisible());
  ok('出典（元のカタログ）を出す', await page.locator('.card.work', { hasText: 'サンプルの森' }).first().getByText('出典：CWカタログのサンプル').isVisible());
  if (width > 600) await cave.screenshot({ path: join(OUT, `held-${colorScheme}.png`) }).catch(() => {});
  await cave.getByRole('button', { name: 'ダウンロード' }).click();
  ok('一時保留中の作品を取るときは確かめる', await page.locator('dialog', { hasText: '一時保留中の作品' }).getByText(/見本：通報が多かったため/).isVisible());
  await page.locator('dialog').getByRole('button', { name: 'やめる' }).click();
  await page.locator('#show-held').uncheck();
  const forest = page.locator('.card.work', { has: page.locator('.item-title', { hasText: /^サンプルの森$/ }) });
  await forest.getByRole('button', { name: 'この作者を除外' }).click();
  await page.locator('dialog').getByRole('button', { name: '除外する' }).click();
  await page.getByText(/「見本作者」さんの作品をカタログに表示しないようにしました/).waitFor();
  ok('入れない作者の作品は出さない', !(await forest.count()) && await page.locator('#show-muted').isVisible());
  await page.locator('#show-muted').check();
  await forest.getByRole('button', { name: '作者の除外を解除' }).click();
  await page.getByText(/の除外を解除しました/).waitFor();
  await page.locator('#show-muted').uncheck().catch(() => {});
  ok('入れない作者から外すと戻る', await forest.isVisible());

  // 9a2. シナリオラベル：R18 はいつもは出さない → 設定で年齢確認してONにすると出る。R15・注意のラベル・苦手なラベルを隠す
  const house = page.locator('.card.work', { has: page.locator('.item-title', { hasText: 'サンプルの館' }) });
  const tower = page.locator('.card.work', { has: page.locator('.item-title', { hasText: 'サンプルの塔（Py版）' }) });
  ok('R18 の作品は、いつもは出さない', !(await house.count()));
  ok('R15・注意のラベルを付けて表示する', await tower.locator('.rating-r15').isVisible() && await tower.getByText('⚠ グロ・残酷描写').isVisible());
  await page.getByRole('tab', { name: '設定' }).click();
  await page.locator('#rating-settings').scrollIntoViewIfNeeded();
  await page.getByLabel('「R15」のラベルの作品を隠す').check();
  await page.locator('#pref-r18').check();
  await page.locator('#age-check').waitFor();
  ok('R18 をONにするとき、年齢を確認する', /18歳以上ですか/.test(await page.locator('#age-check').textContent()));
  if (width > 600) await page.locator('#age-check').screenshot({ path: join(OUT, `age-${colorScheme}.png`) }).catch(() => {});
  await page.locator('#age-check').getByRole('button', { name: 'はい' }).click();
  await page.getByText('R18の作品を表示します').waitFor();
  if (width > 600) await page.locator('#rating-settings').screenshot({ path: join(OUT, `rating-settings-${colorScheme}.png`) }).catch(() => {});
  await page.getByRole('tab', { name: 'カタログ' }).click();
  await house.waitFor();
  ok('ONにすると R18 の作品が出る（R18のラベル・成人向けの注意・ブラウザで開く）', await house.locator('.rating-r18').isVisible() && await house.getByText(/この作品は成人向け（R18）です/).isVisible() && await house.getByRole('button', { name: 'ダウンロード（ブラウザで開く）' }).isVisible());
  ok('苦手なラベル（R15）の作品は隠す', !(await tower.count()) && /苦手なラベルで隠した作品（1件）も表示/.test(await page.locator('#show-label-hidden').locator('..').textContent()));
  if (width > 600) await house.screenshot({ path: join(OUT, `r18-${colorScheme}.png`) }).catch(() => {});
  await page.getByRole('tab', { name: '設定' }).click();
  await page.locator('#pref-r18').uncheck();
  await page.getByText('R18の作品を表示しないようにしました').waitFor();
  await page.getByLabel('「R15」のラベルの作品を隠す').uncheck();
  await page.locator('#pref-r18').check();
  await page.getByText('R18の作品を表示します').waitFor();
  ok('年齢の確認は初回だけ', !(await page.locator('#age-check').count()));
  await page.locator('#pref-r18').uncheck();
  await page.getByText('R18の作品を表示しないようにしました').waitFor();
  await page.getByRole('tab', { name: 'カタログ' }).click();
  ok('OFFに戻すと R18 は出ない', !(await house.count()) && await tower.isVisible());

  // 9b. 選んでフォルダに入れる・作者ごとにまとめる・選んで候補から外す
  await page.getByLabel('候補から外したものも表示').uncheck();
  await page.getByLabel(`${CL.name}を選ぶ`).check();
  await page.getByLabel('サンプル店のuploader版を選ぶ').check();
  await page.locator('.sel-actions').getByRole('button', { name: 'フォルダに入れる' }).click();
  await page.locator('dialog input[type=text]').fill('サンプルシリーズ');
  await page.getByRole('button', { name: '新しく作って入れる' }).click();
  await page.getByText('2件を「サンプルシリーズ」に入れました').waitFor();
  const chip = page.locator('.folder-chips .chip', { hasText: 'サンプルシリーズ' });
  ok('フォルダを作って入れる', (await chip.locator('.n').textContent()) === '2');
  await chip.click();
  ok('フォルダで絞り込む', (await page.locator('.card.work').count()) === 2);
  await page.locator('.folder-chips .chip', { hasText: 'すべて' }).click();
  await page.getByLabel('並べ方').selectOption('author');
  await page.locator('details.group').first().waitFor();
  ok('作者ごとにまとめる', await page.locator('details.group summary', { hasText: '見本作者' }).isVisible() && await page.locator('details.group summary', { hasText: 'テスト作者' }).isVisible());
  await page.getByLabel('並べ方').selectOption('');
  await page.getByLabel('サンプルの森を選ぶ').check();
  await page.locator('.sel-actions').getByRole('button', { name: '候補から外す' }).click();
  await page.getByText('1件を候補から外しました', { exact: false }).waitFor();
  ok('選んで候補から外す', !(await page.locator('.item-title', { hasText: 'サンプルの森' }).count()));
  if (width > 600) await page.screenshot({ path: join(OUT, `folders-${colorScheme}.png`), fullPage: true });

  // 10. 個人用カタログをDL一覧として書き出し → 別のカタログとして読み込む
  await page.getByRole('button', { name: 'カタログの管理' }).click();
  const myRow = page.locator('.src-row', { hasText: 'マイカタログ' });
  await myRow.getByRole('button', { name: 'マイカタログのメニュー' }).click();
  await page.locator('dialog').getByRole('button', { name: /DL一覧として書き出す/ }).click();
  ok('DLキーがあっても書き出さない（書き出すかどうかのチェックも無い）', (await page.getByLabel('DLキーも書き出す').count()) === 0 && await page.locator('dialog').getByText('DLキーは書き出しません').isVisible());
  const [dl3] = await Promise.all([page.waitForEvent('download'), page.locator('dialog').getByRole('button', { name: '書き出す' }).click()]);
  const listPath = await dl3.path();
  const list = JSON.parse(readFileSync(listPath, 'utf8'));
  ok('DL一覧の書き出し（3件・デフォルトが先頭・DLキーは入れない・分類名付き）', list.entries.length === 3 && !JSON.stringify(list).includes('mizu') && list.entries.find((e) => e.name === CL.name).downloads[0].label === '新サイト' && list.entries.find((e) => e.name === CL.name).labels?.[0] === 'サンプルシリーズ', `${list.entries.length}件`);
  await page.getByRole('button', { name: '＋ カタログを追加' }).click();
  await page.locator('#list-file').setInputFiles({ name: '有志の一覧.json', mimeType: 'application/json', buffer: readFileSync(listPath) });
  await page.getByText(/を個人用カタログとして読み込みました（3件）/).waitFor();
  await page.locator('dialog', { hasText: 'の分類名を取り込む' }).waitFor();
  ok('分類名付きのDL一覧を読み込むと、取り込むか聞く', await page.getByLabel('分類名「サンプルシリーズ」を取り込む').isChecked());
  await page.locator('dialog').getByText(/フォルダの名前の前に、カタログの名前を付ける/).click();
  await page.locator('#label-go').click();
  await page.getByText(/1種類の分類名を取り込みました（2件をフォルダに入れました）/).waitFor();
  ok('分類名を、カタログの名前を付けたフォルダとして取り込む', true);
  ok('DL一覧を個人用カタログとして読み込み', await page.locator('.src-row', { hasText: '読み込み（ファイル）' }).isVisible());
  await page.locator('.src-row', { hasText: '読み込み（ファイル）' }).getByLabel(/を候補に含める/).uncheck();
  await page.waitForTimeout(300);
  ok('候補に含めるを外せる', !(await page.locator('.src-row', { hasText: '読み込み（ファイル）' }).getByLabel(/を候補に含める/).isChecked()));
  if (width > 600) await page.locator('#manage').screenshot({ path: join(OUT, `manage-${colorScheme}.png`) }).catch(() => {});

  // 11. 自分のフォルダ一覧：バージョン・タグ・更新ありを一括ダウンロード
  await page.getByRole('tab', { name: /自分のフォルダ一覧/ }).click();
  await page.getByRole('button', { name: '読み取る' }).click();
  await page.getByText(/件を読み取りました/).waitFor();
  const cards = page.locator('#mine-list > .card');
  ok('自分のフォルダ一覧6件（既存・Next・クラシック2か所・サンプル店2・CAB）', (await cards.count()) === (existsSync(join(FX, 'maigo.cab')) ? 6 : 5), String(await cards.count()));
  const first = cards.filter({ hasText: NX.name });
  ok('インストール時の版を記録', (await first.locator('input.ver').inputValue()) === '1.00');
  await first.locator('input[aria-label="タグを追加"]').fill('お気に入り');
  await first.locator('input[aria-label="タグを追加"]').press('Enter');
  await page.locator('.tag', { hasText: 'お気に入り' }).waitFor();
  ok('タグ付け', true);
  const kizon = cards.filter({ hasText: 'Scenario/既存' });
  await kizon.locator('input.ver').fill('0.9');
  await kizon.locator('input.ver').press('Tab');
  await page.waitForTimeout(300);
  ok('バージョンの手入力', (await cards.filter({ hasText: 'Scenario/既存' }).getByText('（手入力）').count()) === 1);
  ok('カタログより古い版は「更新あり」', await cards.filter({ hasText: 'Scenario/既存' }).getByText('新しい版 1.01 があります').isVisible());
  await page.screenshot({ path: join(OUT, `mine-${colorScheme}-${width}.png`), fullPage: true });
  await page.getByRole('button', { name: '更新ありを一括ダウンロード（1件）' }).click();
  const up = page.locator('#batch .batch-item');
  await up.getByText('準備OK').waitFor();
  ok('更新は今の場所に置き換える', await up.getByText('置き換える場所：Scenario/既存').isVisible());
  await up.getByRole('button', { name: 'Readme（利用規約）を読む' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Readme（利用規約）を読みました', exact: true }).click();
  await page.getByRole('button', { name: 'まとめてインストール（1件）' }).click();
  await page.getByText('1件を入れました').waitFor();
  ok('更新を同じ場所に入れ直す（バックアップあり）', await up.getByText(/Scenario\/既存 に入れました（前のものは CWCatalog_backup/).isVisible());

  // 12. 記録の書き出し
  await page.getByRole('tab', { name: '設定' }).click();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '書き出す', exact: true }).click()]);
  const recPath = await dl2.path();
  const rec = JSON.parse(readFileSync(recPath, 'utf8'));
  ok('記録の書き出し（公開形式）', rec.kind === 'cw-catalog-tool/records' && rec.records.length === (existsSync(join(FX, 'maigo.cab')) ? 6 : 5), `${rec.records.length}件`);

  // 12b. 素材・スキン：置き場所を決めて、分類フォルダに入れる → 自分のフォルダ一覧で見る → 分類フォルダを移す
  ok('設定に「安全のしくみ」', await page.locator('#safety-info').getByText('ファイルの検証').isVisible());
  ok('設定のいちばん下に更新履歴（新しい5つ・今の版は開いている）', (await page.locator('#changelog > .changelog-entry').count()) === 5 && await page.locator('#changelog > .changelog-entry').first().evaluate((d) => d.open));
  await page.locator('#changelog-more').click();
  ok('「もっと見る」で全部見られる', (await page.locator('#changelog > .changelog-entry').count()) > 5);
  if (width > 600) await page.locator('#changelog').screenshot({ path: join(OUT, `changelog-${colorScheme}.png`) }).catch(() => {});
  await page.locator('#dev-opfs-backup').click();
  await page.getByText(/バックアップは「.+」に置くようにしました/).waitFor();
  await page.locator('#backup-now', { hasText: 'test-backup' }).waitFor();
  ok('バックアップ先を選べる', true);
  ok('クレジット', await page.locator('#credits').getByText('清葉雪見').isVisible() && await page.locator('#credits').getByText('seiha.yukimi.ilst@gmail.com').isVisible() && await page.locator('#credits').getByText(/group Ask制作の RPG「Card Wirth」/).isVisible());
  if (width > 600) { await page.locator('#credits').screenshot({ path: join(OUT, `credits-${colorScheme}.png`) }).catch(() => {}); await page.locator('#backup-now').locator('..').locator('..').screenshot({ path: join(OUT, `backup-${colorScheme}.png`) }).catch(() => {}); }
  await page.locator('#dev-opfs-materials-set').click();
  await page.getByText(/素材は「.+」に入れるようにしました/).waitFor();
  await page.getByText(/ブラウザ内：test-materials/).first().waitFor();
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  const skin = Buffer.from(zipSync({ 'スキン素材/Resource/Image/a.png': new Uint8Array([137, 80, 78, 71]), 'スキン素材/readme.txt': strToU8('見本のスキンです。改変・再配布はご遠慮ください。') }));
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: 'skin.zip', mimeType: 'application/zip', buffer: skin });
  await page.getByText('シナリオではないようです（スキン・素材・効果音など）').waitFor();
  if (width > 600) await page.screenshot({ path: join(OUT, `material-add-${colorScheme}.png`), fullPage: true });
  ok('シナリオではないものは素材として入れられる', await page.getByRole('button', { name: '素材の置き場所に入れる' }).isVisible());
  await page.getByLabel('スキン素材/readme.txtを入れる').uncheck();
  if (width > 600) { await page.waitForTimeout(300); await page.locator('.file-pick').locator('..').locator('..').screenshot({ path: join(OUT, `filepick-${colorScheme}.png`) }).catch(() => {}); }
  ok('素材は入れるファイルを選べる', await page.getByText('1 / 2 ファイルを入れます').isVisible());
  await page.locator('#mat-isnew').check();
  await page.locator('#mat-newcat').fill('スキン');
  await page.getByRole('button', { name: '素材の置き場所に入れる' }).click();
  await page.locator('dialog').getByRole('button', { name: 'Readme（利用規約）を読みました', exact: true }).click();
  await page.locator('#mat-done', { hasText: /スキン\/skin に入れました/ }).waitFor();
  ok('素材を分類フォルダに入れる（Readmeを確認してから）', true);
  ok('入れたあと、入れた場所を開くボタンの欄が出る', await page.locator('#mat-done').isVisible());
  // もう一度開くと、入れ先の様子（別の分類にある・もう入っている）を出す
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: 'skin.zip', mimeType: 'application/zip', buffer: skin });
  await page.locator('#mat-dest').waitFor();
  ok('入れ先の様子：別の分類フォルダに同じ名前がある', /別の分類フォルダにも同じ名前のものがあります：スキン\/skin/.test(await page.locator('#mat-dest').textContent()));
  await page.locator('#mat-cat').selectOption('スキン');
  ok('入れ先の様子：もう入っている（入れると前のものをバックアップしてから置き換える）', /もう入っています/.test(await page.locator('#mat-dest').textContent()));
  await page.locator('.card', { hasText: 'skin.zip' }).getByRole('button', { name: '閉じる' }).first().click();
  await page.getByRole('tab', { name: /自分のフォルダ一覧/ }).click();
  await page.getByLabel('エンジン').selectOption({ label: '素材の置き場所' });
  const mat = page.locator('#mine-list .card', { hasText: 'スキン/skin' });
  await mat.waitFor();
  ok('素材の置き場所を一覧で見る（分類フォルダごと）', await page.locator('#mine-list details.group summary', { hasText: 'スキン' }).isVisible());
  await mat.getByRole('button', { name: 'skinをお気に入りにする' }).click();
  await page.locator('#mine-list .card', { hasText: 'スキン/skin' }).locator('button.star.on[aria-pressed="true"]', { hasText: '★' }).waitFor();
  ok('☆を押すとお気に入り（★・色つき）', true);
  await page.screenshot({ path: join(OUT, `material-mine-${colorScheme}-${width}.png`), fullPage: true });
  await page.locator('#mine-list .card', { hasText: 'スキン/skin' }).getByLabel('skinを選ぶ').check();
  await page.locator('#mine-bar .sel-actions').getByRole('button', { name: '分類フォルダへ移す' }).click();
  await page.locator('#move-isnew').check();
  await page.locator('#move-newcat').fill('お気に入りスキン');
  await page.locator('#move-go').click();
  await page.locator('dialog', { hasText: '分類フォルダへ移しました（1件）' }).getByRole('button', { name: '閉じる' }).click();
  ok('素材を別の分類フォルダへ移す（実際のフォルダも）', await page.locator('#mine-list .card', { hasText: 'お気に入りスキン/skin' }).isVisible());

  // 12c. スキン（Skin.xml あり）：種類で分類フォルダを自動で決めて、スキンの置き場所へ
  await page.getByRole('tab', { name: '設定' }).click();
  await page.locator('#dev-opfs-skins-set').click();
  await page.getByText(/スキンは「.+」に入れるようにしました/).waitFor();
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  const skinZip = Buffer.from(zipSync({ '和風テスト/Skin.xml': strToU8('<Skin dataVersion="12"><Property><Name>和風テスト</Name><Type>MedievalFantasy</Type><Author>見本</Author></Property></Skin>'), '和風テスト/Resource/Image/b.png': new Uint8Array([137, 80, 78, 71]) }));
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: 'wafu_skin.zip', mimeType: 'application/zip', buffer: skinZip });
  await page.getByText(/スキンのようです（和風テスト・種類：MedievalFantasy/).waitFor();
  ok('スキン（Skin.xml）を見分ける', await page.locator('#mat-cat option', { hasText: '自動（スキンの種類で分ける：MedievalFantasy）' }).count() === 1);
  await page.locator('#mat-install').click();
  await page.locator('#mat-done', { hasText: /MedievalFantasy\/和風テスト に入れました/ }).waitFor();
  ok('スキンを種類の分類フォルダに自動で入れる', true);
  await page.getByRole('tab', { name: /自分のフォルダ一覧/ }).click();
  await page.getByLabel('エンジン').selectOption({ label: 'スキンの置き場所' });
  await page.locator('#mine-list .card', { hasText: 'MedievalFantasy/和風テスト' }).waitFor();
  ok('スキンの置き場所を一覧で見る', true);
  await page.getByLabel('エンジン').selectOption({ index: 0 });

  // 12d. 取ってきたときに保存先を選ぶ（今回だけ）：素材の入れ先と、元のzipの保存先
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  const extra = Buffer.from(zipSync({ 'おまけ/se.ogg': new Uint8Array([79, 103, 103, 83]) }));
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: 'omake.zip', mimeType: 'application/zip', buffer: extra });
  await page.locator('#mat-place').click();
  await page.locator('#place-modal').waitFor();
  ok('保存先を選ぶと「今回だけ／次からも」を聞く（最初は今回だけ）', await page.locator('#place-once').isChecked());
  await page.locator('#place-ok').click();
  await page.locator('#mat-dest', { hasText: '今回だけ' }).waitFor();
  await page.locator('#zip-place-pick').click();
  await page.locator('#place-ok').click();
  await page.locator('#zip-place', { hasText: '今回だけ' }).waitFor();
  ok('元のzipの保存先も選べる', true);
  if (width > 600) await page.locator('#mat-dest').locator('..').screenshot({ path: join(OUT, `place-${colorScheme}.png`) }).catch(() => {});
  await page.locator('#mat-install').click();
  await page.locator('#mat-done', { hasText: /今回だけ/ }).waitFor();
  const pickedMat = await page.evaluate(async () => { const out = []; const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('test-pick-material'); async function walk(x, p) { for await (const [n, hh] of x.entries()) { const q = p ? `${p}/${n}` : n; if (hh.kind === 'directory') await walk(hh, q); else out.push(q); } } await walk(d, ''); return out; });
  const pickedZip = await page.evaluate(async () => { const out = []; const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('test-pick-archive'); for await (const [n] of d.entries()) out.push(n); return out; });
  ok('今回だけ選んだ場所に入れる（素材・元のzip）', pickedMat.includes('omake/se.ogg') && pickedZip.includes('omake.zip'), `${pickedMat.join(',')} / ${pickedZip.join(',')}`);
  await page.locator('#mat-done').getByRole('button', { name: '閉じる' }).click();
  await page.getByRole('tab', { name: /自分のフォルダ一覧/ }).click();

  // 13. 選んでタグをまとめて付ける・整理と二重チェック
  const mcards = page.locator('#mine-list > .card');
  await mcards.filter({ hasText: 'Scenario/既存' }).locator('input[type=checkbox]').first().check();
  await mcards.filter({ hasText: 'Scenario/サンプル店2' }).locator('input[type=checkbox]').first().check();
  await page.locator('#mine-bar .sel-actions').getByRole('button', { name: 'タグを付ける', exact: true }).click();
  await page.locator('dialog .chip', { hasText: '積み' }).click();
  await page.locator('dialog').getByRole('button', { name: '付ける' }).click();
  await page.getByText('2件に「積み」を付けました').waitFor();
  ok('選んでタグをまとめて付ける', (await page.locator('.folder-chips .chip', { hasText: '積み' }).locator('.n').textContent()) === '2');
  await page.locator('.folder-chips .chip', { hasText: '積み' }).click();
  ok('タグで絞り込む', (await mcards.count()) === 2);
  await page.locator('.folder-chips .chip', { hasText: 'すべて' }).click();
  await page.locator('#mine-bar').getByRole('button', { name: '選択を解除' }).click();
  await page.getByRole('button', { name: '整理・二重チェック' }).click();
  await page.locator('#tidy summary', { hasText: 'Scenarioフォルダ内で作品が重複しています' }).waitFor();
  const dupSec = page.locator('#tidy-dup');
  ok('Scenarioの二重を見つける', await dupSec.getByText(CL.name).first().isVisible() && (await dupSec.locator('li li').count()) >= 3);
  ok('保存場所の重なりを見つける', (await page.locator('#tidy-zipdup li li').count()) === 2);
  ok('バックアップを用意するは最初からオン', await page.getByLabel('整理するときバックアップを用意する').isChecked());
  ok('移す先を表示する（選んだバックアップ先）', await page.locator('#tidy').getByText(/test-backup」フォルダの中の CardWirthNext/).first().isVisible());
  if (width > 600) await page.locator('#tidy').screenshot({ path: join(OUT, `tidy-${colorScheme}.png`) }).catch(() => {});
  // 1件だけ移す（確認の一覧 → 結果の記録）
  await dupSec.locator('li li', { hasText: `Scenario/_サンプル分類/${CL.folderName}` }).getByRole('button', { name: 'CWCatalog_backup へ移動' }).click();
  ok('確認の一覧に、移す先を書く', await page.locator('dialog').getByText(/test-backup」フォルダの中の CardWirthNext/).isVisible());
  await page.locator('dialog').getByRole('button', { name: 'この内容で整理する' }).click();
  const log1 = page.locator('dialog', { hasText: '整理しました（1件）' });
  await log1.waitFor();
  ok('結果の記録に移した先を書く', new RegExp(`移動　.*Scenario/_サンプル分類/${esc(CL.folderName)}[\\s\\S]*→ .*test-backup」の中の CardWirthNext[^/]*/\\d{8}_\\d{6}_${esc(CL.folderName)}`).test(await log1.locator('pre').textContent()));
  await log1.getByRole('button', { name: '閉じる' }).click();
  // サンプル店2は除外して、最新版のみ残して整理
  await page.locator('#tidy-dup li li', { hasText: 'Scenario/サンプル店2' }).getByRole('button', { name: 'これを除外' }).click();
  await page.locator('#tidy-dup li li', { hasText: 'Scenario/サンプル店2' }).getByRole('button', { name: /除外中/ }).waitFor();
  ok('除外をオンにできる', true);
  await page.locator('#tidy-latest').click();
  const plan = await page.locator('#tidy-plan').textContent();
  ok('最新版のみ残す：確認の一覧（除外したものは入らない）', !plan.includes('サンプル店2') && /保存場所：/.test(plan), plan.replace(/\n/g, ' / '));
  await page.locator('dialog').getByRole('button', { name: 'この内容で整理する' }).click();
  const log2 = page.locator('dialog', { hasText: /整理しました/ });
  await log2.waitFor();
  await log2.getByRole('button', { name: '閉じる' }).click();
  await page.locator('#tidy-zipdup summary', { hasText: 'なし' }).waitFor();
  ok('整理したあとは重なりがなくなる', true);
  await page.locator('#tidy').getByRole('button', { name: '閉じる' }).click();
  // シナリオを分類フォルダへ移す（複数選んで）
  await page.locator('#mine-list > .card', { hasText: 'Scenario/サンプル店2' }).locator('input[type=checkbox]').first().check();
  await page.locator('#mine-bar .sel-actions').getByRole('button', { name: '分類フォルダへ移す' }).click();
  await page.locator('#move-isnew').check();
  await page.locator('#move-newcat').fill('_集');
  await page.locator('#move-go').click();
  await page.locator('dialog', { hasText: '分類フォルダへ移しました（1件）' }).getByRole('button', { name: '閉じる' }).click();
  ok('シナリオを分類フォルダへ移す', await page.locator('#mine-list > .card', { hasText: 'Scenario/_集/サンプル店2' }).isVisible());

  // 14. Readmeからタグを自動で付ける
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  const shop = Buffer.from(zipSync({ '店テスト/Summary.wsm': CL_WSM, [`店テスト/${CL_WID_NAME}`]: CL_WID, 'Readme.txt': strToU8('これは店シナです。男性１人専用。戦闘はありません。') }));
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: '店テスト.zip', mimeType: 'application/zip', buffer: shop });
  await page.locator('#auto-tags').waitFor();
  const autoChips = await page.locator('#auto-tags .chip').allTextContents();
  ok('Readmeからタグを見つける（店シナ・1人専用・戦闘なし）', ['店シナ', '1人専用', '戦闘なし'].every((t) => autoChips.includes(t)), (await page.locator('#auto-tags .chip').allTextContents()).join(','));
  await page.getByLabel('タグ「戦闘なし」を付ける').uncheck();
  await page.getByLabel('Readme（利用規約）を読みました').check();
  await page.locator('#dest-cat').selectOption(''); // CAB の試験（実物が無ければ飛ばす）に関係なく、分類フォルダなしに入れる
  await page.locator('#dest-name').fill('店テスト');
  await page.getByRole('button', { name: 'インストール' }).click();
  await page.getByText(/Scenario\/店テスト に入れました/).waitFor();
  const shopCard = page.locator('#mine-list > .card', { hasText: 'Scenario/店テスト' });
  await shopCard.waitFor();
  const shopTags = await shopCard.locator('.tag').allTextContents();
  ok('入れるときに、選んだ自動タグだけ付く', shopTags.some((t) => t.startsWith('店シナ')) && shopTags.some((t) => t.startsWith('1人専用')) && !shopTags.some((t) => t.startsWith('戦闘なし')), shopTags.join(','));

  // 14b. 実行ファイルが入っているzip：注意を出し、いつもは外して入れる（元のzipも残さない）
  const mz = new Uint8Array(4000); mz[0] = 0x4d; mz[1] = 0x5a;
  const tool = Buffer.from(zipSync({ '道具入り/Summary.wsm': CL_WSM, [`道具入り/${CL_WID_NAME}`]: CL_WID, '道具入り/setup.exe': mz, '道具入り/data.dat': mz, '道具入り/りどみ.txt': strToU8('道具入りの見本です。') }));
  await page.getByRole('tab', { name: /シナリオ・素材・スキンをDLする/ }).click();
  await page.locator('input[type=file][accept=".zip,.wsn,.cab,.lzh,.lha,.7z"]').setInputFiles({ name: '道具入り.zip', mimeType: 'application/zip', buffer: tool });
  const ew = page.locator('#exec-warn');
  await ew.waitFor();
  ok('実行ファイルの注意（名前と中身の頭のMZ）', /注意！このファイルには、カードワースのシナリオ以外の実行ファイルが入っています/.test(await ew.textContent()) && await ew.getByText('道具入り/setup.exe').isVisible() && await ew.getByText('道具入り/data.dat').isVisible() && /MZ/.test(await ew.textContent()));
  ok('実行ファイルは、いつもは入れない', !(await page.locator('#exec-allow').isChecked()));
  await page.locator('#contents summary').click();
  await page.locator('#contents li.exec').first().waitFor();
  ok('中身の一覧（実行ファイルに印）', (await page.locator('#contents li.exec').count()) === 2 && await page.locator('#contents').getByText('・入れません').first().isVisible());
  await page.locator('#contents').getByRole('button', { name: '道具入り/りどみ.txt' }).click();
  await page.locator('#text-modal', { hasText: '道具入りの見本です。' }).waitFor();
  ok('中身のテキストを、その場で読める', true);
  if (width > 600) await page.locator('#exec-warn').locator('..').screenshot({ path: join(OUT, `exec-warn-${colorScheme}.png`) }).catch(() => {});
  await page.locator('dialog').getByRole('button', { name: '閉じる' }).click();
  await page.getByLabel('Readme（利用規約）を読みました').check();
  await page.getByRole('button', { name: 'インストール' }).click();
  await page.getByText(/Scenario\/道具入り に入れました/).waitFor();

  // OPFSの中身を確認
  const tree = await page.evaluate(async () => {
    const out = [];
    async function walk(d, p) { for await (const [n, h] of d.entries()) { const q = p ? `${p}/${n}` : n; if (h.kind === 'directory') await walk(h, q); else out.push(q); } }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle('test-engine'), '');
    return out.sort();
  });
  const treeOf = (name) => page.evaluate(async (name) => {
    const out = [];
    async function walk(d, p) { for await (const [n, h] of d.entries()) { const q = p ? `${p}/${n}` : n; if (h.kind === 'directory') await walk(h, q); else out.push(q); } }
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(name), '');
    return out.sort();
  }, name);
  const archived = await treeOf('test-archive');
  const mats = await treeOf('test-materials');
  const bk = await treeOf('test-backup');
  const skins = await treeOf('test-skins');
  ok('元のzipを保存場所に保存し、重なりは整理でバックアップ先へ', archived.filter((p) => !p.includes('/') && p !== '店テスト.zip').length === 1 && archived.some((p) => p.endsWith('サンプル店.zip')) && bk.some((p) => /^zipの保存場所\/\d{8}_\d{6}_.+\.zip$/.test(p)), `${archived.join(', ')} / ${bk.join(', ')}`);
  ok('素材・スキンの元のzipは、保存場所の「素材」「スキン」に分けて残す', archived.includes('素材/skin.zip') && archived.includes('スキン/wafu_skin.zip'), archived.join(', '));
  ok('スキンは Skin.xml のフォルダの中身を、種類の分類フォルダに入れる', skins.includes('MedievalFantasy/和風テスト/Skin.xml') && skins.includes('MedievalFantasy/和風テスト/Resource/Image/b.png'), skins.join(', '));
  ok('素材は分類フォルダに、1つ上のフォルダを省いて、選んだファイルだけ入る', mats.includes('お気に入りスキン/skin/Resource/Image/a.png') && !mats.some((p) => p.startsWith('スキン/skin') || p.endsWith('readme.txt')), mats.join(', '));
  ok('サンプル店2 は除外したので残り、分類フォルダへ移った', tree.includes('Scenario/_集/サンプル店2/Summary.wsm') && !tree.includes('Scenario/サンプル店2/Summary.wsm'));
  ok('書き込み先は Scenario と CWCatalog_backup だけ', tree.every((p) => p === 'CardWirthNext.exe' || p.startsWith('Scenario/') || p.startsWith('CWCatalog_backup/')));
  ok('Next版が _サンプル分類 に入った', tree.includes(`Scenario/_サンプル分類/${NX.name}/Summary.wsm`));
  ok('移したものは選んだバックアップ先にある', !tree.includes(`Scenario/_サンプル分類/${CL.folderName}/Summary.wsm`) && bk.some((p) => new RegExp(`^CardWirthNext[^/]*/\\d{8}_\\d{6}_${esc(CL.folderName)}/Summary\\.wsm$`).test(p)), bk.filter((p) => p.endsWith('Summary.wsm')).join(', '));
  ok('外側のReadmeはシナリオに入れない', !tree.some((p) => p.endsWith('りどみ.txt') && !p.includes('道具入り')));
  ok('実行ファイルは外して入れ、元のzipも残さない', tree.includes('Scenario/道具入り/Summary.wsm') && !tree.some((p) => /道具入り\/(setup\.exe|data\.dat)$/.test(p)) && !archived.includes('道具入り.zip'), tree.filter((p) => p.includes('道具入り')).join(', '));
  ok('コンソールにエラーなし（CSP違反を含む）', errors.length === 0, errors.join(' | '));
  await ctx.close();
  return tree;
}

try {
  const tree = await run('light', 1100);
  await run('dark', 390);
  console.log(results.join('\n'));
  console.log('\n--- OPFSの中身 ---\n' + tree.join('\n'));
} catch (e) {
  console.log(results.join('\n'));
  console.error('FAILED', e);
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
  other.close();
}
