// Tarjeta "Presentacion" del resumen de la instancia: caratula (elegir imagen, desde una captura, quitar),
// favorito, etiquetas, acceso directo en el escritorio, aspecto propio y link. Los datos viven en venus-instance.json
// (modulo instancemeta) y los dialogos en pages/versions/meta.js, compartidos con Mis instancias.
import { h, icon, mount } from '../../ui.js';
import { t } from '../../i18n.js';
import { isFavorite, tagsOf } from '../versions/catalog.js';
import { coverEl, favoriteButton, tagChips, openTagsDialog, openCoverDialog, removeCover, createShortcut, shortcutsSupported } from '../versions/meta.js';
import { openInstanceLook } from '../../features/instancelook.js';
import { copyInstanceLink } from '../../features/instancelook/links.js';
import { instanceLink, normalizeLook } from '../../features/instancelook/logic.js';

export function presentationCard(ctx) {
  const box = h('section', { class: 'card ih-present', 'aria-labelledby': 'ih-present-title' });

  function draw() {
    const inst = ctx.inst;
    const fav = isFavorite(inst);
    const onChange = (next) => ctx.setInstance(next);
    const link = instanceLink(inst);
    mount(
      box,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title', id: 'ih-present-title' }, icon('image'), t('instance.presentation')), h('p', { class: 'card-sub' }, t('instance.presentationSub')))),
      h(
        'div',
        { class: 'ih-present-body' },
        h(
          'button',
          { class: 'ih-present-cover', type: 'button', title: t('versions.coverChange'), 'aria-label': t('versions.coverChange'), onclick: () => openCoverDialog(inst, { onChanged: onChange }) },
          coverEl(inst, 'ih-present-img'),
          h('span', { class: 'ih-present-cover-hint' }, icon('edit'), t('versions.coverChange')),
        ),
        h(
          'div',
          { class: 'ih-present-main' },
          h(
            'div',
            { class: 'ih-present-row' },
            h('div', { class: 'ih-present-label' }, t('versions.cover')),
            h('div', { class: 'row wrap' }, h('span', { class: 'small text-2' }, inst.cover ? t('versions.coverCurrent') : t('versions.coverGenerated')), h('button', { class: 'btn sm', type: 'button', onclick: () => openCoverDialog(inst, { onChanged: onChange }) }, icon('image'), t('versions.coverChange')), inst.cover ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => removeCover(inst).then((next) => next && onChange(next)) }, icon('x'), t('versions.coverRemove')) : null),
          ),
          h(
            'div',
            { class: 'ih-present-row' },
            h('div', { class: 'ih-present-label' }, t('versions.favorite')),
            h('div', { class: 'row' }, favoriteButton(inst, { onChange }), h('span', { class: 'small text-2' }, fav ? t('versions.favoriteOn') : t('versions.favoriteOff'))),
          ),
          h(
            'div',
            { class: 'ih-present-row' },
            h('div', { class: 'ih-present-label' }, t('versions.tags')),
            h('div', { class: 'row wrap' }, tagChips(inst, { max: 10, editable: false }), h('button', { class: 'btn sm', type: 'button', onclick: () => openTagsDialog(inst, { onSaved: onChange }) }, icon(tagsOf(inst).length ? 'edit' : 'plus'), t('versions.editTags'))),
          ),
          h(
            'div',
            { class: 'ih-present-row' },
            h('div', { class: 'ih-present-label' }, t('versions.shortcutLabel')),
            h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', type: 'button', disabled: !shortcutsSupported(), title: shortcutsSupported() ? null : t('versions.shortcutErr_unsupported'), onclick: () => createShortcut(inst) }, icon('vsShortcut'), t('versions.shortcut')), h('span', { class: 'small muted' }, shortcutsSupported() ? t('versions.shortcutSub') : t('versions.shortcutUnsupported'))),
          ),
          h(
            'div',
            { class: 'ih-present-row' },
            h('div', { class: 'ih-present-label' }, t('instancetools.lookRow')),
            h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', type: 'button', onclick: () => openInstanceLook(ctx.inst, { onSaved: onChange }) }, icon('palette'), t('instancetools.lookCustomize')), h('span', { class: 'small text-2' }, normalizeLook(inst.look) ? t('instancetools.lookRowOn') : t('instancetools.lookRowOff'))),
          ),
          link
            ? h(
                'div',
                { class: 'ih-present-row' },
                h('div', { class: 'ih-present-label' }, t('instancetools.linkRow')),
                h('div', { class: 'row wrap' }, h('button', { class: 'btn sm', type: 'button', onclick: () => copyInstanceLink(ctx.inst) }, icon('link'), t('instance.copyLink')), h('span', { class: 'small muted' }, link.kind === 'modpack' ? t('instancetools.linkRowPack') : t('instancetools.linkRowLocal'))),
              )
            : null,
        ),
      ),
    );
  }

  draw();
  const off = ctx.onInstance ? ctx.onInstance(draw) : () => {};
  box.destroy = off;
  return box;
}
