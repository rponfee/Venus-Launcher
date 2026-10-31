// Inicio: panel principal del launcher.
// Arriba, la instancia elegida con JUGAR; debajo, accesos rápidos y dos columnas: a la izquierda
// "Continuar donde quedaste" (mundos recientes y "Volver a entrar" al último servidor donde jugaste),
// servidores destacados, capturas y novedades de Minecraft; a la derecha
// tu servidor, amigos en línea, tu actividad y consejos. Cada bloque usa datos de otro módulo
// (mundos, estadísticas, multijugador, social): si todavía no existe o no tiene datos, el bloque
// se oculta solo y el resto se reacomoda. La lógica pura vive en ./home/logic.js.
import {
  h,
  icon,
  mount,
  modal,
  fail,
  loaderBadge,
  loaderVersionLabel,
  instanceIcon,
  instanceLoaderKey,
  fmtAgo,
  fmtDate,
  fmtDuration,
  fmtNumber,
  safeHtml,
  skeleton,
  copyText,
  avatarImg,
  switchEl,
  registerIcons,
  LOADERS,
} from '../ui.js';
import { store, api } from '../store.js';
import { netAllowed, optInBlock } from '../features/netprefs.js';
import { t, locale } from '../i18n.js';
import { navigate, launchInstance, openAccounts, playtimeLabel } from '../app.js';
import { social } from '../social.js';
import { cloud } from '../cloud.js';
import {
  isMissingHandler,
  imgUrl,
  splitAddress,
  pingKey,
  latencyClass,
  summarize,
  lastSevenDays,
  normalizePing,
  motdSegments,
  motdPlain,
  normalizeFriend,
  sortFriends,
  newsImageUrl,
  sortNews,
  gameModeKey,
} from './home/logic.js';

registerIcons({
  hmBulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  hmSignal: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/>',
});

const LIVE_MS = 45000; // ping de servidores (tu servidor y destacados)
const TICK_MS = 30000; // textos relativos: "hace 5 min", "en juego hace..."
const TIP_MS = 12000; // cada cuanto rota un consejo (lo marca la barrita del propio consejo)
const PING_TTL = 40000;
const NEWS_TTL = 10 * 60000;

const MAIN_BLOCKS = ['worlds', 'featured', 'screenshots', 'news'];
const RAIL_BLOCKS = ['server', 'friends', 'stats', 'tips'];
const BLOCKS = ['quick', ...MAIN_BLOCKS, ...RAIL_BLOCKS];
const CUSTOMIZABLE = ['quick', 'worlds', 'server', 'friends', 'featured', 'stats', 'screenshots', 'news', 'tips'];

// Color de cada acceso: siempre tokens (el violeta del buscador sale de mezclar --info y --bad, asi sigue al tema)
const QUICK = [
  { id: 'new', icon: 'plus', route: 'versions/new', color: 'var(--accent)' },
  { id: 'modrinth', icon: 'package', route: 'modrinth', color: 'var(--modrinth)' },
  { id: 'smartsearch', icon: 'sparkles', route: 'smartsearch', color: 'color-mix(in oklch, var(--info), var(--bad))' },
  { id: 'servers', icon: 'server', route: 'servers', color: 'var(--info)' },
  { id: 'voice', icon: 'mic', route: 'voice', color: 'var(--good)' },
  { id: 'worlds', icon: 'globe', route: 'worlds', color: 'var(--warn)' },
  { id: 'multiplayer', icon: 'wifi', route: 'multiplayer', color: 'var(--accent-hi)' },
];

// Consejos que enseñan funciones del launcher (titulo/texto/accion en home.tip_<id>_*)
const TIPS = [
  { id: 'crash', icon: 'bug' },
  { id: 'snapshots', icon: 'history', route: 'versions' },
  { id: 'share', icon: 'share', route: 'versions' },
  { id: 'map', icon: 'map', route: 'worlds' },
  { id: 'smartsearch', icon: 'sparkles', route: 'smartsearch' },
  { id: 'quickplay', icon: 'play' },
  { id: 'voice', icon: 'mic', route: 'voice' },
  { id: 'servers', icon: 'server', route: 'servers' },
  { id: 'netplay', icon: 'network' },
  { id: 'performance', icon: 'gauge', route: 'performance' },
  { id: 'compat', icon: 'shieldCheck' },
  { id: 'security', icon: 'shield' },
  { id: 'translate', icon: 'languages' },
  { id: 'cloudsync', icon: 'cloud' },
  { id: 'stats', icon: 'chart', route: 'stats' },
  { id: 'customize', icon: 'sliders', customize: true },
];

// Estado que sobrevive entre visitas a la pagina (evita repetir pings y lecturas)
const pingCache = new Map(); // direccion -> { at, data, error, missing }
const pingInflight = new Map();
const pingQueue = [];
let pingActive = 0;
let newsCache = null; // { at, entries }
let newsFilter = 'all';
let tipIndex = Math.floor(Math.random() * TIPS.length);

// ---------- Utilidades de interfaz ----------

function warn(scope, err) {
  if (!isMissingHandler(err)) console.warn(`[home] ${scope}:`, err?.message || err);
}

// <img> que se reemplaza por otro elemento si no carga (archivo borrado, sin conexion)
function fallbackImg(src, fallback, cls) {
  const img = h('img', { class: cls, src, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

// Mantiene el foco del teclado cuando se vuelve a dibujar un bloque (los elementos llevan data-fk)
function keepFocus(container, fn) {
  const active = document.activeElement;
  const key = active && container.contains(active) ? active.dataset?.fk : null;
  fn();
  if (key) container.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
}

const shortDur = (ms) => (ms >= 3600000 ? fmtDuration(ms, { short: true }) : fmtDuration(ms));

// ---------- Ping de servidores (cache compartido + maximo 3 a la vez) ----------

function runLimited(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      pingActive++;
      Promise.resolve()
        .then(fn)
        .then(resolve, reject)
        .finally(() => {
          pingActive--;
          pingQueue.shift()?.();
        });
    };
    if (pingActive < 3) start();
    else pingQueue.push(start);
  });
}

function pingServer(address, force = false) {
  const key = pingKey(address);
  const cached = pingCache.get(key);
  if (!force && cached && Date.now() - cached.at < PING_TTL) return Promise.resolve(cached);
  if (pingInflight.has(key)) return pingInflight.get(key);
  const p = runLimited(() => api.invoke('serverlist:ping', address))
    .then((data) => ({ at: Date.now(), data: normalizePing(data), error: null, missing: false }))
    .catch((err) => ({ at: Date.now(), data: null, error: err, missing: isMissingHandler(err) }))
    .then((r) => {
      pingCache.set(key, r);
      pingInflight.delete(key);
      return r;
    });
  pingInflight.set(key, p);
  return p;
}

// MOTD con sus colores (solo textContent y colores validados)
function motdEl(motd, cls) {
  const segs = motdSegments(motd);
  if (!segs.some((s) => s.text.trim())) return null;
  return h(
    'div',
    { class: cls, title: motdPlain(motd) },
    segs.map((s) => {
      const style = {};
      if (s.color) style.color = s.color;
      if (s.bold) style.fontWeight = '700';
      if (s.italic) style.fontStyle = 'italic';
      const deco = [s.underline && 'underline', s.strike && 'line-through'].filter(Boolean).join(' ');
      if (deco) style.textDecoration = deco;
      return h('span', { style }, s.text);
    }),
  );
}

// ---------- Amigos (contrato de social.js: friends + presenceOf) ----------

function friendList() {
  let list = [];
  try {
    if (Array.isArray(social.friends)) list = social.friends;
  } catch {
    list = [];
  }
  const presenceOf = typeof social.presenceOf === 'function' ? (id) => social.presenceOf(id) : null;
  return sortFriends(list.map((f) => normalizeFriend(f, presenceOf)).filter(Boolean));
}

// ---------- Novedades ----------

function newsImg(e, cls) {
  const src = newsImageUrl(e);
  const ph = () => h('span', { class: `${cls} hm-news-ph` }, h('img', { src: 'assets/logo-256.png', alt: '' }));
  return src ? fallbackImg(src, ph, cls) : ph();
}

const typeBadge = (e) => h('span', { class: ['badge', e.type === 'release' ? 'good' : 'accent'] }, e.type === 'release' ? t('home.newsRelease') : t('home.newsSnapshot'));

// ---------- Componentes comunes ----------

// Mismo titulo de seccion que el resto del launcher (.section-title), con el icono en un recuadro
function sectionHead(iconName, title, extra) {
  return h(
    'div',
    { class: 'section-title hm-st' },
    h('span', { class: 'hm-st-icon', 'aria-hidden': 'true' }, icon(iconName)),
    h('h2', { class: 'st-text hm-st-text' }, title),
    h('span', { class: 'st-line', 'aria-hidden': 'true' }),
    extra || null,
  );
}

function cardHead(iconName, title, extra) {
  return h('div', { class: 'hm-card-head' }, h('h2', { class: 'hm-card-title' }, icon(iconName), h('span', { class: 'ellipsis' }, title)), extra || null);
}

function moreLink(label, route, fk) {
  return h('button', { class: 'hm-more', onclick: () => navigate(route), dataset: fk ? { fk } : undefined }, label, icon('chevronRight'));
}

// ===================================================================================

export default {
  ns: ['home'],
  css: ['pages/home'],
  render(root) {
    let alive = true;
    const offs = [];
    const timers = [];
    const sub = (off) => {
      if (typeof off === 'function') offs.push(off);
    };

    // Estado de esta visita
    const activities = {}; // instanceId -> actividad del juego
    let shareMod = null;
    let heroState = { id: null, mode: null };
    let worldsRaw = [];
    let worlds = [];
    let worldsLoaded = false; // hasta la primera lectura se muestra un esqueleto (si hay instancias)
    let rejoin = null; // ultimo servidor donde jugaste: { address, name, at }
    let featured = [];
    const fsRows = new Map();
    let shots = [];
    let newsError = null;
    let lightbox = null;
    let friendsTimer = null;
    let afterGameTimer = null;
    let statsTimer = null;
    let stale = false;

    // ---------- Estructura ----------
    const els = Object.fromEntries(BLOCKS.map((id) => [id, h('section', { class: ['hm-block', `hm-b-${id}`], hidden: true })]));
    const heroPlanet = h('img', { class: 'hero-planet hm-planet', src: 'assets/logo.png', alt: '' });
    const heroContent = h('div', { class: 'hero-content hm-hero-content' });
    const heroEl = h('section', { class: 'hero hm-hero' }, heroPlanet, heroContent);
    const mainCol = h('div', { class: 'hm-main' }, MAIN_BLOCKS.map((id) => els[id]));
    const railCol = h('aside', { class: 'hm-rail', 'aria-label': t('home.railLabel') }, RAIL_BLOCKS.map((id) => els[id]));
    const cols = h('div', { class: 'hm-cols' }, mainCol, railCol);
    const foot = h('div', { class: 'hm-foot' }, h('button', { class: 'btn ghost sm', onclick: () => openCustomize() }, icon('sliders'), t('home.customize')));
    mount(root, h('div', { class: 'hm' }, heroEl, els.quick, cols, foot));

    // Bloques disponibles (con datos) y ocultos por el usuario. "Continuar" y "Tu actividad" arrancan con un
    // esqueleto (asi el resto no salta cuando llegan los datos) y se ocultan solos si no hay nada que mostrar.
    const avail = { quick: true, worlds: store.instances.length > 0, featured: false, screenshots: false, news: true, server: false, friends: true, stats: true, tips: true };
    const hiddenByUser = () => new Set(Array.isArray(store.settings?.home?.hidden) ? store.settings.home.hidden : []);
    function applyVisibility() {
      const hidden = hiddenByUser();
      for (const id of BLOCKS) els[id].hidden = !avail[id] || hidden.has(id);
      const anyMain = MAIN_BLOCKS.some((id) => !els[id].hidden);
      const anyRail = RAIL_BLOCKS.some((id) => !els[id].hidden);
      cols.hidden = !anyMain && !anyRail;
      cols.classList.toggle('no-main', !anyMain);
      cols.classList.toggle('no-rail', !anyRail);
    }
    function setAvail(id, value) {
      avail[id] = value;
      applyVisibility();
    }

    // ---------- Acciones compartidas ----------

    async function joinAddress(address, name) {
      let mod = null;
      try {
        mod = await import('../features/serverlist.js');
      } catch (err) {
        console.warn('[home] serverlist:', err);
      }
      if (typeof mod?.joinServer === 'function') {
        try {
          // el nombre queda en el historial de servidores (lo usa "Volver a entrar")
          await mod.joinServer(address, name && name !== address ? { name } : {});
        } catch (err) {
          fail(t('home.joinFailed'), err);
        }
        return;
      }
      // Respaldo: entrar con la instancia elegida usando Quick Play
      const inst = store.selectedInstance();
      if (!inst) {
        fail(t('home.joinFailed'), t('home.noInstanceToJoin'));
        return;
      }
      const { host, port } = splitAddress(address);
      launchInstance(inst.id, { quickPlay: { server: host, port } });
    }

    async function openMap(w) {
      try {
        const mod = await import('../features/worldmap.js');
        await mod.openWorldMap(w.instanceId, w.folder);
      } catch (err) {
        fail(t('home.mapFailed'), err);
      }
    }

    async function importPack() {
      try {
        const mod = await import('../features/packs.js');
        await mod.openImportPack();
      } catch (err) {
        fail(t('home.importFailed'), err);
      }
    }

    function playWorld(w) {
      if (!store.selectedAccount()) {
        openAccounts({ welcome: true });
        return;
      }
      if (store.settings?.selectedInstance !== w.instanceId) store.setSettings({ selectedInstance: w.instanceId }).catch(() => {});
      launchInstance(w.instanceId, { quickPlay: { world: w.folder } });
    }

    function stopInstance(id) {
      api.instances.stop(id).catch((err) => fail(t('home.stopFailed'), err));
    }

    // ---------- Heroe: instancia elegida + JUGAR ----------

    function heroMode(inst) {
      if (!inst) return 'empty';
      const run = store.running[inst.id];
      if (run?.state === 'running') return 'running';
      if (run?.state === 'preparing' || store.taskFor(inst.id)) return 'preparing';
      return 'idle';
    }

    function greeting(acc) {
      const hr = new Date().getHours();
      const part = hr >= 6 && hr < 12 ? 'Morning' : hr >= 12 && hr < 20 ? 'Afternoon' : 'Evening';
      return acc?.name ? t(`home.greet${part}Name`, { name: acc.name }) : t(`home.greet${part}`);
    }

    function activityText(id) {
      const act = activities[id];
      if (!act || typeof act !== 'object') return null;
      if (act.type === 'server' && act.address) return t('home.activityServer', { address: act.address });
      if (act.type === 'singleplayer') {
        if (!act.world) return t('home.activitySingleplayer');
        const w = worlds.find((x) => x.instanceId === id && x.folder === act.world);
        return t('home.activityWorld', { world: w?.name || act.world });
      }
      if (act.type === 'menu') return t('home.activityMenu');
      return null;
    }

    function prepInfo(inst) {
      const task = store.taskFor(inst.id);
      const pct = task?.progress !== null && task?.progress !== undefined ? Math.max(0, Math.min(100, Math.round(task.progress * 100))) : null;
      return { task, pct };
    }

    function playButton(inst, mode) {
      if (mode === 'running') {
        return h('button', { class: 'play-btn stop hm-play', dataset: { fk: 'play' }, onclick: () => stopInstance(inst.id) }, icon('stop'), h('span', {}, t('home.stop')));
      }
      if (mode === 'preparing') {
        const { pct } = prepInfo(inst);
        return h(
          'button',
          { class: 'play-btn hm-play is-busy', disabled: true, 'aria-busy': 'true', 'aria-label': pct !== null ? t('home.preparingPct', { pct }) : t('home.preparing'), dataset: { fk: 'play' } },
          h('span', { class: 'spinner hm-play-spin' }),
          h('span', {}, t('home.preparing')),
        );
      }
      return h(
        'button',
        {
          class: 'play-btn hm-play',
          dataset: { fk: 'play' },
          onclick: () => {
            if (!store.selectedAccount()) openAccounts({ welcome: true });
            else launchInstance(inst.id);
          },
        },
        icon('play'),
        h('span', {}, t('home.play')),
      );
    }

    function heroStatus(inst, mode, acc) {
      if (mode === 'running') {
        const run = store.running[inst.id] || {};
        const act = activityText(inst.id);
        return h(
          'div',
          { class: 'hm-live', role: 'status' },
          h('span', { class: 'hm-live-dot', 'aria-hidden': 'true' }),
          run.startedAt
            ? h('span', { class: 'hm-live-time', dataset: { since: String(run.startedAt) } }, t('home.runningFor', { time: fmtDuration(Date.now() - run.startedAt) }))
            : h('span', { class: 'hm-live-time' }, t('home.runningNow')),
          act ? h('span', { class: 'hm-live-act' }, act) : null,
        );
      }
      if (mode === 'preparing') {
        const { task, pct } = prepInfo(inst);
        return h(
          'div',
          { class: 'hm-prep' },
          h(
            'div',
            { class: ['progress', pct === null && 'indeterminate'], role: 'progressbar', 'aria-label': t('home.preparing'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct ?? undefined },
            h('i', { style: { width: `${pct || 0}%` } }),
          ),
          h(
            'div',
            { class: 'hm-prep-line' },
            h('span', { class: 'hm-prep-pct' }, pct !== null ? `${pct}%` : ''),
            h('span', { class: 'hm-prep-detail', title: task?.detail || task?.title || '' }, task?.detail || task?.title || t('home.preparingWait')),
          ),
        );
      }
      if (!acc) {
        // Aviso secundario: el boton principal de la vista es JUGAR / CREAR
        return h(
          'div',
          { class: 'hm-noacc' },
          icon('user'),
          h('span', { class: 'hm-noacc-text' }, t('home.noAccount')),
          h('button', { class: 'btn sm tonal', dataset: { fk: 'add-account' }, onclick: () => openAccounts({ welcome: true }) }, icon('plus'), t('home.addAccount')),
        );
      }
      return null;
    }

    function drawHero() {
      const inst = store.selectedInstance();
      const acc = store.selectedAccount();
      const mode = heroMode(inst);
      heroState = { id: inst?.id || null, mode };
      heroEl.classList.toggle('is-running', mode === 'running');
      const greet = h('div', { class: 'hero-greet hm-greet' }, greeting(acc));
      if (!inst) {
        mount(
          heroContent,
          greet,
          h('h1', { class: 'hero-title hm-title' }, t('home.heroEmptyTitle')),
          h('p', { class: 'hm-hero-text' }, t('home.heroEmptyText')),
          h(
            'div',
            { class: 'hero-actions' },
            h('button', { class: 'play-btn hm-play', dataset: { fk: 'create' }, onclick: () => navigate('versions/new') }, icon('plus'), h('span', {}, t('home.create'))),
            h(
              'div',
              { class: 'hm-hero-alt' },
              h('button', { class: 'btn', dataset: { fk: 'explore' }, onclick: () => navigate('modrinth') }, icon('package'), t('home.exploreModpacks')),
              h('button', { class: 'btn ghost', dataset: { fk: 'import' }, onclick: importPack }, icon('download'), t('home.importPack')),
            ),
          ),
          heroStatus(null, 'empty', acc),
        );
        return;
      }
      const pack = inst.modrinth?.pack;
      let group = null;
      try {
        group = shareMod?.groupBadge?.(inst) || null;
      } catch (err) {
        console.warn('[home] groupBadge:', err);
      }
      mount(
        heroContent,
        greet,
        h('h1', { class: 'hero-title hm-title', title: inst.name }, inst.name),
        h(
          'div',
          { class: 'hero-meta hm-badges' },
          h('span', { class: 'badge' }, icon('box'), t('home.mcVersion', { version: inst.mcVersion })),
          loaderBadge(instanceLoaderKey(inst), loaderVersionLabel(inst)),
          pack ? h('span', { class: 'badge modrinth', title: pack.name || '' }, icon('package'), pack.version ? t('home.modpackVersion', { version: pack.version }) : t('home.modpack')) : null,
          group instanceof Node ? group : null,
        ),
        h(
          'div',
          { class: 'hm-meta' },
          h('span', {}, icon('clock'), h('span', {}, playtimeLabel(inst))),
          inst.lastPlayed
            ? h('span', {}, icon('history'), h('span', { dataset: { ago: String(inst.lastPlayed), agoKey: 'home.lastPlayed' } }, t('home.lastPlayed', { ago: fmtAgo(inst.lastPlayed) })))
            : null,
          inst.launches ? h('span', {}, icon('gamepad'), h('span', {}, t('home.launches', { count: inst.launches }))) : null,
        ),
        h(
          'div',
          { class: 'hero-actions' },
          playButton(inst, mode),
          h(
            'button',
            { class: 'instance-picker hm-picker', dataset: { fk: 'picker' }, onclick: openPicker, title: t('home.changeInstance'), 'aria-haspopup': 'dialog' },
            instanceIcon(inst, 'ip-icon'),
            h('span', { class: 'spacer hm-picker-text' }, h('span', { class: 'ip-name ellipsis' }, inst.name), h('span', { class: 'ip-sub' }, t('home.instancesCount', { count: store.instances.length }))),
            icon('chevronDown'),
          ),
          h('button', { class: 'icon-btn', dataset: { fk: 'manage' }, title: t('home.manageInstance'), 'aria-label': t('home.manageInstance'), onclick: () => navigate(`instance/${inst.id}`) }, icon('settings')),
          h(
            'button',
            {
              class: 'icon-btn',
              dataset: { fk: 'folder' },
              title: t('home.openInstanceFolder'),
              'aria-label': t('home.openInstanceFolder'),
              onclick: () => api.instances.openFolder(inst.id).catch((err) => fail(t('home.showFailed'), err)),
            },
            icon('folder'),
          ),
        ),
        heroStatus(inst, mode, acc),
      );
    }

    const redrawHero = () => keepFocus(heroEl, drawHero);

    // Progreso de "Preparando": se actualiza sin redibujar todo el heroe
    function patchHeroTask(task) {
      const inst = store.selectedInstance();
      if (!inst || task?.meta?.instanceId !== inst.id) return;
      const mode = heroMode(inst);
      if (mode !== heroState.mode || inst.id !== heroState.id) {
        redrawHero();
        return;
      }
      if (mode !== 'preparing') return;
      const { task: cur, pct } = prepInfo(inst);
      heroEl.querySelector('.hm-play.is-busy')?.setAttribute('aria-label', pct !== null ? t('home.preparingPct', { pct }) : t('home.preparing'));
      const pctEl = heroEl.querySelector('.hm-prep-pct');
      if (pctEl) pctEl.textContent = pct !== null ? `${pct}%` : '';
      const bar = heroEl.querySelector('.hm-prep .progress');
      if (bar) {
        bar.classList.toggle('indeterminate', pct === null);
        if (bar.firstChild) bar.firstChild.style.width = `${pct || 0}%`;
        if (pct !== null) bar.setAttribute('aria-valuenow', String(pct));
        else bar.removeAttribute('aria-valuenow');
      }
      const detail = heroEl.querySelector('.hm-prep-detail');
      const info = cur || task;
      if (detail) {
        detail.textContent = info?.detail || info?.title || t('home.preparingWait');
        detail.title = info?.detail || info?.title || '';
      }
    }

    // Selector de instancia (busqueda + flechas del teclado)
    function openPicker() {
      const list = h('div', { class: 'hm-pick-list', role: 'listbox', 'aria-label': t('home.pickTitle') });
      const search = store.instances.length > 6 ? h('input', { class: 'input', type: 'search', placeholder: t('home.pickSearch'), 'aria-label': t('home.pickSearch') }) : null;
      const current = store.selectedInstance()?.id;
      const choose = async (inst) => {
        m.close();
        if (inst.id !== current) {
          try {
            await store.setSettings({ selectedInstance: inst.id });
          } catch (err) {
            fail(t('home.customizeSaveFailed'), err);
          }
        }
      };
      const draw = () => {
        const q = (search?.value || '').trim().toLowerCase();
        const items = store.instances.filter((i) => !q || `${i.name} ${i.mcVersion} ${i.loader}`.toLowerCase().includes(q));
        if (!items.length) {
          mount(list, h('div', { class: 'hm-pick-empty' }, t('home.pickNoResults')));
          return;
        }
        mount(
          list,
          items.map((i) => {
            const running = store.running[i.id]?.state === 'running';
            const loader = LOADERS[instanceLoaderKey(i)]?.name || i.loader;
            return h(
              'button',
              { class: ['hm-pick', i.id === current && 'active'], role: 'option', 'aria-selected': String(i.id === current), onclick: () => choose(i) },
              instanceIcon(i),
              h(
                'span',
                { class: 'hm-pick-main' },
                h('span', { class: 'hm-pick-name', title: i.name }, i.name),
                h(
                  'span',
                  { class: 'hm-pick-sub' },
                  i.lastPlayed ? t('home.pickSub', { version: i.mcVersion, loader, ago: fmtAgo(i.lastPlayed) }) : t('home.pickSubNew', { version: i.mcVersion, loader }),
                ),
              ),
              running
                ? h('span', { class: 'badge good' }, h('span', { class: 'status-dot online' }), t('home.inGame'))
                : i.id === current
                  ? h('span', { class: 'badge accent' }, icon('check'), t('home.selected'))
                  : null,
            );
          }),
        );
      };
      list.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const items = [...list.querySelectorAll('.hm-pick')];
        const at = items.indexOf(document.activeElement);
        const next = items[e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1)];
        if (next) {
          e.preventDefault();
          next.focus();
        }
      });
      search?.addEventListener('input', draw);
      search?.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          list.querySelector('.hm-pick')?.focus();
        } else if (e.key === 'Enter') {
          list.querySelector('.hm-pick')?.click();
        }
      });
      draw();
      const m = modal({
        title: t('home.pickTitle'),
        body: h('div', { class: 'stack hm-pick-body' }, search, list),
        footer: [
          h('button', { class: 'btn ghost', onclick: () => (m.close(), navigate('versions')) }, t('home.seeAllInstances')),
          h('button', { class: 'btn', onclick: () => (m.close(), navigate('versions/new')) }, icon('plus'), t('home.newInstance')),
        ],
      });
      setTimeout(() => (search || list.querySelector('.hm-pick.active') || list.querySelector('.hm-pick'))?.focus(), 40);
    }

    // ---------- Accesos rapidos ----------

    function drawQuick() {
      mount(
        els.quick,
        h(
          'nav',
          { class: 'hm-qa-grid', 'aria-label': t('home.quickTitle') },
          QUICK.map((q) =>
            h(
              'button',
              { class: 'hm-qa', style: { '--qa': q.color }, title: t(`home.qa_${q.id}_sub`), onclick: () => navigate(q.route) },
              h('span', { class: 'hm-qa-icon' }, icon(q.icon)),
              h('span', { class: 'hm-qa-title' }, t(`home.qa_${q.id}`)),
              h('span', { class: 'hm-qa-sub' }, t(`home.qa_${q.id}_sub`)),
            ),
          ),
        ),
      );
    }

    // ---------- Continuar donde quedaste (mundos recientes + Quick Play) ----------

    function modeInfo(mode, hardcore) {
      const key = gameModeKey(mode, hardcore);
      return key ? { key, label: t(`home.mode_${key}`) } : null;
    }

    function normWorld(w) {
      if (!w || typeof w !== 'object' || !w.instanceId || !w.folder) return null;
      const inst = store.instances.find((i) => i.id === w.instanceId);
      if (!inst) return null; // la instancia ya no existe
      return {
        instanceId: String(w.instanceId),
        folder: String(w.folder),
        name: String(w.name || w.folder).slice(0, 80),
        instanceName: String(w.instanceName || inst.name),
        version: w.version ? String(w.version).slice(0, 30) : inst.mcVersion || '',
        lastPlayed: Number(w.lastPlayed) || 0,
        icon: imgUrl(w.icon),
        mode: modeInfo(w.gameMode, w.hardcore),
      };
    }

    function worldCard(w) {
      const running = Boolean(store.running[w.instanceId]);
      const letter = () => h('span', { class: 'hm-world-letter' }, (w.name.trim().charAt(0) || '?').toUpperCase());
      return h(
        'article',
        { class: ['hm-world', running && 'running'] },
        w.icon ? fallbackImg(w.icon, () => h('span'), 'hm-world-bg') : null,
        h('div', { class: 'hm-world-top' }, h('div', { class: 'hm-world-icon' }, w.icon ? fallbackImg(w.icon, letter) : letter()), h('h3', { class: 'hm-world-name', title: w.name }, w.name)),
        h(
          'div',
          { class: 'hm-world-info' },
          h('div', { class: 'hm-world-sub', title: w.instanceName }, w.version ? t('home.worldSub', { instance: w.instanceName, version: w.version }) : w.instanceName),
          h(
            'div',
            { class: 'hm-world-meta' },
            w.mode ? h('span', { class: ['hm-mode', `hm-mode-${w.mode.key}`] }, w.mode.label) : null,
            w.lastPlayed ? h('span', { class: 'hm-world-ago', dataset: { ago: String(w.lastPlayed) } }, fmtAgo(w.lastPlayed)) : null,
          ),
        ),
        h(
          'div',
          { class: 'hm-world-actions' },
          h(
            'button',
            {
              class: 'btn sm tonal hm-world-play',
              disabled: running,
              dataset: { fk: `wp-${w.instanceId}/${w.folder}` },
              'aria-label': t('home.playWorld', { world: w.name }),
              title: t('home.playWorld', { world: w.name }),
              onclick: () => playWorld(w),
            },
            icon('play'),
            running ? t('home.inGame') : t('home.playShort'),
          ),
          h(
            'button',
            { class: 'icon-btn sm', dataset: { fk: `wm-${w.instanceId}/${w.folder}` }, title: t('home.viewMap'), 'aria-label': t('home.viewMapOf', { world: w.name }), onclick: () => openMap(w) },
            icon('map'),
          ),
        ),
      );
    }

    // "Volver a entrar": el ultimo servidor donde jugaste (historial del modulo multijugador).
    // No se repite si es "Tu servidor", que ya tiene su boton en la columna derecha.
    function rejoinTarget() {
      if (!rejoin) return null;
      const own = branding().address;
      return own && pingKey(own) === pingKey(rejoin.address) ? null : rejoin;
    }

    function rejoinCard(r) {
      const p = pingCache.get(pingKey(r.address)) || null;
      const state = serverState(p);
      const d = state === 'online' ? p.data : null;
      const label = { checking: 'home.serverChecking', unknown: 'home.serverUnknown', offline: 'home.serverOffline', online: 'home.serverOnline' }[state];
      const named = r.name && r.name !== r.address;
      return h(
        'article',
        { class: 'hm-world hm-rejoin' },
        h(
          'div',
          { class: 'hm-world-top' },
          h('div', { class: 'hm-world-icon hm-rejoin-icon' }, d?.favicon ? fallbackImg(d.favicon, () => icon('server')) : icon('server')),
          h('h3', { class: 'hm-world-name', title: r.name || r.address }, r.name || r.address),
        ),
        h(
          'div',
          { class: 'hm-world-info' },
          h('div', { class: 'hm-world-sub', title: r.address }, named ? r.address : t('home.rejoinLast')),
          h(
            'div',
            { class: 'hm-world-meta' },
            h('span', { class: 'hm-rejoin-state' }, h('span', { class: ['hm-dot', state] }), t(label)),
            r.at ? h('span', { class: 'hm-world-ago', dataset: { ago: String(r.at) } }, fmtAgo(r.at)) : null,
          ),
        ),
        h(
          'div',
          { class: 'hm-world-actions' },
          h(
            'button',
            {
              class: 'btn sm tonal hm-world-play',
              dataset: { fk: 'rejoin' },
              'aria-label': t('home.rejoinAria', { name: r.name || r.address }),
              title: t('home.rejoinAria', { name: r.name || r.address }),
              onclick: () => joinAddress(r.address, r.name),
            },
            icon('play'),
            t('home.rejoin'),
          ),
          h(
            'button',
            { class: 'icon-btn sm', dataset: { fk: 'rejoin-copy' }, title: t('home.copyAddress', { address: r.address }), 'aria-label': t('home.copyAddress', { address: r.address }), onclick: () => copyText(r.address, t('home.addressCopied')) },
            icon('copy'),
          ),
        ),
      );
    }

    // Esqueleto con la forma de las tarjetas de mundo (icono, nombre, dos lineas y el boton)
    function worldsSkeleton() {
      const card = () =>
        h(
          'div',
          { class: 'hm-world hm-world-skel', 'aria-hidden': 'true' },
          h('div', { class: 'hm-world-top' }, h('span', { class: 'skeleton hm-sk-icon' }), h('span', { class: 'skeleton skeleton-line hm-sk-name' })),
          h('div', { class: 'skeleton-lines' }, h('span', { class: 'skeleton skeleton-line' }), h('span', { class: 'skeleton skeleton-line' })),
          h('span', { class: 'skeleton hm-sk-btn' }),
        );
      return h('div', { class: 'hm-worlds', role: 'status', 'aria-busy': 'true' }, card(), card(), card(), h('span', { class: 'sr-only' }, t('common.loading')));
    }

    function drawWorlds() {
      if (!worldsLoaded) {
        const waiting = store.instances.length > 0;
        if (waiting && !els.worlds.querySelector('.hm-world-skel')) mount(els.worlds, sectionHead('history', t('home.continueTitle')), worldsSkeleton());
        setAvail('worlds', waiting);
        return;
      }
      worlds = worldsRaw.map(normWorld).filter(Boolean).slice(0, 6);
      const server = rejoinTarget();
      if (!worlds.length && !server) {
        mount(els.worlds);
        setAvail('worlds', false);
        return;
      }
      const cards = server ? [rejoinCard(server), ...worlds.slice(0, 5).map(worldCard)] : worlds.map(worldCard);
      keepFocus(els.worlds, () => mount(els.worlds, sectionHead('history', t('home.continueTitle'), moreLink(t('home.seeAllWorlds'), 'worlds', 'worlds-more')), h('div', { class: 'hm-worlds' }, cards)));
      setAvail('worlds', true);
    }

    async function loadRejoin() {
      let list = null;
      try {
        list = await api.invoke('serverlist:history');
      } catch (err) {
        warn('serverlist:history', err);
      }
      if (!alive) return;
      const last = (Array.isArray(list) ? list : []).find((x) => x && x.kind === 'join' && typeof x.address === 'string' && x.address.trim());
      rejoin = last ? { address: last.address.trim(), name: typeof last.name === 'string' && last.name.trim() ? last.name.trim().slice(0, 64) : null, at: Number(last.at) || 0 } : null;
      drawWorlds();
      pingRejoin(false);
    }

    function pingRejoin(force) {
      const r = rejoinTarget();
      if (r) pingServer(r.address, force).then(() => alive && rejoin === r && drawWorlds());
    }

    async function loadWorlds() {
      let list = null;
      try {
        list = await api.invoke('worlds:recent', 6);
      } catch (err) {
        warn('worlds:recent', err);
      }
      if (!alive) return;
      worldsRaw = Array.isArray(list) ? list : [];
      worldsLoaded = true;
      drawWorlds();
    }

    // ---------- Tu servidor (branding) ----------

    function branding() {
      const b = store.settings?.branding;
      const address = typeof b?.server === 'string' ? b.server.trim() : '';
      const name = typeof b?.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 48) : address;
      return { address, name };
    }

    function serverState(r) {
      if (!r) return 'checking';
      if (r.missing) return 'unknown';
      return r.error || !r.data?.online ? 'offline' : 'online';
    }

    function metricChips(d) {
      if (!d) return [];
      const players =
        d.playersOnline !== null
          ? h(
              'span',
              {
                class: 'hm-metric',
                title: d.playersMax ? t('home.playersAria', { online: fmtNumber(d.playersOnline), max: fmtNumber(d.playersMax) }) : t('home.playersOnlineAria', { online: fmtNumber(d.playersOnline) }),
              },
              icon('users'),
              d.playersMax ? t('home.playersCount', { online: fmtNumber(d.playersOnline), max: fmtNumber(d.playersMax) }) : fmtNumber(d.playersOnline),
            )
          : null;
      const latency = d.latency !== null ? h('span', { class: ['hm-metric', latencyClass(d.latency)], title: t('home.latencyTitle') }, icon('hmSignal'), t('home.latency', { ms: d.latency })) : null;
      const ver = d.mcVersion || d.version;
      const version = ver ? h('span', { class: 'hm-metric hm-metric-ver', title: t('home.versionTitle', { version: d.version || ver }) }, icon('box'), h('span', { class: 'ellipsis' }, ver)) : null;
      return [players, latency, version];
    }

    function playersSample(d) {
      const shown = d.sample.slice(0, 6);
      const extra = Math.max(0, (d.playersOnline || 0) - shown.length);
      return h(
        'div',
        { class: 'hm-sample', role: 'group', 'aria-label': t('home.playersSampleAria') },
        shown.map((name) => h('span', { class: 'hm-sample-head', title: name }, avatarImg(name, 32, ''))),
        extra > 0 ? h('span', { class: 'hm-sample-more' }, t('home.morePlayers', { count: fmtNumber(extra) })) : null,
      );
    }

    function drawServer() {
      const { address, name } = branding();
      if (!address) {
        mount(els.server);
        setAvail('server', false);
        return;
      }
      const r = pingCache.get(pingKey(address)) || null;
      const state = serverState(r);
      const d = state === 'online' ? r.data : null;
      const label = { checking: 'home.serverChecking', unknown: 'home.serverUnknown', offline: 'home.serverOffline', online: 'home.serverOnline' }[state];
      const motd = d ? motdEl(d.motd, 'hm-motd-text') : null;
      keepFocus(els.server, () =>
        mount(
          els.server,
          h(
            'div',
            { class: ['card', 'hm-card', 'hm-srv', `is-${state}`] },
            h(
              'div',
              { class: 'hm-srv-top' },
              h('div', { class: 'hm-srv-icon' }, d?.favicon ? h('img', { src: d.favicon, alt: '' }) : icon('server')),
              h(
                'div',
                { class: 'hm-srv-id' },
                h('div', { class: 'hm-srv-eyebrow' }, h('span', { class: 'hm-eyebrow' }, t('home.yourServer')), h('span', { class: ['hm-srv-state', state], role: 'status' }, h('span', { class: ['hm-dot', state] }), t(label))),
                h('h2', { class: 'hm-srv-name', title: name }, name),
                h(
                  'button',
                  { class: 'hm-srv-addr', dataset: { fk: 'srv-copy' }, title: t('home.copyAddress', { address }), 'aria-label': t('home.copyAddress', { address }), onclick: () => copyText(address, t('home.addressCopied')) },
                  h('span', { class: 'ellipsis' }, address),
                  icon('copy'),
                ),
              ),
            ),
            d ? h('div', { class: 'hm-srv-metrics' }, metricChips(d).filter(Boolean)) : null,
            motd ? h('div', { class: 'hm-motd' }, motd) : null,
            d?.sample?.length ? playersSample(d) : null,
            h(
              'button',
              { class: ['btn', 'block', 'hm-srv-join', state !== 'offline' && 'tonal'], dataset: { fk: 'srv-join' }, 'aria-label': t('home.joinServer', { name }), onclick: () => joinAddress(address, name) },
              icon('play'),
              t('home.join'),
            ),
          ),
        ),
      );
      setAvail('server', true);
    }

    function refreshServer(force) {
      const { address } = branding();
      drawServer();
      if (!address) return;
      pingServer(address, force).then(() => alive && drawServer());
    }

    // ---------- Servidores destacados ----------

    function patchFeaturedRow(row, r) {
      const d = r?.data && !r.error ? r.data : null;
      const iconSrc = imgUrl(row.s.icon) || d?.favicon || null;
      if (iconSrc !== row.iconSrc) {
        row.iconSrc = iconSrc;
        mount(row.icon, iconSrc ? fallbackImg(iconSrc, () => icon('server')) : icon('server'));
      }
      const desc = row.s.description ? motdEl(row.s.description, 'hm-fs-motd') : d?.motd ? motdEl(d.motd, 'hm-fs-motd') : null;
      mount(row.desc, desc);
      const state = serverState(r);
      row.join?.classList.toggle('tonal', state !== 'offline');
      if (state === 'checking') mount(row.metrics, h('span', { class: 'skeleton skeleton-line hm-skel-metric', 'aria-hidden': 'true' }), h('span', { class: 'skeleton skeleton-line hm-skel-metric short', 'aria-hidden': 'true' }));
      else if (state === 'unknown') mount(row.metrics, h('span', { class: 'hm-metric muted' }, t('home.serverUnknown')));
      else if (state === 'offline') mount(row.metrics, h('span', { class: 'hm-metric bad' }, h('span', { class: 'hm-dot offline' }), t('home.serverOffline')));
      else mount(row.metrics, metricChips(d));
    }

    function featuredRow(s) {
      const address = s.address.trim();
      const name = String(s.name || address).slice(0, 64);
      const tags = Array.isArray(s.tags) ? s.tags.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3) : [];
      const row = {
        s,
        iconSrc: undefined,
        icon: h('div', { class: 'hm-fs-icon' }),
        desc: h('div', { class: 'hm-fs-desc' }),
        metrics: h('div', { class: 'hm-fs-metrics' }),
        join: h('button', { class: 'btn sm tonal hm-fs-join', title: address, 'aria-label': t('home.joinServer', { name }), onclick: () => joinAddress(address, name) }, icon('play'), t('home.join')),
      };
      fsRows.set(pingKey(address), row);
      patchFeaturedRow(row, pingCache.get(pingKey(address)) || null);
      return h(
        'div',
        { class: 'hm-fs-row' },
        row.icon,
        h(
          'div',
          { class: 'hm-fs-main' },
          h('div', { class: 'hm-fs-name-row' }, h('h3', { class: 'hm-fs-name', title: name }, name), tags.length ? h('div', { class: 'hm-tags' }, tags.map((x) => h('span', { class: 'hm-tag' }, x.trim().slice(0, 20)))) : null),
          row.desc,
        ),
        row.metrics,
        row.join,
      );
    }

    function drawFeatured() {
      fsRows.clear();
      if (!featured.length) {
        mount(els.featured);
        setAvail('featured', false);
        return;
      }
      mount(els.featured, sectionHead('star', t('home.featuredTitle'), moreLink(t('home.seeAllServers'), 'multiplayer', 'featured-more')), h('div', { class: 'card hm-fs' }, featured.map(featuredRow)));
      setAvail('featured', true);
    }

    function pingFeatured(force) {
      for (const s of featured) {
        pingServer(s.address.trim(), force).then((r) => {
          const row = alive && fsRows.get(pingKey(s.address));
          if (row) patchFeaturedRow(row, r);
        });
      }
    }

    async function loadFeatured() {
      // Lista del servidor de Venus + ping a cada servidor: solo si el usuario lo activó (netprefs.js).
      if (!netAllowed('featuredServers')) {
        featured = [];
        fsRows.clear();
        mount(els.featured, sectionHead('star', t('home.featuredTitle')), optInBlock('featuredServers', () => alive && loadFeatured()));
        setAvail('featured', true);
        return;
      }
      let list = null;
      try {
        list = await api.invoke('serverlist:featured');
      } catch (err) {
        warn('serverlist:featured', err);
      }
      if (!alive) return;
      const own = pingKey(branding().address);
      featured = (Array.isArray(list) ? list : [])
        .filter((s) => s && typeof s.address === 'string' && s.address.trim() && pingKey(s.address) !== own)
        .slice(0, 5);
      drawFeatured();
      pingFeatured(false);
    }

    // ---------- Amigos en linea ----------

    function friendSub(f) {
      if (!f.online) return { text: f.lastSeen ? t('home.friendSeen', { ago: fmtAgo(f.lastSeen) }) : t('home.status_offline'), ago: f.lastSeen };
      const a = f.activity;
      if (a?.type === 'server' && a.address) return { text: t('home.friendOnServer', { address: a.address }), playing: true };
      if (a?.instance) return { text: t('home.friendPlaying', { name: a.instance }), playing: true };
      if (a?.type === 'singleplayer') return { text: t('home.friendInWorld'), playing: true };
      if (a?.type === 'menu' || a) return { text: a.version ? t('home.friendPlayingVersion', { version: a.version }) : t('home.friendInMenu'), playing: true };
      if (f.statusText) return { text: f.statusText };
      return { text: t(`home.status_${f.status}`) };
    }

    function friendRow(f) {
      const sub = friendSub(f);
      const canJoin = f.online && f.activity?.type === 'server' && f.activity.address;
      return h(
        'div',
        { class: ['hm-friend', f.online ? 'online' : 'offline'] },
        h(
          'button',
          { class: 'hm-friend-main', dataset: { fk: `f-${f.id}` }, title: t('home.friendMessage', { name: f.name }), onclick: () => openFriendChat(f) },
          h('span', { class: 'hm-av' }, avatarImg(f.avatar, 64, 'hm-av-img'), h('span', { class: ['status-dot', 'hm-sd', f.online && 'online', `st-${f.status}`], title: t(`home.status_${f.status}`) })),
          h(
            'span',
            { class: 'hm-friend-text' },
            h('span', { class: 'hm-friend-name' }, f.name),
            h('span', { class: ['hm-friend-sub', sub.playing && 'playing'], dataset: sub.ago ? { ago: String(sub.ago), agoKey: 'home.friendSeen' } : undefined }, sub.text),
          ),
        ),
        canJoin
          ? h(
              'button',
              { class: 'icon-btn sm hm-friend-join', dataset: { fk: `fj-${f.id}` }, title: t('home.friendJoin', { name: f.name }), 'aria-label': t('home.friendJoin', { name: f.name }), onclick: () => joinAddress(f.activity.address) },
              icon('logIn'),
            )
          : null,
      );
    }

    // social.openChat abre Mensajes por su cuenta (contrato del modulo social)
    function openFriendChat(f) {
      if (typeof social.openChat === 'function') Promise.resolve(social.openChat(f.id)).catch((err) => console.warn('[home] openChat:', err));
      else navigate(`messages/${encodeURIComponent(f.id)}`);
    }

    function friendsCta(iconName, title, text, label, route) {
      return h(
        'div',
        { class: 'hm-cta' },
        h('div', { class: 'hm-cta-icon', 'aria-hidden': 'true' }, icon(iconName)),
        h('h3', { class: 'hm-cta-title' }, title),
        h('p', { class: 'hm-cta-text' }, text),
        h('button', { class: 'btn sm tonal', dataset: { fk: 'friends-cta' }, onclick: () => (typeof route === 'function' ? route() : navigate(route)) }, label, icon(typeof route === 'function' ? 'refresh' : 'arrowRight')),
      );
    }

    function drawFriends() {
      const friends = friendList();
      const online = friends.filter((f) => f.online);
      let body;
      if (friends.length) {
        const shown = online.length ? online.slice(0, 6) : friends.slice(0, 3);
        const rest = friends.length - shown.length;
        body = [
          online.length ? null : h('p', { class: 'hm-friends-none' }, t('home.friendsNoneOnline')),
          h('div', { class: 'hm-friends' }, shown.map(friendRow)),
          h(
            'button',
            { class: 'hm-more hm-friends-more', dataset: { fk: 'friends-more' }, onclick: () => navigate('messages') },
            rest > 0 ? t('home.friendsMore', { count: rest }) : t('home.seeAllFriends'),
            icon('chevronRight'),
          ),
        ];
      } else {
        let configured = false;
        let signedIn = false;
        try {
          configured = cloud.isConfigured();
          signedIn = cloud.isSignedIn();
        } catch {
          /* nube no disponible */
        }
        const state = typeof social.state === 'string' ? social.state : '';
        const retry = () => social.retry?.();
        if (!configured || state === 'disabled') body = friendsCta('clock', t('home.friendsUnavailableTitle'), t('home.friendsUnavailableText'), t('home.friendsRetry'), retry);
        else if (!signedIn || state === 'signedOut') body = friendsCta('logIn', t('home.friendsSignInTitle'), t('home.friendsSignInText'), t('home.friendsSignInBtn'), 'settings/cloud/venus');
        else if (state === 'loading' || state === 'idle') body = h('div', { class: 'hm-friends-skel' }, skeleton('list', { rows: 3 }));
        else if (state === 'missingSchema') body = friendsCta('clock', t('home.friendsUnavailableTitle'), t('home.friendsUnavailableText'), t('home.friendsRetry'), retry);
        else body = friendsCta('userPlus', t('home.friendsEmptyTitle'), t('home.friendsEmptyText'), t('home.friendsAdd'), 'messages');
      }
      keepFocus(els.friends, () =>
        mount(
          els.friends,
          h(
            'div',
            { class: 'card hm-card hm-fr' },
            cardHead('users', t('home.friendsTitle'), friends.length ? h('span', { class: ['pill', online.length && 'good'] }, h('span', { class: ['hm-dot', online.length ? 'online' : 'idle'] }), t('home.friendsOnline', { count: online.length })) : null),
            body,
          ),
        ),
      );
      setAvail('friends', true);
    }

    const scheduleFriends = () => {
      clearTimeout(friendsTimer);
      friendsTimer = setTimeout(() => alive && drawFriends(), 150);
    };

    // ---------- Tu actividad ----------

    function favoriteName(fav) {
      if (!fav) return null;
      const id = typeof fav === 'string' ? fav : fav.id || fav.instanceId;
      const inst = id ? store.instances.find((i) => i.id === id) : null;
      if (inst) return inst.name;
      if (typeof fav === 'object' && typeof fav.name === 'string') return fav.name;
      return typeof fav === 'string' ? fav : null;
    }

    function weekChart(days) {
      const max = Math.max(...days.map((d) => d.ms), 1);
      const total = days.reduce((a, d) => a + d.ms, 0);
      const wd = new Intl.DateTimeFormat(locale(), { weekday: 'narrow' });
      return h(
        'div',
        { class: 'hm-week', role: 'img', 'aria-label': t('home.weekAria', { time: fmtDuration(total) }) },
        days.map((d, i) =>
          h(
            'div',
            { class: ['hm-wbar', i === days.length - 1 && 'today', d.ms === 0 && 'zero'], title: t('home.dayTip', { day: fmtDate(d.start, { weekday: 'long', day: 'numeric', month: 'short' }), time: fmtDuration(d.ms) }) },
            h('div', { class: 'hm-wbar-track' }, h('i', { style: { height: `${d.ms ? Math.max(8, Math.round((d.ms / max) * 100)) : 0}%` } })),
            h('span', { 'aria-hidden': 'true' }, wd.format(new Date(d.start))),
          ),
        ),
      );
    }

    // Esqueleto de "Tu actividad" mientras se leen las estadisticas (tres cifras y el grafico de la semana)
    function drawStatsSkeleton() {
      mount(
        els.stats,
        h(
          'div',
          { class: 'card hm-card hm-stats' },
          cardHead('chart', t('home.statsTitle')),
          h(
            'div',
            { role: 'status', 'aria-busy': 'true' },
            h('span', { class: 'sr-only' }, t('common.loading')),
            h('div', { class: 'hm-kpis', 'aria-hidden': 'true' }, [0, 1, 2].map(() => h('span', { class: 'skeleton hm-sk-kpi' }))),
            h('span', { class: 'skeleton hm-sk-week', 'aria-hidden': 'true' }),
          ),
        ),
      );
    }

    function drawStats(sum, days) {
      const head = cardHead('chart', t('home.statsTitle'), moreLink(t('home.seeStats'), 'stats', 'stats-more'));
      const totalMs = Number(sum.totalMs) || 0;
      if (!(totalMs > 0) && !(Number(sum.sessions) > 0)) {
        mount(els.stats, h('div', { class: 'card hm-card hm-stats' }, head, h('div', { class: 'hm-stats-empty' }, h('div', { class: 'hm-cta-icon', 'aria-hidden': 'true' }, icon('gamepad')), h('p', {}, t('home.statsEmpty')))));
        setAvail('stats', true);
        return;
      }
      const streak = Math.max(0, Math.round(Number(sum.streak) || 0));
      const fav = favoriteName(sum.favoriteInstance);
      const kpi = (value, label, cls, title) => h('div', { class: ['hm-kpi', cls], title }, h('div', { class: 'hm-kpi-value' }, value), h('div', { class: 'hm-kpi-label' }, label));
      mount(
        els.stats,
        h(
          'div',
          { class: 'card hm-card hm-stats' },
          head,
          h(
            'div',
            { class: 'hm-kpis' },
            kpi(shortDur(Number(sum.weekMs) || 0), t('home.thisWeek')),
            kpi([icon('flame'), h('span', {}, String(streak))], t('home.streakLabel', { count: streak }), streak > 0 ? 'streak on' : 'streak', t('home.streakTip')),
            kpi(shortDur(totalMs), t('home.total')),
          ),
          days ? weekChart(days) : null,
          h(
            'div',
            { class: 'hm-stats-foot' },
            streak > 0 && sum.playedToday === false ? h('span', { class: 'hm-risk' }, icon('flame'), t('home.streakAtRisk')) : null,
            h('span', {}, icon('clock'), t('home.todayPlayed', { time: fmtDuration(Number(sum.todayMs) || 0) })),
            fav ? h('span', { title: fav }, icon('star'), h('span', { class: 'ellipsis' }, t('home.favorite', { name: fav }))) : null,
          ),
        ),
      );
      setAvail('stats', true);
    }

    async function loadStats() {
      const [sumR, rawR] = await Promise.allSettled([api.invoke('stats:summary'), api.invoke('stats:get')]);
      if (!alive) return;
      if (sumR.status === 'rejected') warn('stats:summary', sumR.reason);
      const sessions = rawR.status === 'fulfilled' && Array.isArray(rawR.value?.sessions) ? rawR.value.sessions : null;
      let sum = sumR.status === 'fulfilled' && sumR.value && typeof sumR.value === 'object' ? sumR.value : null;
      if (!sum && sessions) sum = summarize(sessions);
      if (!sum) {
        mount(els.stats);
        setAvail('stats', false);
        return;
      }
      drawStats(sum, sessions ? lastSevenDays(sessions) : null);
    }

    // ---------- Consejos ----------

    function drawTips(animate) {
      const idx = ((tipIndex % TIPS.length) + TIPS.length) % TIPS.length;
      const tip = TIPS[idx];
      const go = (delta) => {
        tipIndex = idx + delta;
        keepFocus(els.tips, () => drawTips(true));
      };
      let action = null;
      if (tip.route) action = h('button', { class: 'btn sm hm-tip-action', dataset: { fk: 'tip-action' }, onclick: () => navigate(tip.route) }, t(`home.tip_${tip.id}_action`), icon('arrowRight'));
      else if (tip.customize) action = h('button', { class: 'btn sm hm-tip-action', dataset: { fk: 'tip-action' }, onclick: () => openCustomize() }, icon('sliders'), t(`home.tip_${tip.id}_action`));
      // La barrita marca el tiempo hasta el proximo consejo; se pausa con el mouse o el foco encima
      const progress = h('div', { class: 'hm-tip-progress', style: { animationDuration: `${TIP_MS}ms` }, 'aria-hidden': 'true' });
      progress.addEventListener('animationend', () => alive && go(1));
      mount(
        els.tips,
        h(
          'div',
          { class: 'card hm-card hm-tip' },
          cardHead(
            'hmBulb',
            t('home.tipsTitle'),
            h(
              'div',
              { class: 'hm-tip-nav' },
              h('button', { class: 'icon-btn sm', dataset: { fk: 'tip-prev' }, title: t('home.tipPrev'), 'aria-label': t('home.tipPrev'), onclick: () => go(-1) }, icon('chevronLeft')),
              h('span', { class: 'hm-tip-count' }, t('home.tipCounter', { index: idx + 1, total: TIPS.length })),
              h('button', { class: 'icon-btn sm', dataset: { fk: 'tip-next' }, title: t('home.tipNext'), 'aria-label': t('home.tipNext'), onclick: () => go(1) }, icon('chevronRight')),
            ),
          ),
          h(
            'div',
            { class: ['hm-tip-body', animate && 'hm-tip-in'] },
            h('div', { class: 'hm-tip-icon' }, icon(tip.icon)),
            h('div', { class: 'hm-tip-main' }, h('h3', { class: 'hm-tip-title' }, t(`home.tip_${tip.id}_title`)), h('p', { class: 'hm-tip-text' }, t(`home.tip_${tip.id}_text`)), action),
          ),
          progress,
        ),
      );
    }

    // ---------- Capturas recientes + visor ----------

    function normShot(s) {
      if (!s || typeof s !== 'object') return null;
      const src = imgUrl(s.url) || imgUrl(s.path);
      if (!src) return null;
      const inst = store.instances.find((i) => i.id === s.instanceId);
      const date = s.date ? new Date(s.date).getTime() || null : null;
      return {
        src,
        thumb: imgUrl(s.thumb) || imgUrl(s.thumbnail) || src, // miniatura opcional (si el modulo de mundos la ofrece)
        path: typeof s.path === 'string' ? s.path : null,
        date,
        world: typeof s.world === 'string' && s.world.trim() ? s.world.trim().slice(0, 80) : null,
        instanceName: inst?.name || (typeof s.instanceName === 'string' ? s.instanceName : null),
      };
    }

    function shotLabel(s) {
      const date = s.date ? fmtDate(s.date, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      return s.world ? t('home.shotOpen', { world: s.world, date }) : t('home.shotOpenNoWorld', { date });
    }

    // Cuadricula de 4 capturas (3 en columnas angostas, lo decide el CSS). La ultima visible muestra "+N"
    // si hay mas; el visor recorre todas las cargadas.
    function drawShots() {
      if (!shots.length) {
        mount(els.screenshots);
        setAvail('screenshots', false);
        return;
      }
      const total = shots.length;
      const more = (n, cls) => (n > 0 ? h('span', { class: ['hm-shot-more', cls], 'aria-hidden': 'true' }, t('home.shotsMore', { count: n })) : null);
      keepFocus(els.screenshots, () =>
        mount(
          els.screenshots,
          sectionHead('camera', t('home.shotsTitle'), moreLink(t('home.seeAllShots'), 'worlds/media', 'shots-more')),
          h(
            'div',
            { class: 'hm-shots' },
            shots.map((s, i) =>
              h(
                'button',
                { class: 'hm-shot', dataset: { fk: `shot-${i}` }, 'aria-label': shotLabel(s), title: s.world || s.instanceName || '', onclick: () => openLightbox(i) },
                fallbackImg(s.thumb, () => h('span', { class: 'hm-shot-missing' }, icon('image')), 'hm-shot-img'),
                h('span', { class: 'hm-shot-cap', 'aria-hidden': 'true' }, s.world || s.instanceName || (s.date ? fmtDate(s.date) : '')),
                i === 3 ? more(total - 4, 'wide') : null,
                i === 2 ? more(total - 3, 'narrow') : null,
              ),
            ),
          ),
        ),
      );
      setAvail('screenshots', true);
    }

    async function loadShots() {
      let list = null;
      try {
        list = await api.invoke('worlds:screenshots', { limit: 8 });
      } catch (err) {
        warn('worlds:screenshots', err);
      }
      if (!alive) return;
      shots = (Array.isArray(list) ? list : []).map(normShot).filter(Boolean).slice(0, 8);
      drawShots();
    }

    function closeLightbox() {
      lightbox?.close();
    }

    function openLightbox(index) {
      closeLightbox();
      const list = shots.slice();
      if (!list.length) return;
      let i = index;
      const img = h('img', { class: 'hm-lb-img', alt: '' });
      const title = h('div', { class: 'hm-lb-title' });
      const subline = h('div', { class: 'hm-lb-sub' });
      const counter = h('span', { class: 'hm-lb-count' });
      const show = (n) => {
        i = (n + list.length) % list.length;
        const s = list[i];
        img.src = s.src;
        img.alt = shotLabel(s);
        title.textContent = s.world || s.instanceName || '';
        title.title = title.textContent;
        mount(subline, s.instanceName && s.world ? h('span', {}, s.instanceName) : null, s.date ? h('span', {}, fmtDate(s.date, { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })) : null);
        counter.textContent = t('home.shotCounter', { index: i + 1, total: list.length });
        folderBtn.hidden = !list[i].path;
      };
      const prevBtn = h('button', { class: 'icon-btn hm-lb-nav prev', title: t('home.prevShot'), 'aria-label': t('home.prevShot'), onclick: () => show(i - 1) }, icon('chevronLeft'));
      const nextBtn = h('button', { class: 'icon-btn hm-lb-nav next', title: t('home.nextShot'), 'aria-label': t('home.nextShot'), onclick: () => show(i + 1) }, icon('chevronRight'));
      const folderBtn = h(
        'button',
        { class: 'btn sm', onclick: () => list[i].path && api.app.showItem(list[i].path).catch((err) => fail(t('home.showFailed'), err)) },
        icon('folderOpen'),
        t('home.showInFolder'),
      );
      const closeBtn = h('button', { class: 'icon-btn', title: t('home.close'), 'aria-label': t('home.close'), onclick: () => closeLightbox() }, icon('x'));
      prevBtn.hidden = nextBtn.hidden = list.length < 2;
      const box = h(
        'div',
        { class: 'hm-lb', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('home.lightboxLabel') },
        h('div', { class: 'hm-lb-stage', onclick: (e) => e.target === e.currentTarget && closeLightbox() }, prevBtn, img, nextBtn),
        h('div', { class: 'hm-lb-bar' }, h('div', { class: 'hm-lb-info' }, title, subline), counter, folderBtn, closeBtn),
      );
      const prevFocus = document.activeElement;
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          closeLightbox();
        } else if (e.key === 'ArrowLeft') show(i - 1);
        else if (e.key === 'ArrowRight') show(i + 1);
        else if (e.key === 'Tab') {
          // el foco no sale del visor
          const items = [...box.querySelectorAll('button')].filter((b) => !b.hidden);
          const at = items.indexOf(document.activeElement);
          if (e.shiftKey && at <= 0) {
            e.preventDefault();
            items.at(-1)?.focus();
          } else if (!e.shiftKey && at === items.length - 1) {
            e.preventDefault();
            items[0]?.focus();
          }
        }
      };
      document.addEventListener('keydown', onKey, true);
      document.body.append(box);
      show(i);
      closeBtn.focus();
      lightbox = {
        close() {
          document.removeEventListener('keydown', onKey, true);
          box.remove();
          lightbox = null;
          if (prevFocus?.isConnected) prevFocus.focus({ preventScroll: true });
        },
      };
    }

    // ---------- Novedades de Minecraft ----------

    function openNews(list, index) {
      let i = index;
      let token = 0;
      const body = h('div', { class: 'hm-reader' });
      const prev = h('button', { class: 'btn ghost', onclick: () => show(i - 1) }, icon('chevronLeft'), t('home.newsPrev'));
      const next = h('button', { class: 'btn ghost', onclick: () => show(i + 1) }, t('home.newsNext'), icon('chevronRight'));
      const onKey = (e) => {
        if (e.target?.closest?.('input, textarea')) return;
        if (e.key === 'ArrowLeft') show(i - 1);
        else if (e.key === 'ArrowRight') show(i + 1);
      };
      const m = modal({ title: list[i].title, size: 'wide', body, footer: [prev, h('span', { class: 'spacer' }), next], onClose: () => document.removeEventListener('keydown', onKey) });
      document.addEventListener('keydown', onKey);
      const titleEl = m.el.querySelector('.modal-head h3');
      const scroller = m.el.querySelector('.modal-body');
      async function show(n) {
        if (n < 0 || n >= list.length) return;
        i = n;
        const e = list[i];
        const my = ++token;
        if (titleEl) titleEl.textContent = e.title;
        prev.disabled = i === 0;
        next.disabled = i === list.length - 1;
        mount(body, readerSkeleton());
        if (scroller) scroller.scrollTop = 0;
        try {
          const note = await api.versions.patchNote(e.contentPath);
          if (my !== token) return;
          mount(
            body,
            newsImageUrl(e) ? fallbackImg(newsImageUrl(e), () => h('span'), 'hm-reader-img') : null,
            h('div', { class: 'hm-reader-meta' }, typeBadge(e), e.version ? h('span', { class: 'badge' }, e.version) : null, h('span', { class: 'small muted' }, fmtDate(e.date, { day: 'numeric', month: 'long', year: 'numeric' }))),
            safeHtml(note?.body),
          );
        } catch (err) {
          if (my !== token) return;
          // Error con la causa y como seguir (reintentar la misma nota)
          mount(
            body,
            h(
              'div',
              { class: 'notice bad hm-reader-error', role: 'alert' },
              icon('alert'),
              h('div', {}, h('div', {}, t('home.newsReaderError', { error: err.message })), h('button', { class: 'btn sm', onclick: () => show(i) }, icon('refresh'), t('home.retry'))),
            ),
          );
        }
      }
      show(i);
    }

    // Esqueleto del lector de notas: imagen, titulo y parrafos
    function readerSkeleton() {
      return h(
        'div',
        { class: 'hm-reader-skel', role: 'status', 'aria-busy': 'true' },
        h('span', { class: 'sr-only' }, t('common.loading')),
        h(
          'div',
          { class: 'skeleton-shapes', 'aria-hidden': 'true' },
          h('span', { class: 'skeleton skeleton-block hm-reader-skel-img' }),
          h('span', { class: 'skeleton skeleton-line title' }),
          h('div', { class: 'skeleton-lines' }, [0, 1, 2, 3, 4, 5].map(() => h('span', { class: 'skeleton skeleton-line' }))),
        ),
      );
    }

    function newsSkeleton() {
      return h(
        'div',
        { class: 'hm-news', role: 'status', 'aria-busy': 'true' },
        h('span', { class: 'skeleton hm-skel-nf', 'aria-hidden': 'true' }),
        h('div', { class: 'hm-nlist', 'aria-hidden': 'true' }, [0, 1, 2, 3].map(() => h('span', { class: 'skeleton hm-skel-ni' }))),
        h('span', { class: 'sr-only' }, t('common.loading')),
      );
    }

    function newsHead() {
      const filters = [
        ['all', 'home.newsAll'],
        ['release', 'home.newsReleases'],
        ['snapshot', 'home.newsSnapshots'],
      ];
      const seg = h(
        'div',
        { class: 'segmented hm-seg', role: 'group', 'aria-label': t('home.newsFilter') },
        filters.map(([id, key]) =>
          h(
            'button',
            {
              class: newsFilter === id ? 'active' : '',
              'aria-pressed': String(newsFilter === id),
              dataset: { fk: `news-${id}` },
              onclick: () => {
                newsFilter = id;
                drawNews();
              },
            },
            t(key),
          ),
        ),
      );
      return sectionHead('fileText', t('home.newsTitle'), newsCache ? seg : null);
    }

    function drawNews() {
      keepFocus(els.news, () => {
        if (!newsCache) {
          mount(
            els.news,
            newsHead(),
            newsError
              ? h(
                  'div',
                  { class: 'card hm-news-error', role: 'alert' },
                  h('span', { class: 'hm-news-error-icon', 'aria-hidden': 'true' }, icon('wifi')),
                  h('span', { class: 'hm-news-error-text' }, t('home.newsError')),
                  h('button', { class: 'btn sm', dataset: { fk: 'news-retry' }, onclick: () => loadNews(true) }, icon('refresh'), t('home.retry')),
                )
              : newsSkeleton(),
          );
          return;
        }
        const list = newsCache.entries.filter((e) => newsFilter === 'all' || e.type === newsFilter);
        if (!list.length) {
          mount(
            els.news,
            newsHead(),
            h('div', { class: 'card hm-news-error is-empty' }, h('span', { class: 'hm-news-error-icon', 'aria-hidden': 'true' }, icon('fileText')), h('span', { class: 'hm-news-error-text' }, t('home.newsEmpty'))),
          );
          return;
        }
        const [first, ...rest] = list;
        mount(
          els.news,
          newsHead(),
          h(
            'div',
            { class: 'hm-news' },
            h(
              'button',
              { class: 'hm-nf', title: first.title, dataset: { fk: 'news-0' }, onclick: () => openNews(list, 0) },
              newsImg(first, 'hm-nf-img'),
              h(
                'span',
                { class: 'hm-nf-body' },
                h('span', { class: 'hm-nf-meta' }, typeBadge(first), h('span', {}, fmtDate(first.date))),
                h('span', { class: 'hm-nf-title' }, first.title),
                first.shortText ? h('span', { class: 'hm-nf-text' }, first.shortText) : null,
                h('span', { class: 'hm-nf-read' }, t('home.newsRead'), icon('arrowRight')),
              ),
            ),
            h(
              'div',
              { class: 'hm-nlist' },
              rest.slice(0, 4).map((e, k) =>
                h(
                  'button',
                  { class: 'hm-ni', title: e.title, dataset: { fk: `news-${k + 1}` }, onclick: () => openNews(list, k + 1) },
                  newsImg(e, 'hm-ni-img'),
                  h('span', { class: 'hm-ni-main' }, h('span', { class: 'hm-ni-title' }, e.title), h('span', { class: 'hm-ni-meta' }, typeBadge(e), h('span', {}, fmtDate(e.date)))),
                ),
              ),
            ),
          ),
        );
      });
    }

    async function loadNews(force) {
      // Novedades de Mojang: solo si el usuario lo activó (netprefs.js).
      if (!netAllowed('news')) {
        mount(els.news, sectionHead('fileText', t('home.newsTitle')), optInBlock('news', () => alive && loadNews(true)));
        return;
      }
      if (!force && newsCache && Date.now() - newsCache.at < NEWS_TTL) {
        drawNews();
        return;
      }
      newsError = null;
      if (force) newsCache = null;
      drawNews();
      try {
        const data = await api.versions.patchNotes();
        newsCache = { at: Date.now(), entries: sortNews(data?.entries) };
      } catch (err) {
        newsError = err;
        warn('versions:patchNotes', err);
      }
      if (alive) drawNews();
    }

    // ---------- Personalizar inicio ----------

    function openCustomize() {
      const hidden = hiddenByUser();
      const save = async () => {
        try {
          await store.setSettings({ home: { ...(store.settings?.home || {}), hidden: [...hidden] } });
        } catch (err) {
          fail(t('home.customizeSaveFailed'), err);
        }
      };
      const rows = h('div', { class: 'hm-cz' });
      const drawRows = () =>
        mount(
          rows,
          CUSTOMIZABLE.map((id) =>
            h(
              'div',
              { class: 'toggle-row' },
              h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t(`home.block_${id}`))),
              switchEl(
                !hidden.has(id),
                (on) => {
                  if (on) hidden.delete(id);
                  else hidden.add(id);
                  save();
                },
                t(`home.block_${id}`),
              ),
            ),
          ),
        );
      drawRows();
      const m = modal({
        title: t('home.customize'),
        body: h('div', { class: 'stack' }, h('p', { class: 'text-2 hm-cz-text' }, t('home.customizeText')), rows),
        footer: [
          h(
            'button',
            {
              class: 'btn ghost',
              onclick: () => {
                hidden.clear();
                drawRows();
                save();
              },
            },
            t('home.customizeShowAll'),
          ),
          h('button', { class: 'btn primary', onclick: () => m.close() }, t('home.close')),
        ],
      });
    }

    // ---------- Refrescos ----------

    // Textos relativos sin redibujar: [data-ago] (+ data-ago-key) y [data-since]
    function tick() {
      if (!alive) return;
      root.querySelectorAll('[data-ago]').forEach((el) => {
        const ts = Number(el.dataset.ago);
        if (!ts) return;
        el.textContent = el.dataset.agoKey ? t(el.dataset.agoKey, { ago: fmtAgo(ts) }) : fmtAgo(ts);
      });
      root.querySelectorAll('[data-since]').forEach((el) => {
        const since = Number(el.dataset.since);
        if (since) el.textContent = t('home.runningFor', { time: fmtDuration(Date.now() - since) });
      });
    }

    // Partes en vivo: pings y capturas mientras se juega (se pausa con la ventana oculta)
    function live() {
      if (!alive) return;
      if (document.hidden) {
        stale = true;
        return;
      }
      stale = false;
      refreshServer(true);
      pingFeatured(true);
      pingRejoin(true);
      if (Object.values(store.running).some((r) => r?.state === 'running')) loadShots();
    }

    const onVisibility = () => {
      if (!document.hidden && stale) live();
    };
    document.addEventListener('visibilitychange', onVisibility);
    sub(() => document.removeEventListener('visibilitychange', onVisibility));
    timers.push(setInterval(live, LIVE_MS), setInterval(tick, TICK_MS));

    // ---------- Eventos ----------

    let runningIds = new Set(Object.keys(store.running));
    sub(
      store.on('running', () => {
        const now = new Set(Object.keys(store.running));
        const stopped = [...runningIds].some((id) => !now.has(id));
        runningIds = now;
        redrawHero();
        drawWorlds();
        if (stopped) {
          // Al cerrar el juego cambian los mundos, las estadisticas y las capturas
          clearTimeout(afterGameTimer);
          afterGameTimer = setTimeout(() => {
            if (!alive) return;
            loadWorlds();
            loadRejoin();
            loadStats();
            loadShots();
          }, 2500);
        }
      }),
    );
    sub(
      store.on('instances', () => {
        redrawHero();
        drawWorlds();
      }),
    );
    sub(store.on('accounts', redrawHero));
    let lastBranding = branding().address;
    let lastNet = `${netAllowed('news')}|${netAllowed('featuredServers')}`;
    sub(
      store.on('settings', () => {
        redrawHero();
        applyVisibility();
        const addr = branding().address;
        // Conexiones opcionales activadas o apagadas desde el aviso o Ajustes > Privacidad
        const net = `${netAllowed('news')}|${netAllowed('featuredServers')}`;
        const netChanged = net !== lastNet;
        if (netChanged) {
          const newsChanged = net.split('|')[0] !== lastNet.split('|')[0];
          lastNet = net;
          if (newsChanged) loadNews(true);
        }
        if (addr !== lastBranding || netChanged) {
          lastBranding = addr;
          refreshServer(false);
          loadFeatured();
          drawWorlds();
          pingRejoin(false);
        }
      }),
    );
    sub(store.on('task', (task) => task?.meta?.instanceId && patchHeroTask(task)));
    // El modulo de estadisticas avisa cuando registra una partida
    sub(
      api.on('stats:updated', () => {
        clearTimeout(statsTimer);
        statsTimer = setTimeout(() => alive && loadStats(), 400);
      }),
    );
    sub(
      api.on('game:activity', (id, act) => {
        activities[id] = act;
        if (alive && id === heroState.id) redrawHero();
      }),
    );
    if (typeof social?.on === 'function') {
      sub(social.on('friends', scheduleFriends));
      sub(social.on('presence', scheduleFriends));
      sub(social.on('state', scheduleFriends));
    }
    if (typeof cloud?.on === 'function') {
      sub(cloud.on('auth', scheduleFriends));
      sub(cloud.on('config', scheduleFriends));
    }

    // ---------- Primer dibujo + cargas ----------

    drawHero();
    drawQuick();
    drawWorlds();
    drawFriends();
    drawStatsSkeleton();
    drawTips(false);
    refreshServer(false);
    applyVisibility();
    loadWorlds();
    loadRejoin();
    loadStats();
    loadFeatured();
    loadShots();
    loadNews(false);

    api
      .invoke('game:activity')
      .then((map) => {
        if (!alive || !map || typeof map !== 'object') return;
        Object.assign(activities, map);
        if (heroState.mode === 'running') redrawHero();
      })
      .catch(() => {});

    import('../features/share.js')
      .then((mod) => {
        if (!alive) return;
        shareMod = mod;
        const inst = store.selectedInstance();
        let badge = null;
        try {
          badge = inst ? mod.groupBadge?.(inst) : null;
        } catch {
          badge = null;
        }
        if (badge instanceof Node) redrawHero();
      })
      .catch((err) => console.warn('[home] share:', err));

    return () => {
      alive = false;
      timers.forEach(clearInterval);
      clearTimeout(friendsTimer);
      clearTimeout(afterGameTimer);
      clearTimeout(statsTimer);
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ya desuscripto */
        }
      }
      closeLightbox();
    };
  },
};
