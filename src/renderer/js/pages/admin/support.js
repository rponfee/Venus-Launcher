import { mount } from '../../ui.js';
import { ticketDesk } from '../../features/support.js';

export function render(root) {
  const desk = ticketDesk({ admin: true });
  mount(root, desk.el);
  return { refresh: desk.refresh, destroy: desk.destroy };
}
