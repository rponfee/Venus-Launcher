// Nube de mundos y configuraciones: estado de cada mundo (al día, local más nuevo, nube más nueva, conflicto),
// subir y bajar, sincronización automática (al cerrar el juego se sube lo jugado; al abrir el launcher se baja
// lo que cambió en otra PC) y el espacio usado. Los archivos los maneja el proceso principal (cloudsync:*):
// acá solo se le pasa el token de la sesión de Venus en cada operación.
//
// Contrato (docs/arquitectura.md §6): openCloudSync(instanceId)
// Además startup() (lo llama features/share.js al abrir el launcher) para la sincronización automática.
import { h, icon, mount, modal, toast, ok, fail, confirmDialog, ensureCss, fmtBytes, fmtAgo, instanceIcon, instanceLoaderKey, loaderVersionLabel, loaderBadge, emptyState, switchEl } from '../ui.js';
import { store, api } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { cloud } from '../cloud.js';
import { navigate } from '../app.js';

// fmtAgo en medio de una frase: 'Subido hace un momento' (no 'Subido Hace un momento').
const agoText = (ts) => {
  const s = fmtAgo(ts);
  return s ? s.charAt(0).toLocaleLowerCase() + s.slice(1) : s;
};

const CONFIG = '@config';
const STATE_PILL = {
  synced: { cls: 'good', icon: 'check' },
  localNewer: { cls: 'warn', icon: 'upload' },
  remoteNewer: { cls: 'info', icon: 'download' },
  conflict: { cls: 'bad', icon: 'alert' },
  localOnly: { cls: '', icon: 'monitor' },
  remoteOnly: { cls: '', icon: 'cloud' },
};

let started = false;

async function ready() {
  ensureCss('features/cloudsync');
  try {
    await loadNs('cloudsync');
  } catch {
    /* sin textos se ven las claves */
  }
}

function gate() {
  if (!cloud.isConfigured()) return 'noCloud';
  if (!cloud.isSignedIn()) return 'signedOut';
  return null;
}

// Token vigente de la sesión (supabase-js lo renueva si hace falta).
async function auth() {
  await Promise.resolve(cloud.ready()).catch(() => {});
  if (!cloud.isSignedIn()) return null;
  try {
    const { data } = await cloud.client.auth.getSession();
    const token = data?.session?.access_token || cloud.session?.access_token;
    return token ? { accessToken: token } : null;
  } catch {
    return cloud.session?.access_token ? { accessToken: cloud.session.access_token } : null;
  }
}

function fileUrl(p, version) {
  const parts = String(p || '').replace(/\\/g, '/').split('/');
  const enc = parts.map((s, i) => (i === 0 && /^[a-zA-Z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
  return `file:///${enc.replace(/^\/+/, '')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;
}

function dialog(title, { icon: iconName } = {}) {
  const body = h('div', { class: 'csy-dialog' });
  const foot = h('div', { class: 'csy-foot' });
  const ctl = { alive: true };
  const m = modal({
    title,
    icon: iconName,
    body,
    footer: [foot],
    size: 'wide csy-modal',
    onClose: () => {
      ctl.alive = false;
    },
  });
  return Object.assign(ctl, { el: m.el, close: () => m.close(), show: (...n) => mount(body, ...n), footer: (...n) => mount(foot, ...n) });
}

const closeBtn = (d) => h('button', { class: 'btn ghost', type: 'button', onclick: () => d.close() }, t('cloudsync.close'));

function head(inst, extra) {
  return h(
    'div',
    { class: 'csy-head' },
    instanceIcon(inst, 'csy-head-icon'),
    h(
      'div',
      { class: 'csy-head-text' },
      h('div', { class: 'csy-head-name', title: inst.name }, inst.name),
      h('div', { class: 'row wrap csy-head-meta' }, h('span', { class: 'badge' }, icon('box'), inst.mcVersion), loaderBadge(instanceLoaderKey(inst), loaderVersionLabel(inst))),
    ),
    extra || null,
  );
}

function gateView(kind, d) {
  const isCfg = kind === 'noCloud';
  return emptyState(
    isCfg ? 'cloud' : 'logIn',
    t(`cloudsync.gate_${kind}`),
    t(`cloudsync.gate_${kind}Text`),
    isCfg ? null : h(
      'button',
      {
        class: 'btn primary',
        type: 'button',
        onclick: () => {
          d.close();
          navigate('settings/cloud/venus');
        },
      },
      icon('logIn'),
      t(`cloudsync.gate_${kind}Btn`),
    ),
  );
}

// Esqueleto mientras se consulta la nube: lista de mundos a la izquierda y ajustes a la derecha.
function skeletonView() {
  const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
  const row = () => h('div', { class: 'skeleton-row' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')));
  return h(
    'div',
    { class: 'skeleton-group csy-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('cloudsync.loading')),
    h(
      'div',
      { class: 'skeleton-shapes csy-split', 'aria-hidden': 'true' },
      h('div', { class: 'csy-col' }, bone('skeleton-line', { width: '28%' }), h('div', { class: 'skeleton-list' }, row(), row(), row(), row())),
      h('div', { class: 'csy-col' }, bone('skeleton-line', { width: '45%' }), h('div', { class: 'csy-skel-side' }, h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line'), bone('skeleton-line')), h('div', { class: 'skeleton-lines' }, bone('skeleton-line'), bone('skeleton-line')))),
    ),
  );
}

function pill(state) {
  const meta = STATE_PILL[state] || STATE_PILL.localOnly;
  return h('span', { class: ['pill', 'csy-pill', meta.cls] }, icon(meta.icon), t(`cloudsync.state_${state}`));
}

function toggleRow(title, sub, checked, onChange) {
  return h('div', { class: 'toggle-row csy-toggle' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), h('div', { class: 'tr-sub' }, sub)), switchEl(checked, onChange, title));
}

// ---------- Diálogo ----------

export async function openCloudSync(instanceId) {
  await ready();
  await Promise.resolve(cloud.ready()).catch(() => {});
  let inst;
  try {
    inst = await api.instances.get(instanceId);
  } catch (err) {
    fail(t('cloudsync.errInstance'), err);
    return;
  }
  const d = dialog(t('cloudsync.title'), { icon: 'cloud' });
  const ctx = { d, inst, status: null, busy: new Map() };
  const g = gate();
  if (g) {
    d.show(head(inst), gateView(g, d));
    d.footer(closeBtn(d));
    return;
  }
  d.show(head(inst), skeletonView());
  d.footer(closeBtn(d));
  load(ctx);
}

async function load(ctx) {
  const { d } = ctx;
  const a = await auth();
  if (!d.alive) return;
  if (!a) {
    d.show(head(ctx.inst), gateView('signedOut', d));
    return;
  }
  let st;
  try {
    st = await api.invoke('cloudsync:status', ctx.inst.id, a);
  } catch (err) {
    if (d.alive) d.show(head(ctx.inst), h('div', { class: 'notice bad csy-error', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, err.message), h('button', { class: 'btn sm', type: 'button', onclick: () => load(ctx) }, icon('refresh'), t('cloudsync.retry'))));
    return;
  }
  if (!d.alive) return;
  if (st.unavailable) {
    if (st.unavailable === 'no_cloud' || st.unavailable === 'auth') {
      d.show(head(ctx.inst), gateView(st.unavailable === 'no_cloud' ? 'noCloud' : 'signedOut', d));
      return;
    }
    const isSchema = st.unavailable === 'schema';
    d.show(
      head(ctx.inst),
      h(
        'div',
        { class: 'csy-gate' },
        emptyState(
          isSchema ? 'clock' : 'wifi',
          t(isSchema ? 'cloudsync.schemaTitle' : 'cloudsync.offlineTitle'),
          st.message,
          h('button', { class: 'btn', type: 'button', onclick: () => load(ctx) }, icon('refresh'), t('cloudsync.retry')),
        ),
      ),
    );
    return;
  }
  ctx.status = st;
  draw(ctx);
}

function worldIcon(w) {
  if (w.icon) {
    const img = h('img', { src: fileUrl(w.icon, w.iconTime), alt: '', loading: 'lazy' });
    const box = h('div', { class: 'csy-wicon' }, img);
    img.addEventListener('error', () => mount(box, icon('globe')), { once: true });
    return box;
  }
  return h('div', { class: 'csy-wicon' }, icon(w.folder === CONFIG ? 'keyboard' : 'globe'));
}

function remoteLine(r) {
  if (!r) return null;
  // Cada dato es un bloque que no se corta; el "·" entre ellos lo pone el CSS
  return h(
    'div',
    { class: 'csy-row-remote' },
    icon('cloud'),
    h('span', {}, r.device ? t('cloudsync.remoteFrom', { ago: agoText(r.updatedAt), device: r.device }) : t('cloudsync.remoteAgo', { ago: agoText(r.updatedAt) })),
    h('span', {}, fmtBytes(r.size)),
    h('span', {}, t('cloudsync.version', { version: r.version })),
  );
}

function actionButtons(ctx, item) {
  const busy = ctx.busy.get(item.folder);
  if (busy) return [h('span', { class: 'csy-busy' }, h('span', { class: 'spinner csy-spin', 'aria-hidden': 'true' }), t(busy === 'up' ? 'cloudsync.uploading' : busy === 'down' ? 'cloudsync.downloading' : 'cloudsync.removing'))];
  const name = item.displayName;
  // Acciones de fila secundarias: en una lista con varias filas no puede haber varios botones principales.
  const up = () => h('button', { class: 'btn sm csy-act', type: 'button', title: t('cloudsync.uploadTip', { name }), 'aria-label': t('cloudsync.uploadTip', { name }), onclick: () => doUpload(ctx, item) }, icon('cloudUpload'), t('cloudsync.upload'));
  const down = () => h('button', { class: 'btn sm csy-act', type: 'button', title: t('cloudsync.downloadTip', { name }), 'aria-label': t('cloudsync.downloadTip', { name }), onclick: () => doDownload(ctx, item) }, icon('cloudDownload'), t('cloudsync.download'));
  const out = [];
  switch (item.state) {
    case 'localNewer':
    case 'localOnly':
      out.push(up());
      break;
    case 'remoteNewer':
    case 'remoteOnly':
      out.push(down());
      break;
    case 'conflict':
      out.push(h('button', { class: 'btn sm csy-resolve', type: 'button', onclick: () => openConflict(ctx, item) }, icon('alert'), t('cloudsync.resolve')));
      break;
    default:
      break;
  }
  if (item.remote) {
    out.push(
      h(
        'button',
        { class: 'icon-btn sm danger', type: 'button', title: t('cloudsync.removeTip', { name }), 'aria-label': t('cloudsync.removeTip', { name }), onclick: () => doRemove(ctx, item) },
        icon('trash'),
      ),
    );
  }
  return out;
}

function row(ctx, item, { config = false } = {}) {
  const local = item.local;
  const sub = config
    ? local
      ? t('cloudsync.configsSub', { count: local.files, size: fmtBytes(local.size) })
      : t('cloudsync.configsNone')
    : local
      ? [item.lastPlayed ? t('cloudsync.playedAgo', { ago: agoText(item.lastPlayed) }) : null, fmtBytes(local.size), item.mcVersion || null].filter(Boolean).join(' · ')
      : t('cloudsync.notOnThisPc');
  return h(
    'div',
    { class: ['csy-row', `is-${item.state || 'none'}`], role: 'listitem' },
    worldIcon(item),
    h(
      'div',
      { class: 'csy-row-main' },
      h('div', { class: 'csy-row-title' }, h('span', { class: 'csy-row-name', title: item.displayName }, item.displayName), item.state ? pill(item.state) : null),
      h('div', { class: 'csy-row-sub', title: config ? '' : item.folder }, sub),
      remoteLine(item.remote),
    ),
    h('div', { class: 'csy-row-actions' }, actionButtons(ctx, item)),
  );
}

function draw(ctx) {
  const { d } = ctx;
  const st = ctx.status;
  const configItem = { folder: CONFIG, displayName: t('cloudsync.configsName'), state: st.config.state, local: st.config.local, remote: st.config.remote };
  const counts = st.worlds.reduce((a, w) => ((a[w.state] = (a[w.state] || 0) + 1), a), {});
  const pending = (counts.localNewer || 0) + (counts.remoteNewer || 0) + (counts.conflict || 0);

  const settingsCard = h(
    'div',
    { class: 'card flat csy-settings' },
    toggleRow(t('cloudsync.auto'), t('cloudsync.autoSub'), st.auto, async (v) => {
      try {
        await api.invoke('cloudsync:settings', ctx.inst.id, { auto: v });
        st.auto = v;
        if (v) toast('good', t('cloudsync.autoOn'), t('cloudsync.autoOnText'), 6000);
      } catch (err) {
        fail(t('cloudsync.settingsFailed'), err);
      }
    }),
    toggleRow(t('cloudsync.includeConfigs'), t('cloudsync.includeConfigsSub'), st.configs, async (v) => {
      try {
        await api.invoke('cloudsync:settings', ctx.inst.id, { configs: v });
        st.configs = v;
      } catch (err) {
        fail(t('cloudsync.settingsFailed'), err);
      }
    }),
  );

  const usage = h(
    'div',
    { class: 'csy-usage', title: t('cloudsync.usageTip') },
    icon('cloud'),
    h('div', {}, h('div', { class: 'csy-usage-num' }, fmtBytes(st.usage.bytes)), h('div', { class: 'csy-usage-label' }, t('cloudsync.usage', { count: st.usage.count }))),
  );

  const list = st.worlds.length
    ? h('div', { class: 'csy-list', role: 'list', 'aria-label': t('cloudsync.worldsTitle') }, st.worlds.map((w) => row(ctx, w)))
    : h('div', { class: 'csy-empty' }, emptyState('globe', t('cloudsync.noWorlds'), t('cloudsync.noWorldsText')));

  const others = st.otherKeys.length
    ? h(
        'div',
        { class: 'csy-others' },
        h('div', { class: 'csy-label', role: 'heading', 'aria-level': '4' }, icon('link'), t('cloudsync.othersTitle')),
        h('div', { class: 'small muted csy-others-text' }, t('cloudsync.othersText')),
        h(
          'div',
          { class: 'csy-list', role: 'list' },
          st.otherKeys.slice(0, 8).map((o) =>
            h(
              'div',
              { class: 'csy-row is-other', role: 'listitem' },
              h('div', { class: 'csy-wicon' }, icon('archive')),
              h(
                'div',
                { class: 'csy-row-main' },
                h('div', { class: 'csy-row-title' }, h('span', { class: 'csy-row-name' }, o.label || o.key)),
                h('div', { class: 'csy-row-sub' }, [t('cloudsync.otherWorlds', { count: o.worlds }), fmtBytes(o.bytes), o.updatedAt ? t('cloudsync.updatedAgo', { ago: agoText(o.updatedAt) }) : null].filter(Boolean).join(' · ')),
              ),
              h(
                'div',
                { class: 'csy-row-actions' },
                h(
                  'button',
                  {
                    class: 'btn sm',
                    type: 'button',
                    onclick: async () => {
                      if (!(await confirmDialog(t('cloudsync.linkTitle'), t('cloudsync.linkConfirm', { name: o.label || o.key, instance: ctx.inst.name }), { okText: t('cloudsync.linkOk') }))) return;
                      try {
                        await api.invoke('cloudsync:settings', ctx.inst.id, { key: o.key });
                        ok(t('cloudsync.linked'), o.label || o.key);
                        load(ctx);
                      } catch (err) {
                        fail(t('cloudsync.settingsFailed'), err);
                      }
                    },
                  },
                  icon('link'),
                  t('cloudsync.useThis'),
                ),
              ),
            ),
          ),
        ),
      )
    : null;

  const relinked =
    st.key !== st.defaultKey
      ? h(
          'div',
          { class: 'notice info csy-note' },
          icon('link'),
          h('div', { class: 'spacer' }, t('cloudsync.linkedTo', { key: st.key })),
          h(
            'button',
            {
              class: 'btn sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api.invoke('cloudsync:settings', ctx.inst.id, { key: null });
                  load(ctx);
                } catch (err) {
                  fail(t('cloudsync.settingsFailed'), err);
                }
              },
            },
            t('cloudsync.unlinkKey'),
          ),
        )
      : null;

  d.show(
    head(ctx.inst, usage),
    st.busy ? h('div', { class: 'notice info csy-note' }, h('span', { class: 'spinner csy-spin' }), h('div', {}, t('cloudsync.busyNow'))) : null,
    store.running[ctx.inst.id] ? h('div', { class: 'notice csy-note' }, icon('alert'), h('div', {}, t('cloudsync.gameRunning'))) : null,
    relinked,
    h(
      'div',
      { class: 'csy-split' },
      h(
        'div',
        { class: 'csy-col' },
        h(
          'div',
          { class: 'csy-label', role: 'heading', 'aria-level': '4' },
          icon('globe'),
          t('cloudsync.worldsTitle'),
          h('span', { class: 'csy-label-count' }, String(st.worlds.length)),
          pending ? h('span', { class: 'badge warn csy-pending' }, t('cloudsync.pendingCount', { count: pending })) : null,
        ),
        list,
        others,
      ),
      h(
        'div',
        { class: 'csy-col side' },
        h('div', { class: 'csy-label', role: 'heading', 'aria-level': '4' }, icon('settings'), t('cloudsync.settingsTitle')),
        settingsCard,
        h('div', { class: 'csy-label', role: 'heading', 'aria-level': '4' }, icon('keyboard'), t('cloudsync.configsTitle')),
        h('div', { class: 'csy-list', role: 'list' }, row(ctx, configItem, { config: true })),
        h('div', { class: 'csy-device small muted' }, icon('monitor'), t('cloudsync.thisDevice', { name: st.device?.name || '' })),
      ),
    ),
  );
  d.footer(
    h('div', { class: 'small muted csy-foot-left' }, icon('shield'), t('cloudsync.privateNote')),
    h('button', { class: 'btn ghost', type: 'button', onclick: () => load(ctx) }, icon('refresh'), t('cloudsync.refresh')),
    closeBtn(d),
  );
}

function setBusy(ctx, folder, kind) {
  if (kind) ctx.busy.set(folder, kind);
  else ctx.busy.delete(folder);
  if (ctx.d.alive && ctx.status) draw(ctx);
}

async function doUpload(ctx, item, { force = false } = {}) {
  if (store.running[ctx.inst.id]) return toast('info', t('cloudsync.closeGameFirst'), ctx.inst.name);
  const a = await auth();
  if (!a) return fail(t('cloudsync.uploadFailed', { name: item.displayName }), t('cloudsync.gate_signedOutText'));
  setBusy(ctx, item.folder, 'up');
  try {
    const r = await api.invoke('cloudsync:upload', ctx.inst.id, item.folder, a, { force });
    if (r?.conflict) {
      setBusy(ctx, item.folder, null);
      openConflict(ctx, { ...item, remote: r.remote || item.remote });
      return undefined;
    }
    ok(t('cloudsync.uploaded', { name: item.displayName }), t('cloudsync.uploadedText', { size: fmtBytes(r.size), version: r.version }));
  } catch (err) {
    fail(t('cloudsync.uploadFailed', { name: item.displayName }), err);
  }
  setBusy(ctx, item.folder, null);
  if (ctx.d.alive) load(ctx);
  return undefined;
}

async function doDownload(ctx, item, { force = false } = {}) {
  if (store.running[ctx.inst.id]) return toast('info', t('cloudsync.closeGameFirst'), ctx.inst.name);
  if (force && item.local) {
    const msg = item.folder === CONFIG ? t('cloudsync.replaceConfigsConfirm') : t('cloudsync.replaceWorldConfirm', { name: item.displayName });
    if (!(await confirmDialog(t('cloudsync.replaceTitle'), msg, { okText: t('cloudsync.replaceOk'), danger: true }))) return undefined;
  }
  const a = await auth();
  if (!a) return fail(t('cloudsync.downloadFailed', { name: item.displayName }), t('cloudsync.gate_signedOutText'));
  setBusy(ctx, item.folder, 'down');
  try {
    const r = await api.invoke('cloudsync:download', ctx.inst.id, item.folder, a, { force });
    if (r?.conflict) {
      setBusy(ctx, item.folder, null);
      openConflict(ctx, { ...item, remote: r.remote || item.remote });
      return undefined;
    }
    ok(t('cloudsync.downloaded', { name: item.displayName }), r.movedTo ? t('cloudsync.movedAside', { name: r.movedTo }) : t('cloudsync.downloadedText', { version: r.version }));
  } catch (err) {
    fail(t('cloudsync.downloadFailed', { name: item.displayName }), err);
  }
  setBusy(ctx, item.folder, null);
  if (ctx.d.alive) load(ctx);
  return undefined;
}

async function doRemove(ctx, item) {
  if (!(await confirmDialog(t('cloudsync.removeTitle'), t('cloudsync.removeConfirm', { name: item.displayName }), { okText: t('cloudsync.removeOk'), danger: true }))) return;
  const a = await auth();
  if (!a) return;
  setBusy(ctx, item.folder, 'remove');
  try {
    await api.invoke('cloudsync:remove', ctx.inst.id, item.folder, a);
    ok(t('cloudsync.removed', { name: item.displayName }));
  } catch (err) {
    fail(t('cloudsync.removeFailed', { name: item.displayName }), err);
  }
  setBusy(ctx, item.folder, null);
  if (ctx.d.alive) load(ctx);
}

function openConflict(ctx, item) {
  const r = item.remote || {};
  const local = item.local || {};
  const isConfig = item.folder === CONFIG;
  const side = (cls, ic, title, lines) => h('div', { class: ['csy-side', cls] }, h('div', { class: 'csy-side-head' }, icon(ic), title), h('ul', { class: 'csy-side-list' }, lines.filter(Boolean).map((l) => h('li', {}, l))));
  const m = modal({
    title: t('cloudsync.conflictTitle', { name: item.displayName }),
    size: 'csy-conflict',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'text-2 csy-conflict-text' }, t(isConfig ? 'cloudsync.conflictTextConfig' : 'cloudsync.conflictText')),
      h(
        'div',
        { class: 'csy-sides' },
        side('here', 'monitor', t('cloudsync.thisPc'), [
          item.lastPlayed && !isConfig ? t('cloudsync.playedAgo', { ago: agoText(item.lastPlayed) }) : null,
          local.size ? fmtBytes(local.size) : null,
          item.syncedAt ? t('cloudsync.lastSyncHere', { ago: agoText(item.syncedAt) }) : t('cloudsync.neverSyncedHere'),
        ]),
        side('cloud', 'cloud', t('cloudsync.cloudCopy'), [
          r.updatedAt ? (r.device ? t('cloudsync.remoteFrom', { ago: agoText(r.updatedAt), device: r.device }) : t('cloudsync.remoteAgo', { ago: agoText(r.updatedAt) })) : null,
          r.lastPlayed && !isConfig ? t('cloudsync.playedAgo', { ago: agoText(r.lastPlayed) }) : null,
          r.rawSize || r.size ? fmtBytes(r.rawSize || r.size) : null,
          r.version ? t('cloudsync.version', { version: r.version }) : null,
        ]),
      ),
      h('div', { class: 'csy-safety' }, icon('shield'), h('span', {}, t(isConfig ? 'cloudsync.conflictSafetyConfig' : 'cloudsync.conflictSafety'))),
    ),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('cloudsync.cancel')),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            m.close();
            doDownload(ctx, item, { force: true });
          },
        },
        icon('cloudDownload'),
        t('cloudsync.keepCloud'),
      ),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            m.close();
            doUpload(ctx, item, { force: true });
          },
        },
        icon('cloudUpload'),
        t('cloudsync.keepLocal'),
      ),
    ],
  });
}

// ---------- Automático ----------

async function autoFor(instanceId, direction, since = 0) {
  if (!cloud.isSignedIn() || store.running[instanceId]) return;
  const a = await auth();
  if (!a) return;
  let r;
  try {
    r = await api.invoke('cloudsync:autoSync', instanceId, a, { direction, since });
  } catch (err) {
    console.warn('[cloudsync] auto:', err?.message || err);
    return;
  }
  if (!r || r.unavailable) return;
  const inst = store.instances.find((i) => i.id === instanceId);
  const name = inst?.name || instanceId;
  const names = (list) => list.map((x) => x.name || x.folder).slice(0, 4).join(', ');
  if (r.uploaded.length) toast('good', t('cloudsync.autoUploaded', { count: r.uploaded.length, name }), names(r.uploaded), 6000);
  if (r.downloaded.length) toast('good', t('cloudsync.autoDownloaded', { count: r.downloaded.length, name }), names(r.downloaded), 7000);
  if (r.conflicts.length) toast('info', t('cloudsync.autoConflicts', { count: r.conflicts.length, name }), t('cloudsync.autoConflictsText', { names: names(r.conflicts) }), 12000);
  if (r.errors.length) toast('bad', t('cloudsync.autoFailed', { name }), r.errors[0].error, 10000);
}

async function autoAll(direction) {
  if (!cloud.isSignedIn()) return;
  let cfg = null;
  try {
    cfg = await api.invoke('cloudsync:settings');
  } catch (err) {
    console.warn('[cloudsync] ajustes:', err?.message || err);
    return;
  }
  for (const i of cfg?.instances || []) if (i.auto) await autoFor(i.id, direction);
}

export async function startup() {
  if (started) return;
  started = true;
  await ready();
  const sessions = new Map();
  api.on('game:state', (id, st) => {
    if (st?.state === 'running') sessions.set(id, Date.now());
    else if (st?.state === 'stopped' || st?.state === 'crashed') {
      const since = sessions.get(id) || 0;
      sessions.delete(id);
      // un momento para que el juego termine de escribir el mundo
      setTimeout(() => autoFor(id, 'up', since), 4000);
    }
  });
  await Promise.resolve(cloud.ready()).catch(() => {});
  let lastUser = cloud.user?.id || null;
  cloud.on('auth', () => {
    const id = cloud.user?.id || null;
    if (id && id !== lastUser) {
      lastUser = id;
      autoAll('down');
    } else if (!id) lastUser = null;
  });
  // Al abrir el launcher: bajar lo que se jugó en otra PC (después de que arranque todo lo demás).
  setTimeout(() => autoAll('down'), 6000);
}
