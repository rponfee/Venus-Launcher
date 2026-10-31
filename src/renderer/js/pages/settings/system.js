// Ajustes > Java (runtimes que instala Venus, Java del sistema y que Java usa cada version) y
// Datos (carpeta de datos y su espacio, cambiar la ubicacion, cache y modo portable).
import { h, icon, mount, ok, fail, confirmDialog, copyText, fmtBytes, skeleton } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { sectionHead, card, note, errorNote, emptyRow, withBusy, errMsg } from './shared.js';

// Version de Minecraft -> Java que necesita (igual que core/java.js majorForMinecraft).
const JAVA_TABLE = [
  ['javaRow26', 25],
  ['javaRow1205', 21],
  ['javaRow118', 17],
  ['javaRow117', 16],
  ['javaRow116', 8],
];
const SOURCES = { mojang: 'Mojang', adoptium: 'Adoptium' };

function javaTile(major) {
  return h('div', { class: 'cfg-java-tile', 'aria-hidden': 'true' }, String(major || '?'));
}

// ---------------- Java ----------------

export function renderJava(body, ctx) {
  const info = ctx.info || {};
  const venusList = h('div', { class: 'cfg-java-list' }, skeleton('list', { rows: 2 }));
  const sysList = h('div', { class: 'cfg-java-list' });
  let detected = null; // null = todavia no se busco

  async function loadVenus() {
    let list;
    try {
      list = await api.java.runtimes();
    } catch (err) {
      if (ctx.alive()) mount(venusList, errorNote(t('settings.javaLoadError', { error: errMsg(err) }), loadVenus));
      return;
    }
    if (!ctx.alive()) return;
    if (!list?.length) {
      mount(venusList, emptyRow('coffee', t('settings.javaNone'), t('settings.javaNoneSub')));
      return;
    }
    list.sort((a, b) => (b.major || 0) - (a.major || 0));
    mount(
      venusList,
      list.map((r) => {
        const ver = h('span', { class: 'cfg-java-ver' });
        api.java
          .test(r.path)
          .then((v) => {
            if (v?.version) ver.textContent = v.version;
          })
          .catch(() => {});
        return h(
          'div',
          { class: 'cfg-java' },
          javaTile(r.major),
          h('div', { class: 'cfg-java-main' }, h('div', { class: 'cfg-java-title' }, h('span', {}, t('settings.javaName', { major: r.major || '?' })), ver), h('div', { class: 'cfg-java-path ellipsis selectable', title: r.path }, r.path)),
          h('span', { class: 'badge' }, SOURCES[r.source] || t('settings.javaSourceVenus')),
          h(
            'button',
            { type: 'button', class: 'icon-btn sm', title: t('settings.javaOpenFolder'), 'aria-label': t('settings.javaOpenFolder'), onclick: () => api.app.openPath(r.dir).catch((err) => fail(t('settings.openError'), err)) },
            icon('folder'),
          ),
        );
      }),
    );
  }

  const drawSys = () => {
    if (detected === null) {
      mount(sysList, emptyRow('search', t('settings.javaSysIdle'), t('settings.javaSysIdleSub')));
      return;
    }
    if (!detected.length) {
      mount(sysList, emptyRow('coffee', t('settings.javaSysNone'), t('settings.javaSysNoneSub')));
      return;
    }
    mount(
      sysList,
      detected.map((j) =>
        h(
          'div',
          { class: 'cfg-java' },
          javaTile(j.major),
          h(
            'div',
            { class: 'cfg-java-main' },
            h('div', { class: 'cfg-java-title' }, h('span', {}, t('settings.javaName', { major: j.major || '?' })), h('span', { class: 'cfg-java-ver' }, j.version || '')),
            h('div', { class: 'cfg-java-path ellipsis selectable', title: j.path }, j.path),
            j.vendor ? h('div', { class: 'cfg-java-vendor ellipsis', title: j.vendor }, j.vendor) : null,
          ),
          h('button', { type: 'button', class: 'icon-btn sm', title: t('settings.javaCopyPath'), 'aria-label': t('settings.javaCopyPath'), onclick: () => copyText(j.path, t('settings.javaPathCopied')) }, icon('copy')),
        ),
      ),
    );
  };

  const detectBtn = h('button', { type: 'button', class: 'btn sm' }, icon('search'), t('settings.javaDetect'));
  detectBtn.addEventListener('click', () =>
    withBusy(detectBtn, async () => {
      try {
        detected = (await api.java.detect()) || [];
      } catch (err) {
        fail(t('settings.javaDetectError'), err);
        return;
      }
      if (!ctx.alive()) return;
      drawSys();
      if (detected.length) ok(t('settings.javaDetectDone'), t('settings.javaDetectCount', { count: detected.length }));
    }),
  );

  const testBtn = h('button', { type: 'button', class: 'btn sm ghost' }, icon('file'), t('settings.javaTestExe'));
  testBtn.addEventListener('click', () =>
    withBusy(testBtn, async () => {
      const files = await api.app.selectFiles({ title: t('settings.javaPick'), filters: info.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [] }).catch(() => []);
      if (!files?.length) return;
      const v = await api.java.test(files[0]).catch(() => null);
      if (v?.version) ok(t('settings.javaTestOk', { major: v.major, version: v.version }), files[0]);
      else fail(t('settings.javaTestBad'), files[0]);
    }),
  );

  const refreshBtn = h('button', { type: 'button', class: 'icon-btn sm', title: t('settings.refresh'), 'aria-label': t('settings.refresh'), onclick: (e) => withBusy(e.currentTarget, loadVenus) }, icon('refresh'));

  const table = h(
    'table',
    { class: 'table cfg-java-table' },
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, t('settings.javaColMc')), h('th', { scope: 'col' }, t('settings.javaColJava')))),
    h(
      'tbody',
      {},
      JAVA_TABLE.map(([key, major]) => h('tr', {}, h('td', {}, t(`settings.${key}`)), h('td', {}, h('span', { class: 'cfg-java-chip' }, t('settings.javaName', { major }))))),
    ),
  );

  mount(
    body,
    sectionHead('java', 'coffee'),
    card({ title: t('settings.javaVenusTitle'), iconName: 'download', sub: t('settings.javaVenusSub'), extra: refreshBtn, anchor: 'venus' }, venusList),
    card(
      { title: t('settings.javaSysTitle'), iconName: 'monitor', sub: t('settings.javaSysSub'), extra: detectBtn, anchor: 'system' },
      sysList,
      h('div', { class: 'cfg-card-foot' }, testBtn, h('span', { class: 'small muted' }, t('settings.javaTestHint'))),
    ),
    card({ title: t('settings.javaTableTitle'), iconName: 'layers', sub: t('settings.javaTableSub'), anchor: 'versions' }, table, h('div', { class: 'cfg-hint-row' }, icon('info'), h('span', {}, t('settings.javaPerInstance')))),
  );
  drawSys();
  loadVenus();
}

// ---------------- Datos ----------------

const CATS = [
  ['instances', 'var(--accent)'],
  ['versions', 'var(--accent-hi)'],
  ['libraries', 'var(--accent-lo)'],
  ['assets', 'var(--cream)'],
  ['runtime', 'var(--info)'],
  ['servers', 'var(--good)'],
  ['cache', 'var(--muted)'],
];

function somethingRunning() {
  const games = Object.values(store.running || {}).some((r) => r && (r.state === 'running' || r.state === 'preparing'));
  const servers = (store.servers || []).some((s) => s.state === 'online' || s.state === 'starting' || s.state === 'stopping');
  return games || servers;
}

// Skeleton con la forma del uso de disco (total, barra y leyenda): medir una carpeta grande tarda.
function usageSkeleton() {
  const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
  return h(
    'div',
    { class: 'skeleton-group cfg-usage-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, t('settings.dataMeasuring')),
    h(
      'div',
      { class: 'skeleton-shapes', 'aria-hidden': 'true' },
      bone('skeleton-line title', { width: '128px', height: '24px' }),
      bone('cfg-meter-skel'),
      h('div', { class: 'cfg-legend' }, CATS.map(() => bone('skeleton-line'))),
    ),
  );
}

export function renderData(body, ctx) {
  const info = ctx.info || {};
  const dir = info.dataDir || '';
  const portable = Boolean(info.portable);
  const usageBox = h('div', { class: 'cfg-usage' }, usageSkeleton());
  const cacheSize = h('span', { class: 'badge cfg-cache-size' }, '…');
  let usage = null;

  function drawUsage() {
    const total = CATS.reduce((a, [k]) => a + (usage?.[k] || 0), 0);
    cacheSize.textContent = fmtBytes(usage?.cache || 0);
    if (!total) {
      mount(usageBox, h('div', { class: 'small muted' }, t('settings.dataEmpty')));
      return;
    }
    const pct = (v) => ((v || 0) / total) * 100;
    mount(
      usageBox,
      h('div', { class: 'cfg-usage-top' }, h('span', { class: 'cfg-usage-total' }, fmtBytes(total)), h('span', { class: 'small muted' }, t('settings.dataTotal'))),
      h(
        'div',
        { class: 'cfg-meter', role: 'img', 'aria-label': t('settings.dataMeterAria', { total: fmtBytes(total) }) },
        CATS.filter(([k]) => pct(usage[k]) >= 0.6).map(([k, color]) => h('i', { style: { width: `${pct(usage[k]).toFixed(2)}%`, background: color }, title: t('settings.catTitle', { name: t(`settings.cat_${k}`), size: fmtBytes(usage[k]) }) })),
      ),
      h(
        'div',
        { class: 'cfg-legend' },
        CATS.map(([k, color]) =>
          h('div', { class: 'cfg-legend-item' }, h('span', { class: 'cfg-sw', style: { background: color } }), h('span', { class: 'cfg-legend-label' }, t(`settings.cat_${k}`)), h('span', { class: 'cfg-legend-val' }, fmtBytes(usage[k] || 0))),
        ),
      ),
    );
  }

  async function loadUsage() {
    mount(usageBox, usageSkeleton());
    try {
      usage = await api.app.dataUsage();
    } catch (err) {
      usage = null;
      cacheSize.textContent = '-';
      if (ctx.alive()) mount(usageBox, errorNote(t('settings.dataUsageError', { error: errMsg(err) }), loadUsage));
      return;
    }
    if (ctx.alive()) drawUsage();
  }

  const relaunchWith = async (target) => {
    try {
      await api.app.setDataDir(target);
      await api.app.relaunch();
    } catch (err) {
      fail(t('settings.dataChangeError'), err);
    }
  };

  const changeBtn = h('button', { type: 'button', class: 'btn sm', disabled: portable }, icon('edit'), t('settings.dataChange'));
  changeBtn.addEventListener('click', async () => {
    if (somethingRunning()) return fail(t('settings.dataBusyTitle'), t('settings.dataBusyText'));
    const picked = await api.app.selectFolder({ title: t('settings.dataPickTitle') }).catch(() => null);
    if (!picked) return undefined;
    if (picked.replace(/[\\/]+$/, '').toLowerCase() === dir.replace(/[\\/]+$/, '').toLowerCase()) return ok(t('settings.dataSame'));
    const yes = await confirmDialog(t('settings.dataChangeTitle'), t('settings.dataChangeText', { path: picked }), { okText: t('settings.dataChangeOk'), cancelText: t('settings.cancel') });
    if (yes) await relaunchWith(picked);
    return undefined;
  });

  const isDefault = /[\\/]\.venuslauncher[\\/]?$/i.test(dir);
  const resetBtn =
    !portable && dir && !isDefault
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn sm ghost',
            onclick: async () => {
              if (somethingRunning()) return fail(t('settings.dataBusyTitle'), t('settings.dataBusyText'));
              const yes = await confirmDialog(t('settings.dataResetTitle'), t('settings.dataResetText'), { okText: t('settings.dataChangeOk'), cancelText: t('settings.cancel') });
              if (yes) await relaunchWith(null);
              return undefined;
            },
          },
          icon('undo'),
          t('settings.dataReset'),
        )
      : null;

  const clearBtn = h('button', { type: 'button', class: 'btn sm' }, icon('trash'), t('settings.cacheClear'));
  clearBtn.addEventListener('click', () =>
    withBusy(clearBtn, async () => {
      const before = usage?.cache || 0;
      try {
        await api.app.clearCache();
        ok(t('settings.cacheCleared'), before ? t('settings.cacheFreed', { size: fmtBytes(before) }) : null);
      } catch (err) {
        fail(t('settings.cacheError'), err);
      }
      if (ctx.alive()) await loadUsage();
    }),
  );

  mount(
    body,
    sectionHead('data', 'folderOpen'),
    card(
      { title: t('settings.dataFolderTitle'), iconName: 'folder', sub: t('settings.dataFolderSub'), anchor: 'folder' },
      h(
        'div',
        { class: 'cfg-path' },
        icon('folder'),
        h('span', { class: 'cfg-path-text selectable', title: dir }, dir || '-'),
        h('button', { type: 'button', class: 'icon-btn sm', title: t('settings.copyPath'), 'aria-label': t('settings.copyPath'), disabled: !dir, onclick: () => copyText(dir, t('settings.pathCopied')) }, icon('copy')),
        h('button', { type: 'button', class: 'btn sm', disabled: !dir, onclick: () => api.app.openPath(dir).catch((err) => fail(t('settings.openError'), err)) }, icon('folderOpen'), t('settings.open')),
      ),
      usageBox,
      h('div', { class: 'cfg-card-foot' }, changeBtn, resetBtn),
      h('div', { class: 'cfg-hint-row' }, icon('info'), h('span', {}, portable ? t('settings.dataChangePortable') : t('settings.dataChangeHint'))),
    ),
    card(
      { title: t('settings.cacheTitle'), iconName: 'archive', sub: t('settings.cacheSub'), anchor: 'cache', extra: cacheSize },
      h('div', { class: 'cfg-card-foot cfg-foot-flat' }, clearBtn, h('span', { class: 'small muted cfg-foot-text' }, t('settings.cacheHint'))),
    ),
    card(
      { title: t('settings.portableTitle'), iconName: 'drive', anchor: 'portable' },
      portable ? note('good', 'check', t('settings.portableOn')) : h('p', { class: 'cfg-text' }, t('settings.portableOff')),
    ),
  );
  loadUsage();
}
