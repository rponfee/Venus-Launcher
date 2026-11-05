// Diagnóstico opcional: la persona lo activa a mano, elige qué partes mandar y ve el texto EXACTO que saldrá (ya sin rutas,
// usuario, correo ni IP: eso lo hace el proceso principal). Nada se envía si no lo tilda.
import { h, icon, mount, loading, copyText } from '../../ui.js';
import { api } from '../../store.js';
import { S, uid, errMsg } from './common.js';
import { LIMITS, counter } from './logic.js';

const KINDS = ['path', 'email', 'ip', 'uuid', 'user', 'host', 'player', 'secret', 'chat'];

// -> { el, value() -> texto | null, chars(), isOn(), reset() }
export function createDiagnosticPicker({ onChange = () => {}, compact = false } = {}) {
  const id = uid('sp-diag');
  let data = null; // última respuesta de support:diagnostic
  let on = false;
  let busy = false;
  const check = h('input', { type: 'checkbox', id: `${id}-on`, 'aria-describedby': `${id}-help` });
  const body = h('div', { class: 'sp-diag-body', id: `${id}-body`, hidden: true });
  const errors = h('div', { class: 'sp-error', role: 'alert' });
  const el = h('section', { class: ['sp-diag', compact && 'compact'], 'aria-labelledby': `${id}-title` },
    h('div', { class: 'sp-diag-head' },
      h('label', { class: 'sp-check', for: `${id}-on` }, check, h('span', {}, h('strong', { id: `${id}-title` }, S('diagTitle')), h('span', { class: 'muted small' }, ` ${S('optional')}`))),
      icon('shieldCheck', 'sp-diag-icon')),
    h('p', { class: 'sp-hint', id: `${id}-help` }, S('diagHelp')), errors, body);

  async function ask(extra = {}) {
    busy = true;
    errors.textContent = '';
    try {
      data = await api.invoke('support:diagnostic', { instanceId: data?.instanceId, lines: data?.lines, ids: data?.selected, ...extra });
    } catch (err) {
      errors.textContent = S('diagFailed', { error: errMsg(err) });
      data = null;
    } finally { busy = false; }
    draw();
    onChange();
  }

  function draw() {
    if (!on) { body.hidden = true; return; }
    body.hidden = false;
    if (!data) { mount(body, busy ? loading(S('diagLoading')) : null); return; }
    const sectionRow = (s) => {
      const box = h('input', { type: 'checkbox', id: `${id}-s-${s.id}`, checked: data.selected.includes(s.id), 'aria-describedby': `${id}-s-${s.id}-d` });
      box.addEventListener('change', () => ask({ ids: [...data.sections.map((x) => x.id)].filter((x) => (x === s.id ? box.checked : data.selected.includes(x))) }));
      return h('li', { class: 'sp-diag-row' }, h('label', { class: 'sp-check', for: box.id }, box,
        h('span', {}, h('strong', {}, S(`diag_${s.id}`)), h('span', { class: 'sp-hint block', id: `${id}-s-${s.id}-d` }, S(`diag_${s.id}_d`)))),
        h('span', { class: 'sp-count' }, S('chars', { used: s.chars, max: LIMITS.diagnostic })));
    };
    const instances = data.instances || [];
    const instanceSelect = instances.length ? h('select', { class: 'select', id: `${id}-inst`, 'aria-label': S('diagInstance'), onchange: (e) => ask({ instanceId: e.target.value }) },
      instances.map((i) => h('option', { value: i.id, selected: i.id === data.instanceId }, `${i.name} (${i.mcVersion || '?'})`))) : null;
    const linesSelect = data.sections.some((s) => s.id === 'log') ? h('select', { class: 'select', id: `${id}-lines`, 'aria-label': S('diagLines'), onchange: (e) => ask({ lines: Number(e.target.value) }) },
      data.linesChoices.map((n) => h('option', { value: n, selected: n === data.lines }, S('diagLinesOption', { count: n })))) : null;
    const c = counter(data.text, LIMITS.diagnostic);
    const kinds = KINDS.filter((k) => data.redactions?.kinds?.[k]).map((k) => `${S(`diagKind_${k}`)} ${data.redactions.kinds[k]}`);
    mount(body,
      instanceSelect || linesSelect ? h('div', { class: 'sp-diag-pick' }, instanceSelect, linesSelect) : null,
      data.sections.length ? h('fieldset', { class: 'sp-diag-sections' }, h('legend', {}, S('diagInclude')), h('ul', {}, data.sections.map(sectionRow))) : h('p', { class: 'muted small' }, S('diagNone')),
      h('div', { class: 'sp-diag-cleaned', 'aria-live': 'polite' }, icon('shield'),
        data.redactions?.total ? S('diagCleaned', { count: data.redactions.total, kinds: kinds.join(', ') }) : S('diagNothingToClean')),
      h('div', { class: 'sp-diag-preview-head' }, h('strong', { id: `${id}-pv` }, S('diagPreview')),
        h('span', { class: 'sp-count', 'data-level': c.level }, S('chars', { used: data.text.length, max: LIMITS.diagnostic })),
        h('span', { class: 'sp-diag-tools' },
          data.text ? h('button', { type: 'button', class: 'btn sm ghost', onclick: () => copyText(data.text, S('diagCopied')) }, icon('copy'), S('diagCopy')) : null,
          h('button', { type: 'button', class: 'btn sm ghost', onclick: () => ask({ refresh: true }) }, icon('refresh'), S('diagRefresh')))),
      data.text
        ? h('pre', { class: 'sp-diag-pre selectable', tabindex: '0', 'aria-labelledby': `${id}-pv` }, data.text)
        : h('p', { class: 'sp-diag-empty muted small' }, S('diagNothingSelected')),
      data.truncated ? h('p', { class: 'sp-hint' }, S('diagTruncated')) : null);
  }

  check.addEventListener('change', () => {
    on = check.checked;
    if (on && !data) { draw(); ask({}); } else { draw(); onChange(); }
  });
  return {
    el,
    // Texto exacto que se manda, o null si no está tildado o no se eligió nada.
    value: () => (on && data?.text ? data.text : null),
    chars: () => (on && data?.text ? data.text.length : 0),
    isOn: () => on,
    reset() { on = false; check.checked = false; data = null; errors.textContent = ''; draw(); onChange(); },
  };
}
