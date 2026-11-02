// ブラウザのフォルダ書き込み機能（File System Access API）を、共通のフォルダの形にする

export class FsaDir {
  constructor(handle) {
    this.h = handle;
    this.name = handle.name;
  }
  async entries() {
    const out = [];
    for await (const [name, h] of this.h.entries()) out.push({ name, kind: h.kind === 'directory' ? 'dir' : 'file' });
    return out;
  }
  async dir(name, { create = false } = {}) {
    try {
      return new FsaDir(await this.h.getDirectoryHandle(name, { create }));
    } catch (e) {
      if (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') return null;
      throw e;
    }
  }
  async readFile(name) {
    const f = await (await this.h.getFileHandle(name)).getFile();
    return new Uint8Array(await f.arrayBuffer());
  }
  async fileSize(name) {
    return (await (await this.h.getFileHandle(name)).getFile()).size;
  }
  async writeFile(name, data) {
    const fh = await this.h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(data);
    } finally {
      await w.close();
    }
  }
  async remove(name) {
    await this.h.removeEntry(name, { recursive: true });
  }
  async has(name) {
    for await (const [n, h] of this.h.entries()) {
      if (n.toLowerCase() === name.toLowerCase()) return h.kind === 'directory' ? 'dir' : 'file';
    }
    return null;
  }
}

export const FsaDirFromHandle = (handle) => new FsaDir(handle);
