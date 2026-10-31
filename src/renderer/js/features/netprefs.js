// Conexiones opcionales: lo que el launcher haría por su cuenta (sin que el usuario lo pida) queda apagado hasta que
// lo active. Al terminar la bienvenida (o la primera vez que se abre esta versión) aparece un aviso para elegir;
// después se cambia en Ajustes > Privacidad. Ver README > Privacy policy.
//   autoUpdates      buscar e instalar actualizaciones de GitHub al abrir y cada 4 horas
//   news             novedades de Minecraft en Inicio (launchercontent.mojang.com)
//   featuredServers  servidores destacados en Inicio (lista del servidor de Venus + ping a cada servidor)
//   playerHeads      caras de jugadores (mc-heads.net)
// Discord Rich Presence tiene su propio ajuste (settings.discord.enabled), también apagado por defecto.
import { h, icon, modal, switchEl, setPlayerHeads, fail } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs } from '../i18n.js';

export const NET_KEYS = ['autoUpdates', 'news', 'featuredServers', 'playerHeads'];
const N = (key, vars) => t(`common.net_${key}`, vars);

export const netAllowed = (key) => store.settings?.privacy?.[key] === true;

export function setNetAllowed(patch) {
  return store.setSettings({ privacy: patch });
}

/** Tarjeta para activar una conexión desde donde se usa (por ejemplo, las novedades en Inicio). */
export function optInBlock(key, onEnabled) {
  const btn = h('button', { type: 'button', class: 'btn sm' }, icon('wifi'), N('enable'));
  btn.addEventListener('click', async () => {
    try {
      await setNetAllowed({ [key]: true });
      onEnabled?.();
    } catch (err) {
      fail(N('saveError'), err);
    }
  });
  return h('div', { class: 'notice info net-optin' }, icon('shieldCheck'), h('div', { class: 'spacer' }, h('strong', {}, N(`${key}Title`)), h('div', { class: 'small' }, N(`${key}Text`))), btn);
}

let asking = false;

async function ask() {
  if (asking) return;
  asking = true;
  await loadNs('common');
  const choice = Object.fromEntries(NET_KEYS.map((k) => [k, netAllowed(k)]));
  let discord = store.settings?.discord?.enabled === true;
  const row = (key, checked, onChange) => h('div', { class: 'toggle-row' },
    h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, N(`${key}Title`)), h('div', { class: 'tr-sub' }, N(`${key}Text`))),
    switchEl(checked, onChange, N(`${key}Title`)));
  let saved = false;
  const save = async () => {
    if (saved) return;
    saved = true;
    try {
      await store.setSettings({ privacy: { ...choice, decided: true }, discord: { enabled: discord } });
    } catch (err) {
      fail(N('saveError'), err);
    }
  };
  const body = h('div', { class: 'stack' },
    h('p', {}, N('askIntro')),
    NET_KEYS.map((k) => row(k, choice[k], (on) => { choice[k] = on; })),
    row('discord', discord, (on) => { discord = on; }),
    h('p', { class: 'muted small' }, N('askFoot')));
  let dialog;
  const ok = h('button', { type: 'button', class: 'btn primary' }, N('askSave'));
  ok.addEventListener('click', async () => { await save(); dialog.close(); });
  dialog = modal({ title: N('askTitle'), icon: 'shieldCheck', body, footer: [ok], onClose: () => { save(); asking = false; } });
}

function sync() {
  setPlayerHeads(netAllowed('playerHeads'));
  const s = store.settings;
  if (s?.onboarded === true && s?.privacy?.decided !== true) ask();
}

let started = false;
export async function startup() {
  if (started) return sync();
  started = true;
  store.on('settings', sync);
  if (!store.settings) await store.refreshSettings().catch(() => null);
  sync();
}
