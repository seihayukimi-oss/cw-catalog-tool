// アプリ版（Tauri・ポータブル版）の入れ物。
// ファイル操作・ネット接続・起動は、Tauri公式のプラグインを使う。
// どのフォルダに触れるかは、ユーザーがダイアログで選んだフォルダだけに限られる
// （選んだ場所はTauriの許可範囲に追加され、exe の横の CWCatalog-data に記憶される）。

import { readDir, readFile, writeFile, mkdir, remove, stat, exists } from '@tauri-apps/plugin-fs';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import { decodeHtml, fileNameFrom } from '../core/weblink.js';
import { compareVersions } from '../core/catalog.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// ポータブル版の更新情報（リリースのときに作る）
const UPDATE_INFO_URL = 'https://github.com/seihayukimi-oss/cw-catalog-tool/releases/latest/download/latest-portable.json';
export const ARCHIVE_EXTS = ['zip', 'wsn', 'cab', 'lzh', 'lha', '7z'];
const join = (a, b) => `${a.replace(/[\\/]+$/, '')}\\${b}`;
const baseName = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();

class TauriDir {
  constructor(path) {
    this.path = path;
    this.name = baseName(path);
  }
  async entries() {
    return (await readDir(this.path)).map((e) => ({ name: e.name, kind: e.isDirectory ? 'dir' : 'file' }));
  }
  async dir(name, { create = false } = {}) {
    const p = join(this.path, name);
    if (await exists(p)) {
      const s = await stat(p);
      return s.isDirectory ? new TauriDir(p) : null;
    }
    if (!create) return null;
    await mkdir(p, { recursive: true });
    return new TauriDir(p);
  }
  async readFile(name) {
    return readFile(join(this.path, name));
  }
  async fileSize(name) {
    return (await stat(join(this.path, name))).size;
  }
  async writeFile(name, data) {
    await writeFile(join(this.path, name), data);
  }
  async remove(name) {
    await remove(join(this.path, name), { recursive: true });
  }
  async has(name) {
    const hit = (await readDir(this.path)).find((e) => e.name.toLowerCase() === name.toLowerCase());
    return hit ? (hit.isDirectory ? 'dir' : 'file') : null;
  }
}

const UA = 'CWCatalogTool (+https://github.com/)';

// 一連の通信の間だけ使うCookie（ホスト名ごと）
const jar = new Map();
function keepCookies(host, headers) {
  const raw = headers.get('set-cookie');
  if (!raw) return;
  const m = jar.get(host) || new Map();
  for (const part of raw.split(/,(?=\s*[^;,=\s]+=)/)) {
    const kv = part.split(';')[0].trim();
    const i = kv.indexOf('=');
    if (i > 0) m.set(kv.slice(0, i), kv.slice(i + 1));
  }
  jar.set(host, m);
}
function cookieHeader(host) {
  const m = jar.get(host);
  return m ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : '';
}

export const platform = {
  kind: 'app',
  label: 'アプリ版',
  canWriteFolders: true,
  canFetchAnywhere: true,
  canCheckPages: true,
  canUpdateSelf: true,
  canInAppBrowse: true,
  canPickDownloads: true,
  canRegisterWindows: true,
  isPortable: true,

  async pickFolder({ title = 'CardWirthのフォルダ（CardWirth.exe がある場所）を選んでください' } = {}) {
    const path = await openDialog({ directory: true, recursive: true, multiple: false, title });
    if (!path) throw Object.assign(new Error('キャンセルされました'), { name: 'AbortError' });
    return { dir: new TauriDir(path), ref: path, label: path };
  },

  /** zip・wsn などを選んでもらう（DL元のURLも一緒に読む）。複数選べる */
  async pickArchiveFiles() {
    const picked = await openDialog({ multiple: true, title: '入れたいシナリオのファイルを選んでください', filters: [{ name: 'シナリオ（zip・wsn・cab・lzh・7z）', extensions: ARCHIVE_EXTS }] });
    if (!picked || (Array.isArray(picked) && !picked.length)) throw Object.assign(new Error('キャンセルされました'), { name: 'AbortError' });
    const paths = Array.isArray(picked) ? picked : [picked];
    return Promise.all(paths.map((p) => this.readPath(p)));
  },

  /** 渡されたファイル（ダブルクリック・右クリックの「CWカタログで開く」など）を読む */
  async readPath(path) {
    const [bytes, zone] = await Promise.all([readFile(path), invoke('zone_info', { path }).catch(() => ({}))]);
    return { name: baseName(path), bytes, path, zone };
  },

  /** 「ダウンロード」フォルダの zip・wsn などの一覧（新しい順・DL元のURLつき） */
  async downloadsList() {
    return invoke('downloads_list');
  },
  async downloadsRead(name) {
    return new Uint8Array(await invoke('downloads_read', { name }));
  },

  /** 起動したときに渡されたファイル・リンクと、そのあと渡されたもの */
  async takeOpenArgs() {
    return invoke('take_open_args').catch(() => []);
  },
  onOpenArgs(cb) {
    listen('cw-open-args', (ev) => cb(ev.payload || []));
  },

  async portableInfo() {
    return invoke('portable_info');
  },

  async assocStatus() { return invoke('assoc_status'); },
  async assocRegister() { return invoke('assoc_register'); },
  async assocUnregister() { return invoke('assoc_unregister'); },

  async toggleFullscreen() {
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
  },

  async pickSourceFolder() {
    const path = await openDialog({ directory: true, recursive: true, multiple: false, title: '入れたいシナリオのフォルダを選んでください' });
    if (!path) throw Object.assign(new Error('キャンセルされました'), { name: 'AbortError' });
    return new TauriDir(path);
  },

  async openFolder(ref) {
    if (!ref || !(await exists(ref))) return null;
    return new TauriDir(ref);
  },

  async fetchJson(url) {
    const r = await httpFetch(url, { headers: { 'User-Agent': UA }, cache: 'no-cache' });
    if (!r.ok) throw new Error(`読み込めませんでした（${r.status}）`);
    return r.json();
  },

  async fetchFile(url) {
    const r = await httpFetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`ダウンロードできませんでした（${r.status}）`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 2 * 1024 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
    return new Uint8Array(await r.arrayBuffer());
  },

  /**
   * URLの中身を取る。同意ページの送信（POST）にも使う。
   * 同意ページはCookieで「同意した人」を見分けることがあるので、同じサイトへの一連の通信では
   * 受け取ったCookieを送り返す（このアプリの中だけで、保存はしない）。
   */
  async fetchResource(url, { method = 'GET', body, headers = {} } = {}) {
    const host = new URL(url).hostname;
    const cookie = cookieHeader(host);
    const r = await httpFetch(url, {
      method,
      body,
      headers: { 'User-Agent': UA, ...(cookie ? { Cookie: cookie } : {}), ...headers },
    });
    keepCookies(host, r.headers);
    if (!r.ok) throw new Error(`読み込めませんでした（${r.status}）`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 2 * 1024 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
    return {
      bytes: new Uint8Array(await r.arrayBuffer()),
      contentType: r.headers.get('content-type') || '',
      fileName: fileNameFrom(r.url || url, r.headers.get('content-disposition') || ''),
      finalUrl: r.url || url,
    };
  },

  /**
   * アプリ内ブラウザで配布ページを開く。本人がサイトのダウンロードボタンを押すと、
   * 落ちてきたファイルを受け取って返す。押さずに窓を閉じたら null。
   */
  openInAppBrowser(url) {
    return new Promise((resolve, reject) => {
      let done = false;
      let off = [];
      const cleanup = () => { off.forEach((f) => f()); off = []; };
      Promise.all([
        listen('cw-download', async (ev) => {
          if (done) return;
          done = true;
          cleanup();
          const p = ev.payload || {};
          if (!p.success || !p.path) { reject(new Error('ダウンロードに失敗しました')); return; }
          try {
            const bytes = await readFile(p.path);
            await remove(p.path).catch(() => {});
            resolve({ bytes, fileName: baseName(p.path), url: p.url });
          } catch (e) { reject(e); }
        }),
        listen('cw-download-closed', () => { if (!done) { done = true; cleanup(); resolve(null); } }),
      ]).then(async (fns) => {
        off = fns;
        try {
          await invoke('open_download_window', { url });
        } catch (e) {
          done = true; cleanup(); reject(new Error(String(e)));
        }
      }, reject);
    });
  },

  /** 配布ページを読む（更新チェック用）。相手に負担をかけないよう呼ぶ側で間隔をあける */
  async fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await httpFetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      if (!r.ok) throw new Error(`ページを開けませんでした（${r.status}）`);
      return decodeHtml(new Uint8Array(await r.arrayBuffer()), r.headers.get('content-type') || '');
    } finally {
      clearTimeout(t);
    }
  },

  async openUrl(url) {
    if (!/^https?:\/\//.test(url)) return;
    await openUrl(url);
  },

  async saveFile(fileName, data) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: fileName });
    if (path) await writeFile(path, data);
  },

  /** CardWirth本体を起動する（登録したエンジンのフォルダの中のexeだけ） */
  async launch(engineRef, kind) {
    const exe = { cw150: 'CardWirth.exe', next: 'CardWirthNext.exe', py: 'CardWirthPy.exe' }[kind];
    if (!exe) throw new Error('このエンジンは起動できません');
    const p = join(engineRef, exe);
    if (!(await exists(p))) throw new Error(`${exe} が見つかりません`);
    await openPath(p);
  },

  /**
   * アプリ自体の更新を確認する（ポータブル版）。あれば { version, notes, install() }
   * 入れ替えは Rust 側で、署名を確かめてから行う。
   */
  async checkSelfUpdate(currentVersion) {
    const r = await httpFetch(UPDATE_INFO_URL, { headers: { 'User-Agent': UA }, cache: 'no-cache' });
    if (r.status === 404) return null; // まだリリースが無い
    if (!r.ok) throw new Error(`更新の情報を取れませんでした（${r.status}）`);
    const info = await r.json();
    if (!info?.version || !info.url || !info.signature) throw new Error('更新の情報の形が正しくありません');
    if (compareVersions(info.version, currentVersion) <= 0) return null;
    return {
      version: info.version,
      notes: typeof info.notes === 'string' ? info.notes : '',
      keyConfigured: await invoke('update_key_configured').catch(() => false),
      async install() {
        await invoke('portable_update_install', { url: info.url, signature: info.signature });
      },
    };
  },
};
