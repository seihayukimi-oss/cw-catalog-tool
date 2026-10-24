// エンジンのフォルダを調べる：どのエンジンか／Scenarioに何が入っているか。

import { parseSummaryWsm, parseSummaryXml, isWdp } from './summary.js';
import { decodeText } from './text.js';
import { guessVersion } from './scenario.js';
import { openArchive } from './archive.js';
import { BACKUP_DIR } from './install.js';

/** フォルダの中身から、どのエンジンかを当てる */
export async function detectEngineKind(root) {
  const names = new Set((await root.entries()).filter((e) => e.kind === 'file').map((e) => e.name.toLowerCase()));
  if (names.has('cardwirthpy.exe')) return 'py';
  if (names.has('cardwirthnext.exe')) return 'next';
  if (names.has('cardwirth.exe')) return 'cw150';
  return null;
}

/**
 * エンジンのフォルダとして選ばれた場所が正しいか調べる。
 * よくある間違い：Scenario フォルダそのものや、シナリオのフォルダ、宿（Yado）を選んでしまう。
 * @returns {{ok: boolean, problem: ''|'scenario'|'inside'|'yado'|'noscenario', kind: string|null}}
 */
export async function checkEngineFolder(dir) {
  const entries = await dir.entries();
  const files = new Set(entries.filter((e) => e.kind === 'file').map((e) => e.name.toLowerCase()));
  const dirs = new Set(entries.filter((e) => e.kind === 'dir').map((e) => e.name.toLowerCase()));
  const kind = await detectEngineKind(dir);
  const name = (dir.name || '').toLowerCase();
  if (kind && dirs.has('scenario')) return { ok: true, problem: '', kind };
  if (files.has('summary.wsm') || files.has('summary.xml')) return { ok: false, problem: 'inside', kind };
  if (name === 'scenario') return { ok: false, problem: 'scenario', kind };
  if (name === 'yado' || name === 'data') return { ok: false, problem: 'yado', kind };
  if (!dirs.has('scenario')) return { ok: false, problem: 'noscenario', kind };
  return { ok: true, problem: '', kind };
}

const MAX_ARCHIVE_SCAN = 300 * 1024 * 1024;

/**
 * Scenarioフォルダを調べる。
 * @param {import('./fs.js').Dir} engineRoot
 * @param {{onProgress?: (msg: string) => void, readArchive?: (dir, name) => Promise<Uint8Array>}} opts
 * @returns {{items: object[], categories: string[], warnings: string[]}}
 */
export async function scanScenarioFolder(engineRoot, { onProgress } = {}) {
  const scen = await engineRoot.dir('Scenario');
  if (!scen) throw new Error('このフォルダには Scenario フォルダがありません');
  const items = [];
  const categories = [];
  const warnings = [];

  async function visit(dir, rel, depth) {
    const entries = await dir.entries();
    const files = entries.filter((e) => e.kind === 'file');
    const lower = new Map(files.map((e) => [e.name.toLowerCase(), e.name]));

    if (lower.has('summary.wsm') || lower.has('summary.xml')) {
      onProgress?.(rel);
      try {
        let s;
        if (lower.has('summary.xml')) s = parseSummaryXml(decodeText(await dir.readFile(lower.get('summary.xml'))).text);
        else s = parseSummaryWsm(await dir.readFile(lower.get('summary.wsm')));
        let encrypted = null;
        if (s.format !== 'wsn') {
          const wid = files.find((e) => /\.wid$/i.test(e.name));
          if (wid) encrypted = isWdp((await dir.readFile(wid.name)).subarray(0, 4));
        }
        const folder = rel.split('/').pop();
        items.push({
          path: rel, type: 'folder', name: s.name, author: s.author, format: s.format,
          dataVersion: s.kind === 'wsm' ? s.dataVersion : null,
          wsnVersion: s.kind === 'xml' ? s.dataVersion : null,
          encrypted, versionGuess: guessVersion(folder), sha256: '',
        });
      } catch (e) {
        warnings.push(`${rel}：${e.message}`);
      }
      return; // シナリオの中には潜らない
    }

    if (rel !== 'Scenario') categories.push(rel.slice('Scenario/'.length));

    for (const f of files) {
      const n = f.name.toLowerCase();
      if (!/\.(wsn|zip|cab|lzh)$/.test(n)) continue;
      const path = `${rel}/${f.name}`;
      if (/\.(cab|lzh)$/.test(n)) {
        items.push({ path, type: 'archive', name: f.name, author: '', format: 'unknown', note: '未解析（cab・lzh）' });
        continue;
      }
      const size = await dir.fileSize(f.name).catch(() => 0);
      if (size > MAX_ARCHIVE_SCAN) {
        items.push({ path, type: 'archive', name: f.name, author: '', format: 'unknown', note: '大きいため未解析' });
        continue;
      }
      onProgress?.(path);
      try {
        const opened = await openArchive(await dir.readFile(f.name), f.name);
        if (!opened.scenarios.length) continue; // シナリオでないzip（素材など）は一覧に出さない
        for (const s of opened.scenarios) {
          items.push({
            path, type: 'archive', inner: s.root, name: s.name, author: s.author, format: s.format,
            dataVersion: s.dataVersion, wsnVersion: s.wsnVersion, encrypted: s.encrypted,
            versionGuess: s.versionGuess, sha256: opened.source.sha256,
          });
        }
      } catch (e) {
        warnings.push(`${path}：${e.message}`);
      }
    }

    if (depth <= 0) return;
    for (const e of entries) {
      if (e.kind !== 'dir' || e.name === BACKUP_DIR) continue;
      const sub = await dir.dir(e.name);
      if (sub) await visit(sub, `${rel}/${e.name}`, depth - 1);
    }
  }

  await visit(scen, 'Scenario', 8);
  return { items, categories: categories.sort(), warnings };
}
