// 手元のファイルを入れる：
//  ・「ダウンロード」フォルダから選ぶ（アプリ版）。ブラウザが付けた「DL元のURL」も一緒に読む
//  ・複数のファイルを選んだ・ドロップしたときは、まとめて入れる

import { openArchive } from '../core/archive.js';
import { downloadsFromZone } from '../core/urls.js';
import { S, busy } from './state.js';
import { h, toast, modal, fmtSize, fmtDate } from './ui.js';
import { openSource } from './add.js';
import { startLocalBatch } from './batch.js';

/**
 * @param {{name: string, bytes: Uint8Array, zone?: {hostUrl?: string, referrerUrl?: string}}[]} list
 */
export async function openLocalFiles(list) {
  if (!list?.length) return;
  if (list.length === 1) {
    const f = list[0];
    S.pendingZone = f.zone && (f.zone.hostUrl || f.zone.referrerUrl) ? f.zone : null;
    const dl = downloadsFromZone(S.pendingZone);
    if (dl.length) S.lastUrl = dl[0].url;
    return openSource(async () => openArchive(f.bytes, f.name));
  }
  return startLocalBatch(list);
}

/** アプリ版：「ファイルを選ぶ」（複数選べる・DL元のURLも読む） */
export async function pickFiles() {
  const got = await busy('ファイルを読み込み', () => S.platform.pickArchiveFiles());
  if (got) await openLocalFiles(got);
}

const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

/** 「ダウンロード」フォルダの zip・wsn などを一覧にして、選んで入れる */
export async function pickDownloads() {
  const list = await busy('「ダウンロード」フォルダを見ています', () => S.platform.downloadsList());
  if (!list) return;
  if (!list.length) { toast('「ダウンロード」フォルダに、zip・wsn・cab・lzh・7z のファイルはありませんでした'); return; }
  const chosen = await modal((close) => {
    const sel = new Set();
    const q = h('input', { type: 'search', class: 'grow', placeholder: 'ファイル名・DL元で絞り込み' });
    const go = h('button', { class: 'btn primary', disabled: true }, '入れる');
    const body = h('div', { class: 'dl-pick' });
    const draw = () => {
      const k = q.value.normalize('NFKC').toLowerCase();
      body.replaceChildren(...list.filter((f) => !k || `${f.name} ${f.referrerUrl || ''} ${f.hostUrl || ''}`.normalize('NFKC').toLowerCase().includes(k)).map((f) => {
        const from = f.referrerUrl || f.hostUrl;
        return h('label', { class: 'dl-pick-row' },
          h('input', { type: 'checkbox', checked: sel.has(f.name), onchange: (ev) => { if (ev.target.checked) sel.add(f.name); else sel.delete(f.name); go.disabled = !sel.size; go.textContent = sel.size > 1 ? `${sel.size}件をまとめて入れる` : '入れる'; } }),
          h('span', { class: 'grow' },
            h('b', {}, f.name),
            h('div', { class: 'meta' }, [fmtSize(f.size), fmtDate(f.modified), from ? `DL元：${host(from)}` : 'DL元の記録なし'].join('・'))));
      }));
    };
    q.addEventListener('input', draw);
    go.addEventListener('click', () => close([...sel]));
    draw();
    return h('div', { class: 'stack' },
      h('h2', {}, '「ダウンロード」フォルダから選ぶ'),
      h('p', { class: 'small muted', style: 'margin:0' }, 'ブラウザでDLした zip・wsn・cab・lzh・7z を、新しい順に並べています。「DL元」は、ブラウザがファイルに残した記録です（個人用カタログに登録するとき、DL先として使えます）。'),
      q, body,
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'), go));
  });
  if (!chosen?.length) return;
  const files = await busy('ファイルを読み込み', async () => {
    const out = [];
    for (const name of chosen) {
      const f = list.find((x) => x.name === name);
      out.push({ name, bytes: await S.platform.downloadsRead(name), zone: { hostUrl: f.hostUrl, referrerUrl: f.referrerUrl } });
    }
    return out;
  });
  if (files) await openLocalFiles(files);
}
