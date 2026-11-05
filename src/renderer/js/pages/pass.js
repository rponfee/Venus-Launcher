// Venus Pass (#/pass): el nivel con su progreso, los premios destacados (marcos, títulos y efectos) y la lista de los
// 380 niveles por páginas, con "Ir a mi nivel" y "Reclamar todo". El pase no se compra: se gana jugando (1 XP por
// minuto, 60 XP por nivel). Estado compartido en features/pass.js; reglas y RPC en
// supabase/migrations/0041_venus_pass_tiempo.sql · plan de premios: pages/pass/plan.js · guía: docs/wip/pase-46.md.
import { h, icon, mount, skeleton, emptyState, setBusy, toast, fail, fmtDate, fmtDuration, reducedMotion, avatarImg } from '../ui.js';
import { store } from '../store.js';
import { t, has, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { getPass, onPass, loadPass, claim, claimAll, passBackend } from '../features/pass.js';
import { itemName } from '../features/rewards.js';
import { frameItem, framePreview } from '../social/frames.js';
import { pointsTicket, levelBadge } from '../features/cosmic-art.js';
import { openAppearance } from './pass/appearance.js';
import { levelInfo, levelTiles, levelRanges, rangeIndexOf, rangeStats, itemRewards, itemKind, nextItem, playSummary, claimableList, minutesForXp, xpToLevel, seasonState, daysLeft } from './pass/logic.js';

const P = (key, vars) => t(`pass.${key}`, vars);
const KIND_ICON = { frame: 'user', name_effect: 'sparkles', title: 'tag', badge_style: 'shield', cape: 'flame', item: 'gift' };
// Los errores del pase llegan como texto de la excepción ('locked', 'already'...); los de cuenta o red, ya clasificados.
const errText = (err) => {
  if (err?.code && has(`pass.err_${err.code}`)) return P(`err_${err.code}`);
  if (err?.message && has(`pass.err_${err.message}`)) return P(`err_${err.message}`);
  if (err?.code && has(`rewards.err_${err.code}`)) return t(`rewards.err_${err.code}`);
  return t('rewards.err_server');
};
const fmtInt = (n) => new Intl.NumberFormat(locale()).format(n ?? 0);

function pageHead(me) {
  const st = me ? seasonState(me.season) : 'none';
  let when = null;
  if (me && me.season.permanent) when = P('permanent');
  else if (st === 'active') {
    const d = daysLeft(me.season.endsAt);
    when = d > 0 ? P('daysLeft', { count: d, n: fmtInt(d) }) : P('endsToday');
  } else if (st === 'ended') when = P('ended');
  else if (st === 'upcoming') when = P('upcoming', { date: fmtDate(Date.parse(me.season.startsAt)) });
  return h('div', { class: 'page-head' },
    h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, P('title')), h('p', { class: 'page-sub' }, P('tagline'))),
    me && when ? h('div', { class: 'ps-season' }, h('span', { class: 'ps-season-label' }, P('progressionLabel')), h('span', { class: ['ps-season-when', `is-${st}`] }, icon(me.season.permanent ? 'rocket' : 'calendar'), when)) : null);
}

// ---------- Premios ----------
function rewardFace(r) {
  if (r.kind === 'points') return [pointsTicket(`+${fmtInt(r.amount)}`, { label: P('points', { n: fmtInt(r.amount) }), compact: true })];
  const kind = itemKind(r.itemId);
  // Un marco se ve puesto en tu cabeza (circular), con su rareza
  const fr = kind === 'frame' ? frameItem(r.itemId) : null;
  if (fr) {
    const acc = store.selectedAccount();
    const head = avatarImg(acc?.type === 'msa' ? acc.uuid : acc?.name || 'MHF_Steve', 64, 'sc-head');
    return [h('span', { class: 'ps-tile-frame' }, framePreview(r.itemId, head, 44)), h('span', { class: 'ps-tile-name' }, itemName(r.itemId)), h('span', { class: ['ps-tile-sub', 'fr-rarity', `r-${fr.rarity}`] }, t(`rewards.rarity_${fr.rarity}`))];
  }
  return [h('span', { class: 'ps-tile-icon ps-tile-item' }, icon(KIND_ICON[kind] || 'gift')), h('span', { class: 'ps-tile-name' }, itemName(r.itemId)), h('span', { class: 'ps-tile-sub' }, P(`kind_${kind}`))];
}

// Lo que falta para llegar a un nivel, en horas y minutos de juego (a la velocidad actual: con Premium rinde más).
const timeTo = (me, level) => fmtDuration(minutesForXp(me, xpToLevel(me, level)) * 60000, { short: true });

function tile(tl, me, onClaim) {
  const head = h('div', { class: 'ps-tile-head' }, h('span', { class: 'ps-tile-level' }, P('levelShort', { level: tl.level })), tl.current ? h('span', { class: 'ps-col-tag' }, P('current')) : null);
  if (!tl.reward) return h('div', { class: ['ps-tile', 'ps-tile-empty', tl.current && 'is-current'], role: 'listitem', dataset: { level: String(tl.level) }, tabindex: '-1' }, head, h('span', { class: 'ps-tile-sub' }, P('noReward')));
  const r = tl.reward;
  const el = h('div', { class: ['ps-tile', `is-${tl.state}`, r.kind === 'item' && 'is-item', tl.current && 'is-current'], role: 'listitem', dataset: { level: String(tl.level) }, tabindex: '-1' },
    head, h('div', { class: 'ps-tile-body' }, ...rewardFace(r)));
  if (tl.state === 'claimable') {
    const btn = h('button', { type: 'button', class: 'btn primary sm ps-claim', 'aria-label': P('claimLevel', { level: tl.level }) }, icon('gift'), P('claim'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      try { await onClaim(r); } finally { done(); }
    });
    el.append(btn);
  } else if (tl.state === 'claimed') el.append(h('span', { class: 'ps-tile-state' }, icon('check'), P('claimed')));
  else el.append(h('span', { class: 'ps-tile-state' }, icon('lock'), P('lockedTime', { time: timeTo(me, tl.level) })));
  return el;
}

// ---------- Nivel ----------
function heroView(me, { onClaimAll, onCustomize }) {
  const lv = levelInfo(me);
  const play = playSummary(me);
  const claimable = claimableList(me).length;
  const next = nextItem(me);
  const claimBtn = claimable ? h('button', { type: 'button', class: 'btn primary' }, icon('gift'), P('claimAllCount', { count: claimable, n: fmtInt(claimable) })) : null;
  if (claimBtn) claimBtn.addEventListener('click', async () => { const done = setBusy(claimBtn); try { await onClaimAll(); } finally { done(); } });
  return h('section', { class: 'card ps-hero' },
    h('div', { class: 'ps-emblem' }, levelBadge(lv.level, store.settings?.passAppearance, { label: P('level') }), h('button', { type: 'button', class: 'btn sm ghost ps-customize', onclick: onCustomize }, icon('palette'), P('customize'))),
    h('div', { class: 'ps-progress-wrap' },
      h('div', { class: 'ps-progress-head' },
        h('strong', {}, lv.maxed ? P('levelMax') : P('levelOf', { level: lv.level, levels: lv.levels })),
        h('span', { class: 'ps-muted' }, lv.maxed ? P('xpAll', { n: fmtInt(me.xp.total) }) : P('xpToNext', { n: fmtInt(lv.toNext), level: lv.level + 1 }))),
      h('div', { class: 'ps-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(lv.pct), 'aria-label': P('levelOf', { level: lv.level, levels: lv.levels }) }, h('i', { style: { width: `${lv.pct}%` } })),
      h('div', { class: 'ps-muted ps-progress-foot' }, lv.maxed ? P('maxedText') : P('xpProgress', { n: fmtInt(lv.levelXp), total: fmtInt(lv.xpPerLevel) })),
      h('div', { class: 'ps-chips' },
        me.xp.premiumMult > 1 ? h('span', { class: 'ps-chip' }, icon('crown'), P('premiumXp')) : null,
        h('span', { class: 'ps-chip ps-chip-muted' }, icon('play'), P('playedTotal', { time: fmtDuration(me.xp.fromPlay * 60000) })),
        h('span', { class: ['ps-chip', 'ps-chip-muted', play.capped && 'is-capped'] }, icon('clock'), P('playedToday', { today: fmtInt(play.today), cap: fmtInt(play.cap) }))),
      next ? h('p', { class: 'ps-next' }, icon('gift'), h('span', {}, P('nextItem', { name: itemName(next.reward.itemId), level: next.reward.level, time: fmtDuration(next.minutesLeft * 60000) }))) : null),
    h('div', { class: 'ps-hero-actions' }, claimBtn));
}

// ---------- Premios destacados (cosméticos) ----------
function highlightsView(me, onClaim, keepLeft) {
  const items = itemRewards(me);
  if (!items.length) return null;
  const byLevel = new Map(levelTiles(me).map((tl) => [tl.level, tl]));
  const strip = h('div', { class: 'ps-strip', role: 'list', tabindex: '0', 'aria-label': P('highlightsTitle') }, items.map((r) => tile(byLevel.get(r.level), me, onClaim)));
  const scrollBy = (dir) => strip.scrollBy({ left: dir * Math.max(240, strip.clientWidth * 0.8), behavior: reducedMotion() ? 'auto' : 'smooth' });
  const nav = h('div', { class: 'ps-strip-nav' },
    h('button', { type: 'button', class: 'icon-btn sm', title: P('prev'), 'aria-label': P('prev'), onclick: () => scrollBy(-1) }, icon('chevronLeft')),
    h('button', { type: 'button', class: 'icon-btn sm', title: P('next'), 'aria-label': P('next'), onclick: () => scrollBy(1) }, icon('chevronRight')));
  // Arranca en el primer cosmético que todavía no se reclamó (al repintar, donde ya estaba)
  queueMicrotask(() => {
    if (typeof keepLeft === 'number') { strip.scrollLeft = keepLeft; return; }
    const target = strip.querySelector('.is-claimable, .is-locked');
    if (target) strip.scrollLeft = Math.max(0, target.offsetLeft - 8);
  });
  return h('section', { class: 'card ps-highlights' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, icon('sparkles'), P('highlightsTitle')), h('p', { class: 'card-sub' }, P('highlightsHint'))), nav),
    strip);
}

// ---------- Todos los niveles (por páginas) ----------
function levelsView(me, { selected, onSelect, onJump, onClaimAll, onClaim }) {
  const ranges = levelRanges(me.season.levels);
  const range = ranges[Math.min(selected, ranges.length - 1)];
  const claimable = claimableList(me).length;
  const chips = ranges.map((rg) => {
    const st = rangeStats(me, rg);
    const label = `${rg.from}–${rg.to}`;
    const btn = h('button', { type: 'button', class: ['ps-range', st.claimable && 'has-claim'], 'aria-pressed': String(rg.index === range.index), 'aria-label': st.claimable ? `${P('rangeLabel', { from: rg.from, to: rg.to })}, ${P('rangeClaimable', { count: st.claimable, n: st.claimable })}` : P('rangeLabel', { from: rg.from, to: rg.to }) }, label, st.claimable ? h('i', { class: 'ps-range-dot', 'aria-hidden': 'true' }) : null);
    btn.addEventListener('click', () => onSelect(rg.index));
    return btn;
  });
  const claimBtn = claimable ? h('button', { type: 'button', class: 'btn primary sm' }, icon('gift'), P('claimAllCount', { count: claimable, n: fmtInt(claimable) })) : null;
  if (claimBtn) claimBtn.addEventListener('click', async () => { const done = setBusy(claimBtn); try { await onClaimAll(); } finally { done(); } });
  const tiles = levelTiles(me).filter((tl) => tl.level >= range.from && tl.level <= range.to);
  return h('section', { class: 'card ps-levels' },
    h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title' }, icon('layers'), P('trackTitle')), h('p', { class: 'card-sub' }, P('levelsHint', { levels: me.season.levels, xp: me.season.xpPerLevel })))),
    h('div', { class: 'ps-toolbar' },
      h('div', { class: 'ps-ranges', role: 'group', 'aria-label': P('rangesLabel') }, chips),
      h('div', { class: 'ps-toolbar-actions' }, h('button', { type: 'button', class: 'btn sm', onclick: onJump }, icon('target'), P('goCurrent')), claimBtn)),
    h('div', { class: 'ps-grid', role: 'list', 'aria-label': P('rangeLabel', { from: range.from, to: range.to }) }, tiles.map((tl) => tile(tl, me, onClaim))));
}

// ---------- Cómo se sube de nivel ----------
function howView(me) {
  const play = playSummary(me);
  const items = [
    ['play', P('howPlayXp', { xp: me.season.xpPerLevel })],
    ['clock', play.capped ? P('howCapDone', { cap: fmtInt(play.cap) }) : P('howCap', { today: fmtInt(play.today), cap: fmtInt(play.cap) })],
    ['crown', P('howPremium')],
    ['rocket', P('howFree', { levels: me.season.levels })],
    ['logIn', P('howAccount')],
  ];
  return h('section', { class: 'card ps-how' },
    h('h2', { class: 'card-title' }, icon('info'), P('howTitle')),
    h('ul', { class: 'ps-how-list' }, items.map(([ic, text]) => h('li', {}, icon(ic), h('span', {}, text)))));
}

// ---------- Página ----------
export default {
  ns: ['pass', 'rewards'],
  css: ['pages/pass', 'features/frames', 'features/cosmic-art'],
  async render(root) {
    const b = await passBackend();
    if (!root.isConnected) return null;
    let alive = true;
    const cleanups = [];
    let appearanceDialog = null;
    let selected = null; // página de la lista (null: la del nivel actual hasta que se elija otra)
    let jumpTo = null;
    cleanups.push(() => appearanceDialog?.close());

    if (!b.signedIn()) {
      mount(root, pageHead(null), h('div', { class: 'ps-signed-out' }, emptyState('logIn', P('signInTitle'), P('signInText'),
        h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), P('signIn')))));
      return () => { alive = false; };
    }

    const heroHost = h('div');
    const highlightsHost = h('div');
    const levelsHost = h('div');
    const howHost = h('div');
    const body = h('div', { class: 'ps-body' });
    mount(root, pageHead(null), body);
    mount(body, skeleton(3));

    async function onClaim(r) {
      try {
        const res = await claim(r.level);
        toast('good', P('claimedOne', { level: r.level }), res?.kind === 'points' ? P('claimedPoints', { n: fmtInt(res.points) }) : itemName(res?.itemId || r.itemId), 4500);
      } catch (err) {
        fail(P('claimError'), errText(err));
      }
    }
    async function onClaimAll() {
      try {
        const res = await claimAll();
        const items = (res?.claimed || []).filter((x) => x.kind === 'item').length;
        toast('good', P('claimedTitle'), [res?.points ? P('claimedPoints', { n: fmtInt(res.points) }) : '', items ? P('claimedItems', { count: items, n: items }) : ''].filter(Boolean).join(' '), 6000);
      } catch (err) {
        fail(P('claimError'), errText(err));
      }
    }
    const onCustomize = () => {
      const me = getPass().data;
      if (!me) return;
      appearanceDialog?.close();
      appearanceDialog = openAppearance(me.level);
    };

    // La lista se repinta sola (al elegir otra página no se toca el resto de la página).
    function paintLevels() {
      const me = getPass().data;
      if (!alive || !me) return;
      const ranges = levelRanges(me.season.levels);
      if (selected === null) selected = rangeIndexOf(me.level, ranges);
      mount(levelsHost, levelsView(me, {
        selected, onClaim, onClaimAll,
        onSelect: (i) => { selected = i; paintLevels(); levelsHost.querySelector('.ps-range[aria-pressed="true"]')?.focus({ preventScroll: true }); },
        onJump: () => { jumpTo = Math.max(1, me.level); selected = rangeIndexOf(jumpTo, ranges); paintLevels(); },
      }));
      if (jumpTo !== null) {
        const target = levelsHost.querySelector(`.ps-tile[data-level="${jumpTo}"]`);
        jumpTo = null;
        if (target) {
          target.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
          target.classList.add('is-flash');
          target.focus({ preventScroll: true });
          setTimeout(() => target.classList.remove('is-flash'), 1800);
        }
      }
    }

    function paint() {
      if (!alive) return;
      const { data: me, error, at } = getPass();
      if (error && !me) {
        mount(body, h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, P('loadError')), h('button', { type: 'button', class: 'btn sm', onclick: () => { mount(body, skeleton(3)); loadPass({ force: true }); } }, icon('refresh'), P('retry'))));
        return;
      }
      if (!at && !me) return;
      if (!me) {
        mount(root, pageHead(null), emptyState('calendar', P('noPass'), P('noPassText')));
        return;
      }
      const top = root.scrollTop;
      if (root.firstChild) root.firstChild.replaceWith(pageHead(me));
      mount(heroHost, heroView(me, { onClaimAll, onCustomize }));
      mount(highlightsHost, highlightsView(me, onClaim, highlightsHost.querySelector('.ps-strip')?.scrollLeft));
      mount(howHost, howView(me));
      if (!body.contains(heroHost)) mount(body, heroHost, highlightsHost, levelsHost, howHost);
      paintLevels();
      root.scrollTop = top;
    }

    cleanups.push(onPass(paint));
    cleanups.push(store.on('settings', paint));
    cleanups.push(b.onAuth?.(() => navigate('pass')) || (() => {}));
    await loadPass({ force: true });
    paint();
    return () => {
      alive = false;
      cleanups.forEach((fn) => fn?.());
    };
  },
};
