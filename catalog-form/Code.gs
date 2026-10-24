/**
 * CWカタログ 共用カタログの登録フォーム（Google Apps Script）
 *
 * できること
 *  ・登録フォーム（Googleフォーム）：作品名・作者名・配布URLだけで登録できる。Googleアカウントでのログインが要る
 *    （メールアドレスは確認済みのものを記録し、公開しない）。送信後のメールに「回答を編集」のリンクと編集キーが届く
 *  ・変更・削除フォーム：編集キーで直す／掲載をやめる（すぐ非公開）／サイト認証で本人確認／編集キーの再発行
 *  ・作者さん以外の「代理登録」も受け付ける。作者さんがサイト認証をすれば、自分の登録として引き取れる
 *  ・スプレッドシートの「作品」シートが台帳。「状態」の列で 公開／承認待ち／非公開 を切り替える
 *  ・ウェブアプリとして公開すると、CWカタログが読む index.json（?file=index）と meta.json（?file=meta）を出す
 *
 * 使い方は README.md を見てください。最初に setup() を1回だけ実行します。
 */

const P = PropertiesService.getScriptProperties();
const SHEET = '作品';
const LOG_SHEET = '記録';
const STATES = ['公開', '承認待ち', '非公開', '削除依頼'];
const COLS = [
  'ID', '状態', '種類', '作品名', '作者名', '配布URL', 'URLの種類', '予備・旧の配布URL', '形式', 'バージョン',
  '紹介ページ', 'タグ', '紹介文', '登録の立場', '登録者メール', '編集キー（ハッシュ）', '回答ID', '登録日時', '更新日時',
  '認証トークン', '認証メール', '認証期限', 'メモ',
];
const C = Object.fromEntries(COLS.map((c, i) => [c, i]));

// フォームの質問（タイトルで見分ける）
const Q = {
  type: '種類',
  name: '作品名',
  author: '作者名',
  url: '配布URL',
  urlKind: 'URLの種類',
  more: '予備・旧の配布URL（あれば）',
  format: '形式',
  version: 'バージョン',
  intro: '紹介ページ（あれば）',
  tags: 'タグ（あれば）',
  desc: '紹介文（あれば）',
  who: '登録する人',
  agree: '確認',
  id: '作品ID',
  action: 'したいこと',
  key: '編集キー',
  reason: '理由（削除のとき・任意）',
};
const TYPE = { 'シナリオ': 'scenario', 'スキン（CardWirthPy）': 'skin', '素材（画像・音など）': 'material' };
const URL_KIND = { '配布ページ（ページを開いてDL）': 'page', 'zipなどのファイルへの直接リンク': 'direct', 'ファイル一覧（アップローダーなど。新しい版を自動で探す）': 'list' };
const FORMAT = { 'クラシック（1.50・Next・Pyで遊べる）': 'classic', 'Next仕様': 'next', 'Py仕様（WSN）': 'wsn', 'わからない': 'unknown' };
const WHO = { '作者本人': 'author', '作者さん以外（代理登録）': 'proxy' };
const ACTION = {
  edit: '内容を直す（編集キーが必要）',
  remove: '掲載をやめてほしい（すぐ非公開になります）',
  verify: 'サイト認証で本人確認する（代理登録の引き取り・編集キーをなくしたとき）',
  rekey: '編集キーをもう一度送ってほしい（登録したメール宛て）',
};

// ------------------------------------------------------------ 最初に1回だけ
function setup() {
  if (P.getProperty('SHEET_ID')) throw new Error('もう setup 済みです。やり直すときは、スクリプトのプロパティを消してから実行してください');
  const name = 'CWカタログ 共用カタログ';
  const ss = SpreadsheetApp.create(`${name}（登録の台帳）`);
  const sh = ss.getSheets()[0].setName(SHEET);
  sh.getRange(1, 1, 1, COLS.length).setValues([COLS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(2, C['状態'] + 1, 1000, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(STATES, true).build());
  ss.insertSheet(LOG_SHEET).getRange(1, 1, 1, 4).setValues([['日時', 'メール', '作品ID', 'できごと']]).setFontWeight('bold');

  const reg = buildRegisterForm(name);
  const man = buildManageForm(name);
  P.setProperties({
    SHEET_ID: ss.getId(),
    FORM_REGISTER_ID: reg.getId(),
    FORM_MANAGE_ID: man.getId(),
    SALT: Utilities.getUuid(),
    CATALOG_NAME: name,
    ADMIN_EMAIL: Session.getEffectiveUser().getEmail(),
    AUTO_PUBLISH: 'false',
    REGISTER_URL: reg.getPublishedUrl(),
    MANAGE_URL: man.getPublishedUrl(),
  });
  ScriptApp.newTrigger('onFormSubmit').forForm(reg).onFormSubmit().create();
  ScriptApp.newTrigger('onFormSubmit').forForm(man).onFormSubmit().create();
  Logger.log(`台帳：${ss.getUrl()}`);
  Logger.log(`登録フォーム：${reg.getPublishedUrl()}`);
  Logger.log(`変更・削除フォーム：${man.getPublishedUrl()}`);
  Logger.log('次に「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」で公開してください（README.md）');
}

function verifiedEmail(form) {
  form.setCollectEmail(true);
  try { form.setEmailCollectionType(FormApp.EmailCollectionType.VERIFIED); } catch (e) { /* 古い環境では、フォームの設定で「確認済み」を選んでください */ }
}

function workQuestions(form, required) {
  const req = (item) => item.setRequired(required);
  req(form.addMultipleChoiceItem().setTitle(Q.type).setChoiceValues(Object.keys(TYPE)));
  req(form.addTextItem().setTitle(Q.name));
  req(form.addTextItem().setTitle(Q.author).setHelpText('作者さんの名前（サークル名でも）。登録する人の名前ではありません'));
  req(form.addTextItem().setTitle(Q.url).setHelpText('https:// から始まるURL。BOOTH・作者さんのサイト・アップローダーなど')
    .setValidation(FormApp.createTextValidation().requireTextIsUrl().setHelpText('https:// から始まるURLを入れてください').build()));
  req(form.addMultipleChoiceItem().setTitle(Q.urlKind).setChoiceValues(Object.keys(URL_KIND)));
  form.addParagraphTextItem().setTitle(Q.more).setHelpText('1行に1つ。「名前 | URL」とも書けます（例：旧サイト | https://…）');
  const f = form.addMultipleChoiceItem().setTitle(Q.format).setChoiceValues(Object.keys(FORMAT));
  if (required) f.setRequired(false);
  form.addTextItem().setTitle(Q.version).setHelpText('例：1.02（わからなければ空でOK）');
  form.addParagraphTextItem().setTitle(Q.intro).setHelpText('作者さんのサイトや、X・Misskeyの告知の投稿など。1行に1つ');
  form.addTextItem().setTitle(Q.tags).setHelpText('「、」で区切る（例：短編、店シナ、1人用）');
  form.addParagraphTextItem().setTitle(Q.desc);
}

function buildRegisterForm(name) {
  const form = FormApp.create(`${name}：作品の登録`);
  form.setDescription([
    'CardWirth のシナリオ・スキン・素材を、CWカタログ（一括DL・インストールツール）の共用カタログに載せるためのフォームです。',
    '・載せるのは配布場所の情報だけです。作品ファイルは置かないので、再配布禁止の作品でも大丈夫です。',
    '・作者さん以外の方も登録できます（代理登録）。作者さんから「載せないで」と依頼があれば、すぐに外します。',
    '・送信すると、登録したメールアドレスに「作品ID」「編集キー」「回答を編集するリンク」が届きます。メールアドレスは公開しません。',
  ].join('\n'));
  verifiedEmail(form);
  form.setAllowResponseEdits(true);
  form.setConfirmationMessage('ありがとうございました。作品IDと編集キーをメールでお送りしました（届かないときは迷惑メールのフォルダも見てください）。');
  workQuestions(form, true);
  form.addMultipleChoiceItem().setTitle(Q.who).setChoiceValues(Object.keys(WHO)).setRequired(true);
  form.addCheckboxItem().setTitle(Q.agree).setRequired(true).setChoiceValues([
    '載せるのは配布場所の情報だけで、作者さんから依頼があれば外されることを理解しました',
  ]);
  return form;
}

function buildManageForm(name) {
  const form = FormApp.create(`${name}：登録の変更・削除`);
  form.setDescription([
    '共用カタログに載っている作品の内容を直したり、掲載をやめたりするフォームです。',
    '・内容を直す：作品IDと編集キーを入れて、直したい項目だけ書いてください（空の項目はそのまま）。',
    '・掲載をやめる：作品IDを入れて送ると、すぐに非公開になります。',
    '・サイト認証：1回目の送信で確認用の文字がメールで届きます。それを配布ページ（またはReadme）に書いてから、もう一度送ってください。',
  ].join('\n'));
  verifiedEmail(form);
  form.setConfirmationMessage('受け付けました。結果をメールでお送りします。');
  form.addTextItem().setTitle(Q.id).setRequired(true).setHelpText('例：e00012（登録したときのメールに書いてあります）');
  form.addMultipleChoiceItem().setTitle(Q.action).setChoiceValues(Object.values(ACTION)).setRequired(true);
  form.addTextItem().setTitle(Q.key).setHelpText('「内容を直す」のときに入れてください（登録したときのメールに書いてあります）');
  form.addPageBreakItem().setTitle('直したい項目（空の項目はそのまま）');
  workQuestions(form, false);
  form.addParagraphTextItem().setTitle(Q.reason);
  return form;
}

// ------------------------------------------------------------ 送信されたとき
function onFormSubmit(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const formId = e.source.getId();
    const r = e.response;
    const email = (r.getRespondentEmail() || '').trim().toLowerCase();
    const a = answers(r);
    if (formId === P.getProperty('FORM_REGISTER_ID')) onRegister(r, email, a);
    else if (formId === P.getProperty('FORM_MANAGE_ID')) onManage(email, a);
  } finally {
    lock.releaseLock();
  }
}

function answers(r) {
  const out = {};
  for (const ir of r.getItemResponses()) {
    const v = ir.getResponse();
    out[ir.getItem().getTitle()] = Array.isArray(v) ? v.join('、') : String(v || '').trim();
  }
  return out;
}

function onRegister(r, email, a) {
  const sh = sheet();
  const rows = sh.getDataRange().getValues();
  const now = new Date();
  const found = rows.findIndex((row, i) => i > 0 && row[C['回答ID']] === r.getId());
  if (found > 0) {
    // 届いたメールの「回答を編集」から直したとき：同じ行を書き直す
    const row = rows[found];
    if (row[C['登録者メール']] && row[C['登録者メール']] !== email) {
      // サイト認証で作者さんが引き取った登録は、前に登録した人の「回答を編集」では直せない
      mail(email, `【CWカタログ】${row[C['作品名']]}（${row[C['ID']]}）は直せませんでした`, 'この登録は、作者さんがサイト認証をして引き取ったため、こちらからは直せなくなりました。');
      log(email, row[C['ID']], '引き取り済みのため、回答の編集を受け付けなかった');
      return;
    }
    if (row[C['状態']] === '削除依頼') { log(email, row[C['ID']], '削除依頼中のため、回答の編集を受け付けなかった'); return; }
    fillWork(row, a, true);
    row[C['更新日時']] = now;
    sh.getRange(found + 1, 1, 1, COLS.length).setValues([row]);
    log(email, row[C['ID']], '回答の編集で内容を直した');
    mail(email, `【CWカタログ】${row[C['作品名']]}（${row[C['ID']]}）の内容を直しました`, `作品ID：${row[C['ID']]}\n内容を直しました。カタログには数分で反映されます。`);
    return;
  }
  const id = nextId(rows);
  const key = newKey();
  const row = new Array(COLS.length).fill('');
  row[C['ID']] = id;
  row[C['状態']] = P.getProperty('AUTO_PUBLISH') === 'true' ? '公開' : '承認待ち';
  fillWork(row, a, false);
  row[C['登録の立場']] = WHO[a[Q.who]] || 'proxy';
  row[C['登録者メール']] = email;
  row[C['編集キー（ハッシュ）']] = hash(key);
  row[C['回答ID']] = r.getId();
  row[C['登録日時']] = now;
  row[C['更新日時']] = now;
  const dup = rows.find((x, i) => i > 0 && norm(x[C['作品名']]) === norm(row[C['作品名']]) && norm(x[C['作者名']]) === norm(row[C['作者名']]));
  if (dup) row[C['メモ']] = `同じ作品名・作者名の登録があります：${dup[C['ID']]}`;
  sh.appendRow(row);
  log(email, id, `登録（${row[C['登録の立場']] === 'author' ? '作者本人' : '代理登録'}）`);
  const manage = P.getProperty('MANAGE_URL');
  mail(email, `【CWカタログ】「${row[C['作品名']]}」を受け付けました（${id}）`, [
    `「${row[C['作品名']]}」（${row[C['作者名']]}）の登録を受け付けました。`,
    row[C['状態']] === '公開' ? 'カタログには数分で反映されます。' : '管理人が確認してから、カタログに載ります。',
    '',
    `作品ID：${id}`,
    `編集キー：${key}`,
    '（編集キーは、このメールでしかお知らせしません。なくさないように保管してください）',
    '',
    `内容を直す（このGoogleアカウントで）：${r.getEditResponseUrl()}`,
    `内容を直す・掲載をやめる（編集キーで）：${manage}`,
    dup ? `\n※ 同じ作品名・作者名の登録（${dup[C['ID']]}）がすでにあります。管理人が確認します。` : '',
  ].join('\n'));
  notifyAdmin(`新しい登録：${id}「${row[C['作品名']]}」（${row[C['作者名']]}）${row[C['登録の立場']] === 'proxy' ? '・代理登録' : ''}`);
}

function onManage(email, a) {
  const sh = sheet();
  const rows = sh.getDataRange().getValues();
  const id = (a[Q.id] || '').trim().toLowerCase();
  const i = rows.findIndex((row, k) => k > 0 && String(row[C['ID']]).toLowerCase() === id);
  if (i < 1) { mail(email, '【CWカタログ】作品IDが見つかりませんでした', `作品ID「${a[Q.id]}」の登録が見つかりませんでした。登録したときのメールを確かめてください。`); return; }
  const row = rows[i];
  const save = () => sh.getRange(i + 1, 1, 1, COLS.length).setValues([row]);
  const title = `${row[C['作品名']]}（${row[C['ID']]}）`;
  const action = a[Q.action];

  if (action === ACTION.remove) {
    // 掲載をやめる：だれからの依頼でも、すぐに非公開（作者さんの意思を優先）。管理人に知らせる
    row[C['状態']] = '削除依頼';
    row[C['更新日時']] = new Date();
    row[C['メモ']] = `削除依頼（${email}）${a[Q.reason] ? `：${a[Q.reason]}` : ''}`;
    save();
    log(email, row[C['ID']], '削除依頼で非公開にした');
    mail(email, `【CWカタログ】${title} の掲載をやめました`, `${title} を共用カタログから外しました（数分で反映されます）。\nもう一度載せたいときは、管理人にご連絡ください。`);
    notifyAdmin(`削除依頼：${title}（${email}）${a[Q.reason] ? `\n理由：${a[Q.reason]}` : ''}`);
    return;
  }
  if (action === ACTION.edit) {
    const ok = (a[Q.key] && hash(a[Q.key].trim().toUpperCase()) === row[C['編集キー（ハッシュ）']]) || (email && email === row[C['登録者メール']]);
    if (!ok) { mail(email, `【CWカタログ】${title} を直せませんでした`, '編集キーが違います。登録したときのメールを確かめるか、「サイト認証」で本人確認をしてください。'); log(email, row[C['ID']], '編集キー違い'); return; }
    fillWork(row, a, true);
    row[C['更新日時']] = new Date();
    save();
    log(email, row[C['ID']], '編集キーで内容を直した');
    mail(email, `【CWカタログ】${title} の内容を直しました`, 'カタログには数分で反映されます。');
    return;
  }
  if (action === ACTION.rekey) {
    if (!email || email !== row[C['登録者メール']]) { mail(email, `【CWカタログ】${title}`, '登録したときのメールアドレスと違うため、編集キーを送れませんでした。「サイト認証」で本人確認をしてください。'); return; }
    const key = newKey();
    row[C['編集キー（ハッシュ）']] = hash(key);
    save();
    log(email, row[C['ID']], '編集キーを再発行');
    mail(email, `【CWカタログ】${title} の新しい編集キー`, `新しい編集キー：${key}\n前の編集キーは使えなくなりました。`);
    return;
  }
  if (action === ACTION.verify) {
    const now = new Date();
    const pending = row[C['認証トークン']] && row[C['認証メール']] === email && new Date(row[C['認証期限']]) > now;
    if (!pending) {
      const token = `cw-catalog-verify:${Utilities.getUuid().replace(/-/g, '').slice(0, 12)}`;
      row[C['認証トークン']] = token;
      row[C['認証メール']] = email;
      row[C['認証期限']] = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
      save();
      log(email, row[C['ID']], 'サイト認証を始めた');
      mail(email, `【CWカタログ】${title} のサイト認証`, [
        '次の文字を、登録されている配布ページ（または紹介ページ）のどこかに書いてください。',
        '',
        token,
        '',
        `配布ページ：${row[C['配布URL']]}`,
        '書いたら、変更・削除フォームでもう一度「サイト認証で本人確認する」を選んで送ってください（7日以内）。',
        '確認できたら、この文字は消してかまいません。',
      ].join('\n'));
      return;
    }
    const urls = [row[C['配布URL']], ...String(row[C['紹介ページ']] || '').split('\n').map((l) => l.split('|').pop().trim())].filter((u) => /^https?:\/\//.test(u));
    const hit = urls.some((u) => {
      try {
        const res = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true });
        return Utilities.newBlob(res.getContent()).getDataAsString('ISO-8859-1').indexOf(row[C['認証トークン']]) >= 0;
      } catch (err) { return false; }
    });
    if (!hit) { mail(email, `【CWカタログ】${title} のサイト認証`, `配布ページ・紹介ページに確認用の文字（${row[C['認証トークン']]}）が見つかりませんでした。書いてから、もう一度送ってください。`); log(email, row[C['ID']], 'サイト認証：見つからない'); return; }
    const key = newKey();
    row[C['登録者メール']] = email;
    row[C['登録の立場']] = 'author';
    row[C['編集キー（ハッシュ）']] = hash(key);
    row[C['認証トークン']] = '';
    row[C['認証メール']] = '';
    row[C['認証期限']] = '';
    row[C['更新日時']] = now;
    save();
    log(email, row[C['ID']], 'サイト認証できた（作者として引き取り）');
    mail(email, `【CWカタログ】${title} のサイト認証ができました`, `この作品は、あなたの登録になりました（作者さん確認済み）。\n\n新しい編集キー：${key}\n確認用の文字は、ページから消してかまいません。`);
    notifyAdmin(`サイト認証：${title}（${email}）`);
  }
}

/** フォームの答えを、行に書き込む（onlyFilled なら、空の項目はそのまま） */
function fillWork(row, a, onlyFilled) {
  const set = (col, v) => { if (!onlyFilled || (v !== undefined && v !== '')) row[C[col]] = v === undefined ? '' : v; };
  set('種類', a[Q.type] ? TYPE[a[Q.type]] || 'scenario' : onlyFilled ? undefined : 'scenario');
  set('作品名', a[Q.name]);
  set('作者名', a[Q.author]);
  set('配布URL', a[Q.url]);
  set('URLの種類', a[Q.urlKind] ? URL_KIND[a[Q.urlKind]] || 'page' : onlyFilled ? undefined : 'page');
  set('予備・旧の配布URL', a[Q.more]);
  set('形式', a[Q.format] ? FORMAT[a[Q.format]] || 'unknown' : onlyFilled ? undefined : 'unknown');
  set('バージョン', a[Q.version]);
  set('紹介ページ', a[Q.intro]);
  set('タグ', a[Q.tags]);
  set('紹介文', a[Q.desc]);
}

// ------------------------------------------------------------ CWカタログが読む JSON
function doGet(e) {
  const file = (e && e.parameter && e.parameter.file) || 'index';
  const index = buildIndex();
  const text = JSON.stringify(index);
  if (file === 'meta') {
    const sha = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8).map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
    return json({ format: 1, sha256: sha, count: index.entries.length, updated: index.updated });
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function buildIndex() {
  const rows = sheet().getDataRange().getValues().slice(1).filter((r) => r[C['ID']] && r[C['状態']] === '公開');
  const COMPAT = {
    classic: { cw150: 'expected', next: 'expected', py: 'expected' },
    next: { cw150: 'no', next: 'expected', py: 'unknown' },
    wsn: { cw150: 'no', next: 'no', py: 'expected' },
    unknown: { cw150: 'unknown', next: 'unknown', py: 'unknown' },
  };
  const day = (d) => (d instanceof Date ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : '');
  let latest = '';
  const entries = rows.map((r) => {
    const fmt = r[C['形式']] || 'unknown';
    const downloads = [{ label: '配布元', url: String(r[C['配布URL']]), kind: r[C['URLの種類']] || 'page', status: 'active' }];
    for (const line of String(r[C['予備・旧の配布URL']] || '').split('\n')) {
      const parts = line.split('|').map((s) => s.trim());
      const url = parts.pop();
      if (/^https?:\/\//.test(url || '')) downloads.push({ label: parts[0] || '予備', url, kind: 'page', status: 'mirror' });
    }
    const intro = String(r[C['紹介ページ']] || '').split('\n').map((line) => {
      const parts = line.split('|').map((s) => s.trim());
      const url = parts.pop();
      return /^https?:\/\//.test(url || '') ? { url, label: parts[0] || '' } : null;
    }).filter(Boolean).slice(0, 10);
    const updated = day(r[C['更新日時']]);
    if (updated > latest) latest = updated;
    return {
      id: String(r[C['ID']]),
      owner: norm(r[C['作者名']]),
      type: r[C['種類']] || 'scenario',
      name: String(r[C['作品名']]),
      author: String(r[C['作者名']]),
      version: String(r[C['バージョン']] || ''),
      updated,
      format: fmt === 'unknown' ? 'classic' : fmt,
      compat: COMPAT[fmt] || COMPAT.unknown,
      convert: 'self',
      downloads,
      file: { name: '', sha256: '' },
      readme: '',
      level: null,
      tags: String(r[C['タグ']] || '').split(/[、,，]/).map((t) => t.trim()).filter(Boolean).slice(0, 30),
      description: String(r[C['紹介文']] || ''),
      requires: [],
      related: [],
      links: [],
      intro,
      claim: r[C['登録の立場']] === 'author' ? 'author' : 'proxy',
    };
  });
  return {
    format: 1,
    kind: 'cw-catalog/shared',
    name: P.getProperty('CATALOG_NAME') || 'CWカタログ 共用カタログ',
    updated: latest,
    links: {
      register: P.getProperty('REGISTER_URL') || '',
      manage: P.getProperty('MANAGE_URL') || '',
    },
    authors: {},
    entries,
  };
}

// ------------------------------------------------------------ 道具
function sheet() { return SpreadsheetApp.openById(P.getProperty('SHEET_ID')).getSheetByName(SHEET); }
function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function norm(s) { return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s　・･_\-ー〜~!！?？「」『』()（）［］\[\]]/g, ''); }
function nextId(rows) {
  const max = rows.slice(1).reduce((m, r) => Math.max(m, parseInt(String(r[C['ID']]).replace(/\D/g, ''), 10) || 0), 0);
  return `e${String(max + 1).padStart(5, '0')}`;
}
function newKey() {
  // 紛らわしい文字（0/O・1/I）を除いた、4文字×3のキー
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Date.now());
  const chars = raw.slice(0, 12).map((b) => abc[(b + 256) % abc.length]).join('');
  return `CW-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
function hash(key) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${P.getProperty('SALT')}:${String(key).trim().toUpperCase()}`, Utilities.Charset.UTF_8);
  return d.map((b) => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}
function mail(to, subject, body) {
  if (!to) return;
  MailApp.sendEmail({ to, subject, body: `${body}\n\n――\nCWカタログ 共用カタログ（このメールは自動で送っています）`, name: 'CWカタログ' });
}
function notifyAdmin(text) {
  const to = P.getProperty('ADMIN_EMAIL');
  if (to) MailApp.sendEmail({ to, subject: `【CWカタログ 管理】${text.split('\n')[0].slice(0, 60)}`, body: text, name: 'CWカタログ' });
}
function log(email, id, what) {
  SpreadsheetApp.openById(P.getProperty('SHEET_ID')).getSheetByName(LOG_SHEET).appendRow([new Date(), email, id, what]);
}
