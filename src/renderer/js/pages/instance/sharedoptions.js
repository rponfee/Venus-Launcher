// Tarjeta "Ajustes compartidos" de los ajustes de la instancia: prender el perfil maestro en esta instancia, guardarlo
// desde su options.txt, elegir los grupos que se comparten y si un cambio hecho en el juego vuelve al perfil.
// Canales sharedoptions:* (modules/sharedoptions.js); el interruptor es sharedOptions en venus-instance.json.
import { h, icon, mount, ok, fail, confirmDialog, switchEl, setBusy, skeleton, fmtAgo } from '../../ui.js';
import { api } from '../../store.js';
import { t, has } from '../../i18n.js';

const GROUPS = [
  { id: 'controls', icon: 'gamepad' },
  { id: 'fov', icon: 'monitor' },
  { id: 'mouse', icon: 'target' },
  { id: 'audio', icon: 'volume' },
  { id: 'video', icon: 'image' },
  { id: 'chat', icon: 'message' },
  { id: 'accessibility', icon: 'accessibility' },
];

function errorText(err) {
  const key = `instancetools.sharedErr_${err?.code}`;
  return err?.code && has(key) ? t(key) : err?.message || String(err);
}

export function sharedOptionsCard(ctx) {
  const box = h('section', { class: 'card it-shared' });
  let alive = true;
  let data = null;

  const load = async () => {
    try {
      const [status, history] = await Promise.all([api.invoke('sharedoptions:get', ctx.id), api.invoke('sharedoptions:history')]);
      data = { ...status, history };
      if (alive) draw();
    } catch (err) {
      if (alive) mount(box, h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', {}, errorText(err))));
    }
  };

  const setEnabled = async (value) => {
    try {
      ctx.setInstance(await api.instances.update(ctx.id, { sharedOptions: value }));
      load();
    } catch (err) {
      fail(t('instancetools.sharedSaveFailed'), err);
      draw();
    }
  };

  const setPrefs = async (patch) => {
    try {
      data.profile = await api.invoke('sharedoptions:setPrefs', patch);
      load();
    } catch (err) {
      fail(t('instancetools.sharedSaveFailed'), err);
    }
  };

  const saveFrom = async (btn) => {
    const p = data.profile;
    if (p.saved && !(await confirmDialog(t('instancetools.sharedReplaceTitle'), t('instancetools.sharedReplaceText', { name: p.source?.name || '?' }), { okText: t('instancetools.sharedReplaceOk') }))) return;
    const release = setBusy(btn);
    try {
      data.profile = await api.invoke('sharedoptions:saveFrom', ctx.id);
      ok(t('instancetools.sharedSaved'), ctx.inst.name);
      load();
    } catch (err) {
      release();
      fail(t('instancetools.sharedSaveFailed'), errorText(err));
    }
  };

  const undo = async (entry, btn) => {
    if (!(await confirmDialog(t('reliability.sharedHistoryUndo'), t('reliability.sharedHistoryConfirm'), { okText: t('reliability.sharedHistoryUndo') }))) return;
    const release = setBusy(btn);
    try {
      const result = await api.invoke('sharedoptions:undo', entry.id);
      data.profile = result.profile;
      data.history = result.history;
      ok(t('reliability.sharedHistoryRestored'));
      draw();
    } catch (err) {
      fail(t('reliability.sharedHistoryFailed'), errorText(err));
    } finally {
      release();
    }
  };

  function historyView() {
    const entries = (data.history || []).slice(0, 8);
    return h('div', { class: 'it-shared-history' },
      h('h3', { class: 'card-title' }, t('reliability.sharedHistoryTitle')),
      entries.length ? h('ul', { class: 'list' }, entries.map((entry) => {
        const kind = t(`reliability.sharedHistory_${entry.kind}`);
        const name = entry.source?.name || kind;
        const button = h('button', { class: 'btn sm', type: 'button', 'aria-label': t('reliability.sharedHistoryUndoLabel', { name }), onclick: () => undo(entry, button) }, icon('history'), t('reliability.sharedHistoryUndo'));
        return h('li', { class: 'it-shared-history-row' },
          h('span', {}, h('strong', {}, kind), ' · ', name, ' · ', fmtAgo(entry.at)),
          h('span', { class: 'small muted' }, t('reliability.sharedHistoryCount', { count: entry.changed?.length || 0 })),
          button);
      })) : h('p', { class: 'small muted' }, t('reliability.sharedHistoryEmpty')));
  }

  function controlsNote() {
    const { profile: p, instance: inst } = data;
    if (!inst?.enabled || !p.saved || !p.groups.controls) return null;
    if (!inst.format) return h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.sharedFormatMismatch')));
    if (inst.format === 'modern' && !p.modern) return h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.sharedNoModern')));
    if (inst.format === 'legacy' && !p.legacy) return h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.sharedNoLegacy')));
    return null;
  }

  function draw() {
    const { profile: p, instance: inst } = data;
    const saveBtn = h('button', { class: 'btn sm', type: 'button', disabled: !inst?.hasOptions, title: inst?.hasOptions ? null : t('instancetools.sharedErr_noOptions'), onclick: () => saveFrom(saveBtn) }, icon('save'), t('instancetools.sharedSaveFrom'));
    mount(
      box,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, icon('sliders'), t('instancetools.sharedTitle')), h('p', { class: 'card-sub' }, t('instancetools.sharedSub')))),
      h(
        'div',
        { class: 'toggle-row' },
        h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('instancetools.sharedEnable')), h('div', { class: 'tr-sub' }, inst?.enabled ? t('instancetools.sharedEnableOn') : t('instancetools.sharedEnableOff'))),
        switchEl(Boolean(inst?.enabled), setEnabled, t('instancetools.sharedEnable')),
      ),
      p.saved ? null : h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('instancetools.sharedEmpty'))),
      h('div', { class: 'row wrap it-shared-save' }, saveBtn, p.saved ? h('span', { class: 'small muted spacer' }, t('instancetools.sharedSource', { name: p.source?.name || '?', version: p.source?.mcVersion || '?', when: fmtAgo(p.updatedAt) })) : null),
      controlsNote(),
      inst?.running ? h('div', { class: 'small muted' }, t('instancetools.sharedRunning')) : null,
      h('div', { class: 'label it-shared-label' }, t('instancetools.sharedGroups')),
      h(
        'div',
        { class: 'chips it-shared-groups', role: 'group', 'aria-label': t('instancetools.sharedGroups') },
        GROUPS.map((g) => {
          const active = p.groups[g.id] === true;
          return h(
            'button',
            { type: 'button', class: ['chip', active && 'active'], 'aria-pressed': String(active), title: t(`instancetools.sharedGroupHint_${g.id}`), onclick: () => setPrefs({ groups: { [g.id]: !active } }) },
            t(`instancetools.sharedGroup_${g.id}`),
            p.saved && p.counts[g.id] ? h('span', { class: 'vs-chip-count' }, String(p.counts[g.id])) : null,
          );
        }),
      ),
      h(
        'div',
        { class: 'toggle-row' },
        h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('instancetools.sharedSync')), h('div', { class: 'tr-sub' }, t('instancetools.sharedSyncSub'))),
        switchEl(p.syncBack, (v) => setPrefs({ syncBack: v }), t('instancetools.sharedSync')),
      ),
      historyView(),
    );
  }

  mount(box, skeleton('card', { lines: 3 }));
  load();
  box.destroy = () => {
    alive = false;
  };
  return box;
}
