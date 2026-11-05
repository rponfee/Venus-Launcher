// Planes de clan, fondos y escenarios para el modo de ejemplo de Comunidades (VENUS_DEVSHOT + VENUS_REWARDS_FAKE): misma forma y mismas
// reglas que las RPC de 0044_clanes_planes.sql, en memoria y sin red. Se engancha a fake.js con wrapPlans(): cambia los límites que
// antes eran fijos (galería, canales, roles) por los del plan de cada comunidad y suma las RPC de planes, fondos y Administración.
// Cada comunidad guarda c.plan = { id, endsAt } (gratis hasta que se "paga" o se regala) y c.backdrops.
import { PRESETS } from './presets.js';

const DAY = 86400000;
// Los mismos números que la tabla community_plans de la migración (la prueba de plan.test.js los compara).
export const FAKE_PLAN_TABLE = Object.freeze([
  { id: 'free', name: 'Gratis', rank: 0, priceUsd: 0, periodDays: 30, media: 10, pending: 5, backdrops: 0, stages: 0, animated: false, members: 500, channels: 50, roles: 15, priority: false, active: true },
  { id: 'go', name: 'Go', rank: 1, priceUsd: 2, periodDays: 30, media: 50, pending: 5, backdrops: 2, stages: 1, animated: false, members: 500, channels: 50, roles: 15, priority: false, active: true },
  { id: 'pro', name: 'Pro', rank: 2, priceUsd: 4, periodDays: 30, media: 150, pending: 5, backdrops: 6, stages: 4, animated: true, members: 500, channels: 50, roles: 15, priority: false, active: true },
  { id: 'max', name: 'Max', rank: 3, priceUsd: 6, periodDays: 30, media: 400, pending: 10, backdrops: 15, stages: 10, animated: true, members: 500, channels: 50, roles: 15, priority: false, active: true },
  { id: 'ultra', name: 'Ultra', rank: 4, priceUsd: 10, periodDays: 30, media: 1000, pending: 10, backdrops: 40, stages: 25, animated: true, members: 5000, channels: 150, roles: 50, priority: true, active: true },
]);

const limitsOf = (p) => ({ media: p.media, pending: p.pending, backdrops: p.backdrops, stages: p.stages, animated: p.animated, members: p.members, channels: p.channels, roles: p.roles, priority: p.priority });

export function createFakePlans({ communities, commOf, needComm, fail, iso, everyMedia, mediaOf, ME }) {
  const table = FAKE_PLAN_TABLE.map((p) => ({ ...p }));
  const row = (id) => table.find((p) => p.id === id) || table[0];
  const planOf = (c) => {
    const live = c.plan && c.plan.id !== 'free' && Date.parse(c.plan.endsAt) > Date.now() ? c.plan : null;
    return row(live ? live.id : 'free');
  };
  const planJson = (c) => {
    const p = planOf(c);
    return { id: p.id, name: p.name, rank: p.rank, priceUsd: p.priceUsd, periodDays: p.periodDays, endsAt: p.id === 'free' ? null : c.plan.endsAt, limits: limitsOf(p) };
  };
  const active = (c) => c.media.filter((m) => ['pending', 'approved'].includes(m.status));
  // Los más nuevos pasan a ocultos cuando el cupo baja.
  const hiddenIds = (c) => new Set([...active(c)].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(planOf(c).media).map((m) => m.id));
  const presetOf = (id) => PRESETS.find((p) => p.id === id);
  const state = (c, bd, hidden) => {
    const p = planOf(c);
    const same = c.backdrops.filter((x) => x.kind === bd.kind).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const media = bd.mediaId ? c.media.find((m) => m.id === bd.mediaId) : null;
    if (same.indexOf(bd) >= (bd.kind === 'chat' ? p.backdrops : p.stages)) return 'hidden_plan';
    const animated = bd.source === 'preset' ? presetOf(bd.preset)?.animated : media?.animated;
    if (animated && !p.animated) return 'hidden_animated';
    if (bd.mediaId && (!media || media.status !== 'approved' || hidden.has(media.id))) return 'media_unavailable';
    return 'ok';
  };
  const backdropJson = (c, bd, hidden) => {
    const media = bd.mediaId ? c.media.find((m) => m.id === bd.mediaId) : null;
    return { id: bd.id, kind: bd.kind, channelId: bd.channelId, source: bd.source, preset: bd.preset || null, dim: bd.dim, blur: bd.blur, state: state(c, bd, hidden),
      animated: bd.source === 'preset' ? presetOf(bd.preset)?.animated === true : media?.animated === true,
      media: media ? { id: media.id, source: media.source || 'upload', path: media.path || null, url: media.url || null, still: media.still || null, width: media.width, height: media.height, animated: media.animated === true, name: media.name } : null };
  };
  const usage = (c) => ({ media: active(c).length, pending: c.media.filter((m) => m.status === 'pending').length, backdrops: c.backdrops.filter((b) => b.kind === 'chat').length,
    stages: c.backdrops.filter((b) => b.kind === 'stage').length, members: c.members.length + c.extra, channels: c.channels.length, roles: c.roles.length });

  /** Un pago acreditado (o regalado): el período se apila como en private.community_plan_grant. */
  function grant(c, planId, days = null) {
    const p = row(planId);
    const len = (days ?? p.periodDays) * DAY;
    const current = planOf(c);
    const ends = c.plan?.endsAt ? Date.parse(c.plan.endsAt) : 0;
    const base = Math.max(Date.now(), ends > Date.now() ? ends : 0);
    if (p.rank >= current.rank) c.plan = { id: p.id, endsAt: iso(base + len) };
    else c.plan = { ...c.plan, endsAt: iso(ends + len) }; // un plan menor espera detrás del que corre
    return c.plan;
  }

  const rpcs = (orig) => ({
    ...orig,
    community_plan_get: ({ p_community }) => {
      const c = needComm(p_community);
      const p = planOf(c);
      return { plan: planJson(c), isOwner: c.myRole === 'owner', usage: usage(c), hiddenMedia: hiddenIds(c).size,
        periods: p.id === 'free' ? [] : [{ plan: p.id, startsAt: iso(Date.now() - DAY), endsAt: c.plan.endsAt, current: true }],
        plans: table.filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, rank: x.rank, priceUsd: x.priceUsd, periodDays: x.periodDays, limits: limitsOf(x) })) };
    },
    community_get: (args) => {
      const out = orig.community_get(args);
      const c = commOf(args.p_community);
      if (!c.myRole) return out;
      return { ...out, maxMembers: planOf(c).members, maxChannels: planOf(c).channels, maxRoles: planOf(c).roles, plan: planJson(c) };
    },
    community_media_register: (args) => {
      const c = needComm(args.p_community, 'owner', 'moderator');
      const p = planOf(c);
      // La galería se llena según el plan: se anota el tope antes del resto de reglas de fake.js.
      if (active(c).length >= p.media) fail('media_limit');
      if (c.media.filter((m) => m.status === 'pending').length >= p.pending) fail('media_pending_limit');
      const item = orig.community_media_register(args);
      const found = c.media.find((m) => m.id === args.p_id);
      if (found) found.animated = found.mime === 'image/gif' || (found.mime === 'image/webp' && args.p_animated === true);
      return found ? mediaJson2(c, found) : item;
    },
    community_media_add_klipy: ({ p_community, p_name, p_url, p_still = null, p_slug = null }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const p = planOf(c);
      if (!/^https:\/\/static[0-9]*\.klipy\.com\/[A-Za-z0-9/._~-]+$/.test(String(p_url))) fail('bad_media');
      const name = String(p_name ?? '').trim();
      if (!name || name.length > 40) fail('bad_media_name');
      if (active(c).length >= p.media) fail('media_limit');
      if (c.media.filter((m) => m.status === 'pending').length >= p.pending) fail('media_pending_limit');
      const item = { id: `k-${Date.now().toString(36)}${c.media.length}`, name, status: 'pending', source: 'klipy', url: p_url, still: p_still, slug: p_slug, path: null, mime: null, bytes: null, width: null, height: null, animated: true,
        createdAt: iso(Date.now()), reviewedAt: null, rejectReason: null, uploadedBy: ME, hue: 160 };
      c.media.unshift(item);
      return mediaJson2(c, item);
    },
    community_media_list: ({ p_community }) => {
      const c = needComm(p_community);
      const hidden = hiddenIds(c);
      return orig.community_media_list({ p_community }).map((m) => {
        const item = c.media.find((x) => x.id === m.id);
        const isHidden = hidden.has(m.id);
        return { ...m, source: item.source || 'upload', animated: item.animated === true, hidden: isHidden, url: item.source === 'klipy' && (item.status === 'approved' || m.mine || c.myRole === 'owner') && !isHidden ? item.url : null,
          still: item.still || null, path: isHidden && !m.mine && c.myRole !== 'owner' ? null : m.path };
      }).filter((m) => !(m.hidden && c.myRole !== 'owner' && !m.mine));
    },
    community_backdrops_get: ({ p_community }) => {
      const c = needComm(p_community);
      const staff = isStaffRole(c.myRole);
      const hidden = hiddenIds(c);
      const items = c.backdrops.map((bd) => backdropJson(c, bd, hidden)).filter((b) => staff || b.state === 'ok');
      return { items, presets: PRESETS.map((p) => ({ id: p.id, scope: p.scope, animated: p.animated })) };
    },
    community_backdrop_set: ({ p_community, p_kind, p_channel = null, p_source, p_value, p_dim = 35, p_blur = 0 }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      const p = planOf(c);
      if (!['chat', 'stage'].includes(p_kind)) fail('bad_kind');
      if (!(p_dim >= 0 && p_dim <= 80) || !(p_blur >= 0 && p_blur <= 20)) fail('bad_value');
      if (p_channel) {
        const ch = c.channels.find((x) => x.id === p_channel);
        if (!ch || (p_kind === 'stage') !== (ch.kind === 'voice')) fail('bad_channel');
      }
      let animated = false;
      let mediaId = null;
      if (p_source === 'preset') {
        const preset = PRESETS.find((x) => x.id === p_value && x.scope === p_kind);
        if (!preset) fail('bad_preset');
        animated = preset.animated;
      } else if (p_source === 'media') {
        const media = c.media.find((m) => m.id === p_value);
        if (!media || media.status !== 'approved' || hiddenIds(c).has(media.id)) fail('bad_media');
        animated = media.animated === true;
        mediaId = media.id;
      } else fail('bad_source');
      if (animated && !p.animated) fail('plan_animated');
      const existing = c.backdrops.find((b) => b.kind === p_kind && b.channelId === (p_channel || null));
      if (!existing && c.backdrops.filter((b) => b.kind === p_kind).length >= (p_kind === 'chat' ? p.backdrops : p.stages)) fail('plan_limit');
      const next = { source: p_source, preset: p_source === 'preset' ? p_value : null, mediaId, dim: p_dim, blur: p_blur };
      if (existing) Object.assign(existing, next);
      else c.backdrops.push({ id: `bd-${c.backdrops.length + 1}-${Date.now().toString(36)}`, kind: p_kind, channelId: p_channel || null, createdAt: iso(Date.now()), ...next });
      return { ok: true };
    },
    community_backdrop_clear: ({ p_community, p_kind, p_channel = null }) => {
      const c = needComm(p_community, 'owner', 'moderator');
      c.backdrops = c.backdrops.filter((b) => !(b.kind === p_kind && b.channelId === (p_channel || null)));
      return { ok: true };
    },
    community_stage_get: ({ p_room: asked }) => {
      // La sala de demostración del Voice Chat (voice.demo(), solo en capturas) hace de la primera sala de voz de la comunidad de ejemplo.
      const p_room = asked === 'demo' ? 'r-v-1' : asked;
      const c = [...communities.values()].find((x) => x.myRole && x.channels.some((ch) => `r-${ch.id}` === p_room));
      if (!c) return null;
      const ch = c.channels.find((x) => `r-${x.id}` === p_room);
      const hidden = hiddenIds(c);
      const stages = c.backdrops.filter((b) => b.kind === 'stage').map((bd) => backdropJson(c, bd, hidden)).filter((b) => b.state === 'ok');
      return { communityId: c.id, channelId: ch.id, stage: stages.find((s) => s.channelId === ch.id) || stages.find((s) => s.channelId === null) || null };
    },
    admin_community_plans: () => ({
      plans: table.map((p) => ({ id: p.id, name: p.name, rank: p.rank, priceUsd: p.priceUsd, periodDays: p.periodDays, active: p.active, limits: limitsOf(p),
        communities: [...communities.values()].filter((c) => planOf(c).id === p.id && p.id !== 'free').length })),
      revenueUsd: [...communities.values()].reduce((sum, c) => sum + (planOf(c).id === 'free' ? 0 : planOf(c).priceUsd), 0),
    }),
    admin_community_plan_save: ({ p_id, p_patch }) => {
      const p = table.find((x) => x.id === p_id) || fail('not_found');
      const map = { name: 'name', priceUsd: 'priceUsd', periodDays: 'periodDays', active: 'active', media: 'media', pending: 'pending', backdrops: 'backdrops', stages: 'stages', animated: 'animated', members: 'members', channels: 'channels', roles: 'roles', priority: 'priority' };
      for (const [k, v] of Object.entries(p_patch || {})) {
        if (!map[k]) fail('bad_request');
        if (typeof v === 'number' && v < 0) fail('bad_value');
        p[map[k]] = v;
      }
      return { ok: true };
    },
    admin_community_plan_state: ({ p_community }) => {
      const c = commOf(p_community);
      return { community: c.name, plan: planJson(c), periods: c.plan?.id && c.plan.id !== 'free' ? [{ id: 'pp-1', plan: c.plan.id, source: c.planSource || 'admin', startsAt: iso(Date.now() - DAY), endsAt: c.plan.endsAt, revokedAt: null }] : [] };
    },
    admin_community_plan_grant: ({ p_community, p_plan, p_days = null }) => {
      const c = commOf(p_community);
      if (!['go', 'pro', 'max', 'ultra'].includes(p_plan)) fail('unknown_plan');
      if (p_days !== null && !(p_days >= 1 && p_days <= 365)) fail('bad_value');
      c.planSource = 'admin';
      return { ok: true, endsAt: grant(c, p_plan, p_days).endsAt };
    },
    admin_community_plan_revoke: ({ p_community }) => {
      const c = commOf(p_community);
      const n = planOf(c).id === 'free' ? 0 : 1;
      c.plan = { id: 'free', endsAt: null };
      return { ok: true, periods: n };
    },
    admin_community_media_queue: (args) => {
      const out = orig.admin_community_media_queue(args);
      const priorityOf = (id) => planOf(commOf(id)).priority;
      const items = out.items.map((it) => {
        const found = everyMedia().find((x) => x.item.id === it.id)?.item;
        return { ...it, source: found?.source || 'upload', url: found?.url || null, still: found?.still || null, animated: found?.animated === true, plan: planOf(commOf(it.communityId)).id, priority: priorityOf(it.communityId) };
      });
      if (args.p_status === undefined || args.p_status === 'pending') items.sort((a, b) => Number(b.priority) - Number(a.priority));
      return { ...out, items };
    },
  });
  const isStaffRole = (role) => role === 'owner' || role === 'moderator';
  // mediaJson de fake.js no sabe de KLIPY ni de lo oculto: se completa acá.
  const mediaJson2 = (c, item) => ({ id: item.id, communityId: c.id, name: item.name, status: item.status, source: item.source || 'upload', animated: item.animated === true, hidden: false,
    mime: item.mime, bytes: item.bytes, width: item.width, height: item.height, createdAt: item.createdAt, reviewedAt: item.reviewedAt, mine: true, rejectReason: null,
    path: item.path, url: item.url || null, still: item.still || null, uploadedBy: item.uploadedBy });

  return { rpcs, grant, planOf, table };
}
