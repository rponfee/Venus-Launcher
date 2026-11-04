// Permiso de la cuenta para sumar horas al clan. Separado de compartir con amigos: nunca cambia ajustes ni envía partidas.
// 0033: clan_me().sharePlaytime; clan_share_playtime({ p_share }) -> { sharePlaytime }. Sin ese contrato queda inhabilitado.
import { h, icon, confirmDialog } from '../../ui.js';
import { t } from '../../i18n.js';
import { groupsBackend, errText } from './backend.js';

const C = (key) => t(`clans.${key}`);

export function clanSharingCard({ b: supplied = null, onChanged } = {}) {
  let b = supplied, user = null, share = false, ready = false, busy = false, closed = false;
  const input = h('input', { type: 'checkbox', checked: false, disabled: true, 'aria-label': C('sharePlaytimeToggle') });
  const status = h('p', { class: 'field-help', role: 'status' }, C('sharePlaytimeLoading'));
  const retry = h('button', { type: 'button', class: 'btn sm', hidden: true, onclick: () => load() }, icon('refresh'), C('retry'));
  const el = h('section', { class: 'card', dataset: { clanSharing: 'true' } },
    h('h2', { class: 'card-title' }, icon('shield'), C('sharePlaytimeTitle')),
    h('p', { class: 'card-sub' }, C('sharePlaytimeDetail')),
    h('p', { class: 'card-sub' }, C('sharePlaytimeRequirements')),
    h('p', { class: 'card-sub' }, C('sharePlaytimeMinimum')),
    h('div', { class: 'toggle-row' },
      h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, C('sharePlaytimeToggle')), h('div', { class: 'tr-sub' }, C('sharePlaytimeDefault'))),
      h('label', { class: 'switch' }, input, h('span', { class: 'track' }))),
    status, retry);
  const active = () => !closed && el.isConnected && b?.signedIn() && b.userId() === user;
  function draw() {
    input.checked = share;
    input.disabled = busy || !ready;
    retry.disabled = busy;
    retry.hidden = ready;
  }
  async function load() {
    if (closed || busy) return;
    busy = true;
    ready = false;
    draw();
    status.textContent = C('sharePlaytimeLoading');
    try {
      b ||= await groupsBackend();
      user = b.userId();
      if (!b.signedIn()) throw { code: 'noSession' };
      const data = await b.rpc('clan_me');
      if (!active()) return;
      if (typeof data?.sharePlaytime !== 'boolean') throw { code: 'unavailable' };
      share = data.sharePlaytime;
      ready = true;
      status.textContent = C(share ? 'sharePlaytimeOn' : 'sharePlaytimeOff');
    } catch (err) {
      if (!closed && el.isConnected) status.textContent = `${C('sharePlaytimeUnknown')} ${errText(err)}`;
    } finally {
      busy = false;
      if (!closed) draw();
    }
  }
  input.addEventListener('change', async () => {
    const next = input.checked;
    input.checked = share;
    if (!active() || !ready || busy || next === share) return;
    busy = true;
    draw();
    try {
      if (next && !(await confirmDialog(C('sharePlaytimeToggle'), [C('sharePlaytimeDetail'), C('sharePlaytimeRequirements'), C('sharePlaytimeMinimum')].join('\n\n'), { okText: C('sharePlaytimeAllow') }))) return;
      if (!active()) return;
      const data = await b.rpc('clan_share_playtime', { p_share: next });
      if (!active()) return;
      if (typeof data?.sharePlaytime !== 'boolean' || data.sharePlaytime !== next) throw { code: 'server' };
      share = data.sharePlaytime;
      status.textContent = C(share ? 'sharePlaytimeOn' : 'sharePlaytimeOff');
      Promise.resolve().then(() => onChanged?.()).catch(() => {});
    } catch (err) {
      if (!active()) return;
      // Una respuesta perdida puede haber guardado el cambio: no darlo por confirmado hasta volver a consultar.
      ready = false;
      status.textContent = `${C('sharePlaytimeUnknown')} ${errText(err)}`;
    } finally {
      busy = false;
      if (!closed) draw();
    }
  });
  el.destroy = () => { closed = true; };
  load();
  return el;
}
