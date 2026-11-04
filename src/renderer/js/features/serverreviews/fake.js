// Reseñas de ejemplo para capturas: misma forma que las RPC de 0029, en memoria y sin red. Nunca se carga en el uso
// normal del launcher: solo si alguien llama a useDemo() desde la consola o desde VENUS_DEVSHOT_ROUTES.
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

export function createDemo(scenario, ReviewsError) {
  const signedIn = scenario !== 'signedOut';
  const now = Date.now();
  const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const names = ['Mateo', 'Sofia_MC', 'xX_Tiago_Xx', 'Lucía', 'Nico', 'Camila', 'Bruno', 'Vale', 'Thiago', 'Abril', 'Santi', 'Mora', 'Benja', 'Juli'];
  const stars = [5, 4, 5, 3, 5, 2, 4, 5, 1, 4, 5, 3, 4, 5];
  const texts = [
    'Muy buen servidor, con mucha gente y los minijuegos andan bárbaro.',
    'Se llena en los horarios pico, pero el staff responde rápido.',
    '<img src=x onerror=alert(1)> esto se tiene que ver como texto',
    'Lindo para jugar con amigos.\nLo único: a veces se traba al entrar.',
    '',
    'Demasiada publicidad en el chat.',
    'Volví después de un año y sigue siendo de lo mejor.',
    'PalabraLarguisimaSinEspacios'.repeat(6),
    'No me gustó.',
    'Bed Wars impecable.',
    'Los mapas nuevos están muy bien hechos.',
    'Le falta un poco de moderación.',
    'Bien, sin más.',
    'Excelente comunidad en español.',
  ];
  const reviews = names.map((name, i) => ({
    id: uuid(i + 1),
    stars: stars[i],
    body: texts[i],
    at: iso(now - (i + 1) * 7 * HOUR),
    updatedAt: iso(now - (i + 1) * 7 * HOUR + (i === 1 ? 3 * HOUR : 0)),
    mine: false,
    hidden: false,
    author: { displayName: name, username: name, mcName: /^\w+$/.test(name) ? name : null },
  }));
  let mine = scenario === 'hidden' ? { id: uuid(100), stars: 2, body: 'Esta reseña la ocultó un administrador.', at: iso(now - 30 * HOUR), updatedAt: iso(now - 30 * HOUR), mine: true, hidden: true, author: { displayName: 'Vos', username: 'vos', mcName: null } } : null;
  let myVote = scenario === 'voted' ? { total: 3, lastAt: iso(now - 4 * HOUR), nextAt: iso(now + 20 * HOUR) } : null;
  let votes = 128;
  const admin = reviews.slice(0, 5).map((r, i) => ({
    ...r,
    hidden: i === 3,
    hiddenAt: i === 3 ? r.at : null,
    server: { id: uuid(900), name: 'Universocraft', address: 'mc.universocraft.com' },
    author: { id: uuid(i + 500), username: r.author.username, displayName: r.author.displayName },
    openReports: i === 0 ? 2 : i === 2 ? 1 : 0,
    reports: i === 0 ? [{ reason: 'spam', text: 'Hace publicidad de otro servidor', at: iso(now - HOUR), reporter: 'Vale' }, { reason: 'abuse', text: null, at: iso(now - 2 * HOUR), reporter: 'Nico' }] : i === 2 ? [{ reason: 'other', text: null, at: iso(now - 3 * HOUR), reporter: 'Mora' }] : [],
  }));
  const stats = () => {
    const all = [...reviews, ...(mine && !mine.hidden ? [mine] : [])];
    return { avg: all.length ? all.reduce((sum, r) => sum + r.stars, 0) / all.length : null, count: all.length, votes };
  };
  const needSession = () => {
    if (!signedIn) throw new ReviewsError('not_authenticated');
  };
  const handlers = {
    featured_reviews_summary: ({ p_servers }) => Object.fromEntries(p_servers.map((id, i) => [id, i % 5 === 4 ? { avg: null, count: 0, votes: 2 } : { ...stats(), avg: 3.2 + (i % 4) * 0.5, count: 3 + i * 7, votes: 12 + i * 11 }])),
    featured_reviews_list({ p_before, p_limit }) {
      const before = p_before ? Date.parse(p_before) : Infinity;
      const rows = reviews.filter((r) => Date.parse(r.at) < before);
      const items = rows.slice(0, p_limit);
      return { ...stats(), mine, vote: myVote, items, next: rows.length > items.length ? items.at(-1).at : null };
    },
    featured_review_save({ p_stars, p_body }) {
      needSession();
      mine = { id: mine?.id || uuid(100), stars: p_stars, body: String(p_body || '').trim(), at: mine?.at || iso(Date.now()), updatedAt: iso(Date.now()), mine: true, hidden: mine?.hidden === true, author: { displayName: 'Vos', username: 'vos', mcName: null } };
      return { ...mine, stats: stats() };
    },
    featured_review_delete() {
      needSession();
      mine = null;
      return true;
    },
    featured_server_vote() {
      needSession();
      if (myVote && Date.parse(myVote.nextAt) > Date.now()) return { ok: false, votes, total: myVote.total, nextAt: myVote.nextAt };
      votes++;
      myVote = { total: (myVote?.total || 0) + 1, lastAt: iso(Date.now()), nextAt: iso(Date.now() + 24 * HOUR) };
      return { ok: true, votes, total: myVote.total, nextAt: myVote.nextAt };
    },
    featured_review_report() {
      needSession();
      return { ok: true, id: uuid(200) };
    },
    admin_reviews_list: ({ p_filter }) => admin.filter((r) => (p_filter === 'all' ? true : p_filter === 'hidden' ? r.hidden : r.openReports > 0)).sort((a, b) => b.openReports - a.openReports),
    admin_review_set_hidden({ p_id, p_hidden }) {
      const r = admin.find((x) => x.id === p_id);
      if (r) {
        r.hidden = p_hidden;
        if (p_hidden) {
          r.openReports = 0;
          r.reports = [];
        }
      }
      return { ok: true, id: p_id, hidden: p_hidden };
    },
    admin_review_delete({ p_id }) {
      const i = admin.findIndex((x) => x.id === p_id);
      if (i >= 0) admin.splice(i, 1);
      return { ok: true, id: p_id };
    },
    admin_review_dismiss({ p_id }) {
      const r = admin.find((x) => x.id === p_id);
      if (r) {
        r.openReports = 0;
        r.reports = [];
      }
      return { ok: true, id: p_id, closed: 1 };
    },
  };
  return {
    demo: true,
    signedIn: () => signedIn,
    userId: () => (signedIn ? uuid(100) : null),
    rpc: async (name, args) => handlers[name](args || {}),
  };
}
