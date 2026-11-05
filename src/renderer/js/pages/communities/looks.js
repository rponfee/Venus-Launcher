// Editor de fondos del chat y escenarios de voz de una comunidad (dueño y moderadores). Se elige un fondo para toda la comunidad o
// para un canal de texto, y un escenario para todas las salas o para una sala de voz: un incluido (dibujado por Venus) o una
// imagen o GIF aprobado de la galería, con vista previa, oscurecido para que se lea el chat y desenfoque. Cada uno gasta un cupo
// del plan ("1 de 2"); los animados piden un plan que los permita. El servidor repite todas las reglas (0044).
import { h, icon, mount, modal, ok, fail, setBusy, skeleton, emptyState, confirmDialog } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { normalizePlanState, hasRoom } from '../../features/communities/plan.js';
import { presetsFor } from '../../features/communities/presets.js';
import { BLUR, DIM, checkChoice, choiceAnimated, normalizeBackdrop, normalizeBackdrops, scopeRows, setArgs, stateKey, usableMedia } from '../../features/communities/looks.js';
import { backdropLayer, notifyLooksChanged } from './looks-view.js';
import { isStaff } from './logic.js';

const P = (key, vars) => t(`communityplans.${key}`, vars);

/** Una elección a lo que dibuja backdropLayer (para la grilla y la vista previa). */
function previewOf(kind, choice, { dim = DIM.def, blur = BLUR.def } = {}) {
  if (choice.source === 'preset') return normalizeBackdrop({ kind, source: 'preset', preset: choice.id, dim, blur });
  const m = choice.item;
  return normalizeBackdrop({ kind, source: 'media', dim, blur, animated: m.animated, media: { id: m.id, source: m.source, path: m.path, url: m.url, still: m.still, width: m.width, height: m.height, animated: m.animated, name: m.name } });
}

export async function openLooksDialog(b, initial, { openPlan } = {}) {
  if (!isStaff(initial.myRole)) return null;
  await loadNs('communityplans');
  let community = initial;
  let kind = 'chat';
  let planState = null;
  let items = [];
  let gallery = [];
  let closed = false;
  let failed = false;
  const body = h('div', { class: 'stack cp-looks' }, skeleton('list', { rows: 4 }));
  const m = modal({ title: P('looksTitle'), subtitle: community.name, icon: 'palette', size: 'wide', body, onClose: () => { closed = true; } });

  async function load() {
    try {
      const [plan, back, media] = await Promise.all([
        b.rpc('community_plan_get', { p_community: community.id }),
        b.rpc('community_backdrops_get', { p_community: community.id }),
        b.rpc('community_media_list', { p_community: community.id }).catch(() => []),
      ]);
      if (closed) return;
      planState = normalizePlanState(plan);
      if (!planState) throw new Error('unavailable');
      items = normalizeBackdrops(back).items;
      gallery = usableMedia(media);
      failed = false;
    } catch {
      if (closed) return;
      failed = true;
    }
    draw();
  }

  async function save(row, choice, settings, dialog) {
    const problem = checkChoice(planState, kind, row.backdrop, choice);
    if (problem) { fail(P('looksNotSaved'), P(`err_${problem}`)); return false; }
    try {
      await b.rpc('community_backdrop_set', setArgs(community.id, kind, row.channelId, choice, settings));
      ok(P(kind === 'stage' ? 'stageSaved' : 'backdropSaved'));
      notifyLooksChanged(community.id);
      dialog?.close();
      await load();
      return true;
    } catch (err) {
      fail(P('looksNotSaved'), errText(err));
      return false;
    }
  }

  async function clear(row) {
    if (!(await confirmDialog(P(kind === 'stage' ? 'stageClearTitle' : 'backdropClearTitle'), P('clearText'), { okText: P('clear'), danger: true }))) return;
    try {
      await b.rpc('community_backdrop_clear', { p_community: community.id, p_kind: kind, p_channel: row.channelId });
      ok(P('cleared'));
      notifyLooksChanged(community.id);
      await load();
    } catch (err) {
      fail(P('looksNotSaved'), errText(err));
    }
  }

  function openPicker(row) {
    const limits = planState.plan.limits;
    let choice = row.backdrop ? (row.backdrop.source === 'preset' ? { source: 'preset', id: row.backdrop.preset } : { source: 'media', item: gallery.find((g) => g.id === row.backdrop.media.id) || { ...row.backdrop.media } }) : null;
    const dim = h('input', { type: 'range', min: String(DIM.min), max: String(DIM.max), step: '5', value: String(row.backdrop?.dim ?? DIM.def), 'aria-label': P('dim') });
    const blur = h('input', { type: 'range', min: String(BLUR.min), max: String(BLUR.max), step: '1', value: String(row.backdrop?.blur ?? BLUR.def), 'aria-label': P('blur') });
    const preview = h('div', { class: 'cp-picker-preview', role: 'img', 'aria-label': P('previewLabel') });
    const note = h('p', { class: 'cl-muted small', role: 'status' });
    const tiles = [];
    const saveBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('save'), P('apply'));
    const settings = () => ({ dim: Number(dim.value), blur: Number(blur.value) });
    function drawPreview() {
      const sample = h('div', { class: 'cp-sample' }, h('span', { class: 'cp-sample-bubble' }, P('sampleText')), h('span', { class: 'cp-sample-bubble is-me' }, P('sampleReply')));
      mount(preview, choice ? backdropLayer(b, previewOf(kind, choice, settings())) : null, choice ? sample : h('span', { class: 'cl-muted' }, P('pickOne')));
      const problem = choice ? checkChoice(planState, kind, row.backdrop, choice) : null;
      note.textContent = problem ? P(`err_${problem}`) : choice && choiceAnimated(choice) ? P('animatedNote') : '';
      saveBtn.disabled = !choice || Boolean(problem);
      for (const tile of tiles) tile.el.setAttribute('aria-pressed', String(choice?.source === tile.choice.source && (tile.choice.id ?? tile.choice.item.id) === (choice.id ?? choice.item?.id)));
    }
    function tile(c, label) {
      const locked = choiceAnimated(c) && !limits.animated;
      const el = h('button', { class: ['cp-tile', locked && 'is-locked'], type: 'button', title: locked ? P('err_plan_animated') : label, 'aria-label': label, 'aria-pressed': 'false',
        onclick: () => { choice = c; drawPreview(); } },
        h('div', { class: 'cp-tile-art' }, backdropLayer(b, previewOf(kind, c, { dim: 0 }), { thumb: true })),
        h('span', { class: 'cp-tile-name ellipsis' }, label),
        choiceAnimated(c) ? h('span', { class: ['badge', locked ? 'warn' : ''] }, locked ? icon('lock') : null, P('animated')) : null);
      tiles.push({ el, choice: c });
      return el;
    }
    const presets = presetsFor(kind).map((p) => tile({ source: 'preset', id: p.id }, P(`preset_${p.id}`)));
    const mine = gallery.map((g) => tile({ source: 'media', item: g }, g.name));
    for (const input of [dim, blur]) input.addEventListener('input', drawPreview);
    saveBtn.addEventListener('click', async () => {
      const done = setBusy(saveBtn);
      try { await save(row, choice, settings(), dlg); } finally { done(); }
    });
    const dlg = modal({
      title: P(kind === 'stage' ? 'pickStageTitle' : 'pickBackdropTitle'), subtitle: row.channel ? row.channel.name : P(kind === 'stage' ? 'scopeAll_stage' : 'scopeAll_chat'), icon: 'palette', size: 'wide',
      body: h('div', { class: 'stack cp-picker' }, preview, note,
        h('div', { class: 'cp-sliders' },
          h('label', {}, h('span', {}, P('dim')), dim), h('label', {}, h('span', {}, P('blur')), blur)),
        h('h4', { class: 'cl-h4' }, P('includedTitle')), h('div', { class: 'cp-tiles' }, presets),
        h('h4', { class: 'cl-h4' }, P('fromGallery')),
        mine.length ? h('div', { class: 'cp-tiles' }, mine) : h('p', { class: 'cl-muted small' }, P('galleryEmpty'))),
      footer: [saveBtn],
    });
    drawPreview();
  }

  function draw() {
    if (closed) return;
    if (failed) {
      mount(body, emptyState('alert', P('unavailable'), P('unavailableText'), h('button', { class: 'btn', type: 'button', onclick: () => { mount(body, skeleton('list', { rows: 4 })); load(); } }, icon('refresh'), P('retry'))));
      return;
    }
    const limits = planState.plan.limits;
    const key = kind === 'stage' ? 'stages' : 'backdrops';
    const rows = scopeRows(community, kind, items);
    const seg = h('div', { class: 'segmented cl-seg', role: 'group', 'aria-label': P('looksTitle') },
      ['chat', 'stage'].map((k) => h('button', { type: 'button', class: k === kind ? 'active' : null, 'aria-pressed': String(k === kind), onclick: () => { kind = k; draw(); } },
        icon(k === 'chat' ? 'hash' : 'headphones'), P(`tab_${k}`))));
    const used = planState.usage[key];
    const row = (r) => {
      const bd = r.backdrop;
      const slotFull = !bd && !hasRoom(planState, key);
      return h('li', { class: ['cp-row', bd && bd.state !== 'ok' && 'is-off'] },
        h('div', { class: 'cp-row-thumb' }, bd ? backdropLayer(b, bd, { thumb: true }) : h('span', { class: 'cp-row-empty' }, icon('image'))),
        h('div', { class: 'cp-row-main' },
          h('strong', { class: 'ellipsis' }, r.channel ? r.channel.name : P(`scopeAll_${kind}`)),
          h('span', { class: 'cl-muted small' }, r.channel ? '' : P(`scopeAllHelp_${kind}`)),
          bd && bd.state !== 'ok' ? h('span', { class: 'badge warn' }, icon('eyeOff'), P(stateKey(bd))) : null),
        h('div', { class: 'row cp-row-actions' },
          h('button', { class: 'btn sm', type: 'button', disabled: slotFull || limits[key] === 0, title: slotFull ? P('err_plan_limit') : null, onclick: () => openPicker(r) }, icon(bd ? 'edit' : 'plus'), P(bd ? 'change' : 'choose')),
          bd ? h('button', { class: 'icon-btn sm', type: 'button', title: P('clear'), 'aria-label': P('clear'), onclick: () => clear(r) }, icon('trash')) : null));
    };
    mount(body, seg,
      h('div', { class: 'cp-looks-head' },
        h('span', { class: 'badge accent num' }, P(kind === 'stage' ? 'stagesUsage' : 'backdropsUsage', { used, max: limits[key] })),
        h('span', { class: 'cl-muted small' }, P('planOf', { plan: planState.plan.id === 'free' ? P('freeName') : P('clanName', { name: planState.plan.name }) })),
        openPlan ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => openPlan() }, icon('crown'), P('seePlans')) : null),
      limits[key] === 0 ? h('div', { class: 'notice info' }, icon('lock'), h('div', {}, P(kind === 'stage' ? 'noStagesNote' : 'noBackdropsNote'))) : null,
      !limits.animated ? h('p', { class: 'cl-muted small' }, icon('sparkles'), ' ', P('stillOnlyNote')) : null,
      h('ul', { class: 'cp-rows' }, rows.map(row)));
  }
  load();
  return m;
}
