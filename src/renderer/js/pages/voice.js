// Voice Chat: salas de voz con amigos (WebRTC + Supabase Realtime), ajustes de audio y voz de
// proximidad dentro del juego (Simple Voice Chat).
// Rutas: #/voice (salas), #/voice/audio, #/voice/game, #/voice/join/<codigo>
import { h, icon, mount, registerIcons, skeleton } from '../ui.js';
import { t } from '../i18n.js';
import { cloud } from '../cloud.js';
import { voice } from '../voice.js';
import { VC_ICONS, cloudCta } from '../voice/ui-common.js';
import { lobbyView } from '../voice/ui-lobby.js';
import { roomView } from '../voice/ui-room.js';
import { audioView } from '../voice/ui-audio.js';
import { gameView } from '../voice/ui-game.js';

registerIcons(VC_ICONS);

const TABS = [
  { id: 'rooms', icon: 'users' },
  { id: 'audio', icon: 'sliders' },
  { id: 'game', icon: 'radio' },
];

export default {
  ns: ['voice'],
  css: ['pages/voice'],
  async render(root, params) {
    let tab = TABS.some((x) => x.id === params[0]) ? params[0] : 'rooms';
    let joinCode = params[0] === 'join' ? params[1] : null;
    let mode = null;
    let viewCleanup = null;
    let disposed = false;

    const tabsEl = h('div', { class: 'tabs vc-tabs', role: 'tablist', 'aria-label': t('voice.title'), hidden: true });
    // Mientras arranca el motor, un esqueleto ocupa el lugar del riel de pestañas (sin saltos al aparecer)
    const tabsSkel = h('div', { class: 'skeleton vc-skel-tabs', 'aria-hidden': 'true' });
    const body = h('div', { class: 'vc-body', id: 'vc-panel', role: 'tabpanel' });
    // El encabezado se ve enseguida; mientras arrancan la nube y el motor de voz, un esqueleto
    mount(body, skeleton('grid', { items: 2, min: 320, lines: 4, label: t('voice.loading') }));
    mount(
      root,
      // Mismo armado que las demas paginas con pestañas: encabezado y, debajo, el riel de pestañas
      h('div', { class: 'page-head vc-page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('voice.title')), h('p', { class: 'page-sub' }, t('voice.subtitle')))),
      tabsSkel,
      tabsEl,
      body,
    );
    await Promise.all([voice.init(), cloud.ready()]);
    // Si mientras tanto se fue a otra pagina, no se arma nada
    if (!root.isConnected) return () => {};

    const roomsMode = () => (voice.room ? 'room' : !cloud.isConfigured() ? 'config' : !cloud.isSignedIn() ? 'signin' : 'lobby');

    let tabsKey = '';
    function drawTabs() {
      const inRoom = Boolean(voice.room);
      const key = `${tab}|${inRoom}`;
      if (key === tabsKey) return;
      tabsKey = key;
      const hadFocus = tabsEl.contains(document.activeElement);
      if (tabsEl.hidden) {
        tabsEl.hidden = false;
        tabsSkel.remove();
      }
      mount(
        tabsEl,
        TABS.map((x) =>
          h(
            'button',
            {
              class: ['tab', tab === x.id && 'active'],
              type: 'button',
              role: 'tab',
              id: `vc-tab-${x.id}`,
              'aria-selected': String(tab === x.id),
              'aria-controls': 'vc-panel',
              tabindex: tab === x.id ? 0 : -1,
              onclick: () => select(x.id),
            },
            icon(x.icon),
            t(`voice.tab_${x.id}`),
            x.id === 'rooms' && inRoom ? [h('span', { class: 'vc-tab-live', title: t('voice.inRoomNow'), 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, t('voice.inRoomNow'))] : null,
          ),
        ),
      );
      body.setAttribute('aria-labelledby', `vc-tab-${tab}`);
      // Al redibujar se reemplazan los botones: el foco vuelve a la pestaña elegida
      if (hadFocus) tabsEl.querySelector(`#vc-tab-${tab}`)?.focus();
    }

    // Flechas, Inicio y Fin para moverse entre pestañas (patron de tabs de WAI-ARIA)
    tabsEl.addEventListener('keydown', (e) => {
      const i = TABS.findIndex((x) => x.id === tab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
      else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = TABS.length - 1;
      if (next < 0) return;
      e.preventDefault();
      select(TABS[next].id);
      tabsEl.querySelector(`#vc-tab-${TABS[next].id}`)?.focus();
    });

    function show() {
      try {
        viewCleanup?.();
      } catch (err) {
        console.error('[voice]', err);
      }
      viewCleanup = null;
      mode = tab === 'rooms' ? roomsMode() : tab;
      body.dataset.view = mode;
      if (mode === 'config' || mode === 'signin') cloudCta(body, mode);
      else if (mode === 'room') viewCleanup = roomView(body, { onTab: select });
      else if (mode === 'lobby') {
        viewCleanup = lobbyView(body, { initialCode: joinCode });
        joinCode = null;
      } else if (mode === 'audio') viewCleanup = audioView(body);
      else viewCleanup = gameView(body);
      drawTabs();
    }

    function select(id) {
      if (disposed) return;
      tab = id;
      const hash = id === 'rooms' ? '#/voice' : `#/voice/${id}`;
      if (location.hash !== hash) history.replaceState(null, '', hash);
      show();
      root.scrollTop = 0;
    }

    // Cambia de vista si entro o sali de una sala, o si cambio la sesion de la nube
    const sync = () => {
      if (disposed) return;
      drawTabs();
      if (tab === 'rooms' && roomsMode() !== mode) show();
    };

    show();
    const offs = [voice.on('room', sync), cloud.on('auth', sync), cloud.on('config', sync), cloud.on('profile', sync)];
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      try {
        viewCleanup?.();
      } catch (err) {
        console.error('[voice]', err);
      }
    };
  },
};
