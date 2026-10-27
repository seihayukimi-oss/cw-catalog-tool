// ツールの記録（IndexedDB）。HTML版でもアプリ版でも同じ。
// 形式は docs/開発者向け/データ形式.md の「ツールの記録」に書いてある。

const DB_NAME = 'cw-catalog-tool';
const DB_VERSION = 1;
export const RECORD_FORMAT = 1;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('engines')) d.createObjectStore('engines', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('records')) {
          const s = d.createObjectStore('records', { keyPath: 'id' });
          s.createIndex('engineId', 'engineId');
        }
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const store = {
  async engines() { return tx('engines', 'readonly', (s) => req2p(s.getAll())); },
  async putEngine(e) { return tx('engines', 'readwrite', (s) => req2p(s.put(e))); },
  async deleteEngine(id) {
    await tx('engines', 'readwrite', (s) => req2p(s.delete(id)));
    const recs = await this.records(id);
    await tx('records', 'readwrite', (s) => Promise.all(recs.map((r) => req2p(s.delete(r.id)))));
  },

  async records(engineId) {
    return tx('records', 'readonly', (s) => (engineId === undefined
      ? req2p(s.getAll())
      : req2p(s.index('engineId').getAll(engineId))));
  },
  async getRecord(id) { return tx('records', 'readonly', (s) => req2p(s.get(id))); },
  async putRecord(r) { return tx('records', 'readwrite', (s) => req2p(s.put({ ...r, updatedAt: new Date().toISOString() }))); },
  async putRecords(rs) {
    const now = new Date().toISOString();
    return tx('records', 'readwrite', (s) => Promise.all(rs.map((r) => req2p(s.put({ ...r, updatedAt: now })))));
  },
  async deleteRecord(id) { return tx('records', 'readwrite', (s) => req2p(s.delete(id))); },

  async get(k, def = null) {
    const v = await tx('kv', 'readonly', (s) => req2p(s.get(k)));
    return v ? v.v : def;
  },
  async set(k, v) { return tx('kv', 'readwrite', (s) => req2p(s.put({ k, v }))); },
};

/** 記録の id（エンジン＋場所で一意） */
export const recordId = (engineId, path, inner = '') => `${engineId}:${path}${inner ? '#' + inner : ''}`;

/** 記録を書き出す（他のツールでも読めるJSON。エンジンのフォルダの許可情報は含めない） */
export async function exportRecords(appVersion) {
  const engines = (await store.engines()).map(({ ref, ...e }) => ({ ...e, path: typeof ref === 'string' ? ref : '' }));
  const records = (await store.records()).map(({ readmes, ...r }) => r);
  return {
    format: RECORD_FORMAT,
    kind: 'cw-catalog-tool/records',
    tool: appVersion,
    exported: new Date().toISOString(),
    engines,
    records,
  };
}

/** 書き出した記録を読み込む（エンジンのフォルダは選び直しが必要） */
export async function importRecords(json) {
  if (json?.kind !== 'cw-catalog-tool/records' || json.format !== RECORD_FORMAT) throw new Error('このツールの記録ファイルではありません');
  const known = new Set((await store.engines()).map((e) => e.id));
  for (const e of json.engines || []) {
    if (!known.has(e.id)) await store.putEngine({ id: e.id, name: e.name, kind: e.kind, ref: null, label: e.path || e.label || '', needsReconnect: true });
  }
  const recs = (json.records || []).filter((r) => r && typeof r.id === 'string' && typeof r.engineId === 'string');
  await store.putRecords(recs);
  return recs.length;
}
