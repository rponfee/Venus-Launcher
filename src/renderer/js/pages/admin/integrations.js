// Pestaña Integraciones: la clave de KLIPY (GIF del banner). Va cifrada al Vault del servidor (admin_set_klipy_key, 0023)
// y nunca vuelve completa. Los launchers la piden con klipy_key porque KLIPY exige que los pedidos salgan de la app.
import { h, icon, mount, setBusy, ok, fail } from '../../ui.js';
import { cloud } from '../../cloud.js';
import { T, card, errorBox, skeletonRows, field } from './parts.js';

export function render(root) {
  async function rpc(name, args) {
    const { data, error } = await cloud.client.rpc(name, args);
    if (error) throw error;
    return data;
  }
  async function load() {
    mount(root, skeletonRows(4));
    let st;
    try {
      st = await rpc('admin_klipy_status');
    } catch (err) {
      if (root.isConnected) mount(root, errorBox(err, load));
      return;
    }
    if (!root.isConnected) return;
    const input = h('input', { class: 'input mono', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: st.configured ? T('klipyKeepHint', { hint: st.hint }) : T('klipyPlaceholder') });
    const save = h('button', { class: 'btn primary sm', type: 'button' }, icon('save'), T('klipySave'));
    const remove = h('button', { class: 'btn ghost sm', type: 'button', disabled: !st.configured }, icon('trash'), T('klipyRemove'));
    const send = async (btn, value) => {
      const done = setBusy(btn);
      try {
        await rpc('admin_set_klipy_key', { p_key: value });
        ok(T(value ? 'klipySaved' : 'klipyRemoved'));
        load();
      } catch (err) {
        fail(T('klipyFailed'), err?.message?.includes('bad_key') ? T('klipyBadKey') : err);
      } finally {
        done();
      }
    };
    save.addEventListener('click', () => {
      const v = input.value.trim();
      if (v) send(save, v);
      else input.focus();
    });
    remove.addEventListener('click', () => send(remove, ''));
    mount(
      root,
      card(
        { title: T('klipyTitle'), icon: 'image', sub: T('klipySub') },
        h('div', { class: 'row wrap' }, st.configured ? h('span', { class: 'pill good' }, icon('check'), T('klipyOn', { hint: st.hint })) : h('span', { class: 'pill warn' }, icon('alert'), T('klipyOff'))),
        field(T('klipyKey'), input, T('klipyHelp')),
        h('div', { class: 'row' }, save, remove),
      ),
    );
  }
  load();
}
