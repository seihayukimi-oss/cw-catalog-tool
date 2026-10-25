// 複数のカタログ（共用・個人用）をまとめて扱う。
//  ・共用カタログ：作者さんが登録フォームから登録した、サイト側のカタログ（URLで読む・書き換えない）
//  ・個人用カタログ：自分で作る（own）／有志の方のDL一覧を読み込む（sub）。いくつでも持てる
// 同じ作品が複数のカタログに載っていたら「作品」として1つにまとめ、配布元を合わせる。

import { normalizeName, compareVersions } from './catalog.js';

export const KIND_ORDER = { shared: 0, own: 1, sub: 2 };
export const KIND_LABEL = { shared: '共用', own: '個人用', sub: '個人用（読み込み）' };

/** 作品を見分ける鍵（名前＋作者。全角半角・空白・記号の違いは無視） */
export function workKey(e) {
  return `${normalizeName(e.name)}|${normalizeName(e.author)}`;
}

/**
 * カタログを作品ごとにまとめる。
 * @param {{id: string, kind: 'shared'|'own'|'sub', name: string, catalog: {entries: object[], authors: object}, hidden?: Set<string>|string[]}[]} sources
 */
export function combine(sources) {
  const ordered = [...sources].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const byKey = new Map();
  const authors = {};
  for (const src of ordered) {
    const hidden = src.hidden instanceof Set ? src.hidden : new Set(src.hidden || []);
    for (const [k, a] of Object.entries(src.catalog.authors || {})) if (!authors[k]) authors[k] = a;
    for (const e of src.catalog.entries) {
      const key = workKey(e);
      let w = byKey.get(key);
      if (!w) {
        w = {
          key, name: e.name, author: e.author, version: e.version, updated: e.updated, type: e.type,
          format: e.format, wsn_version: e.wsn_version, compat: e.compat, convert: e.convert,
          description: e.description, level: e.level, owner: e.owner, readme: e.readme,
          tags: [], intro: [], links: [], downloads: [], shas: new Set(), refs: [], hiddenIn: new Set(),
        };
        byKey.set(key, w);
      }
      w.refs.push({ sourceId: src.id, sourceName: src.name, kind: src.kind, entry: e, attribution: src.catalog.attribution || null });
      if (hidden.has(key)) w.hiddenIn.add(src.id);
      if (compareVersions(e.version, w.version) > 0) { w.version = e.version; w.updated = e.updated || w.updated; }
      if (!w.description && e.description) w.description = e.description;
      if (e.file?.sha256) w.shas.add(e.file.sha256);
      for (const t of e.tags || []) if (!w.tags.includes(t)) w.tags.push(t);
      for (const i of e.intro || []) if (!w.intro.some((x) => x.url === i.url)) w.intro.push(i);
      for (const l of e.links || []) if (!w.links.includes(l)) w.links.push(l);
      for (const d of e.downloads || []) {
        if (!w.downloads.some((x) => x.url === d.url)) w.downloads.push({ ...d, sourceId: src.id });
      }
    }
  }
  const works = [...byKey.values()];
  for (const w of works) {
    // すべての掲載元で外されていれば、一覧から外す
    w.hidden = w.refs.every((r) => w.hiddenIn.has(r.sourceId));
    // どの掲載元でも一時保留中なら、一時保留中（個人用カタログに自分で載せていれば、そちらが優先）
    w.held = w.refs.every((r) => r.entry.state === 'held');
    w.heldReason = w.held ? w.refs.map((r) => r.entry.held_reason).find(Boolean) || '' : '';
    w.derivative = w.refs.map((r) => r.entry.derivative).find(Boolean) || null;
    w.site = w.refs.map((r) => r.entry.site).find(Boolean) || '';
    w.checked = w.refs.map((r) => r.entry.checked).find(Boolean) || '';
    // 出典：作品に書かれた元のカタログ、なければ掲載元のカタログの出典
    w.origins = [];
    for (const r of w.refs) {
      const o = r.entry.origin || r.attribution;
      if (o && !w.origins.some((x) => x.name === o.name)) w.origins.push(o);
    }
  }
  return { works, byKey, authors };
}

/**
 * 手元の作品がどの「作品」かを探す。ハッシュ一致なら版まで確定。
 * @returns {{work, by: 'sha256'|'name'}|null}
 */
export function matchWork(combined, { name, author, sha256 }) {
  if (!combined) return null;
  if (sha256) {
    const w = combined.works.find((x) => x.shas.has(sha256));
    if (w) return { work: w, by: 'sha256' };
  }
  const n = normalizeName(name), a = normalizeName(author);
  if (!n) return null;
  const exact = combined.byKey.get(`${n}|${a}`);
  if (exact) return { work: exact, by: 'name' };
  const cands = combined.works.filter((x) => normalizeName(x.name) === n);
  return cands.length === 1 && !a ? { work: cands[0], by: 'name' } : null;
}

/**
 * DLに使う配布元を、使う順に並べる。
 * デフォルトのDL先（利用者が選んだもの）→ 現役 → 予備 → 旧（移転済み。まだ見られるかもしれない）。
 * 終了したものは使わない。
 */
export function chooseDownloads(work, defaultUrl = '') {
  const list = work.downloads.filter((d) => d.status !== 'closed');
  const rank = { active: 0, mirror: 1, old: 2 };
  const sorted = [...list].sort((a, b) => rank[a.status] - rank[b.status]);
  const def = defaultUrl && list.find((d) => d.url === defaultUrl);
  return def ? [def, ...sorted.filter((d) => d !== def)] : sorted;
}

/** 新旧 × 通常予備 → 状態 */
export function statusOf(age, role) {
  if (age === 'closed') return 'closed';
  if (age === 'old') return 'old';
  return role === 'mirror' ? 'mirror' : 'active';
}
/** 状態 → 新旧・通常予備 */
export function ageRoleOf(status) {
  return {
    active: { age: 'new', role: 'normal' },
    mirror: { age: 'new', role: 'mirror' },
    old: { age: 'old', role: 'normal' },
    closed: { age: 'closed', role: 'normal' },
  }[status] || { age: 'new', role: 'normal' };
}

/** 紹介ページのURLから、種類を見分ける（表示用） */
export function introKind(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { return 'site'; }
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  if (/misskey|^mi\.|\.mi$/i.test(host)) return 'misskey';
  if (/(^|\.)booth\.pm$/.test(host)) return 'booth';
  if (/(^|\.)pixiv\.net$/.test(host)) return 'pixiv';
  return 'site';
}
export const INTRO_LABEL = { x: 'X', misskey: 'Misskey', booth: 'BOOTH', pixiv: 'pixiv', site: 'サイト' };

/** 個人用カタログの次の作品ID（p00001 から） */
export function nextPersonalId(entries) {
  const max = entries.reduce((m, e) => Math.max(m, parseInt((e.id.match(/^p(\d+)$/) || [, 0])[1], 10)), 0);
  return `p${String(max + 1).padStart(5, '0')}`;
}

/** 個人用カタログを、人に渡せるDL一覧（index.json と同じ形式）にする */
export function exportPersonal(name, entries, { hidden = [], tool = '' } = {}) {
  const hid = new Set(hidden);
  return {
    format: 1,
    kind: 'cw-catalog/personal',
    name,
    exported: new Date().toISOString(),
    tool,
    authors: {},
    entries: entries.filter((e) => !hid.has(workKey(e))),
  };
}

/**
 * meta.json に書かれた、本体の写しのURL（https で、決まった配り先だけ）。
 * 共用カタログは GitHub に置き、jsDelivr（版＝コミットを固定したURL）からも配る
 */
export function mirrorsOf(meta) {
  if (!meta || !/^[0-9a-f]{64}$/.test(meta.sha256 || '')) return [];
  const list = Array.isArray(meta.mirrors) ? meta.mirrors : [];
  return list.filter((u) => typeof u === 'string' && /^https:\/\/(cdn\.jsdelivr\.net\/gh\/|fastly\.jsdelivr\.net\/gh\/|[a-z0-9-]+\.github\.io\/|raw\.githubusercontent\.com\/)/i.test(u)).slice(0, 3);
}

