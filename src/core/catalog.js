// カタログ（住所録）の読み込み・照合・更新判定と、エンジンとの相性判定。
// カタログはネットから来るデータなので、使う前に必ず形をそろえて検査する。

export const CATALOG_FORMAT = 1;

export const ENGINE_KINDS = {
  cw150: { name: 'CardWirth 1.50', short: '1.50' },
  next: { name: 'CardWirthNext 1.60', short: 'Next' },
  py: { name: 'CardWirthPy', short: 'Py' },
  wcw: { name: 'WebCardWirth（書き出し）', short: 'Web' },
};

const COMPAT = new Set(['verified', 'expected', 'no', 'unknown']);
const STATUS = new Set(['active', 'mirror', 'old', 'closed']);
const isHttp = (u) => typeof u === 'string' && /^https?:\/\/[^\s]+$/.test(u);
const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** カタログ1件を、決まった形だけ残して整える。おかしければ null */
export function sanitizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  // e… は共用カタログ（登録フォーム）、p… は個人用カタログ（このツールで作ったもの）
  if (typeof e.id !== 'string' || !/^[ep]\d{5,}$/.test(e.id)) return null;
  const downloads = (Array.isArray(e.downloads) ? e.downloads : [])
    .filter((d) => d && isHttp(d.url))
    .map((d) => ({
      label: str(d.label, 100),
      url: d.url,
      // list＝ファイル一覧のページ（アップローダーなど）。新しい版のファイルを、一覧から探す
      kind: d.kind === 'direct' ? 'direct' : d.kind === 'list' ? 'list' : 'page',
      ...(d.kind === 'list' && typeof d.match === 'string' && d.match.trim() ? { match: d.match.trim().slice(0, 100) } : {}),
      status: STATUS.has(d.status) ? d.status : 'active',
      until: /^\d{4}-\d{2}-\d{2}$/.test(d.until || '') ? d.until : '',
      note: str(d.note, 300),
      // DLキー（個人用カタログだけで使う。共用カタログの登録フォームには無い）
      ...(typeof d.dlkey === 'string' && d.dlkey ? { dlkey: d.dlkey.slice(0, 100) } : {}),
    }));
  const compat = {};
  for (const k of ['cw150', 'next', 'py']) compat[k] = COMPAT.has(e.compat?.[k]) ? e.compat[k] : 'unknown';
  return {
    id: e.id,
    owner: str(e.owner, 100),
    type: str(e.type, 20) || 'scenario',
    name: str(e.name, 200),
    author: str(e.author, 200),
    version: str(e.version, 50),
    updated: /^\d{4}-\d{2}-\d{2}$/.test(e.updated || '') ? e.updated : '',
    format: ['classic', 'next', 'wsn', 'none'].includes(e.format) ? e.format : 'classic',
    wsn_version: Number.isInteger(e.wsn_version) ? e.wsn_version : null,
    compat,
    convert: ['allowed', 'self', 'forbidden'].includes(e.convert) ? e.convert : 'self',
    downloads,
    file: {
      name: str(e.file?.name, 300),
      sha256: /^[0-9a-f]{64}$/.test(e.file?.sha256 || '') ? e.file.sha256 : '',
    },
    readme: str(e.readme, 300),
    level: e.level && Number.isInteger(e.level.min) ? { min: e.level.min, max: e.level.max } : null,
    tags: (Array.isArray(e.tags) ? e.tags : []).filter((t) => typeof t === 'string').slice(0, 30),
    // 登録した人（author＝作者さん本人・proxy＝作者さん以外の代理登録）。共用カタログの登録フォームが付ける
    claim: e.claim === 'author' || e.claim === 'proxy' ? e.claim : '',
    // ラベル（作者さんごと・企画ごとなどの分け方）。受け取った人が、取り込むかどうかと範囲を選ぶ
    labels: (Array.isArray(e.labels) ? e.labels : []).filter((t) => typeof t === 'string').map((t) => t.trim().slice(0, 60)).filter(Boolean).slice(0, 20),
    description: str(e.description, 5000),
    requires: (Array.isArray(e.requires) ? e.requires : []).filter((x) => /^[ep]\d{5,}$/.test(x)),
    related: (Array.isArray(e.related) ? e.related : []).filter((x) => /^[ep]\d{5,}$/.test(x)),
    links: (Array.isArray(e.links) ? e.links : []).filter(isHttp),
    // 紹介ページ（作者さんのサイト・X・Misskeyなど）。DLの前に、どんな作品かを見てもらうため
    intro: (Array.isArray(e.intro) ? e.intro : [])
      .map((i) => (typeof i === 'string' ? { url: i, label: '' } : i))
      .filter((i) => i && isHttp(i.url))
      .slice(0, 10)
      .map((i) => ({ url: i.url, label: str(i.label, 100) })),
  };
}

/** index.json を読み込んで整える */
export function parseCatalog(json) {
  if (!json || typeof json !== 'object') throw new Error('カタログの形式が正しくありません');
  if (json.format !== CATALOG_FORMAT) throw new Error(`このツールが知らないカタログ形式です（format: ${json.format}）`);
  const entries = (Array.isArray(json.entries) ? json.entries : []).map(sanitizeEntry).filter(Boolean);
  const authors = {};
  for (const [k, a] of Object.entries(json.authors || {})) {
    if (!a || typeof a !== 'object') continue;
    authors[k] = {
      owner: str(a.owner, 100) || k,
      names: (Array.isArray(a.names) ? a.names : []).filter((n) => typeof n === 'string'),
      readme_url: isHttp(a.readme_url) ? a.readme_url : '',
      site: isHttp(a.site) ? a.site : '',
    };
  }
  // 共用カタログの登録・変更のフォーム（あれば）
  const links = {};
  for (const k of ['register', 'manage']) if (isHttp(json.links?.[k])) links[k] = json.links[k];
  return { format: CATALOG_FORMAT, entries, authors, links, byId: new Map(entries.map((e) => [e.id, e])) };
}

/** 比較用に名前をそろえる（全角半角・空白・記号の違いを無視） */
export function normalizeName(s) {
  return (s || '').normalize('NFKC').toLowerCase().replace(/[\s　・･_\-ー〜~!！?？「」『』()（）［］\[\]]/g, '');
}

/**
 * 手元の作品がカタログのどれかを探す。
 * ハッシュが一致すれば確実（版まで確定）。無ければ名前＋作者で探す。
 * @returns {{entry, by: 'sha256'|'name'} | null}
 */
export function matchEntry(catalog, { name, author, sha256 }) {
  if (!catalog) return null;
  if (sha256) {
    const e = catalog.entries.find((x) => x.file.sha256 && x.file.sha256 === sha256);
    if (e) return { entry: e, by: 'sha256' };
  }
  const n = normalizeName(name), a = normalizeName(author);
  if (!n) return null;
  const cands = catalog.entries.filter((x) => normalizeName(x.name) === n);
  const e = cands.find((x) => !a || normalizeName(x.author) === a) || (cands.length === 1 && !a ? cands[0] : null);
  return e ? { entry: e, by: 'name' } : null;
}

/** バージョンの比較。数字のかたまりごとに比べる（1.10 > 1.09 > 1.9 ではなく 1.10 > 1.9） */
export function compareVersions(a, b) {
  const pa = String(a || '').normalize('NFKC').match(/\d+/g) || [];
  const pb = String(b || '').normalize('NFKC').match(/\d+/g) || [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '0', 10), y = parseInt(pb[i] ?? '0', 10);
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * 更新があるか。
 * @returns {'latest'|'update'|'unknown'|'none'}
 *   none=カタログに無い / unknown=手元の版が分からない
 */
export function updateState(record, entry) {
  if (!entry) return 'none';
  if (!record.version) return 'unknown';
  return compareVersions(record.version, entry.version) < 0 ? 'update' : 'latest';
}

/** DLに使う配布元を、使う順に並べる（現役→予備。旧・終了は使わない） */
export function usableDownloads(entry) {
  return [
    ...entry.downloads.filter((d) => d.status === 'active'),
    ...entry.downloads.filter((d) => d.status === 'mirror'),
  ];
}

/**
 * その形式の作品を、そのエンジンで遊べるか（ファイルの中身から判定した結果用）。
 * @returns {{ok: boolean, level: 'ok'|'caution'|'convert'|'no', reason: string}}
 */
export function playability({ format, wsnVersion }, engineKind, engineInfo = {}) {
  if (format === 'classic') {
    if (engineKind === 'wcw') return { ok: true, level: 'caution', reason: 'WebCardWirthは完全対応ではないため、動かない場合があります' };
    return { ok: true, level: 'ok', reason: '' };
  }
  if (format === 'next') {
    if (engineKind === 'next') return { ok: true, level: 'ok', reason: '' };
    if (engineKind === 'py') return { ok: false, level: 'convert', reason: 'Next仕様（データ版7）はPyでは直接読めません。変換が必要です' };
    return { ok: false, level: 'no', reason: 'Next仕様の作品は、CardWirthNextでしか遊べません' };
  }
  if (format === 'wsn') {
    if (engineKind === 'py') {
      if (engineInfo.maxWsn != null && wsnVersion != null && wsnVersion > engineInfo.maxWsn) {
        return { ok: false, level: 'no', reason: `Wsn.${wsnVersion} の作品です。このPyはWsn.${engineInfo.maxWsn}までの対応です` };
      }
      return { ok: true, level: 'ok', reason: '' };
    }
    if (engineKind === 'wcw') return { ok: true, level: 'caution', reason: 'WebCardWirthはPy 5.2相当のため、新しいWSNは動かない場合があります' };
    return { ok: false, level: 'no', reason: 'Py仕様（WSN）の作品は、CardWirthPyでしか遊べません' };
  }
  return { ok: false, level: 'no', reason: 'シナリオではないようです' };
}

/** カタログの作者申告（compat）での判定。カタログに載っている作品用 */
export function catalogCompat(entry, engineKind) {
  const k = engineKind === 'wcw' ? null : engineKind;
  return k ? entry.compat[k] : 'unknown';
}
