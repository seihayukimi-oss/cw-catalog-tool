// 配布元のURLの見分け方：
//  ・期限付きのURL（Notionの添付・Discordの添付・署名付きのS3など）→ しばらくすると使えなくなる
//  ・Googleドライブ・OneDrive の共有リンク → 直接DLのURLに直して取る
//  ・ログインやページの操作が要るサイト（BOOTH・Privatter+・Notion・note）→ アプリ内ブラウザで本人が押す

const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const is = (h, d) => h === d || h.endsWith(`.${d}`);

/** Googleドライブのファイル・フォルダのID */
export function driveId(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (!(h === 'drive.google.com' || h === 'docs.google.com' || h === 'drive.usercontent.google.com')) return null;
  const file = u.pathname.match(/\/file\/d\/([\w-]{10,})/);
  if (file) return { kind: 'file', id: file[1] };
  const folder = u.pathname.match(/\/folders\/([\w-]{10,})/);
  if (folder) return { kind: 'folder', id: folder[1] };
  const q = u.searchParams.get('id');
  if (q && /^[\w-]{10,}$/.test(q)) {
    if (/embeddedfolderview/.test(u.pathname)) return { kind: 'folder', id: q };
    if (/^\/(open|uc|download)/.test(u.pathname)) return { kind: 'file', id: q };
  }
  return null;
}

const b64url = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** OneDriveのリンクの種類。share＝共有リンク（ログイン不要）／private＝本人が見ているときのアドレス（他の人は開けない） */
export function oneDriveKind(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  if (h === '1drv.ms') return 'share';
  if (h !== 'onedrive.live.com') return null;
  if (u.searchParams.get('redeem') || u.searchParams.get('authkey') || /\/redir|\/embed|\/download/.test(u.pathname)) return 'share';
  if (u.searchParams.get('id') || u.searchParams.get('cid')) return 'private';
  return null;
}

/** 期限付きのURLなら、使えなくなる日時（Date）。分からなければ true、期限付きでなければ null */
export function expiresAt(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.toLowerCase();
  const p = u.searchParams;
  // Notion の添付ファイル
  if ((h === 'file.notion.so' || is(h, 'notion-static.com') || h.endsWith('.amazonaws.com')) && p.get('expirationTimestamp')) {
    const t = Number(p.get('expirationTimestamp'));
    return Number.isFinite(t) ? new Date(t) : true;
  }
  // Discord の添付ファイル（ex＝期限の16進数）
  if ((h === 'cdn.discordapp.com' || h === 'media.discordapp.net') && /\/attachments\//.test(u.pathname)) {
    const ex = p.get('ex');
    return ex && /^[0-9a-f]+$/i.test(ex) ? new Date(parseInt(ex, 16) * 1000) : true;
  }
  // 署名付きURL（S3・Google Cloud Storage など）
  if (p.get('X-Amz-Signature') || p.get('X-Goog-Signature')) {
    const date = p.get('X-Amz-Date') || p.get('X-Goog-Date');
    const sec = Number(p.get('X-Amz-Expires') || p.get('X-Goog-Expires'));
    if (date && Number.isFinite(sec)) {
      const m = date.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + sec * 1000);
    }
    return true;
  }
  if (p.get('Expires') && p.get('Signature')) {
    const t = Number(p.get('Expires'));
    return Number.isFinite(t) ? new Date(t * 1000) : true;
  }
  return null;
}

/** アプリ内ブラウザで本人が押す必要があるサイト（ログイン・JavaScriptで作るページ） */
export function inAppSite(url) {
  const h = host(url);
  if (is(h, 'booth.pm')) return { site: 'BOOTH', why: 'BOOTHは、無料の作品でもpixivへのログインが必要です' };
  if (is(h, 'privatter.me') || is(h, 'privatter.net')) return { site: 'Privatter+', why: 'Privatter+は、ログインした人だけが見られるページがあります' };
  if (is(h, 'notion.site') || h === 'www.notion.so' || h === 'notion.so') return { site: 'Notion', why: 'Notionのページは、開いたときにファイルのURLが作られます' };
  if (h === 'note.com' && /\/n\/n[0-9a-z]+/i.test(url)) return { site: 'note', why: 'noteの添付ファイルは、記事を開いて押したときに渡されます' };
  if (is(h, 'fanbox.cc') || is(h, 'fantia.jp') || is(h, 'ci-en.net') || is(h, 'patreon.com')) return { site: h, why: 'ログインが必要なサイトです' };
  return null;
}

/**
 * 取りに行くときに使うURL（共有リンクを直接DLのURLに直す）
 * @returns {{url: string, note?: string}}
 */
export function fetchUrlFor(url) {
  const d = driveId(url);
  // confirm=t：大きいファイルで出る「ウイルススキャンできません」の確認を飛ばす（Googleドライブの仕様）
  if (d?.kind === 'file') return { url: `https://drive.usercontent.google.com/download?id=${d.id}&export=download&confirm=t`, note: 'Googleドライブ' };
  if (d?.kind === 'folder') return { url: `https://drive.google.com/embeddedfolderview?id=${d.id}`, note: 'Googleドライブのフォルダ' };
  if (oneDriveKind(url) === 'share') return { url: `https://api.onedrive.com/v1.0/shares/u!${b64url(url)}/root/content`, note: 'OneDrive' };
  return { url };
}

/**
 * 個人用カタログにDL先を登録するときの注意
 * @returns {{level: 'warn'|'info', text: string}|null}
 */
export function urlAdvice(url, now = new Date()) {
  if (!/^https?:\/\//.test(url || '')) return null;
  const ex = expiresAt(url);
  if (ex) {
    const when = ex instanceof Date ? ex : null;
    const past = when && when < now;
    const fmt = when ? when.toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
    return {
      level: 'warn',
      text: `期限付きのURLです${when ? `（${fmt} ${past ? 'に、もう使えなくなっています' : 'に使えなくなります'}）` : ''}。ファイルのURLではなく、そのファイルが置いてあるページのURLを「配布ページ」で登録してください。`,
    };
  }
  if (oneDriveKind(url) === 'private') return { level: 'warn', text: 'これは、OneDriveを持っている本人が見ているときのアドレスで、他の人は開けません。OneDriveの「共有」→「リンクのコピー」で出るリンクを登録してください。' };
  if (oneDriveKind(url) === 'share') return { level: 'info', text: 'OneDriveの共有リンクです。取れないときは、アプリ内ブラウザで開いて「ダウンロード」を押す形になります。' };
  const d = driveId(url);
  if (d?.kind === 'file') return { level: 'info', text: 'Googleドライブのファイルです。直接DLのURLに直して取ります（「直接DL」にしておくと、サイトを開かずに取れます）。' };
  if (d?.kind === 'folder') return { level: 'info', text: 'Googleドライブのフォルダです。DLのときは、中のファイルを一覧にして選びます。' };
  const ia = inAppSite(url);
  if (ia) return { level: 'info', text: `${ia.why}。DLのときは、アプリ内ブラウザで開いて本人が押す形になります（HTML版ではページを開くだけになります）。` };
  return null;
}

/**
 * ブラウザでDLしたファイルの「DL元の記録」から、登録に使うDL先を作る
 * @param {{hostUrl?: string, referrerUrl?: string}} zone
 */
export function downloadsFromZone(zone) {
  const out = [];
  const hostUrl = zone?.hostUrl && /^https?:\/\//.test(zone.hostUrl) ? zone.hostUrl : '';
  const ref = zone?.referrerUrl && /^https?:\/\//.test(zone.referrerUrl) ? zone.referrerUrl : '';
  const stableFile = hostUrl && !expiresAt(hostUrl) && !/\/(api|downloadx?|g)\//i.test(new URL(hostUrl).pathname) && /\.(zip|wsn|cab|lzh|lha|7z)(\?|$)/i.test(hostUrl);
  if (ref && !/^https?:\/\/(www\.)?(google\.[a-z.]+|bing\.com|search\.yahoo\.co\.jp)\//.test(ref)) out.push({ url: ref, kind: 'page' });
  if (stableFile) out.push({ url: hostUrl, kind: 'direct' });
  if (!out.length && hostUrl && !expiresAt(hostUrl)) out.push({ url: hostUrl, kind: 'page' });
  // 直接DLできる安定したURLがあれば、それを先（デフォルト）に
  return out.sort((a, b) => (b.kind === 'direct') - (a.kind === 'direct'));
}
