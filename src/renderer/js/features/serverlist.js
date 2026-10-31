// Multijugador (contrato de la seccion 6): joinServer(address, { instanceId? }) y openBuildFromServer(address?).
// Ademas exporta las piezas que usa la pagina Multijugador: MOTD con colores, barras de latencia,
// iconos de servidor, ping con manejo de errores y el dialogo para guardar servidores.
import { h, icon, mount, modal, toast, ok, fail, loading, ensureCss, copyText, selectEl, instanceIcon, instanceLoaderKey, loaderBadge, LOADERS, avatarImg, emptyState, setBusy, reducedMotion } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs, locale } from '../i18n.js';
import { navigate, launchInstance, openAccounts } from '../app.js';

const NS = 'multiplayer';
let ready = null;

// Carga los textos y estilos (la feature se puede abrir desde cualquier pagina)
export function ensureUi() {
  ensureCss('features/serverlist');
  if (!ready) ready = loadNs(NS).catch((err) => console.warn('[multiplayer] textos', err));
  return ready;
}

const missingHandler = (err) => /No handler registered/i.test(String(err?.message || err));

// ---------- Direcciones ----------

// Validacion rapida en la interfaz (la definitiva la hace el proceso principal)
export function cleanAddress(input) {
  const s = String(input ?? '').trim().replace(/^minecraft:\/\//i, '').replace(/\/+$/, '');
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  const v6 = s.match(/^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/);
  if (v6) return v6[2] && Number(v6[2]) <= 65535 ? s : v6[2] ? null : s;
  if ((s.match(/:/g) || []).length > 1) return /^[0-9a-fA-F:.]+$/.test(s) ? s : null;
  const [host, port] = s.split(':');
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return null;
  if (!/^[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?(?:\.[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?)*\.?$/u.test(host)) return null;
  return s.replace(/\.(?=:|$)/, '');
}

// "host:puerto" -> { host, port } para Quick Play (sin consultar al proceso principal)
function quickPlayOf(address) {
  const v6 = address.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { server: `[${v6[1]}]`, port: Number(v6[2] || 25565) };
  if ((address.match(/:/g) || []).length > 1) return { server: `[${address}]`, port: 25565 };
  const [server, port] = address.split(':');
  return { server, port: Number(port || 25565) };
}

// ---------- Ping ----------

/**
 * Consulta un servidor sin lanzar errores: siempre devuelve un resultado.
 * Errores: { online: false, error: 'invalid' | 'unavailable' | codigo de red, errorText }
 */
export async function pingServer(address, opts = {}) {
  try {
    return await api.invoke('serverlist:ping', address, opts);
  } catch (err) {
    return { online: false, address, error: missingHandler(err) ? 'unavailable' : 'invalid', errorText: err.message };
  }
}

export function errorText(result) {
  const code = result?.error || 'unknown';
  const key = `${NS}.err_${code}`;
  const txt = t(key);
  return txt === `err_${code}` ? result?.errorText || t(`${NS}.err_unknown`) : txt;
}

// ---------- MOTD con codigos de seccion ----------

const MC_COLORS = {
  0: '#000000',
  1: '#0000aa',
  2: '#00aa00',
  3: '#00aaaa',
  4: '#aa0000',
  5: '#aa00aa',
  6: '#ffaa00',
  7: '#aaaaaa',
  8: '#555555',
  9: '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
};
const FORMATS = { k: 'obf', l: 'bold', m: 'strike', n: 'under', o: 'italic' };

// Texto con codigos § -> lineas de segmentos { text, style: { color, bold, italic, under, strike, obf } }
export function parseMotd(text) {
  const lines = [[]];
  let style = {};
  let buf = '';
  const flush = () => {
    if (buf) lines[lines.length - 1].push({ text: buf, style: { ...style } });
    buf = '';
  };
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\n') {
      flush();
      lines.push([]);
      continue;
    }
    if (ch === '§' && i + 1 < s.length) {
      const c = s[i + 1].toLowerCase();
      flush();
      const hex = s.slice(i + 2, i + 14);
      if (c === 'x' && /^(§[0-9a-f]){6}$/i.test(hex)) {
        style = { color: `#${hex.replace(/§/g, '').toLowerCase()}` };
        i += 13;
      } else if (MC_COLORS[c]) {
        style = { color: MC_COLORS[c] };
        i += 1;
      } else if (FORMATS[c]) {
        style = { ...style, [FORMATS[c]]: true };
        i += 1;
      } else {
        if (c === 'r') style = {};
        i += 1; // el juego ignora los codigos desconocidos
      }
      continue;
    }
    if (ch !== '§') buf += ch;
  }
  flush();
  return lines;
}

export function stripMotd(text) {
  return parseMotd(text)
    .map((l) => l.map((s) => s.text).join(''))
    .join('\n');
}

// Sombra como la del juego: el mismo color a un cuarto de brillo
function shadowOf(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) >> 2;
  const g = ((n >> 8) & 0xff) >> 2;
  const b = (n & 0xff) >> 2;
  return `rgb(${r}, ${g}, ${b})`;
}

// Texto "ofuscado" (§k): caracteres al azar que cambian, con un solo temporizador para todos
const OBF_CHARS = 'ABCDEFGHJKLMNOPQRSTUVWXYZabcdefghkmnopqrstuvwxyz0123456789#$%&?@';
const obfNodes = new Set();
let obfTimer = null;
function scramble(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += OBF_CHARS[Math.floor(Math.random() * OBF_CHARS.length)];
  return out;
}
function tickObf() {
  const now = Date.now();
  for (const el of obfNodes) {
    if (!el.isConnected) {
      if (now - el._born > 3000) obfNodes.delete(el);
      continue;
    }
    if (!document.hidden && !reducedMotion()) el.textContent = scramble(el._len);
  }
  if (!obfNodes.size) {
    clearInterval(obfTimer);
    obfTimer = null;
  }
}
function obfSpan(text, attrs) {
  const len = [...text].length;
  const el = h('span', { ...attrs, 'aria-hidden': 'true' }, scramble(len));
  el._len = len;
  el._born = Date.now();
  obfNodes.add(el);
  if (!obfTimer) obfTimer = setInterval(tickObf, 110);
  return el;
}

/**
 * MOTD con colores y formato (sin innerHTML). opts: { lines: 2, cls }
 * Las lineas que vienen rellenas con espacios para centrarse en el juego se centran.
 */
export function motdView(text, { lines: maxLines = 2, cls = '' } = {}) {
  const parsed = parseMotd(text).slice(0, maxLines);
  while (parsed.length > 1 && !parsed[parsed.length - 1].some((s) => s.text.trim())) parsed.pop();
  const plain = parsed.map((l) => l.map((s) => s.text).join('').trim()).join(' ');
  return h(
    'div',
    { class: ['sl-motd', ...String(cls || '').split(/\s+/).filter(Boolean).map((c) => `sl-motd-${c}`)], title: plain || null },
    parsed.map((segs) => {
      const raw = segs.map((s) => s.text).join('');
      const centered = /^\s{3,}/.test(raw);
      const list = segs.map((s) => ({ ...s }));
      if (centered) {
        while (list.length && !list[0].text.trim()) list.shift();
        if (list.length) list[0].text = list[0].text.replace(/^\s+/, '');
        while (list.length && !list[list.length - 1].text.trim()) list.pop();
        if (list.length) list[list.length - 1].text = list[list.length - 1].text.replace(/\s+$/, '');
      }
      return h(
        'div',
        { class: ['sl-motd-line', centered && 'sl-center'] },
        list.length
          ? list.map((seg) => {
              const st = seg.style;
              const attrs = {
                class: [st.bold && 'sl-b', st.italic && 'sl-i', st.under && 'sl-u', st.strike && 'sl-s', st.under && st.strike && 'sl-us', st.obf && 'sl-obf'],
                style: st.color ? { color: st.color, '--sh': shadowOf(st.color) } : null,
              };
              return st.obf ? obfSpan(seg.text, attrs) : h('span', attrs, seg.text);
            })
          : ' ',
      );
    }),
  );
}

// ---------- Piezas visuales ----------

export function latencyBars(result) {
  const online = Boolean(result?.online);
  const ms = Number(result?.latency) || 0;
  const level = !result ? 0 : !online ? 0 : ms < 150 ? 5 : ms < 300 ? 4 : ms < 600 ? 3 : ms < 1000 ? 2 : 1;
  const tone = !result ? 'sl-wait' : !online ? 'sl-off' : level >= 4 ? 'sl-good' : level >= 2 ? 'sl-warn' : 'sl-bad';
  const label = !result ? t(`${NS}.checking`) : online ? t(`${NS}.latency`, { ms }) : t(`${NS}.offline`);
  return h(
    'span',
    { class: ['sl-bars', tone], title: label, 'aria-label': label, role: 'img' },
    [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= level ? 'sl-on' : null })),
    online ? h('span', { class: 'sl-ms' }, t(`${NS}.latency`, { ms })) : null,
  );
}

export function serverIcon(src, cls = '') {
  if (src && /^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) return h('div', { class: ['sl-icon', cls && `sl-${cls}`] }, h('img', { src, alt: '', draggable: 'false' }));
  return h('div', { class: ['sl-icon', 'sl-icon-empty', cls && `sl-${cls}`] }, icon('server'));
}

export function fmtInt(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  return Number(n).toLocaleString(locale());
}

// 22719 -> "22,7 mil" / "22.7K" segun el idioma (para tarjetas angostas)
export function fmtCompact(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
  if (Math.abs(n) < 10000) return fmtInt(n);
  try {
    return new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  } catch {
    return fmtInt(n);
  }
}

// En tarjetas angostas, las redes grandes muestran solo los conectados (el maximo de 200.000 no dice nada)
export function playersText(result, { compact = false } = {}) {
  if (!result?.online || !result.players) return '–';
  const { online, max } = result.players;
  if (compact && Number(max) >= 1000) return fmtCompact(online);
  const f = compact ? fmtCompact : fmtInt;
  return t(`${NS}.playersCount`, { online: f(online), max: f(max) });
}

// "1.8 a 26.3", "1.20.1" o el texto del servidor
export function versionText(result) {
  if (!result?.online) return '';
  if (result.versionRange && !result.modded) return t(`${NS}.versionRange`, { min: result.versionRange[0], max: result.versionRange[1] });
  return result.mcVersion || result.version || '?';
}

export function loaderText(result) {
  if (!result?.online) return '';
  const l = result.loader;
  if (!l) return t(`${NS}.type_vanilla`);
  if (result.loaderGuessed) return t(`${NS}.type_guess`, { loader: LOADERS[l]?.name || l });
  return LOADERS[l]?.name || l;
}

export function loaderBadgeFor(result) {
  if (!result?.online || !result.loader) return null;
  return loaderBadge(result.loader, null);
}

// ---------- Guardar servidores (dialogo compartido) ----------

/**
 * Agregar o editar un servidor guardado. entry: { name, ip, instances: [ids donde ya esta] } (vacio = nuevo)
 * Devuelve true si se guardo algo.
 */
export async function openSaveDialog(entry = {}) {
  await ensureUi();
  const editing = Boolean(entry.ip && entry.instances?.length);
  const list = store.instances;
  if (!list.length) {
    const m0 = modal({
      title: t(`${NS}.saveDialogTitle`),
      size: 'sm',
      body: emptyState('layers', t(`${NS}.noInstancesTitle`), t(`${NS}.noInstancesText`)),
      footer: [
        h('button', { class: 'btn ghost', onclick: () => m0.close() }, t(`${NS}.cancel`)),
        h('button', { class: 'btn primary', onclick: () => (m0.close(), navigate('versions/new')) }, icon('plus'), t(`${NS}.createInstance`)),
      ],
    });
    return false;
  }
  return new Promise((resolve) => {
    let finished = false;
    const done = (v) => {
      if (finished) return;
      finished = true;
      resolve(v);
    };
    const nameInput = h('input', { class: 'input', id: 'sl-save-name', value: entry.name || '', placeholder: t(`${NS}.namePlaceholder`), maxlength: 64, title: t(`${NS}.nameHelp`) });
    const ipInput = h('input', { class: 'input mono', id: 'sl-save-ip', value: entry.ip || '', placeholder: t(`${NS}.addressPlaceholder`), maxlength: 300, spellcheck: 'false', required: true, 'aria-describedby': 'sl-save-ip-err' });
    // Errores al lado de cada campo (y uno general si falla el guardado)
    const ipErr = h('div', { class: 'field-error sl-err', id: 'sl-save-ip-err', role: 'alert' });
    const instErr = h('div', { class: 'field-error sl-err', id: 'sl-save-inst-err', role: 'alert' });
    const errBox = h('div', { class: 'sl-err', role: 'alert' });
    const setErr = (box, text, field) => {
      mount(box, text ? [icon('alert'), h('span', {}, text)] : null);
      field?.setAttribute('aria-invalid', text ? 'true' : 'false');
    };
    ipInput.addEventListener('blur', () => {
      if (ipInput.value.trim() && !cleanAddress(ipInput.value)) setErr(ipErr, t(`${NS}.invalidAddress`), ipInput);
    });
    ipInput.addEventListener('input', () => ipInput.getAttribute('aria-invalid') === 'true' && cleanAddress(ipInput.value) && setErr(ipErr, null, ipInput));
    const before = new Set(entry.instances || []);
    const defaults = (entry.instancesDefault || []).filter((id) => list.some((i) => i.id === id));
    const sel = new Set(editing ? before : defaults.length ? defaults : [store.selectedInstance()?.id || list[0].id]);
    const checks = h(
      'div',
      { class: 'sl-inst-checks' },
      list.map((inst) => {
        const cb = h('input', { type: 'checkbox', checked: sel.has(inst.id), 'aria-describedby': 'sl-save-inst-err' });
        cb.addEventListener('change', () => {
          if (cb.checked) sel.add(inst.id);
          else sel.delete(inst.id);
          if (sel.size) setErr(instErr, null);
        });
        return h(
          'label',
          { class: 'sl-inst-check' },
          cb,
          instanceIcon(inst, 'sm'),
          h('span', { class: 'ellipsis', title: inst.name }, h('span', { class: 'sl-ic-name' }, inst.name), h('span', { class: 'sl-ic-sub' }, `${inst.mcVersion} · ${LOADERS[instanceLoaderKey(inst)]?.name || inst.loader}`)),
          store.running[inst.id]?.state === 'running' ? h('span', { class: 'badge good' }, t(`${NS}.running`)) : null,
        );
      }),
    );
    const saveBtn = h('button', { class: 'btn primary' }, icon('save'), t(`${NS}.saveBtn`));
    const submit = async () => {
      if (saveBtn.disabled) return;
      const ip = cleanAddress(ipInput.value);
      setErr(ipErr, ip ? null : t(`${NS}.invalidAddress`), ipInput);
      setErr(instErr, sel.size ? null : t(`${NS}.pickOneInstance`));
      setErr(errBox, null);
      if (!ip) {
        ipInput.focus();
        return;
      }
      if (!sel.size) {
        checks.querySelector('input')?.focus();
        return;
      }
      const release = setBusy(saveBtn);
      const name = nameInput.value.trim() || ip;
      try {
        const add = [...sel].filter((id) => !before.has(id));
        const keep = [...sel].filter((id) => before.has(id));
        const drop = [...before].filter((id) => !sel.has(id));
        if (keep.length) await api.invoke('serverlist:updateSaved', keep, entry.ip, { name, ip });
        if (add.length) await api.invoke('serverlist:addSaved', add, { name, ip });
        if (drop.length) await api.invoke('serverlist:removeSaved', drop, entry.ip);
        done(true);
        m.close();
        if (editing) ok(t(`${NS}.updated`), name);
        else ok(t(`${NS}.savedToast`), t(`${NS}.savedText`, { name, count: sel.size }));
      } catch (err) {
        release();
        mount(errBox, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t(`${NS}.saveFailed`)), h('div', {}, missingHandler(err) ? t(`${NS}.err_unavailable`) : err.message))));
      }
    };
    saveBtn.addEventListener('click', submit);
    for (const inp of [nameInput, ipInput]) inp.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
    const anyRunning = list.some((i) => store.running[i.id]?.state === 'running');
    const m = modal({
      title: editing ? t(`${NS}.editDialogTitle`) : t(`${NS}.saveDialogTitle`),
      body: h(
        'div',
        { class: 'stack sl-save-form' },
        h(
          'div',
          { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: 'sl-save-ip' }, t(`${NS}.addressLabel`), h('span', { class: 'sl-required', 'aria-hidden': 'true' }, '*')), ipInput, ipErr),
          h('div', { class: 'field' }, h('label', { for: 'sl-save-name' }, t(`${NS}.nameLabel`), h('span', { class: 'sl-optional' }, t('common.optional'))), nameInput),
        ),
        h(
          'div',
          { class: 'field', role: 'group', 'aria-labelledby': 'sl-save-inst-label' },
          h('div', { class: 'label', id: 'sl-save-inst-label' }, t(`${NS}.instancesLabel`)),
          checks,
          instErr,
          h('div', { class: 'field-help' }, t(`${NS}.instancesHint`)),
        ),
        anyRunning ? h('div', { class: 'notice info' }, icon('info'), t(`${NS}.savedRunningHint`)) : null,
        errBox,
      ),
      footer: [h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.cancel`)), saveBtn],
      onClose: () => done(false),
    });
    setTimeout(() => (entry.ip ? nameInput : ipInput).focus(), 40);
  });
}

// ---------- Esperar a que una instancia termine de instalarse ----------

async function runningTaskFor(instanceId) {
  const local = store.taskFor(instanceId);
  if (local) return local;
  try {
    const list = await api.tasks.list();
    return list.find((tk) => tk.meta?.instanceId === instanceId && tk.state === 'running') || null;
  } catch {
    return null;
  }
}

// Si la instancia se esta instalando, muestra el progreso y espera. -> true (lista) | false (cancelado/fallo)
async function waitInstanceReady(inst, server) {
  let task = await runningTaskFor(inst.id);
  if (!task) return true;
  return new Promise((resolve) => {
    let finished = false;
    const bar = h('i', { style: { width: '0%' } });
    const progress = h('div', { class: 'progress indeterminate' }, bar);
    const detail = h('div', { class: 'small muted ellipsis', 'aria-live': 'polite' });
    const draw = (tk) => {
      const pct = tk.progress === null || tk.progress === undefined ? null : Math.round(tk.progress * 100);
      progress.classList.toggle('indeterminate', pct === null);
      bar.style.width = `${pct || 0}%`;
      detail.textContent = tk.detail || '';
      detail.title = tk.detail || '';
    };
    draw(task);
    const finish = (v) => {
      if (finished) return;
      finished = true;
      off();
      clearInterval(poll);
      m.close();
      resolve(v);
    };
    const off = store.on('task', (tk) => {
      if (tk.meta?.instanceId !== inst.id) return;
      task = tk;
      if (tk.state === 'running') draw(tk);
      else finish(tk.state === 'done');
    });
    const poll = setInterval(async () => {
      if (!(await runningTaskFor(inst.id))) finish(true);
    }, 2500);
    const m = modal({
      title: t(`${NS}.joinWaitTitle`, { name: inst.name }),
      body: h('div', { class: 'stack' }, h('p', { class: 'text-2 sl-wait-text' }, t(`${NS}.joinWaitText`, { server })), progress, detail),
      footer: [h('button', { class: 'btn ghost', onclick: () => finish(false) }, t(`${NS}.cancel`))],
      onClose: () => finish(false),
    });
  });
}

// ---------- Elegir instancia ----------

function compatPill(c) {
  if (c.compatible === true) return h('span', { class: 'pill good' }, icon('check'), t(`${NS}.compatYes`));
  if (c.compatible === false) return h('span', { class: 'pill bad' }, icon('x'), c.reason === 'loader' ? t(`${NS}.compatLoader`) : t(`${NS}.compatNo`));
  return h('span', { class: 'pill' }, t(`${NS}.compatUnknown`));
}

function serverHeader(info, address) {
  const s = info?.server || {};
  return h(
    'div',
    { class: 'sl-join-head' },
    serverIcon(s.favicon, 'md'),
    h(
      'div',
      { class: 'sl-join-headtext' },
      h('div', { class: 'sl-join-addr ellipsis' }, address),
      s.online ? motdView(s.motd, { lines: 2, cls: 'compact' }) : h('div', { class: 'small muted' }, errorText(s)),
    ),
  );
}

/**
 * Dialogo para elegir la instancia. Devuelve { id, remember } | { create: true } | { build: true } | null
 */
function chooseInstanceDialog(info, address, { mode }) {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      m.close();
      resolve(v);
    };
    const cands = info?.candidates || [];
    const shown = mode === 'none' ? cands : cands.filter((c) => c.compatible !== false);
    let selected = shown.find((c) => c.id === info?.best)?.id || shown[0]?.id || null;
    let showAll = false;
    const remember = h('input', { type: 'checkbox' });
    const listBox = h('div', { class: 'sl-pick-list', role: 'radiogroup', 'aria-label': t(`${NS}.instancesLabel`) });
    const joinBtn = h('button', { class: 'btn primary', disabled: !selected }, icon('play'), t(`${NS}.joinButton`));
    // Grupo de opciones: Tab entra a la elegida y las flechas cambian la eleccion (como un grupo de radios)
    const pick = (id, focus = false) => {
      selected = id;
      joinBtn.disabled = false;
      drawList();
      if (focus) listBox.querySelector('.sl-pick.sl-active')?.focus();
    };
    const drawList = () => {
      const items = showAll ? cands : shown;
      const focusId = items.some((c) => c.id === selected) ? selected : items[0]?.id;
      mount(
        listBox,
        items.map((c, i) => {
          const inst = store.instances.find((x) => x.id === c.id) || c;
          const row = h(
            'div',
            {
              class: ['sl-pick', c.id === selected && 'sl-active', c.compatible === false && 'sl-dim'],
              role: 'radio',
              tabindex: c.id === focusId ? 0 : -1,
              'aria-checked': String(c.id === selected),
              onclick: () => pick(c.id),
              ondblclick: () => finish({ id: c.id, remember: remember.checked }),
              onkeydown: (e) => {
                const move = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  pick(c.id, true);
                } else if (move || e.key === 'Home' || e.key === 'End') {
                  e.preventDefault();
                  const j = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + move + items.length) % items.length;
                  pick(items[j].id, true);
                }
              },
            },
            h('span', { class: 'sl-pick-check', 'aria-hidden': 'true' }),
            instanceIcon(inst),
            h(
              'div',
              { class: 'sl-pick-main' },
              h('div', { class: 'sl-pick-name ellipsis', title: c.name }, c.name),
              h('div', { class: 'sl-pick-sub' }, loaderBadge(instanceLoaderKey(inst), null), h('span', { class: 'badge' }, c.mcVersion), c.preferred ? h('span', { class: 'badge accent' }, icon('star'), t(`${NS}.preferredBadge`)) : null, c.built ? h('span', { class: 'badge accent' }, icon('hammer'), t(`${NS}.builtBadge`)) : null),
            ),
            compatPill(c),
          );
          return row;
        }),
      );
    };
    drawList();
    joinBtn.addEventListener('click', () => selected && finish({ id: selected, remember: remember.checked }));
    const s = info?.server || {};
    const acc = store.selectedAccount();
    const intro =
      mode === 'offline'
        ? t(`${NS}.joinOfflineText`)
        : mode === 'unverified'
          ? t(`${NS}.joinUnverifiedText`, { server: address })
          : mode === 'none'
            ? s.modded
              ? t(`${NS}.joinNoneModdedText`, { server: address, loader: LOADERS[s.loader]?.name || s.loader, version: s.mcVersion, count: s.mods || 0 })
              : t(`${NS}.joinNoneText`, { server: address, version: s.mcVersion || '?' })
            : t(`${NS}.joinChooseText`, { server: address });
    const extra = [];
    if ((mode === 'none' || mode === 'unverified') && s.online && s.mcVersion) {
      if (s.modded) extra.push(h('button', { class: 'btn', onclick: () => finish({ build: true }) }, icon('hammer'), t(`${NS}.joinBuild`)));
      else extra.push(h('button', { class: 'btn', onclick: () => finish({ create: true }) }, icon('plus'), t(`${NS}.joinCreateVanilla`, { version: s.mcVersion })));
    }
    const toggleAll =
      mode !== 'none' && cands.length > shown.length
        ? h(
            'button',
            {
              class: 'btn ghost sm',
              onclick: (e) => {
                showAll = !showAll;
                e.currentTarget.textContent = showAll ? t(`${NS}.showCompatible`) : t(`${NS}.showAllInstances`);
                drawList();
              },
            },
            t(`${NS}.showAllInstances`),
          )
        : null;
    const m = modal({
      title: mode === 'none' ? t(`${NS}.joinNoneTitle`) : t(`${NS}.joinChooseTitle`),
      size: 'wide',
      body: h(
        'div',
        { class: 'stack' },
        serverHeader(info, address),
        h('p', { class: 'text-2 sl-wait-text' }, intro),
        cands.length ? listBox : h('div', { class: 'notice info' }, icon('info'), t(`${NS}.noInstancesText`)),
        h('div', { class: 'row wrap' }, cands.length ? h('label', { class: 'sl-remember' }, remember, t(`${NS}.joinRemember`)) : null, h('span', { class: 'spacer' }), toggleAll),
        acc && acc.type !== 'msa' ? h('div', { class: 'notice' }, icon('alert'), t(`${NS}.offlineAccountHint`)) : null,
      ),
      footer: [h('button', { class: 'btn ghost', onclick: () => finish(null) }, t(`${NS}.cancel`)), ...extra, cands.length ? joinBtn : null],
      onClose: () => finish(null),
    });
  });
}

function checkingModal(address) {
  let closed = false;
  const m = modal({
    title: t(`${NS}.joinTitle`, { server: address }),
    size: 'sm',
    body: loading(t(`${NS}.joinChecking`, { server: address })),
    onClose: () => {
      closed = true;
    },
  });
  return {
    get cancelled() {
      return closed;
    },
    close() {
      if (!closed) {
        closed = true;
        m.close();
      }
    },
  };
}

// Instancia abierta: no se puede relanzar. Ofrece guardar el servidor en su lista.
function alreadyRunningDialog(inst, address) {
  const m = modal({
    title: t(`${NS}.joinRunningTitle`, { name: inst.name }),
    size: 'sm',
    body: h('p', { class: 'text-2 sl-wait-text' }, t(`${NS}.joinRunningText`, { server: address })),
    footer: [
      h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.close`)),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: async () => {
            m.close();
            try {
              await api.invoke('serverlist:addSaved', inst.id, { name: address, ip: address });
              ok(t(`${NS}.savedToast`), t(`${NS}.savedText`, { name: address, count: 1 }));
            } catch (err) {
              fail(t(`${NS}.saveFailed`), err);
            }
          },
        },
        icon('save'),
        t(`${NS}.joinSaveToList`),
      ),
    ],
  });
}

// Crea una instancia Vanilla con la version del servidor (sin mods) y devuelve su id
async function createVanillaFor(address, version) {
  try {
    const res = await runBuild(address, { loader: 'vanilla', mods: false, mcVersion: version, name: `${shortName(address)} ${version}` });
    return res?.instanceId || null;
  } catch (err) {
    if (!missingHandler(err)) throw err;
    const inst = await api.instances.create({ name: `${shortName(address)} ${version}`, mcVersion: version, loader: 'vanilla' });
    await store.refreshInstances();
    return inst.id;
  }
}

function shortName(address) {
  const host = String(address).replace(/:\d+$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.').filter((l) => !/^(www|play|mc|hub|join|server|srv|java|connect|go)$/i.test(l));
  const core = labels.length >= 2 ? labels[labels.length - 2] : labels[0] || host;
  return core.charAt(0).toUpperCase() + core.slice(1);
}

/**
 * Entra a un servidor: elige (o pregunta) la instancia y la abre con Quick Play.
 * opts: { instanceId?, name? } -> Promise<boolean>
 */
export async function joinServer(address, opts = {}) {
  await ensureUi();
  const clean = cleanAddress(address);
  if (!clean) {
    fail(t(`${NS}.joinFailed`), t(`${NS}.invalidAddress`));
    return false;
  }
  if (!store.selectedAccount()) {
    openAccounts({ welcome: true });
    return false;
  }
  try {
    let instanceId = opts.instanceId && store.instances.some((i) => i.id === opts.instanceId) ? opts.instanceId : null;
    let remember = false;
    if (!instanceId) {
      if (!store.instances.length) await store.refreshInstances().catch(() => {});
      const wait = checkingModal(clean);
      let info = null;
      try {
        info = await api.invoke('serverlist:pickInstance', clean, { details: true });
      } catch (err) {
        if (!missingHandler(err)) {
          wait.close();
          throw err;
        }
        // Sin el modulo principal: elegir a mano entre todas las instancias
        info = { server: { online: false }, candidates: store.instances.map((i) => ({ id: i.id, name: i.name, mcVersion: i.mcVersion, loader: i.loader, compatible: null })), best: store.selectedInstance()?.id || null };
      }
      if (wait.cancelled) return false;
      wait.close();
      const cands = info.candidates || [];
      const compatible = cands.filter((c) => c.compatible === true);
      const pref = info.preferred && cands.find((c) => c.id === info.preferred && c.compatible !== false);
      let choice = null;
      if (pref) choice = { id: pref.id };
      else if (info.server?.online && compatible.length === 1) choice = { id: compatible[0].id };
      else if (info.server?.online && compatible.length > 1 && !info.ambiguous) choice = { id: info.best };
      else if (info.server?.online && !compatible.length && cands.some((c) => c.compatible === null)) choice = await chooseInstanceDialog(info, clean, { mode: 'unverified' });
      else if (info.server?.online && !compatible.length) choice = await chooseInstanceDialog(info, clean, { mode: 'none' });
      else if (!info.server?.online) choice = await chooseInstanceDialog(info, clean, { mode: 'offline' });
      else choice = await chooseInstanceDialog(info, clean, { mode: 'choose' });
      if (!choice) return false;
      if (choice.build) {
        openBuildFromServer(clean);
        return false;
      }
      if (choice.create) {
        const id = await createVanillaFor(clean, info.server.mcVersion);
        if (!id) return false;
        await store.refreshInstances().catch(() => {});
        choice = { id, remember: true };
      }
      instanceId = choice.id;
      remember = Boolean(choice.remember);
    }
    const inst = store.instances.find((i) => i.id === instanceId) || (await store.refreshInstances(), store.instances.find((i) => i.id === instanceId));
    if (!inst) throw new Error(t(`${NS}.err_noInstance`));
    if (store.running[inst.id]?.state === 'running' || store.running[inst.id]?.state === 'preparing') {
      alreadyRunningDialog(inst, clean);
      return false;
    }
    if (!(await waitInstanceReady(inst, clean))) return false;
    let plan;
    try {
      plan = await api.invoke('serverlist:join', clean, { instanceId: inst.id, remember, name: opts.name });
    } catch (err) {
      if (!missingHandler(err)) throw err;
      plan = { quickPlay: quickPlayOf(clean) };
    }
    toast('info', t(`${NS}.joinStartingTitle`), t(`${NS}.joinStarting`, { name: inst.name, server: clean }), 3500);
    return await launchInstance(inst.id, { quickPlay: plan.quickPlay });
  } catch (err) {
    fail(t(`${NS}.joinFailed`), missingHandler(err) ? t(`${NS}.err_unavailable`) : err);
    return false;
  }
}

// ---------- Armar instancia desde un servidor ----------

// Ejecuta serverlist:buildInstance siguiendo su tarea. onTask(tarea) para mostrar el progreso.
async function runBuild(address, opts, { onTask } = {}) {
  const token = `sl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const off = store.on('task', (tk) => {
    if (tk.meta?.serverlistBuild === token) onTask?.(tk);
  });
  try {
    const res = await api.invoke('serverlist:buildInstance', address, { ...opts, token });
    await store.refreshInstances().catch(() => {});
    return res;
  } finally {
    off();
  }
}

const REASON_KEYS = { notFound: 'buildReason_notFound', noVersion: 'buildReason_noVersion', download: 'buildReason_download', error: 'buildReason_error' };

function extLink(label, url, iconName = 'external') {
  return h('button', { class: 'btn ghost sm', onclick: () => api.app.openExternal(url).catch(() => {}) }, icon(iconName), label);
}

// Ficha resumida del servidor (vista previa del armado)
function buildPreviewCard(result) {
  return h(
    'div',
    { class: 'sl-preview' },
    serverIcon(result.favicon, 'lg'),
    h(
      'div',
      { class: 'sl-preview-main' },
      h('div', { class: 'sl-preview-addr ellipsis' }, result.address),
      motdView(result.motd, { lines: 2 }),
      h(
        'div',
        { class: 'sl-preview-meta' },
        h('span', { class: 'sl-meta' }, icon('users'), playersText(result)),
        latencyBars(result),
        h('span', { class: 'badge' }, icon('box'), versionText(result)),
        loaderBadgeFor(result) || h('span', { class: 'badge' }, loaderText(result)),
      ),
    ),
  );
}

/**
 * Dialogo "Armar instancia desde un servidor": direccion -> vista previa -> progreso -> resultado.
 */
export async function openBuildFromServer(address) {
  await ensureUi();
  const body = h('div', { class: 'sl-build' });
  const foot = h('div', { class: 'sl-build-foot' });
  let alive = true;
  const m = modal({
    title: t(`${NS}.buildTitle`),
    size: 'wide',
    body,
    footer: foot,
    onClose: () => {
      alive = false;
    },
  });

  // Paso 1: direccion
  function stepInput(prefill = '', error = null) {
    const input = h('input', { class: 'input mono', id: 'sl-build-ip', value: prefill, placeholder: t(`${NS}.addressPlaceholder`), maxlength: 300, spellcheck: 'false', 'aria-describedby': 'sl-build-ip-err', 'aria-invalid': error ? 'true' : 'false' });
    const errBox = h('div', { class: 'field-error sl-err', id: 'sl-build-ip-err', role: 'alert' }, error ? [icon('alert'), h('span', {}, error)] : null);
    const go = () => {
      const clean = cleanAddress(input.value);
      if (!clean) {
        mount(errBox, icon('alert'), h('span', {}, t(`${NS}.invalidAddress`)));
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      stepAnalyze(clean);
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') !== 'true') return;
      input.setAttribute('aria-invalid', 'false');
      mount(errBox);
    });
    const recentBox = h('div', { class: 'chips sl-recent' });
    api
      .invoke('serverlist:history')
      .then((hist) => {
        if (!alive || !hist?.length) return;
        mount(recentBox, h('span', { class: 'sl-recent-label' }, t(`${NS}.recent`)), hist.slice(0, 6).map((it) => h('button', { class: 'chip', onclick: () => ((input.value = it.address), go()) }, it.address)));
      })
      .catch(() => {});
    mount(
      body,
      h(
        'div',
        { class: 'stack' },
        h('div', { class: 'sl-build-intro' }, h('div', { class: 'qa-icon' }, icon('hammer')), h('p', { class: 'text-2' }, t(`${NS}.buildIntro`))),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'sl-build-ip' }, t(`${NS}.addressLabel`)),
          h('div', { class: 'sl-address-row' }, h('div', { class: 'input-icon' }, icon('server'), input), h('button', { class: 'btn primary', onclick: go }, icon('search'), t(`${NS}.buildAnalyze`))),
          errBox,
        ),
        recentBox,
        h('div', { class: 'notice info' }, icon('info'), t(`${NS}.buildHowItWorks`)),
      ),
    );
    mount(foot, h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.cancel`)));
    setTimeout(() => input.focus(), 40);
  }

  // Paso 2: analizar (esqueleto con la forma de la vista previa)
  async function stepAnalyze(addr) {
    const bone = (cls) => h('span', { class: `skeleton ${cls}` });
    mount(
      body,
      h(
        'div',
        { class: 'sl-preview-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
        h('div', { class: 'sl-analyzing' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', {}, t(`${NS}.buildAnalyzing`, { server: addr }))),
        h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, bone('skeleton-block'), h('div', { class: 'skeleton-row' }, bone(''), bone('')), bone('skeleton-line'), bone('skeleton-line title')),
      ),
    );
    mount(foot, h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.cancel`)));
    const result = await pingServer(addr, { force: true, remember: true });
    if (!alive) return;
    if (!result.online) {
      stepInput(addr, result.error === 'unavailable' ? t(`${NS}.err_unavailable`) : t(`${NS}.buildOffline`, { server: addr, reason: errorText(result) }));
      return;
    }
    stepPreview(addr, result);
  }

  // Paso 3: vista previa y opciones
  function stepPreview(addr, result) {
    const detected = result.loader && ['forge', 'neoforge', 'fabric', 'quilt'].includes(result.loader) ? result.loader : 'vanilla';
    let loader = detected;
    let version = result.mcVersion || '?';
    const nameInput = h('input', { class: 'input', id: 'sl-build-name', value: shortName(addr), maxlength: 60 });
    const versionBox = h('div', { class: 'sl-version-box' }, h('div', { class: 'row small muted sl-version-loading' }, h('div', { class: 'spinner' }), t(`${NS}.buildVersionLoading`)));
    // Version: la mas nueva que acepta el servidor (se prueba) y las demas de su rango para elegir
    const loadVersions = async () => {
      let opts = null;
      try {
        opts = await api.invoke('serverlist:versionOptions', addr);
      } catch {
        opts = null;
      }
      if (!alive) return;
      const options = opts?.options?.length ? opts.options : result.mcVersion ? [result.mcVersion] : [];
      version = opts?.best || options[0] || version;
      if (options.length <= 1 || opts?.fixed) {
        mount(versionBox, h('div', { class: 'sl-version-fixed' }, icon('box'), h('strong', {}, version), opts?.fixed ? h('span', { class: 'small muted' }, t(`${NS}.buildVersionFixed`)) : null));
      } else {
        const sel = selectEl(
          options.map((v) => ({ value: v, label: v === opts.best ? t(`${NS}.buildVersionBest`, { version: v }) : v === opts.native ? t(`${NS}.buildVersionNative`, { version: v }) : v })),
          version,
          (v) => {
            version = v;
            drawPlan();
          },
        );
        sel.setAttribute('aria-label', t(`${NS}.buildVersionLabel`));
        mount(versionBox, sel);
      }
      createBtn.disabled = !version || version === '?';
      drawPlan();
    };
    const seg = h('div', { class: 'segmented sl-loader-seg', role: 'radiogroup', 'aria-labelledby': 'sl-build-loader-label' });
    const LOADER_OPTS = ['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'];
    const setLoader = (l, focus = false) => {
      loader = l;
      drawSeg();
      drawPlan();
      if (focus) seg.querySelector('button.active')?.focus();
    };
    // Grupo de radios: Tab entra al elegido y las flechas cambian la eleccion
    seg.addEventListener('keydown', (e) => {
      const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!move && e.key !== 'Home' && e.key !== 'End') return;
      e.preventDefault();
      const i = LOADER_OPTS.indexOf(loader);
      const j = e.key === 'Home' ? 0 : e.key === 'End' ? LOADER_OPTS.length - 1 : (i + move + LOADER_OPTS.length) % LOADER_OPTS.length;
      setLoader(LOADER_OPTS[j], true);
    });
    const drawSeg = () =>
      mount(
        seg,
        LOADER_OPTS.map((l) =>
          h(
            'button',
            {
              class: [l === loader && 'active'],
              role: 'radio',
              tabindex: l === loader ? 0 : -1,
              'aria-checked': String(l === loader),
              onclick: () => setLoader(l),
            },
            LOADERS[l]?.name || l,
            l === detected && l !== 'vanilla' ? h('span', { class: 'sl-detected', title: t(`${NS}.buildDetected`), 'aria-label': t(`${NS}.buildDetected`), role: 'img' }, icon('check')) : null,
          ),
        ),
      );
    const planBox = h('div', { class: 'stack' });
    const mods = result.mods || [];
    const drawPlan = () => {
      const blocks = [];
      if ((loader === 'forge' || loader === 'neoforge') && loader === result.loader && mods.length) {
        blocks.push(
          h('div', { class: 'notice good' }, icon('puzzle'), h('div', {}, h('strong', {}, t(`${NS}.buildDetectedMods`, { loader: LOADERS[loader].name, version, count: mods.length })), ' ', t(`${NS}.buildModsInfo`))),
          h('div', { class: 'sl-modchips' }, mods.slice(0, 120).map((md) => h('span', { class: 'sl-modchip', title: md.version ? `${md.id} ${md.version}` : md.id }, md.id)), mods.length > 120 ? h('span', { class: 'sl-modchip sl-modchip-more' }, t(`${NS}.moreMods`, { count: mods.length - 120 })) : null),
        );
        if (result.modsTruncated) blocks.push(h('div', { class: 'notice' }, icon('alert'), t(`${NS}.buildTruncated`)));
        if (result.serverOnlyMods) blocks.push(h('div', { class: 'small muted' }, t(`${NS}.buildServerOnly`, { count: result.serverOnlyMods })));
      } else if (loader === 'neoforge' && result.loader === 'neoforge') {
        blocks.push(h('div', { class: 'notice info' }, icon('info'), t(`${NS}.buildNeoNoList`, { version })));
      } else if (loader === result.loader && loader !== 'vanilla') {
        blocks.push(h('div', { class: 'notice info' }, icon('info'), t(`${NS}.buildLoaderNoList`, { loader: LOADERS[loader]?.name || loader, version })));
      } else if (loader !== 'vanilla' && loader !== detected) {
        blocks.push(h('div', { class: 'notice' }, icon('alert'), t(`${NS}.buildLoaderOverride`, { loader: LOADERS[loader]?.name || loader, version })));
      } else {
        blocks.push(h('div', { class: 'notice info' }, icon('info'), t(`${NS}.buildVanillaInfo`, { version })));
      }
      mount(planBox, blocks);
    };
    const createBtn = h('button', { class: 'btn primary', disabled: true }, icon('hammer'), t(`${NS}.buildCreate`));
    drawSeg();
    drawPlan();
    mount(
      body,
      h(
        'div',
        { class: 'stack' },
        buildPreviewCard(result),
        h(
          'div',
          { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: 'sl-build-name' }, t(`${NS}.buildNameLabel`)), nameInput),
          h('div', { class: 'field' }, h('label', { id: 'sl-build-version-label' }, t(`${NS}.buildVersionLabel`)), versionBox),
          h('div', { class: 'field full' }, h('div', { class: 'label', id: 'sl-build-loader-label' }, t(`${NS}.buildLoaderLabel`)), seg),
        ),
        planBox,
      ),
    );
    createBtn.addEventListener('click', () => {
      if (createBtn.disabled) return;
      stepProgress(addr, result, { loader, mcVersion: version, name: nameInput.value.trim() || shortName(addr) });
    });
    mount(foot, h('button', { class: 'btn ghost', onclick: () => stepInput(addr) }, icon('chevronLeft'), t(`${NS}.back`)), h('span', { class: 'spacer' }), createBtn);
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && createBtn.click());
    loadVersions();
  }

  // Paso 4: progreso
  async function stepProgress(addr, result, opts) {
    const bar = h('i', { style: { width: '2%' } });
    const progress = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': t(`${NS}.buildWorkingTitle`, { name: opts.name }) }, bar);
    const detail = h('div', { class: 'small muted sl-build-detail', 'aria-live': 'polite' }, t(`${NS}.buildWorking`));
    mount(
      body,
      h(
        'div',
        { class: 'stack sl-build-progress' },
        buildPreviewCard(result),
        h('div', { class: 'sl-build-status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('strong', {}, t(`${NS}.buildWorkingTitle`, { name: opts.name }))),
        progress,
        detail,
        h('div', { class: 'sl-build-note' }, icon('info'), h('span', {}, t(`${NS}.buildBackground`))),
      ),
    );
    mount(foot, h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.closeKeepGoing`)));
    try {
      const res = await runBuild(addr, { loader: opts.loader, mcVersion: opts.mcVersion, name: opts.name, serverName: addr }, {
        onTask: (tk) => {
          if (!alive) return;
          if (tk.progress !== null && tk.progress !== undefined) {
            const pct = Math.max(2, Math.round(tk.progress * 100));
            bar.style.width = `${pct}%`;
            progress.setAttribute('aria-valuenow', String(pct));
          }
          if (tk.detail) {
            detail.textContent = tk.detail;
            detail.title = tk.detail;
          }
        },
      });
      if (!alive) {
        ok(t(`${NS}.buildDoneTitle`), t(`${NS}.buildDoneToast`, { name: res.name }));
        return;
      }
      stepResult(addr, result, res);
    } catch (err) {
      if (!alive) return;
      if (/cancel/i.test(err.message)) {
        stepPreview(addr, result);
        return;
      }
      mount(body, h('div', { class: 'stack' }, buildPreviewCard(result), h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t(`${NS}.buildFailed`)), h('div', {}, missingHandler(err) ? t(`${NS}.err_unavailable`) : err.message)))));
      mount(foot, h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.close`)), h('button', { class: 'btn', onclick: () => stepPreview(addr, result) }, icon('refresh'), t(`${NS}.retry`)));
    }
  }

  // Paso 5: resultado
  function stepResult(addr, result, res) {
    const missing = res.missing || [];
    const installed = res.installed || [];
    const approx = installed.filter((i) => i.exact === false);
    const mcVersion = res.mcVersion;
    const loaderName = LOADERS[res.loader]?.name || res.loader;
    const sections = [
      h(
        'div',
        { class: 'sl-done-head' },
        h('div', { class: 'sl-done-icon' }, icon('check')),
        h('div', {}, h('div', { class: 'sl-done-title' }, t(`${NS}.buildDoneTitle`)), h('div', { class: 'text-2' }, t(`${NS}.buildDoneText`, { name: res.name, version: mcVersion, loader: loaderName }))),
      ),
    ];
    if (res.modsTotal) {
      sections.push(
        h(
          'div',
          { class: 'sl-done-stats' },
          h('div', { class: 'sl-stat sl-stat-good' }, h('div', { class: 'sl-stat-value' }, String(installed.length)), h('div', { class: 'sl-stat-label' }, t(`${NS}.buildInstalled`, { count: installed.length }))),
          h('div', { class: ['sl-stat', missing.length ? 'sl-stat-bad' : 'sl-stat-good'] }, h('div', { class: 'sl-stat-value' }, String(missing.length)), h('div', { class: 'sl-stat-label' }, t(`${NS}.buildMissing`, { count: missing.length }))),
          res.serverOnly ? h('div', { class: 'sl-stat' }, h('div', { class: 'sl-stat-value' }, String(res.serverOnly)), h('div', { class: 'sl-stat-label' }, t(`${NS}.buildServerOnlyShort`, { count: res.serverOnly }))) : null,
        ),
      );
    } else if (res.loader === 'neoforge' || res.loader === 'forge') {
      sections.push(h('div', { class: 'notice info' }, icon('info'), t(`${NS}.buildNoModsList`)));
    }
    if (missing.length) {
      sections.push(
        h('div', { class: 'sl-section-label', role: 'heading', 'aria-level': '3' }, t(`${NS}.buildMissingTitle`)),
        h('div', { class: 'small muted' }, t(`${NS}.buildMissingHelp`)),
        h(
          'div',
          { class: 'sl-missing' },
          missing.map((mi) =>
            h(
              'div',
              { class: 'sl-missing-row' },
              h('div', { class: 'sl-missing-main' }, h('div', { class: 'sl-missing-id mono ellipsis', title: mi.title || mi.id }, mi.title || mi.id), h('div', { class: 'small muted ellipsis' }, [mi.version ? `${mi.id} ${mi.version}` : mi.id, ' · ', t(`${NS}.${REASON_KEYS[mi.reason] || 'buildReason_notFound'}`, { loader: loaderName, version: mcVersion })])),
              mi.projectSlug ? extLink(t(`${NS}.openModrinth`), `https://modrinth.com/mod/${encodeURIComponent(mi.projectSlug)}`) : extLink(t(`${NS}.searchModrinth`), `https://modrinth.com/mods?q=${encodeURIComponent(mi.id)}`, 'search'),
              extLink(t(`${NS}.searchCurseforge`), `https://www.curseforge.com/minecraft/search?page=1&pageSize=20&sortBy=relevancy&class=mc-mods&search=${encodeURIComponent(mi.id)}`, 'search'),
            ),
          ),
        ),
      );
    }
    if (approx.length) {
      sections.push(h('div', { class: 'notice' }, icon('alert'), t(`${NS}.buildApproxInfo`, { count: approx.length, list: approx.slice(0, 6).map((a) => a.title || a.id).join(', ') })));
    }
    mount(body, h('div', { class: 'stack' }, sections));
    mount(
      foot,
      h('button', { class: 'btn ghost', onclick: () => m.close() }, t(`${NS}.close`)),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => (m.close(), navigate(`instance/${res.instanceId}`)) }, icon('settings'), t(`${NS}.buildGoInstance`)),
      h('button', { class: 'btn primary', onclick: () => (m.close(), joinServer(addr, { instanceId: res.instanceId })) }, icon('play'), t(`${NS}.buildJoinNow`)),
    );
  }

  const pre = address ? cleanAddress(address) : null;
  if (pre) stepAnalyze(pre);
  else stepInput(address || '');
}

// Avatares de jugadores de la muestra (los "jugadores" con UUID en cero son lineas de texto del servidor)
export function sampleView(sample = []) {
  const real = sample.filter((p) => p.id && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(p.id) && /^[\w]{2,16}$/.test(p.name));
  const lines = sample.filter((p) => !real.includes(p));
  return h(
    'div',
    { class: 'sl-sample' },
    real.length ? h('div', { class: 'sl-sample-players' }, real.map((p) => h('div', { class: 'player-chip', title: p.name }, avatarImg(p.id, 32, ''), h('span', { class: 'ellipsis' }, p.name)))) : null,
    lines.length ? h('div', { class: 'sl-sample-lines' }, lines.map((p) => motdView(p.name, { lines: 1, cls: 'inline' }))) : null,
  );
}

export { copyText };
