// 取ってきたときの「保存先を選ぶ」：フォルダを選んで、今回だけ使うか、次からもそこにするかを決める。

import { S } from './state.js';
import { h, modal } from './ui.js';

const devPick = () => location.hash.includes('dev-opfs') && S.platform.opfsFolder;

/**
 * フォルダを選んでもらい、「今回だけ」か「次からも」かを聞く。やめたら null
 * @param {{title: string, id: string, what: string}} o what＝何の保存先か（例：素材の置き場所）
 * @returns {Promise<{ref: string, label: string, dir: object, remember: boolean}|null>}
 */
export async function choosePlace({ title, id, what }) {
  let p;
  try {
    p = devPick() ? await S.platform.opfsFolder(`test-pick-${id}`) : await S.platform.pickFolder({ title, id: `cw-${id}` });
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw e;
  }
  if (!p) return null;
  const remember = await modal((close) => {
    const once = h('input', { type: 'radio', name: 'place-when', checked: true, id: 'place-once' });
    const always = h('input', { type: 'radio', name: 'place-when', id: 'place-always' });
    return h('div', { class: 'stack', id: 'place-modal' },
      h('h2', { style: 'margin:0' }, `${what}を「${p.label}」にします`),
      h('label', { class: 'check' }, once, '今回だけ、ここに保存する'),
      h('label', { class: 'check' }, always, `次からも、ここを${what}にする（「設定」でも変えられます）`),
      h('div', { class: 'row', style: 'justify-content:flex-end' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'やめる'),
        h('button', { class: 'btn primary', id: 'place-ok', onclick: () => close(always.checked) }, '決める')));
  });
  if (remember == null) return null;
  return { ref: p.ref, label: p.label, dir: p.dir, remember };
}

/** 保存先の表示（今回だけの場所なら、それと分かるように） */
export const placeLabel = (place, normal) => (place ? `${place.label}（今回だけ）` : normal || '未設定');
