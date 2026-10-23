// アプリ版（Tauri）の入れ物。
// ファイル操作・ネット接続・起動は、Tauri公式のプラグインを使う。
// どのフォルダに触れるかは、ユーザーがダイアログで選んだフォルダだけに限られる
// （選んだ場所はTauriの許可範囲に追加され、persisted-scopeで次回以降も記憶される）。

import { readDir, readFile, writeFile, mkdir, remove, stat, exists } from '@tauri-apps/plugin-fs';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import { openUrl, openPath } from '@tauri-apps/plugin-opener';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { decodeHtml, fileNameFrom } from '../core/weblink.js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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

  async pickFolder() {
    const path = await openDialog({ directory: true, multiple: false, title: 'CardWirthのフォルダを選んでください' });
    if (!path) throw Object.assign(new Error('キャンセルされました'), { name: 'AbortError' });
    return { dir: new TauriDir(path), ref: path, label: path };
  },

  async pickSourceFolder() {
    const path = await openDialog({ directory: true, multiple: false, title: '入れたいシナリオのフォルダを選んでください' });
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

  /** アプリ自体の更新を確認する。あれば { version, notes, install() } */
  async checkSelfUpdate() {
    const u = await checkUpdate();
    if (!u) return null;
    return {
      version: u.version,
      notes: u.body || '',
      async install(onProgress) {
        let total = 0, got = 0;
        await u.downloadAndInstall((ev) => {
          if (ev.event === 'Started') total = ev.data.contentLength || 0;
          if (ev.event === 'Progress') { got += ev.data.chunkLength; onProgress?.(got, total); }
        });
        await relaunch();
      },
    };
  },
};
