// 「入れる個人用カタログ」を選ぶ欄（＋個人用カタログを新規作成 つき）
import { h, toast } from './ui.js';
import { ownSources, createOwn } from './catalog-data.js';

/**
 * @param {{preset: Set<string>, label?: string, emptyText?: string}} o
 * @returns {{el: HTMLElement, ids: () => string[], count: () => number}}
 */
export function ownPicker({ preset, label = '入れる個人用カタログ', emptyText = '' }) {
  const boxes = [];
  const row = h('div', { class: 'row' });
  const empty = emptyText ? h('p', { class: 'small muted', style: 'margin:0' }, emptyText) : null;
  const add = (s, checked) => {
    const box = h('input', { type: 'checkbox', checked });
    boxes.push({ s, box });
    row.append(h('label', { class: 'check' }, box, s.name));
    if (empty) empty.hidden = true;
  };
  const nameIn = h('input', { type: 'text', id: 'own-new-name', class: 'grow', placeholder: '新しい個人用カタログの名前', 'aria-label': '新しい個人用カタログの名前' });
  const create = async () => {
    const name = nameIn.value.trim();
    if (!name) { toast('個人用カタログの名前を入れてください', { bad: true }); nameIn.focus(); return; }
    try {
      add(await createOwn(name), true);
      toast(`個人用カタログ「${name}」を作成しました`);
      nameIn.value = '';
      form.hidden = true;
    } catch (e) { toast(`作成できませんでした：${e.message}`, { bad: true }); }
  };
  // 登録の画面はフォームなので、名前の欄で Enter を押しても登録が進まないようにする
  nameIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); create(); } });
  const form = h('div', { class: 'row', hidden: true }, nameIn, h('button', { type: 'button', class: 'btn sm primary', id: 'own-new-go', onclick: create }, '作成する'));
  const newBtn = h('button', { type: 'button', class: 'btn sm', id: 'own-new', onclick: () => { form.hidden = false; nameIn.focus(); } }, '＋ 個人用カタログを新規作成');
  ownSources().forEach((s) => add(s, preset.has(s.id)));
  const el = h('div', { class: 'stack own-pick', style: 'gap:6px' },
    h('div', { class: 'small muted' }, label), empty, row, h('div', { class: 'row' }, newBtn), form);
  return { el, ids: () => boxes.filter((b) => b.box.checked).map((b) => b.s.id), count: () => boxes.length };
}
