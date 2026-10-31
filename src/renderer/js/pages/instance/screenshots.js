// Capturas de la instancia: galeria con visor (flechas para navegar), abrir, mostrar en la carpeta y borrar.
import { h, icon, mount, modal, ok, fail, confirmDialog, emptyState, fmtBytes, fmtDate } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { iconButton, fileUrl, openFolder, skeletonBlocks } from '../versions/common.js';

const DATE_FMT = { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };

// Visor de capturas. onChange() se llama si se borra alguna.
export function openViewer(ctx, list, start = 0, onChange) {
  let i = start;
  const items = [...list];
  const img = h('img', { class: 'ih-viewer-img', alt: '' });
  const info = h('div', { class: 'ih-viewer-info small muted vs-dots' });
  const counter = h('span', { class: 'small muted ih-viewer-counter' });
  const prev = iconButton('chevronLeft', t('instance.previous'), () => go(-1), 'ih-viewer-nav');
  const next = iconButton('chevronRight', t('instance.next'), () => go(1), 'ih-viewer-nav');

  function show() {
    const s = items[i];
    if (!s) return m.close();
    img.src = fileUrl(s.path, Math.round(s.mtime));
    img.alt = s.file;
    mount(info, h('span', {}, fmtDate(s.mtime, DATE_FMT)), h('span', {}, fmtBytes(s.size)), h('span', { class: 'ellipsis', title: s.file }, s.file));
    mount(counter, t('instance.viewerCounter', { current: i + 1, total: items.length }));
    prev.disabled = i === 0;
    next.disabled = i >= items.length - 1;
  }
  function go(d) {
    const n = i + d;
    if (n < 0 || n >= items.length) return;
    i = n;
    show();
  }
  async function remove() {
    const s = items[i];
    if (!(await confirmDialog(t('instance.deleteShotTitle'), t('instance.deleteShotText', { name: s.file }), { okText: t('instance.delete'), danger: true }))) return;
    try {
      await api.instances.deleteFile(ctx.id, 'screenshots', s.file);
      ok(t('instance.shotDeleted'));
      items.splice(i, 1);
      if (onChange) onChange();
      if (!items.length) return m.close();
      i = Math.min(i, items.length - 1);
      show();
    } catch (err) {
      fail(t('instance.deleteShotFailed'), err);
    }
  }
  const onKey = (e) => {
    // Solo si el visor es el dialogo activo (no con la confirmacion de borrar abierta encima)
    if (!m.el.contains(document.activeElement) || e.target.closest?.('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  const m = modal({
    title: t('instance.screenshotTitle'),
    size: 'xwide',
    body: h('div', { class: 'ih-viewer-wrap' }, h('div', { class: 'ih-viewer' }, prev, h('div', { class: 'ih-viewer-stage' }, img), next), info),
    footer: [
      h('button', { class: 'btn sm danger', type: 'button', onclick: remove }, icon('trash'), t('instance.delete')),
      h('span', { class: 'spacer' }),
      counter,
      h('button', { class: 'btn sm', type: 'button', onclick: () => api.app.openPath(items[i].path).catch((err) => fail(t('instance.openFailed'), err)) }, icon('external'), t('instance.open')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => api.app.showItem(items[i].path).catch((err) => fail(t('instance.openFailed'), err)) }, icon('folderOpen'), t('instance.showInFolder')),
    ],
    onClose: () => document.removeEventListener('keydown', onKey),
  });
  m.el.classList.add('ih-viewer-modal');
  document.addEventListener('keydown', onKey);
  show();
  return m;
}

export function screenshotsTab(container, ctx) {
  let alive = true;
  let shots = [];
  let viewer = null;
  const grid = h('div', { class: 'ih-shots' });
  const countBox = h('span', { class: 'small muted num' });
  const openShotsFolder = () => openFolder(ctx.inst, 'screenshots');

  async function load({ quiet = false } = {}) {
    if (!quiet) mount(grid, h('div', { class: 'ih-span' }, skeletonBlocks(8, { cls: 'ih-shots' })));
    try {
      shots = await api.instances.content(ctx.id, 'screenshots');
    } catch (err) {
      if (alive) {
        mount(
          grid,
          h(
            'div',
            { class: 'notice bad ih-span ih-error', role: 'alert' },
            icon('alert'),
            h('div', {}, h('strong', {}, t('instance.loadFailed')), h('div', { class: 'small' }, err.message)),
            h('button', { class: 'btn sm', type: 'button', onclick: () => load() }, icon('refresh'), t('common.retry')),
          ),
        );
      }
      return;
    }
    if (alive) draw();
  }

  function draw() {
    mount(countBox, shots.length ? t('instance.screenshotsCount', { count: shots.length }) : '');
    if (!shots.length) {
      mount(
        grid,
        h(
          'div',
          { class: 'card flat ih-span' },
          emptyState('camera', t('instance.noScreenshots'), t('instance.noScreenshotsText'), h('button', { class: 'btn sm', type: 'button', onclick: openShotsFolder }, icon('folder'), t('instance.openScreenshotsFolder'))),
        ),
      );
      return;
    }
    mount(
      grid,
      shots.map((s, i) =>
        h(
          'button',
          {
            class: 'ih-shot',
            type: 'button',
            'aria-label': t('instance.openScreenshotDate', { date: fmtDate(s.mtime, DATE_FMT) }),
            onclick: () => {
              viewer = openViewer(ctx, shots, i, () => (load({ quiet: true }), ctx.refreshCounts()));
            },
          },
          h('img', { src: fileUrl(s.path, Math.round(s.mtime)), alt: '', loading: 'lazy', decoding: 'async' }),
          h('span', { class: 'ih-shot-date' }, fmtDate(s.mtime, { day: 'numeric', month: 'short', year: 'numeric' })),
        ),
      ),
    );
  }

  mount(
    container,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'ih-subbar' }, countBox, h('span', { class: 'spacer' }), h('span', { class: 'tiny muted' }, icon('info'), t('instance.screenshotHint')), iconButton('folder', t('instance.openScreenshotsFolder'), openShotsFolder)),
      grid,
    ),
  );
  load();
  return () => {
    alive = false;
    if (viewer?.el?.isConnected) viewer.close();
  };
}
