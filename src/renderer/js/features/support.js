// Soporte: la parte compartida entre la página de la persona, la bandeja del equipo y el panel de administración.
// El trabajo está en features/support/ (formulario, conversación, cola, diagnóstico, capturas y avisos); este archivo
// conserva los nombres que ya usaban las páginas.
export { S, supportCall, statusBadge as ticketStatus } from './support/common.js';
export { CATEGORIES, isPending as isPendingTicket } from './support/logic.js';
export { ticketDesk } from './support/desk.js';
