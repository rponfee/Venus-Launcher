// Integraciones del administrador. Cada tarjeta carga por separado; las claves van al Vault y no se muestran.
// CurseForge se consulta por el servicio de Venus. KLIPY conserva su contrato para pedidos desde los launchers.
import { h, icon, mount, setBusy, ok, fail } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { T, card, errorBox, skeletonRows, field } from './parts.js';

function savedStatus(data) {
  if (!data || typeof data.configured !== 'boolean') throw new Error('bad_status');
  // Solo aceptamos la pista de cuatro caracteres, nunca una clave completa devuelta por error.
  const hint = typeof data.hint === 'string' && /^[A-Za-z0-9_+./=-]{4}$/.test(data.hint) ? data.hint : '';
  return { configured: data.configured, hint };
}

export function render(root) {
  let alive = true;
  async function rpc(name, args) {
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw error;
    return savedStatus(data);
  }

  function integration(id, symbol, canTest = false) {
    const body = h('div', { class: 'stack' });
    const el = card({ title: T(id + 'Title'), icon: symbol, sub: T(id + 'Sub') }, body);
    el.dataset.integration = id;
    let pending = false;
    let input = null;
    const active = () => alive && el.isConnected;

    async function load() {
      if (pending || !active()) return;
      pending = true;
      if (input) input.value = '';
      mount(body, skeletonRows(3));
      try {
        const state = await rpc('admin_' + id + '_status');
        if (active()) draw(state);
      } catch {
        if (active()) mount(body, errorBox({ message: T(id + 'LoadFailed') }, load));
      } finally {
        pending = false;
      }
    }

    function draw(state) {
      input = h('input', { class: 'input mono', type: 'password', value: '', autocomplete: 'off', spellcheck: 'false' });
      const secret = input;
      const status = h('div', { class: 'row wrap', 'aria-live': 'polite' });
      const save = h('button', { class: 'btn primary sm', type: 'button' }, icon('save'), T(id + 'Save'));
      const remove = h('button', { class: 'btn ghost sm', type: 'button' }, icon('trash'), T(id + 'Remove'));
      const check = canTest ? h('button', { class: 'btn sm', type: 'button' }, icon('plug'), T('curseforgeTest')) : null;
      const controls = [secret, save, remove, check].filter(Boolean);
      function unlock() {
        controls.forEach(control => { control.disabled = !active(); });
        remove.disabled = !active() || !state.configured;
        if (check) check.disabled = !active() || !state.configured;
      }
      function showStatus() {
        mount(status, h('span', { class: state.configured ? 'pill' : 'pill warn' },
          icon(state.configured ? 'key' : 'alert'),
          state.configured ? T(state.hint ? id + 'On' : id + 'Saved', { hint: state.hint }) : T(id + 'Off')));
        secret.placeholder = state.configured && state.hint ? T(id + 'KeepHint', { hint: state.hint }) : T(id + 'Placeholder');
        if (canTest) mount(save, icon('save'), T(state.configured ? 'curseforgeReplace' : 'curseforgeSave'));
      }

      async function send(button, value, test = false) {
        if (pending || !active() || ((test || !value) && !state.configured)) return;
        pending = true;
        const done = setBusy(button);
        controls.forEach(control => { control.disabled = true; });
        try {
          if (test) {
            const { data, error } = await cloud.client.functions.invoke('curseforge', { body: { method: 'GET', path: '/v1/mods/search?gameId=432&classId=6&pageSize=1' } });
            if (error || !Array.isArray(data?.data)) {
              let code = data?.error?.code;
              // Solo leemos los códigos propios del proxy; jamás mostramos cuerpos ni mensajes remotos.
              if (error?.context?.status && typeof error.context.clone === 'function') {
                const detail = await error.context.clone().json().catch(() => null);
                code = detail?.error?.code;
              }
              throw Object.assign(new Error('test_failed'), { safeCode: ['badkey', 'forbidden', 'unauthorized', 'rate_limit'].includes(code) ? code : '' });
            }
            if (active()) ok(T('curseforgeTestOk'));
          } else {
            const next = await rpc('admin_set_' + id + '_key', { p_key: value });
            if (!active()) return;
            state = next;
            showStatus();
            ok(T(value ? id + 'Saved' : id + 'Removed'));
          }
        } catch (err) {
          if (active()) {
            // Los errores pueden contener datos de la petición: nunca los pasamos al toast ni a la consola.
            const diagnostics = { badkey: 'curseforgeKeyRejected', forbidden: 'curseforgeAccessDenied', unauthorized: 'curseforgeSessionExpired', rate_limit: 'curseforgeRateLimit' };
            const detail = test && diagnostics[err?.safeCode] ? diagnostics[err.safeCode] : !test && typeof err?.message === 'string' && err.message.includes('bad_key') ? id + 'BadKey' : id + 'RetryHint';
            fail(T(test ? 'curseforgeTestFailed' : id + 'Failed'), T(detail));
          }
        } finally {
          secret.value = '';
          value = '';
          done();
          pending = false;
          unlock();
        }
      }

      save.addEventListener('click', () => {
        if (pending || !active()) return;
        const value = secret.value.trim();
        if (value) return send(save, value);
        secret.value = '';
        secret.focus();
      });
      remove.addEventListener('click', () => send(remove, ''));
      check?.addEventListener('click', () => send(check, '', true));
      showStatus();
      unlock();
      mount(body, status, field(T(id + 'Key'), secret, T(id + 'Help')),
        canTest ? h('p', { class: 'muted small' }, T('curseforgeRemoveHint')) : null,
        h('div', { class: 'row wrap' }, save, remove, check),
        canTest ? h('p', { class: 'muted small' }, T('curseforgeTestHint')) : null);
    }

    return { el, load, clear: () => { if (input) input.value = ''; } };
  }

  const cards = [integration('klipy', 'image'), integration('curseforge', 'package', true)];
  mount(root, cards.map(item => item.el));
  cards.forEach(item => item.load());
  return { destroy() { alive = false; cards.forEach(item => item.clear()); } };
}
