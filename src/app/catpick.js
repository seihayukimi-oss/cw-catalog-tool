// 分類フォルダの選び方（シナリオ・素材・スキンで共通）
//   □ 新しい分類フォルダを作る   ← チェックすると、名前の欄が出る
//   [今ある分類フォルダから選ぶ ▼]
import { h } from './ui.js';

/**
 * @param {{cats: string[], rootLabel: string, state: {cat?: string, isNew?: boolean, newCat?: string}, idPrefix?: string,
 *          autoLabel?: string, placeholder?: string, onChange?: Function, nested?: boolean}} o
 *   nested：新しいフォルダを、今あるフォルダの中にも作れるようにする（「作成する場所」を選ぶ欄を出す）
 *   state は呼び出し側の入れ物（画面を描き直しても消えないように、ここに書き込む）
 * @returns {{el: HTMLElement, value: () => string}} value は分類フォルダの名前（'' は直下、'__auto' は自動）
 */
export function catPicker({ cats, rootLabel, state, idPrefix = 'dest', autoLabel = '', placeholder = '新しい分類フォルダの名前', onChange, nested = false }) {
  const st = state;
  if (st.cat === undefined) st.cat = autoLabel ? '__auto' : '';
  const sel = h('select', { id: `${idPrefix}-cat`, 'aria-label': '分類フォルダ', disabled: !!st.isNew },
    autoLabel ? h('option', { value: '__auto' }, autoLabel) : null,
    h('option', { value: '' }, rootLabel),
    cats.map((c) => h('option', { value: c }, c)));
  sel.value = st.cat === '__auto' && autoLabel ? '__auto' : cats.includes(st.cat) ? st.cat : '';
  const newIn = h('input', { type: 'text', id: `${idPrefix}-newcat`, placeholder, value: st.newCat || '', 'aria-label': '新しい分類フォルダの名前' });
  const parentSel = nested ? h('select', { id: `${idPrefix}-newparent`, 'aria-label': '新しいフォルダを作成する場所' },
    h('option', { value: '' }, `${rootLabel}に作成`),
    cats.map((c) => h('option', { value: c }, `「${c}」の中に作成`))) : null;
  if (parentSel) {
    parentSel.value = cats.includes(st.newParent) ? st.newParent : '';
    parentSel.addEventListener('change', () => { st.newParent = parentSel.value; onChange?.(); });
  }
  const newRow = h('div', { class: 'cat-new', hidden: !st.isNew }, parentSel, newIn);
  const box = h('input', { type: 'checkbox', id: `${idPrefix}-isnew`, checked: !!st.isNew, 'aria-label': '新しい分類フォルダを作る' });
  box.addEventListener('change', () => {
    st.isNew = box.checked;
    newRow.hidden = !box.checked;
    sel.disabled = box.checked;
    if (box.checked) setTimeout(() => newIn.focus(), 0);
    onChange?.();
  });
  sel.addEventListener('change', () => { st.cat = sel.value; onChange?.(); });
  newIn.addEventListener('input', () => { st.newCat = newIn.value; onChange?.(); });
  const el = h('div', { class: 'field cat-pick' },
    h('span', {}, '分類フォルダ'),
    h('label', { class: 'check small' }, box, '新しい分類フォルダを作って入れる'),
    newRow,
    sel);
  const newValue = () => {
    const name = (st.newCat || '').trim();
    return name && parentSel?.value ? `${parentSel.value}/${name}` : name;
  };
  return { el, value: () => (st.isNew ? newValue() : sel.value) };
}
