// Copias automáticas de mundos: tarjeta de Ajustes → Datos (settings.backups.schedule) y el aviso discreto cuando terminan
// o fallan. La planificación y la copia las hace modules/worldbackups.js; las copias se ven en el detalle de cada mundo.
import { h, icon, mount, toast, fail, ok, selectEl, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { card, toggleRow, note } from '../../pages/settings/shared.js';

const T = (key, vars) => t(`datatools.${key}`, vars);
const DEFAULTS = { enabled: false, frequency: 'daily', everyHours: 6, keep: 5, instances: 'all', onGameClose: false };

const schedule = () => ({ ...DEFAULTS, ...(store.settings?.backups?.schedule || {}) });
const save = (patch) => store.setSettings({ backups: { schedule: { ...schedule(), ...patch } } }).catch((err) => fail(T('saveError'), err));

let started = false;

export function startBackupNotices() {
  if (started) return;
  started = true;
  api.on('worldbackups:done', ({ copied = [], failed = [] } = {}) => {
    if (copied.length) {
      toast('good', T('backupsDone', { count: copied.length }), copied.slice(0, 3).map((c) => c.name).join(', '), 3500);
    }
    if (failed.length) toast('bad', T('backupsFailed', { name: failed[0].name }), failed[0].error, 9000);
  });
}

function numberField(label, value, { min, max, onChange, id }) {
  const input = h('input', { class: 'input dt-num', type: 'number', min, max, value, id });
  input.addEventListener('change', () => {
    const n = Math.round(Number(input.value));
    const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
    input.value = v;
    onChange(v);
  });
  return h('label', { class: 'dt-field', for: id }, h('span', {}, label), input);
}

export function backupsCard() {
  const body = h('div', { class: 'dt-stack' });

  function instancesPicker(s) {
    const box = h('div', { class: 'dt-picks' });
    const list = store.instances || [];
    if (!list.length) return h('p', { class: 'small muted' }, T('backupsNoInstances'));
    const chosen = () => (s.instances === 'all' ? list.map((i) => i.id) : s.instances);
    for (const inst of list) {
      const input = h('input', { type: 'checkbox', checked: chosen().includes(inst.id) });
      input.addEventListener('change', () => {
        const next = new Set(chosen());
        if (input.checked) next.add(inst.id);
        else next.delete(inst.id);
        const all = list.every((i) => next.has(i.id));
        save({ instances: all ? 'all' : [...next] }).then(draw);
      });
      box.append(h('label', { class: 'dt-pick' }, input, h('span', { class: 'ellipsis', title: inst.name }, inst.name)));
    }
    return box;
  }

  function draw() {
    const s = schedule();
    const freq = selectEl(['hours', 'daily', 'weekly'].map((v) => ({ value: v, label: T(`backupsFreq_${v}`) })), s.frequency, (v) => save({ frequency: v }).then(draw));
    const run = h('button', { type: 'button', class: 'btn sm', title: T('backupsRunNowHint') }, icon('archive'), T('backupsRunNow'));
    run.addEventListener('click', async () => {
      const done = setBusy(run);
      try {
        const res = await api.invoke('worldbackups:runNow');
        if (res.queued) ok(T('backupsQueued', { count: res.queued }));
        else toast('info', T('backupsNothing'), null, 3500);
      } catch (err) {
        fail(T('backupsFailedGeneric'), err);
      } finally {
        done();
      }
    });
    mount(
      body,
      toggleRow({ title: T('backupsEnable'), sub: T('backupsEnableSub'), checked: s.enabled, onChange: (v) => save({ enabled: v }).then(draw) }),
      s.enabled
        ? [
            h(
              'div',
              { class: 'dt-row' },
              h('label', { class: 'dt-field' }, h('span', {}, T('backupsFrequency')), freq),
              s.frequency === 'hours' ? numberField(T('backupsEveryHours'), s.everyHours, { min: 1, max: 168, id: 'dt-bk-hours', onChange: (v) => save({ everyHours: v }) }) : null,
              numberField(T('backupsKeep'), s.keep, { min: 1, max: 100, id: 'dt-bk-keep', onChange: (v) => save({ keep: v }) }),
            ),
            toggleRow({ title: T('backupsOnClose'), sub: T('backupsOnCloseSub'), checked: s.onGameClose, onChange: (v) => save({ onGameClose: v }) }),
            h('div', { class: 'dt-label' }, T('backupsWhich')),
            instancesPicker(s),
            note('info', 'info', T('backupsNote')),
            h('div', { class: 'dt-actions' }, run),
          ]
        : null,
    );
  }
  draw();
  return card({ title: T('backupsTitle'), iconName: 'archive', sub: T('backupsSub'), anchor: 'backups-card' }, body);
}
