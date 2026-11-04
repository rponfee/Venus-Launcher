// Tarjeta "Avisos por Discord" de los ajustes de un servidor: pegar el webhook, elegir qué avisar y probarlo.
// El webhook no vuelve a la interfaz una vez guardado: solo se ve una máscara. Proceso principal: modules/serverdiscord.js.
// discordCard(serverId) -> Element con .destroy().
import { h, icon, mount, switchEl, setBusy, fail, ok, fmtAgo, confirmDialog } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';

const R = (key, vars) => t(`serverremote.${key}`, vars);
const KINDS = ['started', 'stopped', 'crashed', 'join', 'leave', 'backup'];
const ERRORS = { invalid: 'discordErrInvalid', rejected: 'discordErrInvalid', limit: 'discordErrLimit', overflow: 'discordErrLimit', retries: 'discordErrNetwork' };

export function discordCard(serverId) {
  const el = h('div', { class: 'card sr-card sr-discord' });
  const body = h('div', { class: 'stack sr-body' });
  mount(el, h('h2', { class: 'card-title' }, icon('bell'), R('discordTitle')), h('div', { class: 'card-sub' }, R('discordSub')), body);
  let view = null;
  let alive = true;

  const save = async (patch, msg) => {
    try {
      view = await api.invoke('serverdiscord:set', serverId, patch);
      if (msg) ok(msg);
      return true;
    } catch (err) {
      fail(R('discordErrSave'), err);
      return false;
    }
  };

  function formView() {
    const id = `sr-webhook-${serverId}`;
    const input = h('input', { class: 'input mono priv', id, type: 'password', placeholder: 'https://discord.com/api/webhooks/...', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': `${id}-help` });
    const btn = h('button', { class: 'btn', type: 'button' }, icon('save'), R('discordSave'));
    const submit = async () => {
      const value = input.value.trim();
      if (!value) return input.focus();
      const release = setBusy(btn);
      const saved = await save({ url: value }, R('discordSaved'));
      release();
      if (saved) {
        input.value = '';
        draw();
      }
      return undefined;
    };
    btn.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    return h('div', { class: 'field' }, h('label', { for: id }, R('discordUrlLabel')), h('div', { class: 'row sr-url-row' }, input, btn), h('div', { class: 'field-help', id: `${id}-help` }, R('discordHelp')));
  }

  function configuredView() {
    const testBtn = h('button', { class: 'btn sm', type: 'button' }, icon('send'), R('discordTest'));
    testBtn.addEventListener('click', async () => {
      const release = setBusy(testBtn);
      try {
        await api.invoke('serverdiscord:test', serverId);
        ok(R('discordTestOk'));
      } catch (err) {
        fail(R('discordTestFail'), err);
      } finally {
        release();
        refresh();
      }
    });
    const removeBtn = h('button', { class: 'btn sm ghost', type: 'button' }, icon('trash'), R('discordRemove'));
    removeBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(R('discordRemoveTitle'), R('discordRemoveText'), { danger: true, okText: R('discordRemove') }))) return;
      try {
        view = await api.invoke('serverdiscord:remove', serverId);
        draw();
      } catch (err) {
        fail(R('discordErrSave'), err);
      }
    });
    const error = view.lastError ? R(ERRORS[view.lastError] || 'discordErrNetwork') : null;
    return [
      h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, R('discordEnabled')), h('div', { class: 'tr-sub' }, R('discordEnabledHint'))), switchEl(view.enabled, async (on) => {
        await save({ enabled: on });
        draw();
      }, R('discordEnabled'))),
      h('div', { class: 'sr-kv' }, h('span', { class: 'sr-k' }, R('discordWebhook')), h('span', { class: 'kbd priv sr-v ellipsis', title: view.masked }, view.masked)),
      error ? h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, error)) : null,
      view.enabled
        ? h(
            'div',
            { class: 'sr-events' },
            KINDS.map((k) => h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, R(`discordEvent_${k}`))), switchEl(view.events[k], (on) => save({ events: { [k]: on } }), R(`discordEvent_${k}`)))),
          )
        : null,
      h('div', { class: 'row wrap' }, testBtn, removeBtn, view.lastSentAt ? h('span', { class: 'tiny muted' }, R('discordLastSent', { time: fmtAgo(view.lastSentAt) })) : null),
    ];
  }

  function draw() {
    if (!alive || !view) return;
    mount(
      body,
      view.configured ? configuredView() : formView(),
      view.canEncrypt ? null : h('div', { class: 'notice' }, icon('alert'), h('div', {}, R('discordNoEncrypt'))),
      h('div', { class: 'tiny muted' }, R('discordPrivacy')),
    );
  }

  async function refresh() {
    try {
      const next = await api.invoke('serverdiscord:get', serverId);
      if (!alive) return;
      view = next;
      draw();
    } catch (err) {
      console.warn('[serverdiscord]', err?.message || err);
    }
  }

  const off = api.on('serverdiscord:changed', async (id) => {
    if (id !== serverId || !alive) return;
    // Solo el último error o envío cambian solos: no se redibuja si la persona está por escribir
    if (!el.contains(document.activeElement)) refresh();
  });
  el.destroy = () => {
    alive = false;
    off();
  };
  refresh();
  return el;
}
