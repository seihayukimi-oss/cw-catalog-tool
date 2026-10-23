// フォルダ操作の共通の形。
// HTML版（ブラウザのフォルダ書き込み機能）とアプリ版（Tauri）とテスト用（メモリ）で
// 中身を入れ替えられるように、ここでは「フォルダ」の形だけを決める。
//
// interface Dir {
//   name: string
//   entries(): Promise<{name: string, kind: 'file'|'dir'}[]>
//   dir(name, {create}): Promise<Dir|null>
//   readFile(name): Promise<Uint8Array>
//   fileSize(name): Promise<number>
//   writeFile(name, data: Uint8Array): Promise<void>
//   remove(name): Promise<void>     // フォルダなら中身ごと
//   has(name): Promise<'file'|'dir'|null>
// }

const split = (p) => p.split('/').filter(Boolean);

export async function dirAt(root, relPath, { create = false } = {}) {
  let d = root;
  for (const seg of split(relPath)) {
    d = await d.dir(seg, { create });
    if (!d) return null;
  }
  return d;
}

export async function writeAt(root, relPath, data) {
  const segs = split(relPath);
  const name = segs.pop();
  const d = await dirAt(root, segs.join('/'), { create: true });
  await d.writeFile(name, data);
}

export async function readAt(root, relPath) {
  const segs = split(relPath);
  const name = segs.pop();
  const d = await dirAt(root, segs.join('/'));
  if (!d) throw new Error(`見つかりません：${relPath}`);
  return d.readFile(name);
}

export async function existsAt(root, relPath) {
  const segs = split(relPath);
  const name = segs.pop();
  const d = await dirAt(root, segs.join('/'));
  return d ? d.has(name) : null;
}

export async function removeAt(root, relPath) {
  const segs = split(relPath);
  const name = segs.pop();
  const d = await dirAt(root, segs.join('/'));
  if (d && (await d.has(name))) await d.remove(name);
}

/** フォルダの中のファイルを全部、FileRef（後から読める形）で並べる */
export async function listFiles(dir, prefix = '', depth = 12) {
  const out = [];
  if (depth < 0) return out;
  for (const e of await dir.entries()) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.kind === 'dir') {
      const sub = await dir.dir(e.name);
      if (sub) out.push(...(await listFiles(sub, path, depth - 1)));
    } else {
      const size = await dir.fileSize(e.name).catch(() => 0);
      out.push({ path, size, read: () => dir.readFile(e.name) });
    }
  }
  return out;
}

/** フォルダを丸ごとコピー（バックアップ用） */
export async function copyTree(src, dst) {
  for (const e of await src.entries()) {
    if (e.kind === 'dir') {
      await copyTree(await src.dir(e.name), await dst.dir(e.name, { create: true }));
    } else {
      await dst.writeFile(e.name, await src.readFile(e.name));
    }
  }
}

/** テスト・お試し用：メモリ上のフォルダ */
export class MemDir {
  constructor(name = '') {
    this.name = name;
    this.children = new Map(); // 小文字の名前 → {name, kind, data|dir}
  }
  async entries() {
    return [...this.children.values()].map((c) => ({ name: c.name, kind: c.kind }));
  }
  async dir(name, { create = false } = {}) {
    const c = this.children.get(name.toLowerCase());
    if (c) return c.kind === 'dir' ? c.dir : null;
    if (!create) return null;
    const d = new MemDir(name);
    this.children.set(name.toLowerCase(), { name, kind: 'dir', dir: d });
    return d;
  }
  async readFile(name) {
    const c = this.children.get(name.toLowerCase());
    if (!c || c.kind !== 'file') throw new Error(`見つかりません：${name}`);
    return c.data;
  }
  async fileSize(name) {
    return (await this.readFile(name)).length;
  }
  async writeFile(name, data) {
    const old = this.children.get(name.toLowerCase());
    if (old && old.kind === 'dir') throw new Error(`同じ名前のフォルダがあります：${name}`);
    this.children.set(name.toLowerCase(), { name: old?.name || name, kind: 'file', data });
  }
  async remove(name) {
    this.children.delete(name.toLowerCase());
  }
  async has(name) {
    return this.children.get(name.toLowerCase())?.kind || null;
  }
}
