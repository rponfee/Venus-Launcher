// Clips y capturas: capturas, clips (repeticiones instantaneas y lo que exporta el editor) y grabaciones de todas
// las instancias, con filtros (instancia, fecha, busqueda por nombre o mundo), visor grande con teclado, editor
// rapido (recortar y exportar en vertical 9:16 u horizontal) y compartir (link, a un amigo o destacada en el
// perfil). Los archivos los lista worlds:media (carpetas de cada instancia) y los graba modules/capture.js.
// Ruta: #/clips[/<screenshots | clips | recordings>]
import { h, icon, mount, ok, fail, toast, setBusy, selectEl, debounce, emptyState, confirmDialog } from '../ui.js';
import { api } from '../store.js';
import { t } from '../i18n.js';
import { navigate } from '../app.js';
import { mediaGrid, mediaSkeleton } from './worlds/media.js';
import { TABS, RANGES, filterItems, countByTab, instancesOf } from './clips/model.js';
import { TAB_ICON, isMissingHandler, kbd, clock } from './clips/common.js';
import { openViewer, closeViewer } from './clips/viewer.js';
import { openEditor } from './clips/editor.js';

// Filtros mientras dure la sesion (volver a la pagina los recuerda)
const memo = { tab: 'screenshots', instanceId: '', range: 'all', query: '' };

export default {
  ns: ['clips', 'capture', 'worlds'],
  css: ['pages/worlds', 'pages/clips'],
  render(root, params = []) {
    if (TABS.includes(params[0])) memo.tab = params[0];
    return renderClips(root);
  },
};

function renderClips(root) {
  let media = null; // { items, counts }
  let error = null;
  let loading = false;
  let shared = {};
  let cap = null; // estado de capture:status (null = el modulo no esta)
  let aiAvailable = false;
  let aiIndex = {}; // sharedKey -> descripcion hecha con IA (solo las que pidio el usuario)
  let alive = true;
  const offs = [];

  // ---------- Estructura ----------
  const liveHost = h('div', { class: 'cl-live-host' });
  const tabBar = h('div', { class: 'tabs cl-tabs', role: 'tablist', 'aria-label': t('clips.tabsLabel') });
  const toolbar = h('div', { class: 'cl-toolbar' });
  const gridHost = h('div', { class: 'cl-grid-host', role: 'tabpanel', id: 'cl-panel' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('clips.searchPlaceholder'), 'aria-label': t('clips.searchPlaceholder'), value: memo.query });
  const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: t('clips.refresh'), 'aria-label': t('clips.refresh'), onclick: () => load(true) }, icon('refresh'));
  const folderBtn = h('button', { class: 'btn', type: 'button', onclick: () => openFolder() }, icon('folderOpen'), t('clips.openFolder'));
  const settingsBtn = h('button', { class: 'btn ghost', type: 'button', onclick: () => navigate('settings/ingame/capture') }, icon('settings'), t('clips.captureSettings'));
  mount(
    root,
    h(
      'div',
      { class: 'cl-root' },
      h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('clips.title')), h('p', { class: 'page-sub' }, t('clips.subtitle'))), h('div', { class: 'page-actions' }, refreshBtn, settingsBtn, folderBtn)),
      liveHost,
      tabBar,
      toolbar,
      gridHost,
    ),
  );

  // ---------- Estado de la captura (juego abierto, repeticion, grabacion) ----------
  function shortcutOf(action) {
    return cap?.settings?.shortcuts?.[action] || '';
  }

  async function act(btn, run) {
    const done = setBusy(btn);
    try {
      await run();
    } catch (err) {
      fail(t('clips.captureFailed'), err);
    } finally {
      done();
    }
  }

  // Textos que cambian cada segundo (sin volver a armar la barra: el foco del teclado no se pierde)
  let liveKey = '';
  let liveTitle = null;
  let liveSub = null;

  function liveTexts() {
    const recording = cap.recording?.active;
    const replayOn = cap.replay?.enabled;
    const instName = media?.items?.find((i) => i.instanceId === cap.game.instanceId)?.instanceName || cap.game.instanceId;
    return {
      title: recording ? t('clips.liveRecording', { time: clock(cap.recording.duration) }) : t('clips.livePlaying', { name: instName }),
      sub: !cap.game.window ? t('clips.liveSearching') : replayOn ? (cap.replay.active ? t('clips.liveReplayOn', { seconds: cap.replay.buffered, max: cap.replaySeconds }) : t('clips.liveReplayStarting')) : t('clips.liveReplayOff'),
    };
  }

  function drawLive() {
    if (!cap) {
      liveKey = '';
      mount(liveHost);
      return;
    }
    const sc = cap.settings?.shortcuts || {};
    const key = JSON.stringify([Boolean(cap.game), cap.recording?.active, cap.replay?.enabled, cap.replay?.active, cap.replaySeconds, sc]);
    if (key === liveKey && cap.game && liveTitle) {
      const tx = liveTexts();
      if (liveTitle.textContent !== tx.title) liveTitle.textContent = tx.title;
      if (liveSub.textContent !== tx.sub) liveSub.textContent = tx.sub;
      return;
    }
    liveKey = key;
    const hint = (label, a) => h('span', { class: 'cl-live-hint' }, label, kbd(shortcutOf(a)));
    if (!cap.game) {
      liveTitle = liveSub = null;
      mount(
        liveHost,
        h(
          'div',
          { class: 'cl-live idle' },
          h('span', { class: 'cl-live-icon', 'aria-hidden': 'true' }, icon('gamepad')),
          h('div', { class: 'cl-live-text' }, h('strong', {}, t('clips.liveIdle')), h('span', { class: 'cl-live-sub' }, t('clips.liveIdleText'))),
          h('div', { class: 'cl-live-keys' }, hint(t('clips.keyScreenshot'), 'screenshot'), hint(t('clips.keyRecord'), 'record'), hint(t('clips.keyReplay'), 'replay')),
        ),
      );
      return;
    }
    const recording = cap.recording?.active;
    const replayOn = cap.replay?.enabled;
    const focused = liveHost.contains(document.activeElement) ? document.activeElement.dataset.liveAction : null;
    const shotBtn = h('button', { class: 'btn sm', type: 'button', 'data-live-action': 'shot', title: shortcutOf('screenshot') || '', onclick: (e) => act(e.currentTarget, () => api.invoke('capture:screenshot')) }, icon('camera'), t('clips.takeScreenshot'));
    const recBtn = h(
      'button',
      { class: ['btn sm', recording ? 'danger' : ''], type: 'button', 'data-live-action': 'rec', title: shortcutOf('record') || '', onclick: (e) => act(e.currentTarget, () => api.invoke('capture:toggleRecording')) },
      icon(recording ? 'stop' : 'clRec'),
      recording ? t('clips.stopRecording') : t('clips.startRecording'),
    );
    const replayBtn = replayOn
      ? h('button', { class: 'btn sm tonal', type: 'button', 'data-live-action': 'replay', disabled: !cap.replay.active, title: shortcutOf('replay') || '', onclick: (e) => act(e.currentTarget, () => api.invoke('capture:saveReplay')) }, icon('history'), t('clips.saveReplay', { seconds: cap.replaySeconds }))
      : h('button', { class: 'btn sm ghost', type: 'button', onclick: () => navigate('settings/ingame/capture') }, icon('history'), t('clips.enableReplay'));
    const tx = liveTexts();
    liveTitle = h('strong', {}, tx.title);
    liveSub = h('span', { class: 'cl-live-sub' }, tx.sub);
    mount(
      liveHost,
      h(
        'div',
        { class: ['cl-live', 'playing', recording && 'recording'] },
        h('span', { class: 'cl-live-icon', 'aria-hidden': 'true' }, icon(recording ? 'clRec' : 'gamepad')),
        h('div', { class: 'cl-live-text' }, liveTitle, liveSub),
        h('div', { class: 'cl-live-actions' }, replayBtn, recBtn, shotBtn),
      ),
    );
    // Si el foco estaba en un boton de la barra, sigue en el mismo despues de rearmarla
    if (focused) liveHost.querySelector(`[data-live-action="${focused}"]`)?.focus();
  }

  const filters = () => ({ ...memo, now: Date.now(), extraText: (it) => aiIndex[it.sharedKey] || '' });

  // ---------- Pestanas y filtros ----------
  function drawTabs() {
    const counts = media ? countByTab(media.items, filters()) : null;
    const btn = (id) =>
      h(
        'button',
        {
          type: 'button',
          id: `cl-tab-${id}`,
          class: ['tab', memo.tab === id && 'active'],
          role: 'tab',
          'aria-selected': String(memo.tab === id),
          'aria-controls': 'cl-panel',
          tabindex: memo.tab === id ? '0' : '-1',
          onclick: () => selectTab(id),
          onkeydown: (e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            e.preventDefault();
            const k = TABS.indexOf(memo.tab) + (e.key === 'ArrowRight' ? 1 : -1);
            selectTab(TABS[(k + TABS.length) % TABS.length]);
            tabBar.querySelector('.tab.active')?.focus();
          },
        },
        icon(TAB_ICON[id]),
        t(`clips.tab_${id}`),
        h('span', { class: 'count' }, counts ? String(counts[id]) : ''),
      );
    mount(tabBar, TABS.map(btn));
    gridHost.setAttribute('aria-labelledby', `cl-tab-${memo.tab}`);
  }

  function selectTab(id) {
    if (memo.tab === id) return;
    memo.tab = id;
    history.replaceState(null, '', `#/clips/${id}`);
    drawTabs();
    drawToolbar();
    drawGrid();
  }

  function drawToolbar() {
    const insts = media ? instancesOf(media.items) : [];
    if (memo.instanceId && !insts.some((i) => i.id === memo.instanceId)) memo.instanceId = '';
    const instSel = selectEl([{ value: '', label: t('clips.allInstances') }, ...insts.map((i) => ({ value: i.id, label: i.name }))], memo.instanceId, (v) => {
      memo.instanceId = v;
      drawTabs();
      drawGrid();
    });
    instSel.setAttribute('aria-label', t('clips.filterInstance'));
    const chips = h(
      'div',
      { class: 'chips cl-ranges', role: 'group', 'aria-label': t('clips.filterDate') },
      RANGES.map((r) =>
        h(
          'button',
          {
            type: 'button',
            class: ['chip', memo.range === r && 'active'],
            'aria-pressed': String(memo.range === r),
            onclick: () => {
              memo.range = r;
              drawToolbar();
              drawTabs();
              drawGrid();
            },
          },
          t(`clips.range_${r}`),
        ),
      ),
    );
    mount(toolbar, h('div', { class: 'input-icon cl-search' }, icon('search'), search), instSel, chips, aiButton());
  }

  // ---------- Busqueda con IA (solo cuando el usuario la pide) ----------
  function undescribed() {
    if (!media) return [];
    return filterItems(media.items, { ...filters(), tab: 'screenshots', query: '' }).filter((it) => !aiIndex[it.sharedKey]);
  }

  function aiButton() {
    if (!aiAvailable || memo.tab !== 'screenshots' || !media) return null;
    const pending = undescribed();
    const btn = h(
      'button',
      { class: 'btn sm ghost cl-ai-btn', type: 'button', disabled: !pending.length, title: pending.length ? t('clips.aiDescribeHint') : t('clips.aiAllDone') },
      icon('sparkles'),
      t('clips.aiDescribe'),
      pending.length ? h('span', { class: 'count' }, String(Math.min(pending.length, 20))) : null,
    );
    btn.addEventListener('click', () => describeWithAi(btn));
    return btn;
  }

  async function describeWithAi(btn) {
    const list = undescribed().slice(0, 20);
    if (!list.length) return;
    if (!(await confirmDialog(t('clips.aiDescribeTitle'), t('clips.aiDescribeText', { count: list.length }), { okText: t('clips.aiDescribeOk') }))) return;
    const done = setBusy(btn);
    try {
      const res = await api.invoke('capture:aiDescribe', list.map((it) => ({ key: it.sharedKey, path: it.path })));
      aiIndex = (await api.invoke('capture:aiIndex').catch(() => aiIndex)) || aiIndex;
      if (res?.error) toast('info', t('clips.aiDescribed', { count: res.described }), res.error, 7000);
      else ok(t('clips.aiDescribed', { count: res?.described || 0 }), t('clips.aiDescribedText'));
    } catch (err) {
      fail(t('clips.aiFailed'), err);
      if (err?.code === 'noplan' || err?.code === 'quota') import('../features/plans.js').then((m) => m.openPlans?.({ reason: err.code === 'quota' ? 'quota' : 'needsPlan' })).catch(() => navigate('settings/plan'));
      else if (err?.code === 'unavailable' || err?.code === 'session') navigate('settings/ai');
    } finally {
      done();
    }
    if (!alive) return;
    drawToolbar();
    drawTabs();
    drawGrid();
  }

  const onSearch = debounce(() => {
    memo.query = search.value;
    drawTabs();
    drawGrid();
  }, 180);
  search.addEventListener('input', onSearch);

  // ---------- Grilla ----------
  function emptyFor(tab, filtered) {
    if (filtered) {
      return {
        icon: 'filter',
        title: t('clips.noResults'),
        text: t('clips.noResultsText'),
        action: h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: () => {
              Object.assign(memo, { instanceId: '', range: 'all', query: '' });
              search.value = '';
              drawToolbar();
              drawTabs();
              drawGrid();
            },
          },
          icon('x'),
          t('clips.clearFilters'),
        ),
      };
    }
    const key = (a) => shortcutOf(a) || t('clips.noShortcut');
    if (tab === 'screenshots') return { icon: 'camera', title: t('clips.emptyShots'), text: t('clips.emptyShotsText', { key: key('screenshot') }) };
    if (tab === 'recordings') return { icon: 'clVideo', title: t('clips.emptyRecordings'), text: t('clips.emptyRecordingsText', { key: key('record') }) };
    const replayOff = cap && !cap.settings?.replay;
    return {
      icon: 'woFilm',
      title: t('clips.emptyClips'),
      text: replayOff ? t('clips.emptyClipsOffText', { seconds: cap?.replaySeconds || 30 }) : t('clips.emptyClipsText', { key: key('replay'), seconds: cap?.replaySeconds || 30 }),
      action: replayOff ? h('button', { class: 'btn', type: 'button', onclick: () => navigate('settings/ingame/capture') }, icon('history'), t('clips.enableReplay')) : null,
    };
  }

  function drawGrid() {
    if (error) {
      mount(gridHost, h('div', { class: 'card flat' }, emptyState('alert', t('clips.loadError'), error, h('button', { class: 'btn', type: 'button', onclick: () => load(true) }, icon('refresh'), t('clips.retry')))));
      return;
    }
    if (!media) {
      mount(gridHost, mediaSkeleton(8, t('clips.loading')));
      return;
    }
    const now = Date.now();
    const items = filterItems(media.items, filters());
    const anyInTab = filterItems(media.items, { tab: memo.tab, now }).length > 0;
    const empty = emptyFor(memo.tab, !items.length && anyInTab);
    mount(
      gridHost,
      mediaGrid(items, {
        sharedMap: shared,
        emptyIcon: empty.icon,
        emptyTitle: empty.title,
        emptyText: empty.text,
        emptyAction: empty.action || null,
        onOpen: (index) =>
          openViewer(items, index, {
            onDeleted: (it) => {
              media.items = media.items.filter((x) => x.id !== it.id);
              drawTabs();
              drawToolbar();
              drawGrid();
            },
            onShared: () => refreshShared(),
            onEdit: (it) => edit(it),
            describe: (it) => aiIndex[it.sharedKey] || '',
          }),
      }),
    );
  }

  function edit(item) {
    openEditor(item, {
      onSaved: async (res) => {
        memo.tab = 'clips';
        history.replaceState(null, '', '#/clips/clips');
        await load(true);
        const idx = filterItems(media?.items || [], filters()).findIndex((i) => i.path === res?.path);
        if (idx >= 0) {
          const list = filterItems(media.items, filters());
          openViewer(list, idx, { onEdit: (it) => edit(it), onShared: () => refreshShared(), onDeleted: () => load(true) });
        }
      },
    });
  }

  // ---------- Datos ----------
  async function refreshShared() {
    shared = (await api.invoke('worlds:shared').catch(() => ({}))) || {};
    if (alive) drawGrid();
  }

  async function load(force = false) {
    if (loading && !force) return;
    loading = true;
    const done = force ? setBusy(refreshBtn) : () => {};
    try {
      const [res, sh] = await Promise.all([api.invoke('worlds:media', {}), api.invoke('worlds:shared').catch(() => ({}))]);
      if (!alive) return;
      media = { items: Array.isArray(res?.items) ? res.items : [], counts: res?.counts || {} };
      shared = sh || {};
      error = null;
    } catch (err) {
      if (!alive) return;
      if (isMissingHandler(err)) console.warn('[clips] worlds:media no esta disponible');
      error = isMissingHandler(err) ? t('clips.unavailable') : err?.message || String(err);
    } finally {
      loading = false;
      done();
    }
    if (!alive) return;
    drawTabs();
    drawToolbar();
    drawGrid();
    drawLive();
  }

  async function loadAi() {
    const [st, idx] = await Promise.all([api.invoke('capture:aiStatus').catch(() => null), api.invoke('capture:aiIndex').catch(() => null)]);
    aiAvailable = Boolean(st?.available);
    aiIndex = idx && typeof idx === 'object' ? idx : {};
    if (alive && media) {
      drawToolbar();
      drawGrid();
    }
  }

  async function loadCapture() {
    try {
      cap = await api.invoke('capture:status');
    } catch (err) {
      cap = null;
      if (!isMissingHandler(err)) console.warn('[clips] estado de la captura:', err?.message || err);
    }
    if (alive) drawLive();
  }

  async function openFolder() {
    const kind = memo.tab === 'screenshots' ? 'screenshot' : memo.tab === 'recordings' ? 'recording' : 'clip';
    try {
      await api.invoke('capture:openFolder', { instanceId: memo.instanceId || undefined, kind });
    } catch (err) {
      fail(t('clips.openFailed'), err);
    }
  }

  const reload = debounce(() => load(), 400);
  offs.push(api.on('worlds:updated', (e) => e?.kind === 'media' && reload()));
  offs.push(api.on('capture:saved', () => reload()));
  offs.push(
    api.on('capture:state', (s) => {
      cap = s;
      drawLive();
    }),
  );

  drawTabs();
  drawToolbar();
  drawGrid();
  load();
  loadCapture();
  loadAi();

  return () => {
    alive = false;
    offs.forEach((off) => off());
    closeViewer();
  };
}

