// Invitacion a la comunidad, compartida por la bienvenida, el menu y Ajustes.
import { h, icon, fail } from './ui.js';
import { api } from './store.js';
import { t } from './i18n.js';

export const DISCORD_INVITE = 'https://discord.gg/8KuvU5Cswn';
// Página con los fondos de Venus (imágenes y animados): se bajan y se eligen con "Imagen o video" en Apariencia.
export const WALLPAPERS_PAGE = 'https://venus-launcher-fondos.netlify.app/';

export async function openWallpapersPage() {
  try {
    await api.app.openExternal(WALLPAPERS_PAGE);
  } catch (err) {
    fail(t('appearance.moreBgError'), err);
  }
}

export async function openDiscord() {
  try {
    await api.app.openExternal(DISCORD_INVITE);
    return true;
  } catch (err) {
    fail(t('common.discordOpenError'), err);
    return false;
  }
}

export function discordButton({ className = 'btn', label = t('common.discordJoin') } = {}) {
  const button = h(
    'button',
    {
      type: 'button',
      class: className,
      title: `${t('common.discordCommunity')} · ${DISCORD_INVITE}`,
      onclick: async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          await openDiscord();
        } finally {
          button.disabled = false;
        }
      },
    },
    icon('users'),
    h('span', {}, label),
    icon('external'),
  );
  return button;
}
