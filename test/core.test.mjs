// 中核処理のテスト。
// 実物の作品ファイルを使う試験は、作者さんの作品を公開リポジトリに入れないため、
// 環境変数 CW_FIXTURES のフォルダにある場合だけ実行する。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { decodeText, decodeZipName, repairMojibake, encodeCp932, nonCp932Chars } from '../src/core/text.js';
import { readZip, safeRelativePath, writeZip, ZipError, crc32 } from '../src/core/zip.js';
import { guessVersion, readmeScore } from '../src/core/scenario.js';
import { openArchive } from '../src/core/archive.js';
import { planInstall, performInstall, exportForWeb } from '../src/core/install.js';
import { scanScenarioFolder, detectEngineKind } from '../src/core/scan.js';
import { MemDir, readAt, existsAt } from '../src/core/fs.js';
import { parseCatalog, matchEntry, compareVersions, updateState, usableDownloads, playability } from '../src/core/catalog.js';

const FX = process.env.CW_FIXTURES;
const fx = (n) => new Uint8Array(readFileSync(join(FX, n)));
const hasFx = FX && existsSync(FX);

test('文字コード判定：UTF-8・CP932・BOM', () => {
  assert.equal(decodeText(new TextEncoder().encode('りどみ①')).encoding, 'utf-8');
  const sjis = encodeCp932('りどみ①髙﨑');
  const r = decodeText(sjis);
  assert.equal(r.encoding, 'shift_jis');
  assert.equal(r.text, 'りどみ①髙﨑');
  assert.equal(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x41)).text, 'A');
});

test('化けたファイル名を元に戻す', () => {
  assert.equal(repairMojibake('02_闡嶺ｽ懈ｨｩ.txt'), '02_著作権.txt');
  assert.equal(repairMojibake('03_繧ｯ繝ｪ繧｢蠕後↓.txt'), '03_クリア後に.txt');
  assert.equal(repairMojibake('普通の名前.txt'), null);
});

test('zipの名前：フラグ無しのCP932とUTF-8、Macの濁点', () => {
  assert.equal(decodeZipName(encodeCp932('りどみ.txt'), false), 'りどみ.txt');
  assert.equal(decodeZipName(new TextEncoder().encode('りどみ.txt'), false), 'りどみ.txt');
  const nfd = new TextEncoder().encode('か\u3099'); // 「が」の分離形
  assert.equal(decodeZipName(nfd, true), 'が');
});

test('1.50／Nextで使えない文字', () => {
  assert.deepEqual(nonCp932Chars('普通のシナリオ①'), []);
  assert.deepEqual(nonCp932Chars('絵文字🌸'), ['🌸']);
});

test('危険なパスを拒否・Windowsで使えない名前を直す', () => {
  assert.equal(safeRelativePath('../evil.txt'), null);
  assert.equal(safeRelativePath('a/../../b'), null);
  assert.equal(safeRelativePath('C:/Windows/x'), null);
  assert.equal(safeRelativePath('/abs/x'), null);
  assert.equal(safeRelativePath('a\\b\\c.txt'), 'a/b/c.txt');
  assert.equal(safeRelativePath('ok/CON.txt'), 'ok/_CON.txt');
  assert.equal(safeRelativePath('what?.txt'), 'what？.txt');
  assert.equal(safeRelativePath('dots...'), 'dots');
});

test('バージョンの推測と比較', () => {
  assert.equal(guessVersion('開けられた鳥籠ver1_01'), '1.01');
  assert.equal(guessVersion('星暦堂Ver1.12'), '1.12');
  assert.equal(guessVersion('うつろい森のあなた(Next)ver1.00'), '1.00');
  assert.equal(guessVersion('さよならの森へ_230124'), '230124');
  assert.equal(guessVersion('ある風刺画家の一室(NEXT専用)1.02'), '1.02');
  assert.equal(guessVersion('うさぎ小屋'), null);
  assert.equal(compareVersions('1.10', '1.9'), 1);
  assert.equal(compareVersions('1.09', '1.10'), -1);
  assert.equal(compareVersions('ver1.0', '1.0.0'), 0);
});

test('りどみらしさ', () => {
  for (const n of ['01_Readme.txt', '!readme.txt', '@Readme.txt', 'read me.txt', 'りどみ.txt', '02_著作権表記.txt']) {
    assert.ok(readmeScore(n, false) > 10, n);
  }
  assert.ok(readmeScore('@あとがき.txt', true) < readmeScore('@Readme.txt', true));
  assert.equal(readmeScore('image.png', false), 0);
});

test('zipの書き出し：UTF-8の目印が付き、読み戻せる', () => {
  const z = writeZip([{ path: 'テスト/りどみ.txt', data: new TextEncoder().encode('こんにちは') }]);
  const { entries } = readZip(z);
  assert.equal(entries[0].path, 'テスト/りどみ.txt');
  assert.equal(entries[0].utf8Flag, true);
  assert.equal(new TextDecoder().decode(entries[0].read()), 'こんにちは');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('カタログ：整形・照合・更新判定', () => {
  const cat = parseCatalog({
    format: 1,
    entries: [
      { id: 'e00001', name: 'サンプルの森', author: '見本作者', version: '1.10', format: 'classic',
        compat: { cw150: 'verified', next: 'verified', py: 'expected' }, convert: 'self',
        downloads: [
          { url: 'javascript:alert(1)', kind: 'direct', status: 'active' },
          { url: 'https://example.com/old', kind: 'page', status: 'closed', until: '2026-11-25' },
          { url: 'https://example.com/mirror', kind: 'page', status: 'mirror' },
          { url: 'https://example.com/new.zip', kind: 'direct', status: 'active' },
        ], file: { sha256: 'a'.repeat(64) } },
      { id: 'bad-id', name: 'x' },
    ],
  });
  assert.equal(cat.entries.length, 1);
  const e = cat.entries[0];
  assert.equal(e.downloads.length, 3, '危険なURLは捨てる');
  assert.deepEqual(usableDownloads(e).map((d) => d.url), ['https://example.com/new.zip', 'https://example.com/mirror']);
  assert.equal(matchEntry(cat, { sha256: 'a'.repeat(64) }).by, 'sha256');
  assert.equal(matchEntry(cat, { name: 'サンプル の 森', author: '見本作者' }).by, 'name');
  assert.equal(updateState({ version: '1.09' }, e), 'update');
  assert.equal(updateState({ version: '1.10' }, e), 'latest');
  assert.equal(updateState({ version: '' }, e), 'unknown');
  assert.throws(() => parseCatalog({ format: 99 }));
});

test('遊べるかどうかの判定', () => {
  assert.equal(playability({ format: 'classic' }, 'py').level, 'ok');
  assert.equal(playability({ format: 'next' }, 'py').level, 'convert');
  assert.equal(playability({ format: 'next' }, 'cw150').level, 'no');
  assert.equal(playability({ format: 'wsn', wsnVersion: 5 }, 'next').level, 'no');
  assert.equal(playability({ format: 'wsn', wsnVersion: 5 }, 'wcw').level, 'caution');
});

// ---- 実物を使う試験 ----
test('実物：クラシック（CP932の名前・トップにりどみ）', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('classic_cp932.zip'), 'classic_cp932.zip');
  assert.equal(o.scenarios.length, 1);
  const s = o.scenarios[0];
  assert.equal(s.name, '開けられた鳥籠');
  assert.equal(s.author, '清葉雪見');
  assert.equal(s.format, 'classic');
  assert.equal(s.dataVersion, 4);
  assert.equal(s.encrypted, false);
  assert.equal(s.folderName, '開けられた鳥籠ver1_01');
  assert.equal(s.versionGuess, '1.01');
  assert.equal(o.readmes[0].path, 'りどみ.txt', 'トップのりどみが一番');
  const rd = o.files.find((f) => f.path === 'りどみ.txt');
  const t = decodeText(await rd.read());
  assert.equal(t.encoding, 'shift_jis');
  assert.match(t.text, /①テスト用りどみです。髙﨑/);
  assert.ok(o.nonUtf8Names > 0);
});

test('実物：Next（二重フォルダ・暗号化なし）', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('next_nested.zip'), 'next_nested.zip');
  const s = o.scenarios[0];
  assert.equal(s.name, 'うつろい森のあなた');
  assert.equal(s.author, '水雲');
  assert.equal(s.format, 'next');
  assert.equal(s.dataVersion, 7);
  assert.equal(s.encrypted, false);
  assert.equal(s.root, 'うつろい森のあなた(Next)ver1.00/うつろい森のあなた');
  assert.equal(s.versionGuess, '1.00', '内側のフォルダ名に版が無ければzip名から');
});

test('実物：Next（WDP暗号化あり）', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('next_wdp.zip'), 'next_wdp.zip');
  const s = o.scenarios[0];
  assert.equal(s.name, 'ある風刺画家の一室');
  assert.equal(s.format, 'next');
  assert.equal(s.encrypted, true);
  assert.equal(o.readmes[0].path.endsWith('!readme.txt'), true);
});

test('実物：UTF-8なのに目印の無いzip', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('utf8_noflag.zip'), 'x.zip');
  assert.ok(o.files.some((f) => f.path === 'さよなら/02_著作権.txt'));
});

test('実物：危険なパスは無視される', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('zipslip.zip'), 'zipslip.zip');
  assert.deepEqual(o.files.map((f) => f.path).sort(), ['ok/Summary.wsm', 'ok/_CON.txt']);
  assert.equal(o.warnings.filter((w) => w.includes('危険なパス')).length, 3);
});

test('実物：壊れたzipは止まる', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('badcrc.zip'), 'badcrc.zip');
  // CRCを壊したのは1件目（りどみ.txt）
  await assert.rejects(() => o.files.find((f) => f.path === 'りどみ.txt').read(), ZipError);
});

test('実物：WSN（.wsn）', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('alice.wsn'), 'アリスの洞窟Py.wsn');
  const s = o.scenarios[0];
  assert.equal(s.name, 'アリスの洞窟');
  assert.equal(s.author, '飛鳥');
  assert.equal(s.format, 'wsn');
  assert.equal(s.wsnVersion, 5);
  assert.equal(s.root, '');
  assert.equal(o.source.isWsn, true);
});

test('実物：インストール→再インストールでバックアップ→スキャン', { skip: !hasFx }, async () => {
  // メモリ上に「Next」と「Py」のフォルダを作る
  const next = new MemDir('CardWirthNext');
  await next.writeFile('CardWirthNext.exe', new Uint8Array(1));
  await next.dir('Scenario', { create: true });
  assert.equal(await detectEngineKind(next), 'next');

  const o = await openArchive(fx('next_nested.zip'), 'next_nested.zip');
  const plan = planInstall(o, 0, { kind: 'next' }, '_店');
  assert.equal(plan.dest, 'Scenario/_店/うつろい森のあなた');
  assert.equal(plan.play.level, 'ok');
  const r1 = await performInstall(next, plan);
  assert.equal(r1.backup, null);
  assert.ok(await existsAt(next, 'Scenario/_店/うつろい森のあなた/Summary.wsm'));
  const r2 = await performInstall(next, plan);
  assert.match(r2.backup, /^CWCatalog_backup\/\d{8}_\d{6}_うつろい森のあなた$/);
  assert.ok(await existsAt(next, `${r2.backup}/Summary.wsm`));

  // 1.50形式も同じフォルダに入れて、スキャン
  const c = await openArchive(fx('classic_cp932.zip'), 'classic_cp932.zip');
  await performInstall(next, planInstall(c, 0, { kind: 'next' }, ''));
  const scan = await scanScenarioFolder(next);
  const names = scan.items.map((i) => `${i.name}:${i.format}`).sort();
  assert.deepEqual(names, ['うつろい森のあなた:next', '開けられた鳥籠:classic']);
  assert.deepEqual(scan.categories, ['_店']);

  // Next仕様はPyに入れると「変換が必要」と出る
  const py = new MemDir('CardWirthPy');
  assert.equal(planInstall(o, 0, { kind: 'py' }, '').play.level, 'convert');

  // .wsn は Py には解凍せずにファイルのまま置く
  const w = await openArchive(fx('alice.wsn'), 'アリスの洞窟Py.wsn');
  const wp = planInstall(w, 0, { kind: 'py' }, '');
  assert.equal(wp.passthrough, true);
  await performInstall(py, wp);
  assert.equal((await readAt(py, 'Scenario/アリスの洞窟Py.wsn')).length, w.bytes.length);
  const pscan = await scanScenarioFolder(py);
  assert.equal(pscan.items[0].format, 'wsn');
  assert.equal(pscan.items[0].wsnVersion, 5);
});

test('実物：WebCardWirth用の書き出し', { skip: !hasFx }, async () => {
  const o = await openArchive(fx('classic_cp932.zip'), 'classic_cp932.zip');
  const out = await exportForWeb(o, 0);
  assert.equal(out.fileName, '開けられた鳥籠ver1_01.zip');
  const back = readZip(out.data).entries;
  assert.ok(back.every((e) => e.utf8Flag || !/[^\x00-\x7f]/.test(e.path)));
  assert.ok(back.some((e) => e.path === '開けられた鳥籠ver1_01/Summary.wsm'));
  assert.ok(!back.some((e) => e.path.includes('りどみ.txt')), 'シナリオ外のりどみは入れない');
});

// ---- URLから取ってくる ----
import { decodeHtml, extractDownloadLinks, fileNameFrom, siteNotice, pageTitle } from '../src/core/weblink.js';

test('HTMLの文字コード（EUC-JP・Shift_JISの個人サイト）', () => {
  const euc = new Uint8Array([0x3c, 0x6d, 0x65, 0x74, 0x61, 0x20, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x3d, 0x22, 0x45, 0x55, 0x43, 0x2d, 0x4a, 0x50, 0x22, 0x3e, 0xb3, 0xab, 0xa4, 0xb1]); // 開け
  assert.match(decodeHtml(euc), /開け/);
  assert.equal(decodeHtml(encodeCp932('鳥籠'), 'text/html; charset=Shift_JIS'), '鳥籠');
  assert.equal(decodeHtml(new TextEncoder().encode('鳥籠')), '鳥籠');
});

test('ページからダウンロードのリンクを探す', () => {
  const html = `<title>開けられた鳥籠 - 清葉雪見ワールド</title>
    <a href="https://ux.getuploader.com/seiha_yukimiCW/download/12">開けられた鳥籠ver1_01.zip</a>
    <a href="/files/%E9%B3%A5%E7%B1%A0_v1.zip">こちら</a>
    <a href="https://uu.getuploader.com/seiha_yukimiCW/ranking">ランキング</a>
    <a href="other.html">ダウンロードはこちら</a>
    <a href="javascript:void(0)">DL</a>
    <a href="https://example.com/about">作者について</a>`;
  const links = extractDownloadLinks(html, 'https://seesaawiki.jp/seihayukimicw/d/page');
  assert.deepEqual(links.map((l) => [l.kind, l.url]), [
    ['file', 'https://seesaawiki.jp/files/%E9%B3%A5%E7%B1%A0_v1.zip'],
    ['page', 'https://ux.getuploader.com/seiha_yukimiCW/download/12'],
    ['page', 'https://seesaawiki.jp/seihayukimicw/d/other.html'],
  ]);
  assert.equal(pageTitle(html), '開けられた鳥籠 - 清葉雪見ワールド');
});

test('ファイル名の取り出しと、終了するサイトの注意', () => {
  assert.equal(fileNameFrom('https://x/a', "attachment; filename*=UTF-8''%E9%B3%A5.zip"), '鳥.zip');
  assert.equal(fileNameFrom('https://x/a', 'attachment; filename="tori.zip"'), 'tori.zip');
  assert.equal(fileNameFrom('https://x/dl/%E9%B3%A5%E7%B1%A0.zip?x=1'), '鳥籠.zip');
  assert.match(siteNotice('https://ux.getuploader.com/a/download/1'), /2026年11月25日/);
  assert.equal(siteNotice('https://github.com/a/b'), '');
});

import { extractDownloadForms, metaRefreshUrl, pageText } from '../src/core/weblink.js';

// 斧アップローダーと同じ形の見本（実際のページの構造を確かめて作ったもの。中身は架空）
const AXE_1 = `<html><body><nav><a href="/x/ranking">ランキング</a></nav>
  <form><input class="form-control" value="https://uu.example-uploader.com/x/download/12" readonly></form>
  <p>ファイルをダウンロードするには「ダウンロード」ボタンを押下してください。利用規約に同意したものとみなします。</p>
  <form method="POST" onsubmit="download()" name="agree">
    <input type="hidden" name="token" value="6adb7ba6-354c-4509-8ef9-124ea010e467">
    <input class="btn" type="submit" value="ダウンロード" name="yes">
  </form>
  <form id="goog" action="//translate.googleapis.com/translate_voting?client=te" method="post"><input type="text" name="sl"></form>
</body></html>`;
const AXE_2 = `<html><head><meta http-equiv="refresh" content="6;URL=https://downloadx.example-uploader.com/g/6adb7ba6/x/12/%E9%B3%A5.zip"></head>
  <body><a href="https://downloadx.example-uploader.com/g/6adb7ba6/x/12/%E9%B3%A5.zip">Download Now</a></body></html>`;

test('同意ページのダウンロードフォームを読み取る（斧と同じ形）', () => {
  const forms = extractDownloadForms(AXE_1, 'https://ux.example-uploader.com/x/download/12');
  assert.equal(forms.length, 1, '翻訳ボタンなど別サイト行きのフォームは除く');
  assert.deepEqual(forms[0], {
    action: 'https://ux.example-uploader.com/x/download/12', method: 'POST',
    fields: [['token', '6adb7ba6-354c-4509-8ef9-124ea010e467'], ['yes', 'ダウンロード']], label: 'ダウンロード', inputs: [],
  });
  assert.match(pageText(AXE_1), /利用規約に同意したものとみなします/);
  assert.doesNotMatch(pageText(AXE_1), /ランキング/);
});

test('同意したあとのページから本物のファイルを見つける', () => {
  assert.equal(metaRefreshUrl(AXE_2, 'https://ux.example-uploader.com/x/download/12'), 'https://downloadx.example-uploader.com/g/6adb7ba6/x/12/%E9%B3%A5.zip');
  const links = extractDownloadLinks(AXE_2, 'https://ux.example-uploader.com/x/download/12');
  assert.equal(links[0].kind, 'file');
});

test('DLキーの入力欄があるフォーム', () => {
  const html = `<form action="/dl" method="post"><input type="password" name="key" placeholder="DLキー"><button type="submit">DLする</button></form>`;
  const f = extractDownloadForms(html, 'https://example.com/p')[0];
  assert.deepEqual(f.inputs, [{ name: 'key', type: 'password', label: 'DLキー' }]);
  assert.equal(f.action, 'https://example.com/dl');
});

// ------------------------------------------------------------ 複数のカタログ
import { combine, matchWork, chooseDownloads, statusOf, ageRoleOf, exportPersonal, nextPersonalId, workKey, introKind } from '../src/core/catalogs.js';
import { parseOgp } from '../src/core/weblink.js';
import { checkEngineFolder } from '../src/core/scan.js';

const ent = (id, name, extra = {}) => ({ id, name, author: '見本作者', version: '1.0', format: 'classic', downloads: [], ...extra });

test('カタログ：個人用のID（p…）と紹介ページを受け付ける', () => {
  const c = parseCatalog({ format: 1, entries: [
    ent('p00001', '森', { intro: ['https://misskey.io/notes/abc', { url: 'https://x.com/a/status/1', label: '告知' }, { url: 'javascript:alert(1)' }] }),
    ent('x1', 'だめなID'),
  ] });
  assert.equal(c.entries.length, 1);
  assert.deepEqual(c.entries[0].intro, [{ url: 'https://misskey.io/notes/abc', label: '' }, { url: 'https://x.com/a/status/1', label: '告知' }]);
  assert.equal(introKind('https://misskey.io/notes/abc'), 'misskey');
  assert.equal(introKind('https://x.com/a'), 'x');
  assert.equal(introKind('https://example.com/'), 'site');
});

test('カタログをまとめる：同じ作品は1つに、配布元は合わせる、外したもの', () => {
  const shared = parseCatalog({ format: 1, entries: [ent('e00001', 'サンプルの森', { version: '1.10', downloads: [{ url: 'https://a.example/f.zip', kind: 'direct', status: 'active' }], file: { sha256: 'a'.repeat(64) } })] });
  const own = parseCatalog({ format: 1, entries: [
    ent('p00001', 'サンプルの　森', { version: '1.02', downloads: [{ url: 'https://b.example/dl', status: 'mirror' }, { url: 'https://a.example/f.zip', kind: 'direct' }], intro: ['https://b.example/'] }),
    ent('p00002', '別の作品'),
  ] });
  const c = combine([
    { id: 'own1', kind: 'own', name: 'マイ', catalog: own, hidden: [workKey({ name: '別の作品', author: '見本作者' })] },
    { id: 'sh1', kind: 'shared', name: '共用', catalog: shared },
  ]);
  assert.equal(c.works.length, 2);
  const w = c.works.find((x) => x.name === 'サンプルの森');
  assert.equal(w.version, '1.10', '新しい方の版');
  assert.equal(w.downloads.length, 2, 'URLが同じ配布元は1つに');
  assert.equal(w.refs[0].kind, 'shared', '共用カタログが先');
  assert.equal(w.intro.length, 1);
  assert.equal(c.works.find((x) => x.name === '別の作品').hidden, true);
  assert.equal(matchWork(c, { name: 'x', sha256: 'a'.repeat(64) }).by, 'sha256');
  assert.equal(matchWork(c, { name: 'サンプルの森', author: '見本作者' }).work, w);
});

test('DLの順番：デフォルト → 現役 → 予備 → 旧（終了は使わない）', () => {
  const w = { downloads: [
    { url: 'https://old', status: 'old' }, { url: 'https://mirror', status: 'mirror' },
    { url: 'https://closed', status: 'closed' }, { url: 'https://active', status: 'active' },
  ] };
  assert.deepEqual(chooseDownloads(w).map((d) => d.url), ['https://active', 'https://mirror', 'https://old']);
  assert.deepEqual(chooseDownloads(w, 'https://mirror').map((d) => d.url), ['https://mirror', 'https://active', 'https://old']);
  assert.deepEqual(chooseDownloads(w, 'https://closed').map((d) => d.url)[0], 'https://active', '終了したものはデフォルトでも使わない');
  for (const s of ['active', 'mirror', 'old', 'closed']) { const { age, role } = ageRoleOf(s); assert.equal(statusOf(age, role), s); }
});

test('個人用カタログの書き出し：外した作品は入れない、ID の採番', () => {
  const entries = [ent('p00001', 'A'), ent('p00007', 'B')];
  const out = exportPersonal('一覧', entries, { hidden: [workKey(entries[1])] });
  assert.equal(out.format, 1);
  assert.equal(out.kind, 'cw-catalog/personal');
  assert.deepEqual(out.entries.map((e) => e.id), ['p00001']);
  assert.equal(parseCatalog(out).entries.length, 1, '書き出したものは、そのまま読み込める');
  assert.equal(nextPersonalId(entries), 'p00008');
});

test('紹介ページのカード情報（OGP）', () => {
  const og = parseOgp(`<html><head><title>代わり</title>
    <meta content="森の紹介 &amp; 告知" property="og:title">
    <meta property="og:image" content="/img/c.png"><meta name="description" content="説明文"></head></html>`, 'https://site.example/cw/');
  assert.equal(og.title, '森の紹介 & 告知');
  assert.equal(og.image, 'https://site.example/img/c.png');
  assert.equal(og.description, '説明文');
  assert.equal(parseOgp('<title>だけ</title>', 'https://a/').title, 'だけ');
  assert.equal(parseOgp('<meta property="og:image" content="javascript:x">', 'https://a/').image, '');
});

test('エンジンのフォルダの選び間違いを見分ける', async () => {
  const eng = new MemDir('CardWirth');
  await eng.writeFile('CardWirth.exe', Uint8Array.of(1));
  const scen = await eng.dir('Scenario', { create: true });
  const one = await scen.dir('森', { create: true });
  await one.writeFile('Summary.wsm', Uint8Array.of(1));
  const yado = await eng.dir('Yado', { create: true });
  assert.deepEqual(await checkEngineFolder(eng), { ok: true, problem: '', kind: 'cw150' });
  assert.equal((await checkEngineFolder(scen)).problem, 'scenario');
  assert.equal((await checkEngineFolder(one)).problem, 'inside');
  assert.equal((await checkEngineFolder(yado)).problem, 'yado');
  assert.equal((await checkEngineFolder(new MemDir('どこか'))).problem, 'noscenario');
});
