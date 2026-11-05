'use strict';
// Soporte de ejemplo SOLO para capturas de desarrollo (VENUS_DEVSHOT + VENUS_SUPPORT_FAKE=customer|staff|empty, nunca en
// la app empaquetada; lo decide ../support.js). Todo vive en memoria: no habla con Supabase ni con Storage y los datos
// son inventados (nombres, consultas y hasta el sistema del diagnóstico). Responde con las mismas formas que las
// funciones SQL de 0045, así la interfaz no sabe que es de ejemplo.
const { coded, cleanDetails } = require('./rules');

// ids con forma de uuid y primeros caracteres distintos (la lista muestra los primeros 8)
const id = (n) => `${(0x5a3c1000 + n * 7919).toString(16).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MIN = 60000;
const H = 3600000;
const D = 86400000;

function createFake(scenario = 'customer') {
  const now = () => Date.now();
  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  const me = scenario === 'staff' ? id(900) : id(901);
  const staffMe = scenario === 'staff';
  const team = [{ id: id(900), name: 'LuciaSoporte', me: staffMe }, { id: id(902), name: 'TomasSoporte', me: false }];
  let seq = 2000;
  const tickets = [];
  const macros = [
    { id: id(700), title: 'Saludo y pedido de datos', body: 'Hola {name}, gracias por escribirnos. ¿Podés contarnos qué versión de Minecraft usás y qué hacías cuando pasó?', shared: true, mine: true },
    { id: id(701), title: 'Pedido de diagnóstico', body: 'Hola {name}, para revisar esto necesitamos el diagnóstico: al escribir una consulta nueva, activá "Adjuntar un diagnóstico" y elegí qué partes mandar.', shared: true, mine: false, owner: 'TomasSoporte' },
  ];

  function add(t) {
    const base = { id: id(++seq), userId: id(100 + seq), name: null, plan: null, planName: null, priceUsd: null, paymentMethod: null, activatedUntil: null, status: 'open', priority: 'normal',
      category: 'other', details: {}, diagnostic: null, assignedTo: null, rating: null, ratingComment: null, ratedAt: null, reopenCount: 0, messages: [], attachments: [], notes: [],
      createdAt: now() - 2 * H, seen: true, userName: 'Mateo', ...t };
    base.updatedAt = t.updatedAt ?? Math.max(...base.messages.map((m) => m.at), base.createdAt);
    tickets.push(base);
    return base;
  }
  const msg = (who, body, ago, extra = {}) => ({ id: id(++seq), isAdmin: who === 'team', body, at: now() - ago, code: null, ...extra });

  if (scenario === 'customer') {
    const t1 = add({ subject: 'Se cierra al cargar el mundo (1.21.1)', category: 'game', priority: 'normal', status: 'in_progress', userId: me, createdAt: now() - 1 * D - 3 * H, assignedTo: team[0].id,
      details: { mcVersion: '1.21.1', loader: 'fabric', moment: 'loading', modsChanged: 'yes', steps: 'Abro mi mundo y a los 10 segundos se cierra.' },
      diagnostic: '[app]\nlauncher: 4.6.0\nelectron: 44.0.0\nos: Windows 11 (10.0.26200) x64\nram: 16 GB (free 7.1 GB)\ncpu: AMD Ryzen 5 5600 (12 threads)\ngpu: NVIDIA GeForce RTX 3060\nlanguage: es\n\n[java]\njava.required: 21\njava.selected: auto\njava.installed: 17, 21\n\n[instance]\nminecraft: 1.21.1\nloader: fabric 0.16.5\nmemory: 4096 MB\nmods: 43 (38 enabled)',
      seen: false,
      messages: [
        msg('me', 'Hola, desde ayer el juego se cierra solo cuando cargo mi mundo. Instalé dos mods nuevos.', 1 * D + 3 * H),
        msg('team', 'Hola, gracias por escribir. Con el diagnóstico vemos que usás Fabric 0.16.5 con 4 GB. ¿Podés probar quitando los dos mods nuevos y contarnos si sigue?', 1 * D),
        msg('me', 'Los saqué y ahora abre bien. Era uno de los dos.', 20 * H),
        msg('team', 'Perfecto. Probá volver a ponerlos de a uno para saber cuál es el que falla; si querés lo revisamos con vos.', 35 * MIN),
      ] });
    t1.attachments.push({ id: id(500), messageId: t1.messages[0].id, name: 'error-al-cargar.png', mime: 'image/png', size: 214000 });
    add({ subject: 'Pagué el plan Pro y no se activó', category: 'payments', priority: 'high', status: 'open', userId: me, createdAt: now() - 3 * H,
      details: { topic: 'payment', method: 'mercado_pago', paidOn: '2026-11-04', orderRef: '1234567890' }, messages: [msg('me', 'Pagué con Mercado Pago ayer a la noche y sigo sin ver el plan activo.', 3 * H)] });
    add({ subject: 'Idea: colores distintos por instancia', category: 'suggestion', priority: 'low', status: 'closed', userId: me, createdAt: now() - 9 * D, rating: 5, ratedAt: now() - 8 * D, ratingComment: 'Rápido y claro.',
      details: { area: 'launcher', benefit: 'Reconocer cada instancia de un vistazo.' }, closedAt: now() - 8 * D,
      messages: [msg('me', 'Estaría bueno poder elegir un color para cada instancia.', 9 * D), msg('team', 'Gracias por la idea, la anotamos. Ya existe un fondo por instancia en sus ajustes.', 8 * D + 2 * H, { isAdmin: true }), msg('team', 'Consulta cerrada.', 8 * D, { code: 'closed' })] });
    add({ subject: 'El launcher no recuerda mi idioma', category: 'bug', priority: 'normal', status: 'closed', userId: me, createdAt: now() - 3 * D, closedAt: now() - 1 * D - 6 * H,
      details: { area: 'launcher', frequency: 'always' }, messages: [msg('me', 'Cada vez que abro el launcher vuelve a español.', 3 * D), msg('team', 'Ya lo corregimos en la próxima versión.', 2 * D), msg('team', 'Consulta cerrada. Se arregla en la 4.6.', 1 * D + 6 * H, { code: 'closed' })] });
  }

  if (scenario === 'staff') {
    const names = ['MateoBuilds', 'SofiRedstone', 'TomiPvP', 'LuSkyBuilder', 'NicoMods', 'ValenSpeedrun', 'AgusServer', 'EmmaShaders', 'BautiFarm'];
    const rows = [
      ['Pagué el plan Pro y no se activó', 'payments', 'urgent', 'open', 26 * H, 'Pagué con Mercado Pago y sigo sin ver el plan activo. Ya pasó un día.', null],
      ['Se cierra al cargar el mundo (1.21.1)', 'game', 'high', 'in_progress', 5 * H, 'Los dos mods que instalé hacen que se cierre. ¿Podés ayudarme?', 0],
      ['No puedo iniciar sesión con mi cuenta', 'payments', 'high', 'open', 3 * H, 'Dice que la contraseña es incorrecta pero la cambié hoy.', null],
      ['El asistente dice que llegué al límite', 'assistant', 'normal', 'in_progress', 8 * H, '¿Cuándo se renueva mi saldo?', 1],
      ['El launcher no abre después de actualizar', 'bug', 'normal', 'open', 50 * MIN, 'Hice clic en actualizar y ahora la ventana queda en blanco.', null],
      ['Idea: lista de mods favoritos', 'suggestion', 'low', 'open', 2 * D, 'Podría haber una lista de mods favoritos para instalar rápido.', null],
      ['Consulta sobre mi baneo en el chat', 'payments', 'normal', 'open', 6 * H, 'Quiero saber por qué me silenciaron.', null],
      ['Se ve mal el texto en pantalla chica', 'bug', 'low', 'closed', 4 * D, 'En mi notebook el texto se corta.', 0],
      ['Error de Java 8 con Forge 1.12', 'game', 'normal', 'closed', 6 * D, 'Me pide Java 8 y tengo el 17.', 1],
    ];
    rows.forEach(([subject, category, priority, status, ago, body, assignee], i) => {
      const t = add({ subject, category, priority, status, userName: names[i], createdAt: now() - ago - 20 * MIN, assignedTo: assignee == null ? null : team[assignee].id,
        details: category === 'game' ? { mcVersion: '1.21.1', loader: 'fabric', moment: 'loading', modsChanged: 'yes' } : category === 'payments' ? { topic: i === 0 ? 'payment' : 'login' } : {},
        messages: [msg('me', body, ago)], closedAt: status === 'closed' ? now() - ago + 2 * H : null });
      if (assignee != null && status !== 'closed') t.messages.push(msg('team', 'Hola, ya estamos mirando tu consulta.', ago - 40 * MIN));
      if (status === 'closed') { t.messages.push(msg('team', 'Listo, quedó resuelto.', ago - 3 * H)); t.messages.push(msg('team', 'Consulta cerrada.', ago - 2 * H, { code: 'closed' })); t.rating = i === 7 ? 4 : 5; t.ratedAt = now() - ago; }
    });
    tickets[1].notes.push({ id: id(++seq), body: 'Es el tercer aviso de este crash con Sodium 0.6: pedir el diagnóstico y revisar la lista de mods.', author: 'TomasSoporte', mine: false, at: now() - 4 * H });
    tickets[0].diagnostic = '[app]\nlauncher: 4.5.0\nos: Windows 10 (10.0.19045) x64\nram: 8 GB (free 2.4 GB)\n\n[java]\njava.required: 17\njava.selected: auto';
  }

  const byId = (tid) => { const t = tickets.find((x) => x.id === tid); if (!t) throw coded('not_available', 'Ticket no disponible.'); return t; };
  const lastMsg = (t) => t.messages[t.messages.length - 1];
  const lastTeam = (t) => [...t.messages].reverse().find((m) => m.isAdmin && !m.code);
  const lastStaffAt = (t) => Math.max(0, ...t.messages.filter((m) => m.isAdmin).map((m) => m.at));
  const lastUserAt = (t) => Math.max(0, ...t.messages.filter((m) => !m.isAdmin).map((m) => m.at));
  const pending = (t) => ['open', 'in_progress'].includes(t.status);
  const waiting = (t) => pending(t) && (!lastStaffAt(t) || lastUserAt(t) > lastStaffAt(t));
  const msgJson = (t, m) => ({ id: m.id, ticketId: t.id, authorId: m.isAdmin ? team[0].id : t.userId, isAdmin: m.isAdmin, body: m.body, createdAt: iso(m.at), code: m.code || null,
    attachments: t.attachments.filter((a) => a.messageId === m.id).map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })) });
  const ticketJson = (t) => ({ id: t.id, userId: t.userId, name: t.name, subject: t.subject, category: t.category, plan: null, planName: null, priceUsd: null, paymentMethod: null, status: t.status,
    createdAt: iso(t.createdAt), updatedAt: iso(t.updatedAt), closedAt: iso(t.closedAt), activatedUntil: null, priority: t.priority, assigned: t.assignedTo != null,
    lastUserMessageAt: iso(lastUserAt(t) || t.createdAt), lastReplyAt: iso(lastStaffAt(t) || null), unread: !t.seen && lastStaffAt(t) > 0, rating: t.rating, ratedAt: iso(t.ratedAt),
    reopenCount: t.reopenCount, reopenUntil: t.status === 'closed' && t.closedAt ? iso(t.closedAt + 14 * D) : null, hasDiagnostic: Boolean(t.diagnostic), attachmentCount: t.attachments.length });
  const staffJson = (t) => ({ ...ticketJson(t), userName: t.userName, waiting: waiting(t), mine: t.assignedTo === me, assigneeName: t.assignedTo ? team.find((x) => x.id === t.assignedTo)?.name : null,
    lastPreview: (lastMsg(t)?.body || '').slice(0, 160), lastFromTeam: Boolean(lastMsg(t)?.isAdmin) });
  const ownerOf = (t) => (scenario === 'staff' ? false : t.userId === me);
  const addMessage = (t, isAdmin, body, code = null) => { t.messages.push({ id: id(++seq), isAdmin, body, at: now(), code }); t.updatedAt = now(); if (!isAdmin) t.seen = true; return t.messages[t.messages.length - 1]; };
  const requireStaff = () => { if (!staffMe) throw coded('not_staff', 'Solo el equipo de soporte.'); };

  const handlers = {
    staffState: () => ({ isStaff: staffMe }),
    list: ({ admin }) => (admin ? [...tickets] : tickets.filter(ownerOf)).sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({ ...ticketJson(t), lastReplyPreview: lastTeam(t)?.body.slice(0, 140) || null })),
    queue: ({ filter = {} }) => {
      requireStaff();
      let list = tickets.filter((t) => {
        const st = filter.status || 'pending';
        if (st === 'pending' && !pending(t)) return false;
        if (st === 'waiting' && !waiting(t)) return false;
        if (st === 'progress' && t.status !== 'in_progress') return false;
        if (st === 'closed' && !['closed', 'paid'].includes(t.status)) return false;
        if (filter.category && t.category !== filter.category) return false;
        if (filter.priority && t.priority !== filter.priority) return false;
        if (filter.assigned === 'me' && t.assignedTo !== me) return false;
        if (filter.assigned === 'none' && t.assignedTo) return false;
        const q = String(filter.search || '').toLowerCase();
        return !q || t.subject.toLowerCase().includes(q) || t.userName.toLowerCase().includes(q);
      });
      const rank = { urgent: 0, high: 1, normal: 2, low: 3 };
      list = list.sort((a, b) => (filter.sort === 'newest' ? b.updatedAt - a.updatedAt : filter.sort === 'oldest' ? a.createdAt - b.createdAt
        : (pending(b) - pending(a)) || (waiting(b) - waiting(a)) || (rank[a.priority] - rank[b.priority]) || (lastUserAt(a) - lastUserAt(b))));
      const limit = filter.limit || 40;
      const page = filter.page || 0;
      const rated = tickets.filter((t) => t.rating);
      return { items: list.slice(page * limit, (page + 1) * limit).map(staffJson), total: list.length, page, limit, counts: {
        pending: tickets.filter(pending).length, waiting: tickets.filter(waiting).length, unassigned: tickets.filter((t) => pending(t) && !t.assignedTo).length,
        mine: tickets.filter((t) => pending(t) && t.assignedTo === me).length, closed: tickets.filter((t) => !pending(t)).length,
        ratingAvg: rated.length ? Math.round((rated.reduce((s, t) => s + t.rating, 0) / rated.length) * 100) / 100 : null, ratingCount: rated.length } };
    },
    detail: ({ ticketId }) => {
      const t = byId(ticketId);
      return { ticket: { ...ticketJson(t), details: t.details, diagnostic: t.diagnostic, ratingComment: t.ratingComment }, viewer: staffMe ? 'staff' : 'owner', messages: t.messages.map((m) => msgJson(t, m)) };
    },
    create: ({ subject, category, message, details, diagnostic }) => {
      if (tickets.filter((t) => ownerOf(t) && pending(t)).length >= 3) throw coded('too_many_open', 'Ya tenés 3 consultas abiertas. Seguí por una de esas.');
      const t = add({ subject, category, userId: me, userName: 'Vos', details: cleanDetails(category, details), diagnostic: diagnostic || null, createdAt: now(),
        priority: category === 'payments' ? 'high' : category === 'suggestion' ? 'low' : 'normal', messages: [] });
      const m = addMessage(t, false, message);
      return { ...ticketJson(t), firstMessageId: m.id };
    },
    reply: ({ ticketId, body }) => {
      const t = byId(ticketId);
      if (!pending(t)) throw coded('closed', 'El ticket ya está cerrado.');
      const m = addMessage(t, staffMe && !ownerOf(t), body);
      if (staffMe) { t.status = 'in_progress'; t.assignedTo ||= me; }
      return msgJson(t, m);
    },
    resolve: ({ ticketId, note }) => { requireStaff(); const t = byId(ticketId); t.status = 'closed'; t.closedAt = now(); addMessage(t, true, `Consulta cerrada.${note ? ` ${note}` : ''}`, 'closed'); return ticketJson(t); },
    closeOwn: ({ ticketId, note }) => { const t = byId(ticketId); t.status = 'closed'; t.closedAt = now(); addMessage(t, false, `Consulta cerrada.${note ? ` ${note}` : ''}`, 'closed_self'); return ticketJson(t); },
    reopen: ({ ticketId, message }) => {
      const t = byId(ticketId);
      if (t.status !== 'closed') throw coded('not_closed', 'Solo se puede reabrir una consulta cerrada.');
      if (!staffMe && t.reopenCount >= 3) throw coded('reopen_limit', 'Esta consulta ya se reabrió 3 veces.');
      t.status = staffMe ? 'in_progress' : 'open'; t.closedAt = null; if (!staffMe) t.reopenCount += 1;
      addMessage(t, staffMe, message || 'Consulta reabierta.', 'reopened');
      return ticketJson(t);
    },
    rate: ({ ticketId, rating, comment }) => { const t = byId(ticketId); if (t.status !== 'closed') throw coded('not_closed', 'Podés valorar cuando esté cerrada.'); t.rating = rating; t.ratingComment = comment || null; t.ratedAt = now(); return ticketJson(t); },
    markSeen: ({ ticketId }) => { byId(ticketId).seen = true; return { ok: true }; },
    unread: () => {
      const list = tickets.filter((t) => ownerOf(t) && !t.seen && lastStaffAt(t) > 0);
      return { open: tickets.filter((t) => ownerOf(t) && pending(t)).length, unread: list.length, latest: list.map((t) => ({ id: t.id, subject: t.subject, at: iso(lastStaffAt(t)) })) };
    },
    diagnostic: ({ ticketId, diagnostic }) => { const t = byId(ticketId); t.diagnostic = diagnostic; return ticketJson(t); },
    attach: ({ ticketId, messageId, files }) => {
      const t = byId(ticketId);
      return files.map((f) => { const a = { id: id(++seq), messageId: messageId || null, name: f.name || 'captura', mime: 'image/png', size: 150000, path: f.path }; t.attachments.push(a); return { id: a.id, name: a.name, mime: a.mime, size: a.size }; });
    },
    attachmentInfo: ({ attachmentId }) => { for (const t of tickets) { const a = t.attachments.find((x) => x.id === attachmentId); if (a) return { id: a.id, path: a.path || 'fake', mime: a.mime, name: a.name, size: a.size }; } throw coded('not_available', 'Captura no disponible.'); },
    assign: ({ ticketId, to }) => { requireStaff(); const t = byId(ticketId); t.assignedTo = to || null; if (to && t.status === 'open') t.status = 'in_progress'; return ticketJson(t); },
    priority: ({ ticketId, priority }) => { requireStaff(); const t = byId(ticketId); t.priority = priority; return ticketJson(t); },
    note: ({ ticketId, body }) => { requireStaff(); const t = byId(ticketId); const n = { id: id(++seq), body, author: 'LuciaSoporte', mine: true, at: now() }; t.notes.push(n); return { id: n.id, body, author: n.author, mine: true, createdAt: iso(n.at) }; },
    staffPanel: ({ ticketId }) => {
      requireStaff();
      const t = byId(ticketId);
      return { context: { username: t.userName, memberSince: iso(now() - 120 * D), emailConfirmed: true, plan: t.category === 'payments' ? null : 'pro', sanction: t.subject.includes('baneo') ? 'muted' : 'none', sanctionUntil: t.subject.includes('baneo') ? iso(now() + 2 * D) : null,
        tickets: { total: 4, open: tickets.filter((x) => x.userName === t.userName && pending(x)).length || 1, closed: 3 } },
      assignee: t.assignedTo ? { id: t.assignedTo, name: team.find((x) => x.id === t.assignedTo)?.name, me: t.assignedTo === me } : null,
      notes: t.notes.map((n) => ({ id: n.id, body: n.body, author: n.author, mine: n.mine, createdAt: iso(n.at) })) };
    },
    staffList: () => { requireStaff(); return team; },
    macros: () => { requireStaff(); return macros; },
    macroSave: ({ id: mid, title, body, shared }) => { requireStaff(); const m = macros.find((x) => x.id === mid && x.mine); if (m) Object.assign(m, { title, body, shared }); else macros.push({ id: id(++seq), title, body, shared, mine: true }); return macros[macros.length - 1]; },
    macroDelete: ({ id: mid }) => { requireStaff(); const i = macros.findIndex((x) => x.id === mid && x.mine); if (i >= 0) macros.splice(i, 1); return { ok: i >= 0 }; },
  };

  return {
    scenario,
    owner: me,
    call(action, payload = {}) {
      const fn = handlers[action];
      if (!fn) throw coded('badRequest', 'La acción de soporte no es válida.');
      return Promise.resolve().then(() => JSON.parse(JSON.stringify(fn(payload) ?? null)));
    },
    async upload({ ticketId }) { return { path: `${me}/${ticketId}/${id(++seq).replace(/^0{8}/, 'aaaaaaaa')}.png`, mime: 'image/png', size: 150000 }; },
    // Una "captura" dibujada con SVG: ventana con un error inventado.
    async download() {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#14100d"/><rect x="24" y="24" width="592" height="312" rx="10" fill="#241a14" stroke="#4a3626"/>'
        + '<rect x="24" y="24" width="592" height="34" rx="10" fill="#33241a"/><circle cx="46" cy="41" r="6" fill="#e5544b"/><circle cx="66" cy="41" r="6" fill="#fab219"/><circle cx="86" cy="41" r="6" fill="#36c25a"/>'
        + '<text x="48" y="104" fill="#ffc562" font-family="Consolas, monospace" font-size="16">Minecraft 1.21.1 · Fabric</text><text x="48" y="140" fill="#e5544b" font-family="Consolas, monospace" font-size="15">Error de ejemplo: el juego se cerró</text>'
        + '<rect x="48" y="168" width="420" height="10" rx="5" fill="#4a3626"/><rect x="48" y="192" width="360" height="10" rx="5" fill="#4a3626"/><rect x="48" y="216" width="470" height="10" rx="5" fill="#4a3626"/><rect x="48" y="240" width="300" height="10" rx="5" fill="#4a3626"/></svg>';
      return { dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mime: 'image/svg+xml' };
    },
  };
}

module.exports = { createFake };
