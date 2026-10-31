// Consola del servidor: niveles con colores, filtro, historial de comandos, autocompletado, copiar y limpiar.
import { h, icon, mount, fail, copyText, debounce, emptyState } from '../../ui.js';
import { api } from '../../store.js';
import { t, has } from '../../i18n.js';
import { typeMeta } from './common.js';

const cmdHint = (c) => {
  const key = `server.cmd_${c.replace(/-/g, '_')}`;
  return has(key) ? t(key) : '';
};

const MODES = ['survival', 'creative', 'adventure', 'spectator'];
const P = '@p';
// Comando -> argumentos (array = opciones fijas, '@p' = jugador)
const VANILLA = {
  help: [],
  list: [],
  say: [],
  tell: [P],
  msg: [P],
  me: [],
  op: [P],
  deop: [P],
  kick: [P],
  ban: [P],
  'ban-ip': [P],
  pardon: [],
  'pardon-ip': [],
  banlist: [['players', 'ips']],
  whitelist: [['on', 'off', 'add', 'remove', 'list', 'reload'], P],
  gamemode: [MODES, P],
  defaultgamemode: [MODES],
  difficulty: [['peaceful', 'easy', 'normal', 'hard']],
  time: [['set', 'add', 'query'], ['day', 'night', 'noon', 'midnight']],
  weather: [['clear', 'rain', 'thunder']],
  gamerule: [],
  give: [P],
  tp: [P, P],
  teleport: [P, P],
  kill: [P],
  clear: [P],
  effect: [['give', 'clear'], P],
  enchant: [P],
  xp: [['add', 'set', 'query'], P],
  summon: [],
  setworldspawn: [],
  spawnpoint: [P],
  seed: [],
  'save-all': [['flush']],
  'save-on': [],
  'save-off': [],
  stop: [],
  reload: [],
  datapack: [['list', 'enable', 'disable']],
  locate: [['structure', 'biome', 'poi']],
  worldborder: [['set', 'add', 'center', 'get', 'damage', 'warning']],
  tick: [['query', 'rate', 'freeze', 'unfreeze', 'step', 'sprint']],
  title: [P, ['title', 'subtitle', 'actionbar', 'clear', 'reset', 'times']],
  tellraw: [P],
  scoreboard: [['objectives', 'players']],
  team: [['add', 'remove', 'join', 'leave', 'list', 'modify', 'empty']],
  forceload: [['add', 'remove', 'query']],
  perf: [['start', 'stop']],
  transfer: [],
};
const PLUGINS = { plugins: [], pl: [], version: [], tps: [], mspt: [], paper: [['version', 'reload', 'heap', 'dumpitem']], spark: [['profiler', 'tps', 'health', 'gc']] };
const PROXY = {
  velocity: { velocity: [['version', 'plugins', 'reload', 'dump', 'heap', 'info']], glist: [['all']], send: [P], server: [], shutdown: [], end: [] },
  waterfall: { end: [], glist: [], send: [P], server: [], alert: [], greload: [], perms: [], find: [P], ip: [P] },
};

function commandSet(type) {
  const m = typeMeta(type);
  if (m.kind === 'proxy') return PROXY[type] || PROXY.velocity;
  return m.plugins ? { ...VANILLA, ...PLUGINS } : VANILLA;
}

const QUICK = [
  ['sun', 'qDay', 'time set day'],
  ['moon', 'qNight', 'time set night'],
  ['cloud', 'qWeather', 'weather clear'],
  ['save', 'qSave', 'save-all'],
  ['users', 'qList', 'list'],
];

export function consoleTab(container, ctx) {
  const srv = ctx.srv;
  const proxy = typeMeta(srv.type).kind === 'proxy';
  const COMMANDS = commandSet(srv.type);
  let lines = [];
  let filter = '';
  let level = 'all';
  let autoscroll = true;
  const history = (() => {
    try {
      return JSON.parse(localStorage.getItem(`sv-history-${srv.id}`) || '[]').slice(0, 100);
    } catch {
      return [];
    }
  })();
  let hIndex = -1;

  const box = h('div', { class: 'console sv-console', role: 'log', 'aria-live': 'off', 'aria-label': t('server.tab_console'), tabindex: 0 });
  // Mismos estados que la consola de la instancia: apagado (icono + titulo + texto), esperando (spinner) y sin coincidencias
  const waiting = (text) => h('div', { class: 'sv-console-empty sv-console-wait', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), text);
  const empty = () =>
    ctx.state() === 'offline'
      ? h('div', { class: 'sv-console-empty' }, emptyState('terminal', t('server.consoleOfflineTitle'), t('server.consoleOfflineText')))
      : waiting(t('server.consoleWaiting'));
  const matches = (l) => {
    if (level === 'warn' && !['WARN', 'ERROR', 'FATAL'].includes(l.level)) return false;
    if (level === 'error' && !['ERROR', 'FATAL'].includes(l.level)) return false;
    return !filter || l.text.toLowerCase().includes(filter);
  };
  const lineEl = (l) => h('div', { class: `sv-line l-${l.level}` }, l.text);

  const redraw = () => {
    const shown = lines.filter(matches).slice(-2500);
    if (!shown.length) {
      mount(box, lines.length ? h('div', { class: 'sv-console-empty' }, emptyState('filter', t('server.consoleNoMatch'), null)) : empty());
      return;
    }
    const frag = document.createDocumentFragment();
    for (const l of shown) frag.append(lineEl(l));
    mount(box, frag);
    if (autoscroll) box.scrollTop = box.scrollHeight;
  };

  box.addEventListener('scroll', () => {
    const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    if (atBottom !== autoscroll) {
      autoscroll = atBottom;
      pinBtn.classList.toggle('active', autoscroll);
      pinBtn.setAttribute('aria-pressed', String(autoscroll));
    }
  });

  // ---------- Barra de herramientas ----------
  const search = h('input', { class: 'input', type: 'search', placeholder: t('server.consoleFilter'), 'aria-label': t('server.consoleFilter') });
  search.addEventListener('input', debounce(() => ((filter = search.value.trim().toLowerCase()), redraw()), 120));
  const levels = h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': t('server.consoleLevel') },
    ['all', 'warn', 'error'].map((lv) =>
      h(
        'button',
        {
          class: lv === level ? 'active' : '',
          'aria-pressed': lv === level ? 'true' : 'false',
          onclick: (e) => {
            level = lv;
            levels.querySelectorAll('button').forEach((b) => {
              b.classList.toggle('active', b === e.currentTarget);
              b.setAttribute('aria-pressed', b === e.currentTarget ? 'true' : 'false');
            });
            redraw();
          },
        },
        t(`server.consoleLevel_${lv}`),
      ),
    ),
  );
  const pinBtn = h(
    'button',
    {
      class: 'icon-btn sm active',
      title: t('server.consoleAutoscroll'),
      'aria-label': t('server.consoleAutoscroll'),
      'aria-pressed': 'true',
      onclick: () => {
        autoscroll = !autoscroll;
        pinBtn.classList.toggle('active', autoscroll);
        pinBtn.setAttribute('aria-pressed', String(autoscroll));
        if (autoscroll) box.scrollTop = box.scrollHeight;
      },
    },
    icon('arrowRight', 'sv-rot90'),
  );
  const toolbar = h(
    'div',
    { class: 'sv-console-bar' },
    h('div', { class: 'input-icon sv-console-search' }, icon('search'), search),
    levels,
    h('span', { class: 'spacer' }),
    pinBtn,
    h('button', { class: 'icon-btn sm', title: t('server.consoleCopy'), 'aria-label': t('server.consoleCopy'), onclick: () => copyText(lines.filter(matches).map((l) => l.text).join('\n'), t('server.consoleCopied')) }, icon('copy')),
    h(
      'button',
      {
        class: 'icon-btn sm',
        title: t('server.consoleClear'),
        'aria-label': t('server.consoleClear'),
        onclick: async () => {
          await api.invoke('servers:clearLogs', srv.id).catch(() => {});
          lines = [];
          redraw();
        },
      },
      icon('svEraser'),
    ),
    h('button', { class: 'icon-btn sm', title: t('server.openLogs'), 'aria-label': t('server.openLogs'), onclick: () => api.invoke('servers:openPath', srv.id, 'logs').catch((e) => fail(t('common.error'), e)) }, icon('folderOpen')),
  );

  // ---------- Entrada de comandos con autocompletado ----------
  const input = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', 'aria-autocomplete': 'list', 'aria-controls': 'sv-suggest', 'aria-label': t('server.consoleInput') });
  const sendBtn = h('button', { class: 'btn primary', title: t('server.consoleSend'), 'aria-label': t('server.consoleSend') }, icon('send'));
  const suggestBox = h('div', { class: 'sv-suggest hidden', id: 'sv-suggest', role: 'listbox' });
  let suggestions = [];
  let selected = -1;

  const playerNames = () => ctx.players();
  function computeSuggestions() {
    const raw = input.value.replace(/^\//, '');
    const parts = raw.split(' ');
    if (parts.length === 1) {
      const q = parts[0].toLowerCase();
      if (!q) return [];
      return Object.keys(COMMANDS)
        .filter((c) => c.startsWith(q) && c !== q)
        .slice(0, 8)
        .map((c) => ({ value: c, label: c, hint: cmdHint(c) }));
    }
    const spec = COMMANDS[parts[0].toLowerCase()];
    if (!spec) return [];
    const idx = parts.length - 2;
    const arg = spec[idx];
    const q = parts[parts.length - 1].toLowerCase();
    let options = [];
    if (arg === P) options = [...playerNames(), '@a', '@p', '@r', '@s'];
    else if (Array.isArray(arg)) options = arg;
    const prefix = parts.slice(0, -1).join(' ');
    return options
      .filter((o) => o.toLowerCase().startsWith(q) && o.toLowerCase() !== q)
      .slice(0, 8)
      .map((o) => ({ value: `${prefix} ${o}`, label: o, hint: '' }));
  }
  function drawSuggestions() {
    suggestions = ctx.state() === 'offline' ? [] : computeSuggestions();
    if (!suggestions.length) {
      suggestBox.classList.add('hidden');
      input.removeAttribute('aria-activedescendant');
      return;
    }
    if (selected >= suggestions.length) selected = suggestions.length - 1;
    mount(
      suggestBox,
      suggestions.map((s, i) =>
        h(
          'div',
          {
            class: ['sv-sug', i === selected && 'active'],
            id: `sv-sug-${i}`,
            role: 'option',
            'aria-selected': i === selected ? 'true' : 'false',
            onmousedown: (e) => {
              e.preventDefault();
              accept(i);
            },
          },
          h('span', { class: 'mono' }, s.label),
          s.hint ? h('span', { class: 'tiny muted ellipsis' }, s.hint) : null,
        ),
      ),
    );
    suggestBox.classList.remove('hidden');
    if (selected >= 0) input.setAttribute('aria-activedescendant', `sv-sug-${selected}`);
  }
  function accept(i) {
    const s = suggestions[i];
    if (!s) return;
    input.value = `${s.value} `;
    selected = -1;
    drawSuggestions();
    input.focus();
  }
  const send = () => {
    const cmd = input.value.trim().replace(/^\//, '');
    if (!cmd) return;
    if (ctx.state() === 'offline') {
      fail(t('server.errOffline'));
      return;
    }
    if (history[0] !== cmd) history.unshift(cmd);
    history.splice(100);
    try {
      localStorage.setItem(`sv-history-${srv.id}`, JSON.stringify(history));
    } catch {
      /* sin almacenamiento */
    }
    hIndex = -1;
    input.value = '';
    selected = -1;
    drawSuggestions();
    api.servers.command(srv.id, cmd).catch((e) => fail(t('server.errCommand'), e));
  };
  input.addEventListener('input', () => {
    selected = -1;
    drawSuggestions();
  });
  input.addEventListener('blur', () => setTimeout(() => suggestBox.classList.add('hidden'), 120));
  input.addEventListener('keydown', (e) => {
    const open = !suggestBox.classList.contains('hidden') && suggestions.length;
    if (e.key === 'Tab' && open) {
      e.preventDefault();
      accept(selected >= 0 ? selected : 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && selected >= 0) accept(selected);
      else send();
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      suggestBox.classList.add('hidden');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (open) {
        selected = (selected + 1) % suggestions.length;
        drawSuggestions();
      } else if (hIndex >= 0) {
        hIndex--;
        input.value = hIndex >= 0 ? history[hIndex] : '';
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && selected > 0) {
        selected--;
        drawSuggestions();
      } else if (history.length) {
        hIndex = Math.min(history.length - 1, hIndex + 1);
        input.value = history[hIndex];
        suggestBox.classList.add('hidden');
      }
    }
  });
  sendBtn.addEventListener('click', send);

  const quick = h('div', { class: 'chips sv-quick' });
  const updateState = () => {
    const off = ctx.state() === 'offline';
    input.disabled = off;
    sendBtn.disabled = off;
    // Apagado, Enviar no es la accion principal (la cabecera ofrece Iniciar)
    sendBtn.classList.toggle('primary', !off);
    if (off) {
      suggestions = [];
      suggestBox.classList.add('hidden');
    }
    input.placeholder = off ? t('server.consoleInputOffline') : proxy ? t('server.consoleInputProxy') : t('server.consoleInputHint');
    mount(quick, off || proxy ? null : QUICK.map(([ic, k, cmd]) => h('button', { class: 'chip', onclick: () => api.servers.command(srv.id, cmd).catch((e) => fail(t('server.errCommand'), e)), title: `/${cmd}` }, icon(ic), t(`server.${k}`))));
    if (!lines.length) redraw();
  };

  mount(container, h('div', { class: 'sv-console-wrap' }, toolbar, quick, box, h('div', { class: 'sv-cmd' }, h('span', { class: 'sv-cmd-prompt', 'aria-hidden': 'true' }, '>'), input, suggestBox, sendBtn)));
  updateState();
  mount(box, waiting(t('server.consoleLoading')));
  api.servers
    .logs(srv.id)
    .then((l) => {
      lines = [...(l || []), ...lines];
      redraw();
    })
    .catch(() => redraw());

  const offLog = api.on('server:log', (id, line) => {
    if (id !== srv.id || !line) return;
    const wasEmpty = !lines.length;
    lines.push(line);
    if (lines.length > 6000) lines.splice(0, lines.length - 5000);
    if (wasEmpty || box.querySelector('.sv-console-empty')) {
      redraw();
      return;
    }
    if (!matches(line)) return;
    box.append(lineEl(line));
    while (box.childNodes.length > 2500) box.firstChild.remove();
    if (autoscroll) box.scrollTop = box.scrollHeight;
  });
  const offState = ctx.on('state', updateState);
  return () => {
    offLog();
    offState();
  };
}
