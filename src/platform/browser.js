// HTML版の入れ物：ブラウザのフォルダ書き込み機能（File System Access API）を使う。
// Chrome・Edge（パソコン）で使える。Firefox・Safari・スマホでは、
// フォルダへの直接インストールはできず、分析とWebCardWirth用の書き出しだけになる。

import { FsaDir, FsaDirFromHandle } from './fsa.js';
import { fileNameFrom } from '../core/weblink.js';

export const platform = {
  kind: 'web',
  label: 'HTML版',
  canWriteFolders: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
  canFetchAnywhere: false, // 他サイトのファイルはブラウザの制限で取れないことが多い
  canCheckPages: false,
  canUpdateSelf: false,
  canInAppBrowse: false,

  /** エンジンのフォルダを選んでもらう。ref はIndexedDBに保存できる形 */
  async pickFolder({ id = 'cw-engine' } = {}) {
    const handle = await window.showDirectoryPicker({ id, mode: 'readwrite' });
    return { dir: new FsaDir(handle), ref: handle, label: handle.name };
  },

  /** 入れたいシナリオのフォルダ（展開済み）を選んでもらう（読むだけ） */
  async pickSourceFolder() {
    const handle = await window.showDirectoryPicker({ id: 'cw-source', mode: 'read' });
    return new FsaDir(handle);
  },

  /**
   * 保存しておいたフォルダをもう一度使えるようにする。
   * ブラウザは再起動のたびに許可を聞き直すので、ボタンを押したときに呼ぶ。
   * @returns {Promise<FsaDir|null>} 許可されなければ null
   */
  async openFolder(ref, { ask = false } = {}) {
    if (!ref) return null;
    if (ref.opfs) return (await opfsFolder(ref.opfs)).dir; // テスト用
    let p = await ref.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted' && ask) p = await ref.requestPermission({ mode: 'readwrite' });
    return p === 'granted' ? new FsaDir(ref) : null;
  },

  async fetchJson(url) {
    const r = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
    if (!r.ok) throw new Error(`読み込めませんでした（${r.status}）`);
    return r.json();
  },

  /** 直接DL。ブラウザの制限で取れなかったら null を返す（呼び出し側でページを開く） */
  async fetchFile(url) {
    try {
      const r = await fetch(url, { credentials: 'omit' });
      if (!r.ok) return null;
      return new Uint8Array(await r.arrayBuffer());
    } catch {
      return null;
    }
  },

  /**
   * URLの中身を取る。ブラウザの制限（他のサイトのファイルは、相手が許可していないと読めない）で
   * 取れなかったときは { blocked: true } を返す。
   */
  async fetchResource(url, { method = 'GET', body, headers = {}, onProgress } = {}) {
    let r;
    try {
      // 同じサイトの中でだけCookieを使う（他のサイトにはブラウザの決まりでどのみち送られない）
      r = await fetch(url, { method, body, headers, credentials: 'same-origin', redirect: 'follow' });
    } catch {
      return { blocked: true };
    }
    if (!r.ok) throw new Error(`読み込めませんでした（${r.status}）`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 2 * 1024 * 1024 * 1024) throw new Error('ファイルが大きすぎます');
    return {
      bytes: await readWithProgress(r, len, onProgress || platform.netProgress),
      contentType: r.headers.get('content-type') || '',
      fileName: fileNameFrom(r.url || url, r.headers.get('content-disposition') || ''),
      finalUrl: r.url || url,
    };
  },

  async fetchText() {
    throw new Error('配布ページの確認はアプリ版の機能です');
  },

  openUrl(url) {
    if (!/^https?:\/\//.test(url)) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  },

  async saveFile(fileName, data) {
    const blob = new Blob([data], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  },

  async launch() {
    throw new Error('CardWirthの起動はアプリ版の機能です');
  },

  async checkSelfUpdate() {
    return null;
  },

  FsaDirFromHandle,
};

/** テスト用：ブラウザ内の保存領域（OPFS）をエンジンのフォルダとして使う */
/** 中身を読みながら、進み具合を知らせる */
async function readWithProgress(r, total, cb) {
  if (!cb || !r.body) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const parts = [];
  let got = 0, last = 0;
  cb(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (Date.now() - last > 150) { last = Date.now(); cb(got, total); }
  }
  cb(got, total);
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export async function opfsFolder(name) {
  const root = await navigator.storage.getDirectory();
  const h = await root.getDirectoryHandle(name, { create: true });
  // OPFSのハンドルはIndexedDBに保存せず、名前だけを覚えておく
  return { dir: new FsaDir(h), ref: { opfs: name }, label: `ブラウザ内：${name}` };
}
