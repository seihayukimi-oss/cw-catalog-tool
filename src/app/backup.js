// バックアップ先：
//  ・何も選んでいないとき：エンジンのフォルダの中の「CWCatalog_backup」（zipの保存場所の整理は、保存場所の中の CWCatalog_backup）
//  ・設定で選んだとき：そのフォルダの中に、「エンジンの名前」「zipの保存場所」のフォルダを分けて置く
// 置き換える前のシナリオ（インストール・更新）と、整理・二重チェックで移したものの両方に使う。

import { BACKUP_DIR } from '../core/install.js';
import { S, render, busy, engine } from './state.js';
import { store } from './store.js';
import { h, toast } from './ui.js';
import { confirmBox } from './state.js';

const safe = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 60) || 'エンジン';
const isApp = () => S.platform.kind === 'app';
const join = (...p) => p.filter(Boolean).join(isApp() ? '\\' : '/');

export async function loadBackup() {
  S.backupFolder = { ref: null, label: '', ...((await store.get('backupFolder')) || {}) };
}

/** 選んだバックアップ先の中の、どのフォルダに置くか */
const prefixOf = (kind, engineId) => `${kind === 'zip' ? 'zipの保存場所' : safe(engine(engineId)?.name)}/`;

/**
 * performInstall・moveToBackup に渡す設定。選んでいなければ {}（いつもの CWCatalog_backup）
 * @param {'engine'|'zip'} kind
 */
export async function backupOpts(kind, engineId) {
  if (!S.backupFolder?.ref) return {};
  const d = S.backupDir || await S.platform.openFolder(S.backupFolder.ref, { ask: true });
  if (d) S.backupDir = d;
  if (!d) throw new Error('バックアップ先のフォルダを使う許可がありませんでした。「設定」の「バックアップ先」で選び直してください');
  return { backupRoot: d, backupPrefix: prefixOf(kind, engineId) };
}

/** バックアップ先の場所（表示用） */
export function backupPlace(kind, engineId) {
  if (S.backupFolder?.ref) {
    const pre = prefixOf(kind, engineId).replace(/\/$/, '');
    return isApp() ? join(S.backupFolder.ref, pre) : `「${S.backupFolder.label}」フォルダの中の ${pre}`;
  }
  if (kind === 'zip') return isApp() ? join(S.archive.ref, BACKUP_DIR) : `「${S.archive.label}」フォルダの中の ${BACKUP_DIR}`;
  const e = engine(engineId);
  if (!e) return BACKUP_DIR;
  return isApp() ? join(e.ref, BACKUP_DIR) : `「${e.label}」フォルダの中の ${BACKUP_DIR}`;
}

/** 移した先の場所（moveToBackup の返り値から、表示用の場所を作る） */
export function backupFull(kind, engineId, dest) {
  const base = S.backupFolder?.ref ? S.backupFolder.ref : kind === 'zip' ? S.archive.ref : engine(engineId)?.ref;
  const label = S.backupFolder?.ref ? S.backupFolder.label : kind === 'zip' ? S.archive.label : engine(engineId)?.label;
  return isApp() ? join(base, dest.replace(/\//g, '\\')) : `「${label}」の中の ${dest}`;
}

export function viewBackupSettings(dev) {
  const pick = async (useOpfs = false) => busy('バックアップ先を選ぶ', async () => {
    const p = useOpfs ? await S.platform.opfsFolder('test-backup') : await S.platform.pickFolder({ title: 'バックアップを置くフォルダを選んでください', id: 'cw-backup' });
    S.backupFolder = { ref: p.ref, label: p.label };
    S.backupDir = p.dir;
    await store.set('backupFolder', S.backupFolder);
    toast(`バックアップは「${p.label}」に置くようにしました`);
  });
  const reset = async () => {
    if (!(await confirmBox('バックアップ先を、いつもの場所（エンジンのフォルダの中の CWCatalog_backup）に戻します。今までのバックアップは、選んでいたフォルダにそのまま残ります。よろしいですか？'))) return;
    S.backupFolder = { ref: null, label: '' };
    S.backupDir = null;
    await store.set('backupFolder', S.backupFolder);
    toast('バックアップ先を、いつもの場所に戻しました');
    render();
  };
  return h('div', { class: 'card stack' },
    h('p', { class: 'small muted', style: 'margin:0' }, 'シナリオを置き換える前のもの（更新・入れ直し）と、「整理・二重チェック」で移したものを置く場所です。'),
    h('div', { class: 'row' },
      h('span', { class: 'grow small', id: 'backup-now' }, S.backupFolder?.ref
        ? `バックアップ先：${S.backupFolder.label}（この中に「エンジンの名前」「zipの保存場所」のフォルダを作って分けます）`
        : `バックアップ先：いつもの場所（それぞれのエンジンのフォルダの中の ${BACKUP_DIR}）`),
      S.platform.canWriteFolders ? h('button', { class: 'btn sm', onclick: () => pick().then(render) }, S.backupFolder?.ref ? 'バックアップ先を変える' : 'バックアップ先を選ぶ') : null,
      S.backupFolder?.ref ? h('button', { class: 'btn ghost sm', onclick: reset }, 'いつもの場所に戻す') : null,
      dev ? h('button', { class: 'btn sm', id: 'dev-opfs-backup', onclick: () => pick(true).then(render) }, 'テスト用（バックアップ）') : null),
    h('p', { class: 'small muted', style: 'margin:0' }, 'エンジンのScenarioフォルダの中は選ばないでください。外付けのドライブなども選べます。'));
}
