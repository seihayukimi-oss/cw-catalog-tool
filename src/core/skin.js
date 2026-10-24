// CardWirthPy のスキン（Skin.xml があるフォルダ）を見分ける。
import { decodeText } from './text.js';

const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** スキンの入っている場所（'' ＝いちばん上、'フォルダ/' など）。スキンでなければ null */
export function skinRootOf(files) {
  const hits = files.filter((f) => /(^|\/)Skin\.xml$/i.test(f.path)).sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!hits.length) return null;
  return hits[0].path.slice(0, hits[0].path.length - 'Skin.xml'.length);
}

/** Skin.xml から名前・種類・作者を読む */
export function parseSkinXml(text) {
  const tag = (n) => unesc(((text.match(new RegExp(`<${n}>([^<]*)</${n}>`)) || [])[1] || '').trim());
  return { name: tag('Name'), type: tag('Type'), author: tag('Author') };
}

/** zipなどを開いた結果から、スキンの情報を読む。スキンでなければ null */
export async function readSkin(opened) {
  const root = skinRootOf(opened.files);
  if (root == null) return null;
  const f = opened.files.find((x) => x.path.toLowerCase() === `${root}skin.xml`.toLowerCase());
  let info = { name: '', type: '', author: '' };
  try { info = parseSkinXml(decodeText(await f.read()).text); } catch { /* 読めなくてもスキンとして扱う */ }
  const folder = root.replace(/\/$/, '').split('/').pop();
  return { root, ...info, folderName: info.name || folder || opened.source.name.replace(/\.[^.]+$/, '') };
}
