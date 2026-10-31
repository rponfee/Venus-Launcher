// Dialogo de instalacion (contrato del modulo "modrinth"):
//   openInstallDialog(project, { type?, instanceId?, serverId?, versionId?, fileId? }) -> Promise<resultado | null>
// project puede ser un resultado de busqueda, un proyecto completo de Modrinth o { id } / { slug }.
// Si project.source === 'curseforge' instala desde CurseForge (necesita la API key del usuario).
// Pasos: elegir destino (instancia con aviso de compatibilidad, instancia nueva, servidor local para
// plugins y mods de servidor, mundo para data packs), la mejor version compatible (se puede cambiar),
// checkBeforeInstall de features/compat.js y la instalacion con las APIs existentes.
import { h, icon, mount, modal, toast, ok, fail, selectEl, switchEl, setBusy, ensureCss, fmtDate, fmtNumber, instanceIcon, instanceLoaderKey } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import {
  TYPE_IDS,
  INSTALLABLE_LOADERS,
  typeLabelOne,
  loaderName,
  loaderChip,
  acceptedLoaders,
  serverLoadersFor,
  isPluginServer,
  isModServer,
  isProxyServer,
  loadServerTypes,
  targetProblem,
  sortVersions,
  versionMatches,
  bestVersion,
  channelPill,
  isReleaseVersion,
  versionSummary,
  projectIcon,
  projectUrl,
  modLoadersFor,
  keepFocus,
} from '../pages/modrinth/shared.js';

const PLUGIN_LOADERS = new Set(['bukkit', 'bungeecord', 'folia', 'paper', 'purpur', 'spigot', 'sponge', 'velocity', 'waterfall', 'geyser']);
let ixSeq = 0; // ids unicos para enlazar etiquetas y campos de cada dialogo

export async function openInstallDialog(project, opts = {}) {
  ensureCss('features/install');
  try {
    await loadNs('install', 'modrinth');
  } catch {
    /* los textos caen al idioma de respaldo */
  }
  if (!project || typeof project !== 'object') {
    fail(t('install.errNoProject'));
    return null;
  }
  return project.source === 'curseforge' ? curseforgeDialog(project, opts || {}) : modrinthDialog(project, opts || {});
}

// ---------- Piezas comunes ----------

function serverIcon() {
  return h('div', { class: 'ix-ticon srv' }, icon('server'));
}

function targetRow(tg, selected, onPick) {
  const st = tg.eval || {};
  const pill = st.installed
    ? h('span', { class: 'pill good' }, icon('check'), st.upToDate ? t('install.installedLatest') : t('install.installedVersion', { version: st.installed }))
    : st.status === 'ok'
      ? h('span', { class: 'pill good' }, icon('check'), t('install.compatible'))
      : st.status === 'blocked'
        ? h('span', { class: 'pill bad' }, icon('ban'), t('install.notUsable'))
        : h('span', { class: 'pill warn' }, icon('alert'), t('install.noMatch'));
  const sub = tg.kind === 'new' ? t('install.newSub') : tg.sub;
  const name = tg.kind === 'new' ? t('install.newInstance') : tg.name;
  const subText = st.reason && st.status !== 'ok' ? st.reason : sub;
  const fk = `tg-${tg.kind}:${tg.id}`;
  const row = h(
    'div',
    {
      class: ['ix-target', selected && 'active', st.status === 'blocked' && 'blocked'],
      role: 'radio',
      'aria-checked': selected ? 'true' : 'false',
      tabindex: selected ? 0 : -1,
      dataset: { fk },
      onclick: () => onPick(tg),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(tg);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          // grupo de radios: las flechas eligen el destino siguiente y el foco lo acompaña
          e.preventDefault();
          const list = row.parentElement;
          const rows = [...list.querySelectorAll('.ix-target')];
          const i = rows.indexOf(row);
          const n = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          const nextFk = rows[n]?.dataset.fk;
          rows[n]?.click();
          // el dialogo se redibuja al elegir: se enfoca la fila nueva con la misma clave
          const live = [...(row.closest('.ix') || document).querySelectorAll('.ix-target')].find((x) => x.dataset.fk === nextFk);
          const next = live || rows[n];
          next?.focus({ preventScroll: true });
          revealIn(next?.parentElement, next);
        }
      },
    },
    h('span', { class: 'ix-radio', 'aria-hidden': 'true' }),
    tg.kind === 'instance' ? instanceIcon(tg.inst, 'ix-ticon') : tg.kind === 'server' ? serverIcon() : h('div', { class: 'ix-ticon new' }, icon('plus')),
    h('div', { class: 'ix-tmain' }, h('div', { class: 'ix-tname ellipsis', title: name }, name), h('div', { class: 'ix-tsub ellipsis', title: subText }, subText)),
    tg.kind === 'new' ? null : pill,
  );
  return row;
}

function section(title, ...children) {
  const id = `ix-sec-${++ixSeq}`;
  return h('div', { class: 'ix-section', role: 'group', 'aria-labelledby': id }, h('div', { class: 'ix-label', id }, title), ...children);
}

// Cabecera del dialogo: icono, nombre, tipo, descargas y descripcion corta
function projectHead(project, ...badges) {
  return h(
    'div',
    { class: 'ix-head' },
    projectIcon(project.icon_url, 'ix-picon'),
    h(
      'div',
      { class: 'ix-hmain' },
      h('div', { class: 'ix-htitle ellipsis', title: project.title }, project.title),
      h('div', { class: 'ix-hsub' }, badges, Number.isFinite(Number(project.downloads)) ? h('span', { class: 'ix-hdl num' }, icon('download'), t('install.downloads', { n: fmtNumber(project.downloads) })) : null),
      project.description ? h('div', { class: 'ix-hdesc ellipsis', title: project.description }, project.description) : null,
    ),
  );
}

// Redibuja el cuerpo del dialogo conservando el foco (data-fk) y el desplazamiento: al cambiar la version
// o un campo de abajo, la vista no salta al principio.
function remount(body, parts) {
  const scroller = body.closest('.modal-body');
  const top = scroller ? scroller.scrollTop : 0;
  keepFocus(body, () => mount(body, ...parts));
  if (scroller) scroller.scrollTop = top;
}

// Muestra una fila dentro de su lista desplazando solo la lista (nunca el cuerpo del dialogo)
function revealIn(list, el) {
  if (!list || !el) return;
  const lr = list.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  if (er.top < lr.top) list.scrollTop -= lr.top - er.top + 4;
  else if (er.bottom > lr.bottom) list.scrollTop += er.bottom - lr.bottom + 4;
}

// Lista de destinos con sombra abajo mientras quede contenido por desplazar
function targetsList(label, rows) {
  const list = h('div', { class: 'ix-targets', role: 'radiogroup', 'aria-label': label }, rows);
  const sync = () => list.classList.toggle('more', list.scrollHeight - list.scrollTop - list.clientHeight > 4);
  list.addEventListener('scroll', sync, { passive: true });
  requestAnimationFrame(() => {
    revealIn(list, list.querySelector('.ix-target.active'));
    sync();
  });
  return list;
}

// Interruptor con su texto (en lugar de una casilla del sistema)
function toggleRow(text, checked, onChange) {
  const sw = switchEl(checked, onChange, text);
  const box = sw.querySelector('input');
  box.dataset.fk = `toggle-${text}`;
  return h('div', { class: 'ix-check' }, sw, h('span', { class: 'ix-check-text', onclick: () => box.click() }, text));
}

// Esqueleto del dialogo mientras llegan el proyecto y sus versiones
function ixSkeleton() {
  const bone = (cls, w) => h('span', { class: `skeleton ${cls}`, style: w ? { width: w } : null });
  const row = (w) => h('div', { class: 'ix-target ix-sk-row' }, bone('ix-sk-dot'), bone('ix-ticon'), h('div', { class: 'ix-tmain ix-sk-lines' }, bone('skeleton-line', w), bone('skeleton-line', '34%')), bone('ix-sk-pill'));
  return h(
    'div',
    { class: 'skeleton-group ix-skel', role: 'status', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('install.loading')),
    h(
      'div',
      { class: 'ix', 'aria-hidden': 'true' },
      h('div', { class: 'ix-head' }, bone('ix-picon'), h('div', { class: 'ix-hmain ix-sk-lines' }, bone('skeleton-line', '38%'), bone('skeleton-line', '62%'))),
      h('div', { class: 'ix-section' }, bone('skeleton-line ix-sk-label'), h('div', { class: 'ix-targets' }, row('46%'), row('58%'), row('40%'))),
      h('div', { class: 'ix-section' }, bone('skeleton-line ix-sk-label'), bone('ix-sk-select')),
    ),
  );
}

async function compatAllows(target, items) {
  try {
    const mod = await import('./compat.js');
    if (typeof mod.checkBeforeInstall !== 'function') return true;
    const res = await mod.checkBeforeInstall({ target: { kind: target.kind, id: target.id }, items });
    return res !== false;
  } catch (err) {
    console.warn('[modrinth] checkBeforeInstall', err);
    return true;
  }
}

function errorBox(err, onRetry) {
  return h(
    'div',
    { class: 'notice bad ix-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'spacer' }, h('strong', {}, t('install.loadFailed')), h('div', { class: 'ix-error-text' }, err?.message || String(err))),
    onRetry ? h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, icon('refresh'), t('install.retry')) : null,
  );
}

function instSub(inst) {
  const loader = instanceLoaderKey(inst);
  return t('install.instanceSub', { mc: inst.mcVersion, loader: loader === 'vanilla' ? 'Vanilla' : loaderName(loader === 'iris' ? 'iris' : loader) });
}

// ---------- Modrinth ----------

function modrinthDialog(input, opts) {
  const id = input.id || input.project_id || input.slug;
  if (!id) {
    fail(t('install.errNoProject'));
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const body = h('div', { class: 'ix' }, ixSkeleton());
    const footer = h('div', { class: 'ix-foot' });
    const m = modal({
      title: input.title ? t('install.title', { title: input.title }) : t('install.titleGeneric'),
      icon: 'download',
      body,
      footer,
      size: 'wide',
      onClose: () => {
        window.removeEventListener('hashchange', onRoute);
        if (!busy) finish(null);
      },
    });
    const onRoute = () => m.close();
    window.addEventListener('hashchange', onRoute);
    m.el.classList.add('ix-modal');

    const st = { project: null, versions: [], type: null, targets: [], target: null, version: null, manual: false, showAll: false, worlds: null, world: null, newInst: { name: '', mc: '', loader: '' }, deps: new Map() };

    async function load() {
      mount(body, ixSkeleton());
      mount(footer);
      try {
        const [project, versions, servers] = await Promise.all([
          input.body !== undefined && Array.isArray(input.versions) && input.game_versions ? input : api.modrinth.project(id),
          api.modrinth.versions(input.id || input.project_id || id, { includeChangelog: false }),
          api.servers.list().catch(() => store.servers || []),
          loadServerTypes(),
        ]);
        st.project = project;
        st.versions = sortVersions(versions);
        store.servers = servers;
        let type = TYPE_IDS.includes(opts.type) ? opts.type : project.project_type;
        const pre = opts.versionId ? st.versions.find((v) => v.id === opts.versionId) : null;
        if (pre) {
          if (pre.loaders.length && pre.loaders.every((l) => l === 'datapack')) type = 'datapack';
          else if (pre.loaders.some((l) => PLUGIN_LOADERS.has(l)) && !pre.loaders.some((l) => INSTALLABLE_LOADERS.includes(l))) type = 'plugin';
          else if (type === 'datapack' && !pre.loaders.includes('datapack')) type = project.project_type;
        }
        if (!TYPE_IDS.includes(type)) type = 'mod';
        st.type = type;
        m.el.querySelector('.modal-head h3').textContent = t('install.title', { title: project.title });
        buildTargets(servers);
        pickInitialTarget(pre);
        render();
      } catch (err) {
        mount(body, errorBox(err, load));
        mount(footer, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('install.cancel')));
        body.querySelector('.ix-error .btn')?.focus();
      }
    }

    function buildTargets(servers) {
      const { type, versions, project } = st;
      const list = [];
      if (type !== 'modpack') {
        if (type !== 'plugin') {
          for (const inst of store.instances) list.push({ kind: 'instance', id: inst.id, name: inst.name, inst, mc: inst.mcVersion, sub: instSub(inst) });
        }
        // servidores (segun servers:types): plugins en los que cargan plugins (Paper, Purpur, Folia, Spigot,
        // hibridos y proxies); mods de servidor en los que cargan mods (Fabric, Quilt, Forge, NeoForge e
        // hibridos) y tambien en los de plugins si el proyecto publica versiones de plugin para ese servidor
        const pluginBuildsFor = (srv) => {
          const ls = serverLoadersFor(srv, 'plugin');
          return versions.some((v) => v.loaders.some((l) => ls.includes(l)));
        };
        const serverSide = project.server_side !== 'unsupported';
        if (type === 'plugin' || type === 'mod') {
          for (const srv of servers || []) {
            const plugins = isPluginServer(srv);
            const mods = isModServer(srv);
            if (!(plugins || mods)) continue;
            if (type === 'plugin' && !plugins) continue;
            if (type === 'mod' && !mods && !pluginBuildsFor(srv)) continue;
            if (type === 'mod' && mods && !serverSide) continue;
            const proxy = isProxyServer(srv);
            list.push({
              kind: 'server',
              id: srv.id,
              name: srv.name,
              srv,
              mc: proxy ? null : srv.mcVersion,
              sub: proxy ? t('install.proxySub', { type: loaderName(srv.type), version: srv.mcVersion }) : t('install.serverSub', { mc: srv.mcVersion, type: loaderName(srv.type) }),
            });
          }
        }
      }
      if (['mod', 'shader', 'resourcepack', 'modpack'].includes(type) && canCreateInstance()) list.push({ kind: 'new', id: 'new' });
      for (const tg of list) tg.eval = evaluate(tg);
      // compatibles primero (manteniendo el orden de cada grupo)
      const rank = (tg) => (tg.kind === 'new' ? 3 : tg.eval.status === 'ok' ? 0 : tg.eval.status === 'blocked' ? 2 : 1);
      st.targets = list.map((tg, i) => ({ tg, i })).sort((a, b) => rank(a.tg) - rank(b.tg) || a.i - b.i).map((x) => x.tg);
    }

    function canCreateInstance() {
      if (st.type === 'modpack') return st.versions.length > 0;
      return st.versions.some((v) => newInstanceLoaders(v).length);
    }

    // Loaders posibles para una instancia nueva con esta version
    function newInstanceLoaders(v) {
      if (!v) return [];
      if (st.type === 'mod') return INSTALLABLE_LOADERS.filter((l) => v.loaders.includes(l));
      if (st.type === 'shader') return ['iris', 'optifine', 'vanilla'].filter((l) => v.loaders.includes(l));
      if (st.type === 'resourcepack') return ['vanilla'];
      return [];
    }

    function targetLoaders(tg) {
      if (tg.kind === 'server') return serverLoadersFor(tg.srv, st.type);
      return acceptedLoaders(st.type, tg.inst, 'instance');
    }

    function evaluate(tg) {
      if (tg.kind === 'new') return { status: 'ok' };
      const problem = targetProblem(st.type, tg.kind === 'server' ? tg.srv : tg.inst, tg.kind);
      const projects = (tg.kind === 'server' ? tg.srv : tg.inst)?.modrinth?.projects || {};
      const rec = projects[st.project.id];
      if (problem && !(tg.kind === 'server' && st.type === 'mod' && isPluginServer(tg.srv))) {
        return { status: 'blocked', reason: t(`install.problem_${problem}`) };
      }
      const loaders = targetLoaders(tg);
      const best = bestVersion(st.versions, { gameVersion: tg.mc, loaders });
      const installed = rec ? rec.versionNumber || '?' : null;
      if (best) return { status: 'ok', version: best, installed, upToDate: Boolean(rec && rec.versionId === best.id) };
      // tg.mc es null en los proxies: ahi solo importa el loader
      const forMc = tg.mc ? st.versions.filter((v) => v.game_versions.includes(tg.mc)) : st.versions;
      if (forMc.length) {
        const ls = [...new Set(forMc.flatMap((v) => v.loaders))].map(loaderName).slice(0, 3).join(', ');
        return { status: 'loader', reason: t('install.reasonLoader', { loaders: ls }), installed };
      }
      return { status: 'version', reason: t('install.reasonVersion', { mc: tg.mc }), installed };
    }

    function pickInitialTarget(pre) {
      const want = opts.serverId ? { kind: 'server', id: opts.serverId } : opts.instanceId ? { kind: 'instance', id: opts.instanceId } : null;
      let tg = want ? st.targets.find((x) => x.kind === want.kind && x.id === want.id) : null;
      if (!tg && pre) tg = st.targets.find((x) => x.eval.status === 'ok' && versionMatches(pre, { gameVersion: x.mc, loaders: x.kind === 'new' ? null : targetLoaders(x) }));
      if (!tg) {
        const sel = store.selectedInstance();
        tg = st.targets.find((x) => x.kind === 'instance' && x.id === sel?.id && x.eval.status === 'ok');
      }
      if (!tg) tg = st.targets.find((x) => x.eval.status === 'ok' && x.kind !== 'new') || st.targets.find((x) => x.kind === 'new') || st.targets[0] || null;
      selectTarget(tg, pre);
    }

    function compatibleVersions() {
      const tg = st.target;
      if (!tg) return st.versions;
      if (tg.kind === 'new') return st.versions.filter((v) => st.type === 'modpack' || newInstanceLoaders(v).length);
      return st.versions.filter((v) => versionMatches(v, { gameVersion: tg.mc, loaders: targetLoaders(tg) }));
    }

    function selectTarget(tg, preVersion) {
      st.target = tg;
      st.manual = false;
      st.worlds = null;
      st.world = null;
      const compat = compatibleVersions();
      if (tg?.kind === 'new') {
        st.version = preVersion && compat.includes(preVersion) ? preVersion : null;
        resetNewInstance(st.version);
      } else if (preVersion) {
        st.version = preVersion;
        st.manual = !compat.includes(preVersion);
      } else st.version = tg?.eval?.version || null;
      if (st.type === 'datapack' && tg?.kind === 'instance') loadWorlds(tg);
      render();
    }

    // Instancia nueva: loaders posibles (entre todas las versiones), versiones de Minecraft para ese
    // loader y la mejor version del proyecto para la combinacion elegida.
    function newLoaderOptions() {
      const present = new Set(st.versions.flatMap((v) => newInstanceLoaders(v)));
      const order = st.type === 'shader' ? ['iris', 'optifine', 'vanilla'] : st.type === 'resourcepack' ? ['vanilla'] : INSTALLABLE_LOADERS;
      return order.filter((l) => present.has(l));
    }

    function newMcOptions(loader) {
      return sortMc(st.versions.filter((v) => newInstanceLoaders(v).includes(loader)).flatMap((v) => v.game_versions));
    }

    function bestForNew(loader, mc) {
      return bestVersion(st.versions, { gameVersion: mc, loaders: st.type === 'resourcepack' ? null : [loader] });
    }

    // fit: version elegida a mano (se ajustan el loader y Minecraft a esa version)
    function resetNewInstance(fit) {
      const loaders = newLoaderOptions();
      let loader = loaders.includes(st.newInst.loader) ? st.newInst.loader : '';
      if (fit && !newInstanceLoaders(fit).includes(loader)) loader = newInstanceLoaders(fit)[0] || '';
      if (!loader) {
        const sel = store.selectedInstance();
        const pref = st.type === 'mod' && sel ? modLoadersFor(sel)[0] : null;
        loader = loaders.includes(pref) ? pref : loaders[0] || '';
      }
      const mcs = newMcOptions(loader);
      let mc = mcs.includes(st.newInst.mc) ? st.newInst.mc : '';
      if (fit && !fit.game_versions.includes(mc)) mc = sortMc(fit.game_versions)[0] || '';
      if (!mc) mc = mcs[0] || '';
      st.newInst = { name: st.newInst.name || st.project.title, loader, mc };
      if (!fit) st.version = bestForNew(loader, mc);
    }

    async function loadWorlds(tg) {
      try {
        const worlds = await api.instances.content(tg.id, 'saves');
        if (st.target !== tg) return;
        st.worlds = worlds || [];
        st.world = st.worlds[0]?.name || null;
      } catch {
        st.worlds = [];
      }
      render();
    }

    // versiones de Minecraft: releases de la mas nueva a la mas vieja y despues el resto
    function sortMc(list) {
      const uniq = [...new Set(list)];
      const num = (v) => v.split('.').map((x) => parseInt(x, 10) || 0);
      const cmp = (a, b) => {
        const pa = num(a);
        const pb = num(b);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      };
      const rel = uniq.filter(isReleaseVersion).sort(cmp);
      const other = uniq.filter((v) => !isReleaseVersion(v)).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      return [...rel, ...other];
    }

    // ---------- Dibujo ----------
    function render() {
      const { project, type } = st;
      if (!project) return;
      const head = projectHead(project, h('span', { class: 'badge modrinth' }, typeLabelOne(type)));
      if (!st.versions.length) {
        mount(body, head, h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('install.noVersions'))));
        drawFooter();
        return;
      }
      const targetList = st.targets.length
        ? targetsList(
            t('install.whereLabel'),
            st.targets.map((tg) => targetRow(tg, tg === st.target, (x) => x !== st.target && selectTarget(x))),
          )
        : h('div', { class: 'ix-empty' }, emptyTargetsHint());
      const parts = [head];
      if (type === 'modpack') parts.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('install.modpackNote'))));
      else parts.push(section(t('install.where'), targetList, targetHint()));
      if (st.target) parts.push(versionSection());
      if (st.target?.kind === 'new' && type !== 'modpack') parts.push(newInstanceSection());
      if (type === 'datapack' && st.target?.kind === 'instance') parts.push(worldSection());
      const warn = warningsFor();
      if (warn) parts.push(warn);
      // se redibuja todo el cuerpo: el foco vuelve al control equivalente (destino, version, interruptor...)
      remount(body, parts);
      drawFooter();
    }

    function emptyTargetsHint() {
      if (st.type === 'plugin') {
        return [h('div', { class: 'ix-empty-text' }, t('install.noPluginServers')), h('button', { class: 'btn sm', type: 'button', onclick: () => (m.close(), goto('servers')) }, icon('plus'), t('install.createServer'))];
      }
      return [h('div', { class: 'ix-empty-text' }, t('install.noInstances')), h('button', { class: 'btn sm', type: 'button', onclick: () => (m.close(), goto('versions/new')) }, icon('plus'), t('install.createInstance'))];
    }

    function targetHint() {
      const tg = st.target;
      if (!tg || tg.kind !== 'instance') return null;
      if (tg.eval.status === 'blocked' && st.type === 'mod') {
        return h(
          'div',
          { class: 'ix-hint' },
          icon('info'),
          h(
            'span',
            {},
            t('install.hintNeedLoader'),
            ' ',
            h(
              'a',
              {
                href: '#/versions/new',
                onclick: (e) => {
                  e.preventDefault();
                  m.close();
                  goto('versions/new');
                },
              },
              t('install.createInstance'),
            ),
          ),
        );
      }
      if (st.type === 'shader' && tg.eval.status !== 'ok') return h('div', { class: 'ix-hint' }, icon('info'), h('span', {}, t('install.hintShaders')));
      return null;
    }

    function versionLabel(v) {
      const extra = v.version_type !== 'release' ? ` (${t(`modrinth.channel_${v.version_type}`)})` : '';
      return `${v.version_number}${extra} · ${versionSummary(v.game_versions, 2)} · ${v.loaders.map(loaderName).join('/')}`;
    }

    function versionSection() {
      const compat = compatibleVersions();
      const others = st.versions.filter((v) => !compat.includes(v));
      const sel = h('select', { class: 'select ix-vselect', 'aria-label': t('install.version') });
      const addGroup = (label, list) => {
        if (!list.length) return;
        const g = h('optgroup', { label });
        for (const v of list.slice(0, 300)) g.append(h('option', { value: v.id, selected: v === st.version }, versionLabel(v)));
        sel.append(g);
      };
      addGroup(t('install.groupCompatible', { count: compat.length }), compat);
      if (st.showAll || !compat.length || (st.version && !compat.includes(st.version))) addGroup(t('install.groupOther', { count: others.length }), others);
      if (!st.version) sel.prepend(h('option', { value: '', selected: true, disabled: true }, t('install.pickVersion')));
      sel.addEventListener('change', () => {
        st.version = st.versions.find((v) => v.id === sel.value) || null;
        st.manual = true;
        if (st.target?.kind === 'new' && st.version) resetNewInstance(st.version);
        render();
      });
      const v = st.version;
      const best = st.target?.kind === 'new' ? bestForNew(st.newInst.loader, st.newInst.mc) : st.target?.eval?.version;
      const info = v
        ? h(
            'div',
            { class: 'ix-vinfo' },
            channelPill(v.version_type),
            v === best ? h('span', { class: 'badge accent' }, icon('star'), t('install.recommended')) : null,
            h('span', { class: 'ix-vmeta' }, icon('calendar'), fmtDate(v.date_published)),
            ...v.loaders.slice(0, 4).map((l) => loaderChip(l)),
            h('span', { class: 'ix-vmeta ellipsis', title: v.game_versions.join(', ') }, icon('layers'), versionSummary(v.game_versions, 4)),
          )
        : null;
      const toggle =
        others.length && compat.length
          ? toggleRow(t('install.showAllVersions'), st.showAll, (on) => {
              st.showAll = on;
              render();
            })
          : null;
      sel.dataset.fk = 'version';
      return section(t('install.version'), h('div', { class: 'ix-vrow' }, sel, toggle), info, depsPreview(v));
    }

    function depsPreview(v) {
      if (!v || st.type === 'modpack') return null;
      const req = (v.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id);
      if (!req.length) return null;
      const box = h('div', { class: 'ix-deps' }, icon('package'), h('span', { class: 'muted small' }, t('install.depsLoading')));
      const key = v.id;
      const cached = st.deps.get(key);
      const draw = (projects) => {
        const projectsMap = (st.target?.kind === 'server' ? st.target.srv : st.target?.inst)?.modrinth?.projects || {};
        const names = projects.map((p) => (projectsMap[p.id] ? t('install.depInstalled', { title: p.title }) : p.title));
        mount(box, icon('package'), h('span', { class: 'small' }, t('install.depsAlso', { list: names.join(', ') })));
      };
      if (cached) draw(cached);
      else {
        api
          .invoke('modrinth:projects', req.map((d) => d.project_id))
          .then((projects) => {
            st.deps.set(key, projects || []);
            if (box.isConnected) draw(projects || []);
          })
          .catch(() => box.isConnected && mount(box, icon('package'), h('span', { class: 'small muted' }, t('install.depsCount', { count: req.length }))));
      }
      return box;
    }

    function newInstanceSection() {
      const loaders = newLoaderOptions();
      const mcs = newMcOptions(st.newInst.loader);
      const ids = { name: `ix-new-name-${++ixSeq}`, mc: `ix-new-mc-${ixSeq}`, loader: `ix-new-loader-${ixSeq}` };
      const name = h('input', { class: 'input', id: ids.name, value: st.newInst.name, maxlength: 60, dataset: { fk: 'newName' } });
      name.addEventListener('input', () => {
        st.newInst.name = name.value;
        drawFooter();
      });
      const mcSel = selectEl(
        mcs.map((x) => ({ value: x, label: isReleaseVersion(x) ? x : t('install.snapshotVersion', { version: x }) })),
        st.newInst.mc,
        (val) => {
          st.newInst.mc = val;
          st.version = bestForNew(st.newInst.loader, val);
          st.manual = false;
          render();
        },
      );
      mcSel.id = ids.mc;
      mcSel.dataset.fk = 'newMc';
      const loaderOpts = loaders.map((l) => ({ value: l, label: l === 'iris' ? t('install.loaderIris') : l === 'optifine' ? 'OptiFine' : l === 'vanilla' ? 'Vanilla' : loaderName(l) }));
      const loaderSel =
        loaderOpts.length > 1
          ? selectEl(loaderOpts, st.newInst.loader, (val) => {
              st.newInst.loader = val;
              st.manual = false;
              resetNewInstance();
              render();
            })
          : h('div', { class: 'ix-static', id: ids.loader }, loaderOpts[0]?.label || '—');
      if (loaderSel.tagName === 'SELECT') {
        loaderSel.id = ids.loader;
        loaderSel.dataset.fk = 'newLoader';
      }
      return section(
        t('install.newInstance'),
        h(
          'div',
          { class: 'ix-grid3' },
          h('div', { class: 'field' }, h('label', { for: ids.name }, t('install.newName')), name),
          h('div', { class: 'field' }, h('label', { for: ids.mc }, t('install.newMc')), mcSel),
          h('div', { class: 'field' }, loaderSel.tagName === 'SELECT' ? h('label', { for: ids.loader }, t('install.newLoader')) : h('span', { class: 'label' }, t('install.newLoader')), loaderSel),
        ),
        h('div', { class: 'ix-hint' }, icon('info'), h('span', {}, t('install.newHint'))),
      );
    }

    function worldSection() {
      if (st.worlds === null) return section(t('install.world'), h('div', { class: 'ix-loading-line', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('install.worldsLoading')));
      if (!st.worlds.length) return section(t('install.world'), h('div', { class: 'notice' }, icon('globe'), h('div', {}, t('install.noWorlds'))));
      const sel = selectEl(
        st.worlds.map((w) => ({ value: w.name, label: w.name })),
        st.world,
        (val) => {
          st.world = val;
          drawFooter();
        },
      );
      sel.setAttribute('aria-label', t('install.world'));
      sel.dataset.fk = 'world';
      return section(t('install.world'), sel, h('div', { class: 'ix-hint' }, icon('info'), h('span', {}, t('install.worldHint'))));
    }

    function warningsFor() {
      const tg = st.target;
      const v = st.version;
      if (!tg || !v || tg.kind === 'new') return null;
      if (!versionMatches(v, { gameVersion: tg.mc, loaders: targetLoaders(tg) })) {
        return h('div', { class: 'notice' }, icon('alert'), h('div', {}, tg.mc ? t('install.warnIncompatible', { mc: tg.mc }) : t('install.warnIncompatibleProxy', { type: loaderName(tg.srv?.type) })));
      }
      return null;
    }

    function canInstall() {
      const tg = st.target;
      if (!st.version) return false;
      if (st.type === 'modpack') return true;
      if (!tg || tg.eval?.status === 'blocked') return false;
      if (tg.kind === 'new') return Boolean(st.newInst.name.trim() && st.newInst.mc && st.newInst.loader);
      if (st.type === 'datapack' && tg.kind === 'instance' && !st.world) return false;
      return true;
    }

    function actionLabel() {
      const tg = st.target;
      if (st.type === 'modpack') return t('install.installModpack');
      if (!tg) return t('install.install');
      if (tg.kind === 'new') return t('install.createAndInstall');
      if (tg.eval?.installed) return tg.eval.upToDate && st.version?.id === tg.eval.version?.id ? t('install.reinstall') : t('install.updateIn', { name: tg.name });
      return t('install.installIn', { name: tg.name });
    }

    function drawFooter() {
      const p = st.project;
      const label = actionLabel();
      const go = h('button', { class: 'btn modrinth ix-go', type: 'button', disabled: !p || !canInstall(), title: label }, icon('download'), h('span', { class: 'ellipsis' }, label));
      go.addEventListener('click', () => proceed(go));
      // el boton se reemplaza al cambiar el destino o la version: si tenia el foco, lo conserva
      const hadFocus = footer.contains(document.activeElement) && document.activeElement.classList.contains('ix-go');
      mount(
        footer,
        p ? h('button', { class: 'btn ghost', type: 'button', onclick: () => window.venus.app.openExternal(projectUrl({ ...p, project_type: p.project_type })).catch(() => {}) }, icon('external'), t('install.viewOnModrinth')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('install.cancel')),
        p && st.versions.length ? go : null,
      );
      if (hadFocus && !go.disabled) go.focus({ preventScroll: true });
    }

    async function proceed(btn) {
      if (!canInstall()) return;
      const release = setBusy(btn);
      const tg = st.target;
      const sel = { target: tg, version: st.version, world: st.world, newInst: { ...st.newInst } };
      busy = true;
      if (st.type !== 'modpack' && tg && tg.kind !== 'new') {
        // el dialogo de compatibilidad se muestra encima: este se oculta mientras tanto
        const backdrop = m.el.parentElement;
        if (backdrop) backdrop.style.visibility = 'hidden';
        // checkBeforeInstall puede cambiar la version elegida u omitir el item (se modifica en el lugar)
        const items = [{ projectId: st.project.id, versionId: sel.version.id, type: st.type }];
        const allowed = (await compatAllows(tg, items)) && items.length > 0;
        if (!allowed) {
          if (backdrop?.isConnected) {
            backdrop.style.visibility = '';
            busy = false;
            release();
          } else finish(null);
          return;
        }
        sel.versionId = items[0].versionId || sel.version.id;
        if (backdrop?.isConnected) m.close();
      } else m.close();
      finish(await runModrinthInstall(st, sel));
    }

    load();
  });
}

function goto(route) {
  import('../app.js').then((app) => app.navigate(route)).catch(() => (location.hash = `#/${route}`));
}

async function runModrinthInstall(st, { target, version, versionId, world, newInst }) {
  const { project, type } = st;
  // version elegida en la revision de compatibilidad (si la cambio) o la del dialogo
  const vid = versionId || version.id;
  try {
    if (type === 'modpack') {
      toast('info', t('install.packStarted'), t('install.packStartedText', { title: project.title }));
      const inst = await api.modrinth.installModpack({ versionId: version.id });
      await store.refreshInstances();
      ok(t('install.packDone'), inst?.name || project.title);
      return { kind: 'instance', id: inst?.id, created: true, instance: inst };
    }
    if (target.kind === 'server') {
      const r = await api.servers.installProject(target.id, project.id, vid);
      store.servers = await api.servers.list().catch(() => store.servers);
      ok(t('install.doneIn', { name: target.name }), (r?.installed || []).join(', '));
      for (const w of r?.warnings || []) toast('info', t('install.warning'), w, 8000);
      return { kind: 'server', id: target.id, ...r };
    }
    let instId = target.id;
    let instName = target.name;
    if (target.kind === 'new') {
      const loader = newInst.loader;
      const created = await api.instances.create({
        name: newInst.name.trim() || project.title,
        mcVersion: newInst.mc,
        loader: loader === 'iris' ? 'fabric' : loader,
        preset: loader === 'iris' ? 'iris' : null,
      });
      instId = created.id;
      instName = created.name;
      await store.refreshInstances();
      toast('info', t('install.instanceCreated'), t('install.instanceCreatedText', { name: created.name }));
    }
    const r = await api.modrinth.install(instId, project.id, vid, { world: type === 'datapack' ? world : undefined, type });
    await store.refreshInstances();
    ok(t('install.doneIn', { name: instName }), (r?.installed || []).join(', '));
    for (const w of r?.warnings || []) toast('info', t('install.warning'), w, 8000);
    return { kind: 'instance', id: instId, created: target.kind === 'new', ...r };
  } catch (err) {
    if (!/cancel/i.test(err?.message || '')) fail(t('install.failed', { title: project.title }), err);
    return null;
  }
}

// ---------- CurseForge ----------

const CF_RELEASE = { release: 0, beta: 1, alpha: 2 };

function cfLoadersFor(inst) {
  const l = modLoadersFor(inst).filter((x) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(x));
  return l;
}

function cfPick(files, { mc, loaders, type }) {
  const ok = files.filter((f) => f.available !== false && !f.isServerPack && (!mc || !f.gameVersions.length || f.gameVersions.includes(mc)) && (type !== 'mod' || !loaders?.length || !f.loaders.length || f.loaders.some((l) => loaders.includes(l))));
  ok.sort((a, b) => (CF_RELEASE[a.releaseType] ?? 3) - (CF_RELEASE[b.releaseType] ?? 3) || new Date(b.date) - new Date(a.date));
  return ok[0] || null;
}

function curseforgeDialog(input, opts) {
  const modId = input.id;
  return new Promise((resolve) => {
    let settled = false;
    let busy = false;
    const finish = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const body = h('div', { class: 'ix' }, ixSkeleton());
    const footer = h('div', { class: 'ix-foot' });
    const onRoute = () => m.close();
    const m = modal({
      title: input.title ? t('install.title', { title: input.title }) : t('install.titleGeneric'),
      icon: 'download',
      body,
      footer,
      size: 'wide',
      onClose: () => {
        window.removeEventListener('hashchange', onRoute);
        if (!busy) finish(null);
      },
    });
    window.addEventListener('hashchange', onRoute);
    m.el.classList.add('ix-modal', 'ix-cf');
    const st = { project: null, type: null, targets: [], target: null, files: null, filesKey: '', file: null, showAll: false, worlds: null, world: null, newInst: { name: '', mc: '', loader: '' } };

    async function load() {
      mount(body, ixSkeleton());
      mount(footer);
      try {
        const project = input.latestFiles && input.classId ? input : await api.invoke('curseforge:project', modId);
        st.project = project;
        st.type = project.project_type;
        m.el.querySelector('.modal-head h3').textContent = t('install.title', { title: project.title });
        const list = [];
        if (st.type !== 'modpack') for (const inst of store.instances) list.push({ kind: 'instance', id: inst.id, name: inst.name, inst, mc: inst.mcVersion, sub: instSub(inst) });
        if (st.type === 'modpack' || st.type === 'mod' || st.type === 'resourcepack') list.push({ kind: 'new', id: 'new' });
        for (const tg of list) tg.eval = cfEvaluate(tg);
        const rank = (tg) => (tg.kind === 'new' ? 3 : tg.eval.status === 'ok' ? 0 : tg.eval.status === 'blocked' ? 2 : 1);
        st.targets = list.sort((a, b) => rank(a) - rank(b));
        const want = opts.instanceId ? st.targets.find((x) => x.kind === 'instance' && x.id === opts.instanceId) : null;
        const sel = store.selectedInstance();
        await selectTarget(want || st.targets.find((x) => x.kind === 'instance' && x.id === sel?.id && x.eval.status === 'ok') || st.targets.find((x) => x.eval.status === 'ok') || st.targets[0] || null);
      } catch (err) {
        mount(body, errorBox(err, load));
        mount(footer, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('install.cancel')));
        body.querySelector('.ix-error .btn')?.focus();
      }
    }

    function cfEvaluate(tg) {
      if (tg.kind === 'new') return { status: 'ok' };
      const inst = tg.inst;
      const rec = inst.curseforge?.projects?.[st.project.id];
      const installed = rec ? rec.versionNumber || rec.file : null;
      if (st.type === 'mod' && !cfLoadersFor(inst).length) return { status: 'blocked', reason: t('install.problem_instanceNoLoader') };
      if (st.type === 'shader' && inst.loader !== 'optifine' && inst.preset !== 'iris' && !inst.modrinth?.projects?.YL57xq9U) return { status: 'blocked', reason: t('install.problem_instanceNoShaders') };
      const loaders = cfLoadersFor(inst);
      const hit = (st.project.latestFiles || []).some((f) => f.gameVersion === inst.mcVersion && (st.type !== 'mod' || !f.loader || loaders.includes(f.loader)));
      if (hit) return { status: 'ok', installed };
      const forMc = (st.project.latestFiles || []).filter((f) => f.gameVersion === inst.mcVersion);
      if (forMc.length) return { status: 'loader', reason: t('install.reasonLoader', { loaders: [...new Set(forMc.map((f) => f.loader).filter(Boolean))].map(loaderName).join(', ') || '?' }), installed };
      return { status: 'version', reason: t('install.reasonVersion', { mc: inst.mcVersion }), installed };
    }

    async function loadFiles() {
      const tg = st.target;
      const filters = {};
      if (tg && tg.kind === 'instance' && !st.showAll) {
        filters.gameVersion = tg.mc;
        if (st.type === 'mod') filters.loader = cfLoadersFor(tg.inst)[0];
      }
      const key = JSON.stringify(filters);
      if (st.filesKey === key && st.files) return;
      st.files = null;
      st.filesError = null;
      st.filesKey = key;
      render();
      try {
        const res = await api.invoke('curseforge:files', modId, { ...filters, pageSize: 50 });
        if (st.filesKey !== key) return;
        st.files = res.files || [];
      } catch (err) {
        st.files = [];
        st.filesError = err.message;
      }
      const want = opts.fileId ? st.files.find((f) => f.id === Number(opts.fileId)) : null;
      st.file = want || cfPick(st.files, { mc: tg?.kind === 'instance' ? tg.mc : null, loaders: tg?.kind === 'instance' ? cfLoadersFor(tg.inst) : null, type: st.type });
      if (tg?.kind === 'new') resetNew();
      render();
    }

    function resetNew() {
      const f = st.file;
      const mcs = [...(f?.gameVersions || [])].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
      const loaders = st.type === 'mod' ? (f?.loaders || []).filter((l) => INSTALLABLE_LOADERS.includes(l)) : ['vanilla'];
      st.newInst = { name: st.newInst.name || st.project.title, mc: mcs[0] || '', loader: loaders[0] || '' };
    }

    async function selectTarget(tg) {
      st.target = tg;
      st.worlds = null;
      st.world = null;
      if (st.type === 'datapack' && tg?.kind === 'instance') {
        api.instances
          .content(tg.id, 'saves')
          .then((w) => {
            if (st.target !== tg) return;
            st.worlds = w || [];
            st.world = st.worlds[0]?.name || null;
            render();
          })
          .catch(() => {
            st.worlds = [];
            render();
          });
      }
      await loadFiles();
      render();
    }

    function render() {
      const p = st.project;
      if (!p) return;
      const head = projectHead(p, h('span', { class: 'badge ix-cfbadge' }, 'CurseForge'), h('span', { class: 'badge' }, typeLabelOne(st.type)));
      const parts = [head];
      if (st.type === 'modpack') parts.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('install.modpackNote'))));
      else {
        parts.push(
          section(
            t('install.where'),
            st.targets.length
              ? targetsList(
                  t('install.whereLabel'),
                  st.targets.map((tg) => targetRow(tg, tg === st.target, (x) => x !== st.target && selectTarget(x))),
                )
              : h('div', { class: 'ix-empty' }, h('div', { class: 'ix-empty-text' }, t('install.noInstances')), h('button', { class: 'btn sm', type: 'button', onclick: () => (m.close(), goto('versions/new')) }, icon('plus'), t('install.createInstance'))),
          ),
        );
      }
      parts.push(fileSection());
      if (st.target?.kind === 'new' && st.type !== 'modpack') {
        const f = st.file;
        const mcs = [...(f?.gameVersions || [])].sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
        const loaders = st.type === 'mod' ? (f?.loaders || []).filter((l) => INSTALLABLE_LOADERS.includes(l)) : ['vanilla'];
        const ids = { name: `ix-new-name-${++ixSeq}`, mc: `ix-new-mc-${ixSeq}`, loader: `ix-new-loader-${ixSeq}` };
        const name = h('input', { class: 'input', id: ids.name, value: st.newInst.name, maxlength: 60, dataset: { fk: 'newName' } });
        name.addEventListener('input', () => {
          st.newInst.name = name.value;
          drawFooter();
        });
        const mcSel = selectEl(mcs, st.newInst.mc, (v) => (st.newInst.mc = v));
        mcSel.id = ids.mc;
        const loaderSel = loaders.length > 1 ? selectEl(loaders.map((l) => ({ value: l, label: l === 'vanilla' ? 'Vanilla' : loaderName(l) })), st.newInst.loader, (v) => (st.newInst.loader = v)) : null;
        if (loaderSel) loaderSel.id = ids.loader;
        parts.push(
          section(
            t('install.newInstance'),
            h(
              'div',
              { class: 'ix-grid3' },
              h('div', { class: 'field' }, h('label', { for: ids.name }, t('install.newName')), name),
              h('div', { class: 'field' }, h('label', { for: ids.mc }, t('install.newMc')), mcSel),
              h(
                'div',
                { class: 'field' },
                loaderSel ? h('label', { for: ids.loader }, t('install.newLoader')) : h('span', { class: 'label' }, t('install.newLoader')),
                loaderSel || h('div', { class: 'ix-static' }, loaders[0] ? (loaders[0] === 'vanilla' ? 'Vanilla' : loaderName(loaders[0])) : '—'),
              ),
            ),
            h('div', { class: 'ix-hint' }, icon('info'), h('span', {}, t('install.newHint'))),
          ),
        );
      }
      if (st.type === 'datapack' && st.target?.kind === 'instance') {
        if (st.worlds === null) parts.push(section(t('install.world'), h('div', { class: 'ix-loading-line', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), t('install.worldsLoading'))));
        else if (!st.worlds.length) parts.push(section(t('install.world'), h('div', { class: 'notice' }, icon('globe'), h('div', {}, t('install.noWorlds')))));
        else {
          const wSel = selectEl(st.worlds.map((w) => ({ value: w.name, label: w.name })), st.world, (v) => (st.world = v));
          wSel.setAttribute('aria-label', t('install.world'));
          parts.push(section(t('install.world'), wSel, h('div', { class: 'ix-hint' }, icon('info'), h('span', {}, t('install.worldHint')))));
        }
      }
      if (st.file && !st.file.downloadUrl) parts.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('install.cfManualNote'))));
      remount(body, parts);
      drawFooter();
    }

    function fileSection() {
      if (st.files === null) {
        return section(t('install.file'), h('div', { class: 'skeleton-group', role: 'status', 'aria-busy': 'true' }, h('span', { class: 'sr-only' }, t('install.filesLoading')), h('span', { class: 'skeleton ix-sk-select', 'aria-hidden': 'true' })));
      }
      if (!st.files.length) {
        return section(
          t('install.file'),
          h('div', { class: ['notice', st.filesError && 'bad'] }, icon('alert'), h('div', {}, st.filesError || t('install.noFiles'))),
          st.target?.kind === 'instance' && !st.showAll
            ? h('button', { class: 'btn sm ix-showall', type: 'button', onclick: () => ((st.showAll = true), loadFiles()) }, icon('layers'), t('install.showAllFiles'))
            : null,
        );
      }
      const sel = selectEl(
        st.files.map((f) => ({ value: f.id, label: `${f.displayName}${f.releaseType !== 'release' ? ` (${t(`modrinth.channel_${f.releaseType}`)})` : ''} · ${versionSummary(f.gameVersions, 2)}${f.loaders.length ? ` · ${f.loaders.map(loaderName).join('/')}` : ''}` })),
        st.file?.id,
        (v) => {
          st.file = st.files.find((f) => String(f.id) === String(v)) || null;
          if (st.target?.kind === 'new') resetNew();
          render();
        },
      );
      sel.setAttribute('aria-label', t('install.file'));
      sel.dataset.fk = 'file';
      const f = st.file;
      const info = f
        ? h(
            'div',
            { class: 'ix-vinfo' },
            channelPill(f.releaseType),
            h('span', { class: 'ix-vmeta' }, icon('calendar'), fmtDate(f.date)),
            ...f.loaders.map((l) => loaderChip(l)),
            h('span', { class: 'ix-vmeta ellipsis', title: f.gameVersions.join(', ') }, icon('layers'), versionSummary(f.gameVersions, 4)),
          )
        : null;
      const toggle =
        st.target?.kind === 'instance'
          ? toggleRow(t('install.showAllFiles'), st.showAll, (on) => {
              st.showAll = on;
              loadFiles();
            })
          : null;
      return section(t('install.file'), h('div', { class: 'ix-vrow' }, sel, toggle), info);
    }

    function canInstall() {
      const tg = st.target;
      if (!st.file) return false;
      if (st.type === 'modpack') return true;
      if (!tg || tg.eval?.status === 'blocked') return false;
      if (tg.kind === 'new') return Boolean(st.newInst.name.trim() && st.newInst.mc && st.newInst.loader);
      if (st.type === 'datapack' && !st.world) return false;
      return true;
    }

    function drawFooter() {
      const p = st.project;
      const tg = st.target;
      const label = st.type === 'modpack' ? t('install.installModpack') : tg?.kind === 'new' ? t('install.createAndInstall') : tg ? t('install.installIn', { name: tg.name }) : t('install.install');
      const go = h('button', { class: 'btn primary ix-go', type: 'button', disabled: !canInstall(), title: label }, icon('download'), h('span', { class: 'ellipsis' }, label));
      go.addEventListener('click', async () => {
        if (!canInstall()) return;
        const sel = { target: st.target, file: st.file, world: st.world, newInst: { ...st.newInst } };
        busy = true;
        m.close();
        finish(await runCurseForgeInstall(st, sel));
      });
      const hadFocus = footer.contains(document.activeElement) && document.activeElement.classList.contains('ix-go');
      mount(
        footer,
        p?.links?.website ? h('button', { class: 'btn ghost', type: 'button', onclick: () => window.venus.app.openExternal(p.links.website).catch(() => {}) }, icon('external'), t('install.viewOnCurseForge')) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('install.cancel')),
        p ? go : null,
      );
      if (hadFocus && !go.disabled) go.focus({ preventScroll: true });
    }

    load();
  });
}

async function runCurseForgeInstall(st, { target, file, world, newInst }) {
  const { project, type } = st;
  try {
    if (type === 'modpack') {
      toast('info', t('install.packStarted'), t('install.packStartedText', { title: project.title }));
      const r = await api.invoke('curseforge:install', null, project.id, file.id, {});
      await store.refreshInstances();
      ok(t('install.packDone'), r?.instance?.name || project.title);
      if (r?.manual?.length) showManualDownloads(r.manual, r.instance?.id);
      return { kind: 'instance', id: r?.instance?.id, created: true, ...r };
    }
    let instId = target.id;
    let instName = target.name;
    if (target.kind === 'new') {
      const created = await api.instances.create({ name: newInst.name.trim() || project.title, mcVersion: newInst.mc, loader: newInst.loader });
      instId = created.id;
      instName = created.name;
      await store.refreshInstances();
      toast('info', t('install.instanceCreated'), t('install.instanceCreatedText', { name: created.name }));
    }
    const r = await api.invoke('curseforge:install', instId, project.id, file.id, { world: type === 'datapack' ? world : undefined });
    await store.refreshInstances();
    if (r?.installed?.length) ok(t('install.doneIn', { name: instName }), r.installed.join(', '));
    for (const w of r?.warnings || []) toast('info', t('install.warning'), w, 8000);
    if (r?.manual?.length) showManualDownloads(r.manual, instId);
    return { kind: 'instance', id: instId, ...r };
  } catch (err) {
    if (err?.message && /cancel/i.test(err.message)) return null;
    fail(t('install.failed', { title: project.title }), err);
    return null;
  }
}

// Archivos que el autor no deja bajar desde otras apps: link a CurseForge + agregarlos a mano.
function showManualDownloads(items, instanceId) {
  const rows = items.map((it) => {
    const status = h('span', { class: 'muted small' }, it.fileName || '');
    return h(
      'div',
      { class: 'list-item' },
      h('div', { class: 'li-icon' }, icon('download')),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, it.title), status),
      h('button', { class: 'btn sm', onclick: () => window.venus.app.openExternal(it.url).catch(() => {}) }, icon('external'), t('install.manualOpen')),
      instanceId
        ? h(
            'button',
            {
              class: 'btn sm ghost',
              title: t('install.manualAddTitle', { folder: it.folder || 'mods' }),
              onclick: async () => {
                const files = await api.app.selectFiles({ multi: true, title: t('install.manualPick', { title: it.title }) });
                if (!files?.length) return;
                try {
                  await api.instances.addFiles(instanceId, it.folder || 'mods', files);
                  mount(status, h('span', { class: 'pill good' }, icon('check'), t('install.manualAdded')));
                } catch (err) {
                  fail(t('install.manualAddFailed'), err);
                }
              },
            },
            icon('plus'),
            t('install.manualAdd'),
          )
        : null,
    );
  });
  const mm = modal({
    title: t('install.manualTitle', { count: items.length }),
    size: 'wide',
    body: h('div', { class: 'stack' }, h('div', { class: 'notice info' }, icon('info'), t('install.manualText')), h('div', { class: 'list ix-manual' }, rows)),
    footer: [h('button', { class: 'btn primary', onclick: () => mm.close() }, t('install.done'))],
  });
}
