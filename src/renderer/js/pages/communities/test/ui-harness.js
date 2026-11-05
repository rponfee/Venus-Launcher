import { harness as baseHarness, deferred, flush } from '../../../features/communities/test/renderer-harness.js';
import * as logic from '../logic.js';
import * as shared from '../../../features/communities/logic.js';
import * as greeting from '../../../features/communities/greeting.js';
import * as permissions from '../../../features/communities/permissions.js';
import * as media from '../../../features/communities/media.js';
export { deferred, flush };
export function uiHarness() {
  const ui = baseHarness(), dialogs = [];
  const make = ui.deps.h;
  const h = (tag, props = {}, ...children) => {
    const node = make(tag, props, ...children);
    node.style.setProperty = (key, value) => { node.style[key] = value; };
    return node;
  };
  const modal = (args) => {
    const box = h('dialog', {}, args.body, ...(args.footer || []));
    ui.deps.mount(ui.root, ...ui.root.children, box);
    let closed = false;
    const dialog = { ...args, el: box, close() {
      if (closed) return;
      closed = true;
      ui.deps.mount(ui.root, ...ui.root.children.filter((child) => child !== box));
      args.onClose?.();
    } };
    dialogs.push(dialog); return dialog;
  };
  // Lo que no es lógica pura (selector de GIF, galería, diálogos de otras pantallas) se reemplaza por funciones vacías.
  const stubs = { attachChatBackdrop: () => ({ sync() {}, destroy() {} }), openPlanDialog() {}, openLooksDialog() {}, openGifPicker() {}, closeGifPicker() {}, openMediaGallery() {}, mediaImage: () => h('media'), openGreetingsDialog() {}, openRolesDialog() {}, openMemberRolesDialog() {}, openChannelPermsDialog() {}, openGroupReport() {} };
  const load = (file, extra = {}, names = []) => ui.load(new URL('../' + file, import.meta.url), { ...shared, ...greeting, ...permissions, ...media, ...logic, ...stubs, h, modal, ...extra }, names);
  return { ...ui, h, modal, dialogs, load, byLabel: (label) => ui.nodes.findLast((n) => n['aria-label'] === 'communities.' + label && n.isConnected),
    byText: (text) => ui.nodes.findLast((n) => n.tag === 'button' && n.children.includes('communities.' + text) && n.isConnected) };
}
