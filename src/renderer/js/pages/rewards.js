// Venus Points (#/rewards[/<shop, invite, history o premium>]): saldo, premio diario con racha,
// tienda de cosméticos, invitaciones con código (y la verificación de la cuenta de Minecraft que las paga),
// historial y Venus Premium. Reglas y RPC: supabase/migrations/0021_puntos.sql · guía: docs/venus-points.md.
import { h, icon, mount, modal, skeleton, emptyState, sectionTitle, setBusy, toast, ok, fail, confirmDialog, copyText, fmtDate, fmtAgo, fmtDuration, fmtTime, avatarImg, selectEl } from '../ui.js';
import { store, api } from '../store.js';
import { t, has, locale } from '../i18n.js';
import { navigate, openAccounts } from '../app.js';
import { social } from '../social.js';
import { backend } from './rewards/backend.js';
import {
  DOWNLOAD_URL, REFERRAL_POINTS, REFERRAL_DAYS, dailyInfo, equipPatch, formatDelta,
  formatPoints, historyEntry, normalizeReferralCode, shopView, utcDay,
} from './rewards/logic.js';
import { loadSummary, onSummary, getSummary, claimAchievement, sweepServerAchievements, achievementName, itemName } from '../features/rewards.js';
import { perksPanel } from '../features/premium.js';
import { pointsTicket } from '../features/cosmic-art.js';
import { FRAME_CATEGORIES, FRAME_RARITIES, FRAME_PRICE_FILTERS, frameItem, frameSections, framePreview } from '../social/frames.js';
import { registerItems } from '../features/profile-editor/model.js';

const R = (key, vars) => t(`rewards.${key}`, vars);
const TABS = [
  { id: 'shop', icon: 'tag' },
  { id: 'invite', icon: 'userPlus' },
  { id: 'history', icon: 'history' },
  { id: 'premium', icon: 'crown' },
];
const pts = (n) => formatPoints(n, locale());
const cls = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
const errText = (err) => (err?.code && has(`rewards.err_${err.code}`) ? R(`err_${err.code}`) : R('err_server'));

// Estilos de perfil (social/profile-style.js): el nombre con su estilo y el título. Los marcos los dibuja social/frames.js.
let profileStylePromise = null;
function profileStyle() {
  profileStylePromise ||= import('../social/profile-style.js')
    .then(async (m) => {
      await m.ensureProfileStyle?.();
      return m;
    })
    .catch(() => null);
  return profileStylePromise;
}

function pageHead(actions) {
  return h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, R('title')), h('p', { class: 'page-sub' }, R('subtitle'))), actions ? h('div', { class: 'page-actions' }, actions) : null);
}

// Cómo se ganan (sin sesión)
function waysView() {
  const ways = [
    { icon: 'calendar', key: 'wayDaily' },
    { icon: 'trophy', key: 'wayAchievements' },
    { icon: 'userPlus', key: 'wayInvite' },
    { icon: 'tag', key: 'wayShop' },
  ];
  return h('ul', { class: 'rw-ways' }, ways.map((w) => h('li', { class: 'rw-way' }, h('span', { class: 'rw-way-icon', 'aria-hidden': 'true' }, icon(w.icon)), h('span', { class: 'rw-way-main' }, h('strong', {}, R(w.key)), h('span', {}, R(`${w.key}Text`))))));
}

export default {
  ns: ['rewards', 'premium'],
  css: ['pages/rewards', 'features/premium', 'features/frames', 'features/cosmic-art'],
  async render(root, params) {
    const b = await backend();
    if (!root.isConnected) return;
    const cleanups = [];
    let alive = true;
    const userAtRender = b.signedIn() ? b.userId() : null;
    cleanups.push(
      b.onAuth(() => {
        if ((b.signedIn() ? b.userId() : null) !== userAtRender && alive) navigate(location.hash.replace(/^#\/?/, '') || 'rewards');
      }),
    );
    const done = () => {
      alive = false;
      cleanups.forEach((fn) => fn?.());
    };

    // ---------- Sin sesión (o la sesión venció) ----------
    const paintSignedOut = () =>
      mount(
        root,
        pageHead(),
        h('div', { class: 'rw-signed-out' }, emptyState('logIn', R('signInTitle'), R('signInText'), h('button', { type: 'button', class: 'btn primary', onclick: () => navigate('settings/cloud') }, icon('logIn'), R('signIn'))), waysView()),
      );
    if (!userAtRender) {
      paintSignedOut();
      return done;
    }

    // ---------- Estado ----------
    const st = { tab: TABS.some((x) => x.id === params[0]) ? params[0] : 'shop', items: null, itemsError: null, profile: null, ps: null, stats: null, code: null, codeLoading: false, fq: { query: '', category: 'all', rarity: 'all', price: 'all' } };
    let viewCleanups = [];
    const refreshBtn = h('button', { type: 'button', class: 'icon-btn', title: t('common.refresh'), 'aria-label': t('common.refresh'), onclick: () => reload(refreshBtn) }, icon('refresh'));
    const hero = h('div', { class: 'rw-hero' });
    const body = h('div', { class: 'rw-body' });
    const tabButtons = TABS.map((tab) =>
      h(
        'button',
        {
          type: 'button',
          class: 'tab',
          role: 'tab',
          id: `rw-tab-${tab.id}`,
          'aria-controls': 'rw-panel',
          dataset: { tab: tab.id },
          onclick: () => show(tab.id, true),
          onkeydown: (e) => {
            const i = TABS.findIndex((x) => x.id === tab.id);
            const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
            if (next === null) return;
            e.preventDefault();
            const target = TABS[(next + TABS.length) % TABS.length].id;
            show(target, true);
            tabButtons.find((x) => x.dataset.tab === target)?.focus();
          },
        },
        icon(tab.icon),
        h('span', {}, R(`tab_${tab.id}`)),
      ),
    );
    const tabs = h('nav', { class: 'tabs rw-tabs', role: 'tablist', 'aria-label': R('title') }, tabButtons);
    // Campo del código de quien te invitó: se conserva entre redibujos (no se pierde lo que se está escribiendo)
    const codeInput = h('input', { class: 'input rw-code-input', id: 'rw-redeem', maxlength: 12, autocomplete: 'off', spellcheck: 'false', placeholder: 'VP-XXXXXX', 'aria-describedby': 'rw-redeem-error' });
    const redeemError = h('div', { class: 'field-error', id: 'rw-redeem-error', role: 'alert', hidden: true });
    const verifyStatus = h('div', { class: 'rw-verify-status', 'aria-live': 'polite' });

    const data = () => getSummary().data;

    // ---------- Cabecera: saldo y premio diario ----------
    function streakRow(streak) {
      const filled = Math.min(streak, 7);
      return h(
        'div',
        { class: 'rw-streak' },
        h('div', { class: 'rw-streak-cells', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, i) => h('span', { class: ['rw-streak-cell', i < filled && 'on', i === filled - 1 && 'last'] }, i < filled ? icon('flame') : null))),
        h('span', { class: 'rw-streak-label' }, streak > 0 ? R('streak', { count: streak }) : R('streakNone')),
      );
    }

    async function claimDaily(btn) {
      const release = setBusy(btn);
      try {
        const res = await b.rpc('points_daily_claim');
        if (res?.already) toast('info', R('dailyAlready'));
        else ok(R('dailyClaimed', { points: pts(res?.points) }), Number(res?.streak) > 1 ? R('dailyStreakToast', { count: Number(res.streak) }) : null);
        if (!res?.already) window.dispatchEvent(new CustomEvent('venus:mission', { detail: { metric: 'dailyRewards' } }));
        await loadSummary({ force: true });
      } catch (err) {
        fail(R('dailyFailed'), errText(err));
      } finally {
        release();
      }
    }

    function paintHero() {
      const d = data();
      if (!d) return;
      const now = Date.now();
      const info = dailyInfo(d, now);
      // Pasó la medianoche UTC desde la última consulta: el premio diario volvió
      if (utcDay(now) !== utcDay(getSummary().at || now)) loadSummary({ force: true });
      const all = Array.isArray(d.achievements) ? d.achievements : [];
      const doneCount = all.filter((a) => a.unlockedAt).length;
      const claimBtn = h('button', { type: 'button', class: 'btn primary rw-claim', onclick: (e) => claimDaily(e.currentTarget) }, icon('vpoint'), R('dailyClaim', { points: pts(info.points) }));
      mount(
        hero,
        h(
          'section',
          { class: ['card', 'rw-balance', d.premium && 'premium'], 'aria-labelledby': 'rw-balance-label' },
          h('div', { class: 'rw-balance-label', id: 'rw-balance-label' }, R('balanceLabel')),
          pointsTicket(pts(d.balance)),
          h(
            'div',
            { class: 'rw-balance-meta' },
            d.premium
              ? h('span', { class: 'badge accent' }, icon('zap'), R('multiplierOn'))
              : h('button', { type: 'button', class: 'btn sm ghost rw-x2', onclick: () => show('premium', true) }, icon('zap'), R('multiplierOff')),
            h('span', { class: 'rw-meta' }, icon('trophy'), R('achCount', { done: doneCount, total: all.length })),
            h('span', { class: 'rw-meta' }, icon('userPlus'), R('referralCount', { count: Number(d.referrals?.rewarded) || 0 })),
          ),
        ),
        h(
          'section',
          { class: ['card', 'rw-daily', info.claimable && 'ready'], 'aria-labelledby': 'rw-daily-title' },
          h(
            'div',
            { class: 'card-head' },
            h('div', {}, h('h2', { class: 'card-title', id: 'rw-daily-title' }, icon('calendar'), R('dailyTitle')), h('p', { class: 'card-sub' }, R(d.premium ? 'dailySubPremium' : 'dailySub'))),
            info.claimable ? null : h('span', { class: 'pill good' }, icon('check'), R('dailyDone')),
          ),
          streakRow(info.streak),
          h(
            'div',
            { class: 'rw-daily-foot' },
            h('p', { class: 'rw-daily-text' }, info.claimable ? R('dailyReady', { points: pts(info.points) }) : R('dailyBack', { time: fmtDuration(info.nextAt - now), at: fmtTime(info.nextAt), points: pts(info.points) })),
            info.claimable ? claimBtn : null,
          ),
        ),
      );
    }

    // ---------- Logros ----------

    // ---------- Tienda ----------
    function me() {
      const acc = store.selectedAccount();
      const fallbackName = st.profile?.displayName || st.profile?.username || acc?.name || 'Steve';
      return { ...(st.profile || {}), displayName: fallbackName, nameStyle: st.profile?.nameStyle || {}, equipped: st.profile?.equipped || {} };
    }
    // Tu cabeza (la cuenta de Minecraft elegida) para probar los marcos; siempre redonda (.sc-head)
    const myAvatar = (size = 64) => {
      const acc = store.selectedAccount();
      return avatarImg(acc?.type === 'msa' ? acc.uuid : acc?.name || 'MHF_Steve', size > 64 ? 128 : 64, 'sc-head');
    };
    const mcName = () => store.selectedAccount()?.name || 'Steve';
    const itemById = (id) => (st.items || []).find((it) => it.id === id) || null;

    // Cabeza circular con el marco puesto (frameId null: la cabeza sola)
    const frameEl = (frameId, size = 64) => framePreview(frameId, myAvatar(size), size);

    function nameEl(profile, { size = 'md', title = false } = {}) {
      if (st.ps?.styledName) {
        try {
          return st.ps.styledName(profile, { size, title });
        } catch (err) {
          console.warn('[rewards] nombre', err);
        }
      }
      const effectItem = itemById(profile.equipped?.nameEffect);
      const effect = cls(effectItem?.data?.effect || profile.nameStyle?.effect);
      const titleItem = title ? itemById(profile.equipped?.title) : null;
      return h('span', { class: ['rw-name-wrap', `rw-size-${size}`] }, h('span', { class: ['rw-name', effect && `rw-fx-${effect}`] }, profile.displayName), titleItem ? h('span', { class: 'rw-title-tag' }, itemName(titleItem.id)) : null);
    }

    function badgePlate(style) {
      return h('span', { class: 'rw-plate' }, h('span', { class: ['rw-badge', `rw-badge-${cls(style) || 'default'}`], 'aria-hidden': 'true' }, icon('vpoint')), h('span', { class: 'rw-plate-name' }, mcName()));
    }

    function currentBadgeStyle(d) {
      const eq = st.profile?.equipped?.badgeStyle;
      if (d.premium && (eq || 'badge_gold') === 'badge_gold') return 'gold';
      const it = eq ? itemById(eq) : null;
      return it && (d.items || []).includes(it.id) ? it.data?.style : 'default';
    }

    function preview(item) {
      const profile = me();
      if (item.kind === 'frame') return frameEl(item.id, 72);
      if (item.kind === 'name_effect') return nameEl({ ...profile, nameStyle: { ...profile.nameStyle, effect: item.data?.effect }, equipped: { ...profile.equipped, nameEffect: item.id } }, { size: 'md' });
      if (item.kind === 'badge_style') return badgePlate(item.data?.style);
      return nameEl({ ...profile, equipped: { ...profile.equipped, title: item.id } }, { size: 'sm', title: true });
    }

    async function buy(v, btn) {
      const d = data();
      const name = itemName(v.item.id);
      const yes = await confirmDialog(R('buyTitle', { name }), R('buyText', { price: pts(v.price), left: pts((Number(d?.balance) || 0) - v.price) }), { okText: R('buyOk') });
      if (!yes || !alive) return false;
      const release = setBusy(btn);
      let done = false;
      try {
        await b.rpc('shop_buy', { p_item: v.item.id });
        ok(R('bought', { name }), R('boughtText'));
        done = true;
      } catch (err) {
        fail(R('buyFailed'), errText(err));
      } finally {
        release();
        await loadSummary({ force: true });
      }
      return done;
    }

    async function equip(v, itemId, btn) {
      const d = data();
      const patch = equipPatch(st.profile?.equipped || {}, v.slot, itemId, { items: st.items, owned: d?.items, premium: d?.premium });
      const release = setBusy(btn);
      let done = false;
      try {
        const res = await b.rpc('profile_customize', { p_patch: { equipped: patch } });
        const equipped = res?.equipped && typeof res.equipped === 'object' ? res.equipped : Object.fromEntries(Object.entries(patch).filter(([, x]) => x));
        st.profile = { ...(st.profile || {}), equipped };
        ok(itemId ? R('equipped', { name: itemName(itemId) }) : R('unequipped', { name: itemName(v.item.id) }));
        if (alive && st.tab === 'shop') paintPanel();
        done = true;
      } catch (err) {
        fail(R('equipFailed'), errText(err));
      } finally {
        release();
      }
      return done;
    }

    function itemAction(v) {
      const name = itemName(v.item.id);
      if (v.state === 'equipped')
        return [h('span', { class: 'badge good' }, icon('check'), R('equippedBadge')), h('button', { type: 'button', class: 'btn sm ghost', 'aria-label': R('unequipAria', { name }), onclick: (e) => equip(v, null, e.currentTarget) }, R('unequip'))];
      if (v.state === 'owned') return h('button', { type: 'button', class: 'btn sm tonal', 'aria-label': R('equipAria', { name }), onclick: (e) => equip(v, v.item.id, e.currentTarget) }, R('equip'));
      if (v.state === 'premium') return h('button', { type: 'button', class: 'btn sm ghost', onclick: () => show('premium', true) }, icon('crown'), R('seePremium'));
      if (v.state === 'short') return [h('button', { type: 'button', class: 'btn sm', disabled: true, 'aria-describedby': `rw-miss-${v.item.id}` }, R('buy')), h('span', { class: 'rw-item-miss', id: `rw-miss-${v.item.id}` }, R('shopMissing', { points: pts(v.missing) }))];
      return h('button', { type: 'button', class: 'btn sm', 'aria-label': R('buyAria', { name, price: pts(v.price) }), onclick: (e) => buy(v, e.currentTarget) }, R('buy'));
    }

    // Una tarjeta de la tienda (los marcos llevan rareza y una vista previa que se abre grande)
    function itemCard(v) {
      const fr = v.item.kind === 'frame' ? frameItem(v.item.id) : null;
      const name = itemName(v.item.id);
      const pv = preview(v.item);
      return h(
        'article',
        { class: ['rw-item', `is-${v.state}`, fr && 'is-frame'] },
        fr
          ? h('button', { type: 'button', class: 'rw-item-preview rw-pv-btn', 'aria-label': R('framesPreview', { name }), title: R('framesPreview', { name }), onclick: () => openFramePreview(v) }, pv)
          : h('div', { class: 'rw-item-preview' }, pv),
        h(
          'div',
          { class: 'rw-item-body' },
          h('h4', { class: 'rw-item-name' }, name),
          fr ? h('span', { class: ['fr-rarity', `r-${fr.rarity}`] }, R(`rarity_${fr.rarity}`)) : null,
          h('div', { class: 'rw-item-price' }, v.premiumOnly ? h('span', { class: 'badge accent' }, icon('crown'), R('premiumIncluded')) : [icon('vpoint'), h('span', { class: 'num' }, pts(v.price))]),
          h('div', { class: 'rw-item-actions' }, itemAction(v)),
        ),
      );
    }

    // Vista previa grande de un marco: tu cabeza a 128, 64 y 32 px sobre fondo oscuro y claro, y comprar o equipar desde ahí
    function openFramePreview(v) {
      const id = v.item.id;
      const fr = frameItem(id);
      const name = itemName(id);
      const stage = (cls) => h('div', { class: ['rw-stage', cls] }, [128, 64, 32].map((size) => h('div', { class: 'rw-stage-cell' }, frameEl(id, size), h('span', { class: 'rw-stage-size' }, `${size} px`))));
      let dlg = null;
      const run = (fn) => async (e) => {
        if (await fn(e.currentTarget)) dlg?.close();
      };
      let primary;
      if (v.state === 'equipped') primary = h('button', { type: 'button', class: 'btn ghost', onclick: run((btn) => equip(v, null, btn)) }, R('unequip'));
      else if (v.state === 'owned') primary = h('button', { type: 'button', class: 'btn primary', onclick: run((btn) => equip(v, id, btn)) }, icon('check'), R('equip'));
      else if (v.state === 'premium') primary = h('button', { type: 'button', class: 'btn', onclick: () => (dlg?.close(), show('premium', true)) }, icon('crown'), R('seePremium'));
      else if (v.state === 'short') primary = h('button', { type: 'button', class: 'btn', disabled: true }, R('buy'));
      else primary = h('button', { type: 'button', class: 'btn primary', onclick: run((btn) => buy(v, btn)) }, icon('vpoint'), R('buyFor', { price: pts(v.price) }));
      dlg = modal({
        title: name,
        subtitle: fr ? R(`frames_cat_${fr.category}`) : null,
        icon: 'sparkles',
        body: h(
          'div',
          { class: 'rw-pv-modal' },
          h('div', { class: 'rw-stages' }, stage('dark'), stage('light')),
          h('div', { class: 'rw-pv-meta' }, fr ? h('span', { class: ['fr-rarity', `r-${fr.rarity}`] }, R(`rarity_${fr.rarity}`)) : null, v.premiumOnly ? h('span', { class: 'badge accent' }, icon('crown'), R('premiumIncluded')) : h('span', { class: 'rw-item-price' }, icon('vpoint'), h('span', { class: 'num' }, pts(v.price))), v.state === 'short' ? h('span', { class: 'rw-item-miss' }, R('shopMissing', { points: pts(v.missing) })) : null),
          h('p', { class: 'rw-hint small' }, icon('info'), R('framesPreviewHint')),
        ),
        footer: [h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'btn ghost', onclick: () => dlg?.close() }, t('common.close')), primary],
      });
    }

    // Marcos: buscador, categorías, rareza y precio. La barra se arma una vez: escribir no le saca el foco al campo.
    function framesBlock(views) {
      const q = st.fq;
      const grid = h('div', { class: 'rw-frames-grid' });
      const count = h('span', { class: 'rw-frames-count', 'aria-live': 'polite' });
      const chips = h('div', { class: 'chips rw-frame-chips', role: 'group', 'aria-label': R('frames_filter') });
      const draw = () => {
        const sections = frameSections(views, { ...q, nameOf: (id) => itemName(id) });
        const total = sections.reduce((n, sec) => n + sec.items.length, 0);
        count.textContent = R('framesCount', { count: total });
        mount(
          grid,
          total
            ? sections.map((sec) => h('section', { class: 'rw-frame-cat', 'aria-label': R(`frames_cat_${sec.category}`) }, h('h3', { class: 'rw-cat-title' }, R(`frames_cat_${sec.category}`), h('span', { class: 'rw-cat-count' }, sec.items.length)), h('div', { class: 'rw-shop' }, sec.items.map(itemCard))))
            : emptyState('search', R('framesNone'), R('framesNoneText')),
        );
      };
      const drawChips = () =>
        mount(
          chips,
          ['all', ...FRAME_CATEGORIES].map((c) => h('button', { type: 'button', class: ['chip', q.category === c && 'active'], 'aria-pressed': String(q.category === c), onclick: () => ((q.category = c), drawChips(), draw()) }, R(`frames_cat_${c}`))),
        );
      const search = h('input', { class: 'input rw-frames-search', type: 'search', value: q.query, placeholder: R('frames_search'), 'aria-label': R('frames_search'), spellcheck: 'false', maxlength: 40 });
      search.addEventListener('input', () => ((q.query = search.value), draw()));
      const rarity = selectEl([{ value: 'all', label: R('rarity_all') }, ...FRAME_RARITIES.filter((r) => r !== 'mythic').map((r) => ({ value: r, label: R(`rarity_${r}`) }))], q.rarity, (v) => ((q.rarity = v), draw()));
      rarity.setAttribute('aria-label', R('frames_rarity'));
      const price = selectEl(FRAME_PRICE_FILTERS.map((p) => ({ value: p, label: R(`price_${p}`) })), q.price, (v) => ((q.price = v), draw()));
      price.setAttribute('aria-label', R('frames_price'));
      drawChips();
      draw();
      return h('div', { class: 'rw-frames' }, h('div', { class: 'rw-frames-bar' }, h('div', { class: 'input-icon rw-frames-find' }, icon('search'), search), rarity, price, count), chips, grid);
    }

    function shopPanel(d) {
      if (st.itemsError) {
        return h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, R(st.itemsError === 'network' ? 'shopNetwork' : 'shopUnavailable')), h('button', { type: 'button', class: 'btn sm', onclick: () => loadShop().then(paintPanel) }, icon('refresh'), t('common.retry')));
      }
      if (!st.items) return skeleton('grid', { items: 6, min: 200 });
      const profile = me();
      const groups = shopView(st.items, { owned: d.items, premium: d.premium, balance: d.balance, equipped: profile.equipped });
      const look = h(
        'section',
        { class: 'card rw-look', 'aria-labelledby': 'rw-look-title' },
        frameEl(profile.equipped.frame, 64),
        h('div', { class: 'rw-look-main' }, h('div', { class: 'rw-look-label', id: 'rw-look-title' }, R('lookTitle')), nameEl(profile, { size: 'lg', title: true }), badgePlate(currentBadgeStyle(d))),
        h('div', { class: 'rw-look-side' }, h('span', { class: 'rw-look-points' }, icon('vpoint'), h('span', { class: 'num' }, pts(d.balance))), h('span', { class: 'rw-look-hint' }, R('lookHint'))),
      );
      if (!groups.length) return [look, emptyState('tag', R('shopEmpty'), R('shopEmptyText'))];
      return h(
        'div',
        { class: 'rw-shop-view' },
        look,
        groups.map((g) => [
          sectionTitle(R(`kind_${g.kind}`)),
          g.kind === 'frame' ? framesBlock(g.items) : h('div', { class: 'rw-shop' }, g.items.map(itemCard)),
        ]),
      );
    }

    // ---------- Invitaciones ----------
    async function ensureCode() {
      if (st.codeLoading || st.code || st.codeFailed) return;
      st.codeLoading = true;
      try {
        st.code = await b.rpc('referral_my_code');
      } catch (err) {
        st.codeFailed = true; // no se reintenta en cada redibujo (Actualizar lo vuelve a probar)
        console.warn('[rewards] código de invitación', err?.code || err);
      } finally {
        st.codeLoading = false;
        if (alive && st.tab === 'invite') paintPanel();
      }
    }

    async function redeem(btn) {
      const d = data();
      redeemError.hidden = true;
      codeInput.removeAttribute('aria-invalid');
      const code = normalizeReferralCode(codeInput.value);
      const showError = (text) => {
        mount(redeemError, icon('alert'), h('span', {}, text));
        redeemError.hidden = false;
        codeInput.setAttribute('aria-invalid', 'true');
      };
      if (!code) return showError(R('err_bad_code'));
      if (code === (d?.referralCode || st.code)) return showError(R('err_own_code'));
      const release = setBusy(btn);
      try {
        const res = await b.rpc('referral_claim', { p_code: code });
        codeInput.value = '';
        ok(R('redeemed'), R(res?.rewarded ? 'redeemedPaid' : 'redeemedVerify'));
        await loadSummary({ force: true });
      } catch (err) {
        showError(errText(err));
      } finally {
        release();
      }
    }

    async function verify(btn) {
      mount(verifyStatus);
      const release = setBusy(btn);
      try {
        const res = await api.invoke('rewards:verifyMinecraft');
        b.noteVerified?.(res); // solo el modo de capturas
        ok(R(res?.rewarded ? 'verifiedPaid' : 'verifiedOk', { name: res?.name || '' }), res?.rewarded ? R('verifiedPaidText') : null);
        claimAchievement('mc_verified', { force: true });
        await loadSummary({ force: true });
      } catch (err) {
        const code = err?.code;
        const fixAccount = ['noAccount', 'offlineAccount', 'accountSession', 'mojangSession'].includes(code);
        const fixSession = code === 'noSession';
        if (!alive) return;
        mount(
          verifyStatus,
          h(
            'div',
            { class: 'notice bad', role: 'alert' },
            icon('alert'),
            h('div', { class: 'spacer' }, err?.message || R('err_server')),
            fixAccount ? h('button', { type: 'button', class: 'btn sm', onclick: () => openAccounts() }, icon('user'), R('openAccounts')) : null,
            fixSession ? h('button', { type: 'button', class: 'btn sm', onclick: () => navigate('settings/cloud') }, icon('logIn'), R('signIn')) : null,
          ),
        );
      } finally {
        release();
      }
    }

    function invitePanel(d) {
      const code = d.referralCode || st.code;
      if (!code) ensureCode();
      const rewarded = Number(d.referrals?.rewarded) || 0;
      const message = code ? R('shareMessage', { code, url: DOWNLOAD_URL }) : '';
      const inviteCard = h(
        'section',
        { class: 'card rw-invite', 'aria-labelledby': 'rw-invite-title' },
        h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title', id: 'rw-invite-title' }, icon('userPlus'), R('inviteTitle')), h('p', { class: 'card-sub' }, R('inviteSub', { referrer: pts(REFERRAL_POINTS.referrer), referred: pts(REFERRAL_POINTS.referred) })))),
        h(
          'div',
          { class: 'rw-code-row' },
          code
            ? h('code', { class: 'rw-code selectable', 'aria-label': R('codeAria', { code: code.split('').join(' ') }) }, code)
            : st.codeFailed
              ? h('span', { class: 'rw-text muted' }, R('codeUnavailable'))
              : h('div', { class: 'rw-code-skel' }, skeleton('line', { width: 160 })),
          h('button', { type: 'button', class: 'btn tonal', disabled: !code, onclick: () => copyText(code, R('codeCopied')) }, icon('copy'), R('copyCode')),
        ),
        code
          ? h('div', { class: 'rw-share' }, h('div', { class: 'rw-share-label' }, R('shareLabel')), h('p', { class: 'rw-share-text selectable' }, message), h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(message, R('messageCopied')) }, icon('share'), R('copyMessage')))
          : null,
        h(
          'div',
          { class: 'rw-invite-stats' },
          h('div', { class: 'rw-stat' }, h('span', { class: 'rw-stat-value num' }, pts(d.referrals?.total)), h('span', { class: 'rw-stat-label' }, R('statInvited'))),
          h('div', { class: 'rw-stat' }, h('span', { class: 'rw-stat-value num' }, pts(rewarded)), h('span', { class: 'rw-stat-label' }, R('statRewarded'))),
          h('div', { class: 'rw-stat' }, h('span', { class: 'rw-stat-value num' }, pts(rewarded * REFERRAL_POINTS.referrer)), h('span', { class: 'rw-stat-label' }, R('statEarned'))),
        ),
        h('ul', { class: 'rw-rules' }, ['rule1', 'rule2', 'rule3'].map((k) => h('li', {}, icon('check'), h('span', {}, R(k, { days: REFERRAL_DAYS, referrer: pts(REFERRAL_POINTS.referrer), referred: pts(REFERRAL_POINTS.referred) }))))),
      );

      let referredCard;
      if (d.referredBy) {
        const paid = d.referredBy.rewarded === true;
        referredCard = h(
          'section',
          { class: 'card rw-referred', 'aria-labelledby': 'rw-referred-title' },
          h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'rw-referred-title' }, icon('heart'), R('referredTitle')), h('span', { class: ['pill', paid ? 'good' : 'warn'] }, icon(paid ? 'check' : 'clock'), R(paid ? 'referredPaid' : 'referredPending'))),
          h('p', { class: 'rw-text' }, R('referredBy', { name: `@${d.referredBy.username || '?'}` })),
          paid ? null : h('p', { class: 'rw-text muted' }, R('referredPendingText', { referred: pts(REFERRAL_POINTS.referred) })),
        );
      } else if (d.canClaimReferral) {
        const btn = h('button', { type: 'submit', class: 'btn' }, icon('check'), R('redeem'));
        referredCard = h(
          'form',
          { class: 'card rw-referred', 'aria-labelledby': 'rw-referred-title', onsubmit: (e) => { e.preventDefault(); redeem(btn); } },
          h('div', { class: 'card-head' }, h('div', {}, h('h2', { class: 'card-title', id: 'rw-referred-title' }, icon('heart'), R('redeemTitle')), h('p', { class: 'card-sub' }, R('redeemSub', { days: REFERRAL_DAYS, referred: pts(REFERRAL_POINTS.referred) })))),
          h('div', { class: 'field' }, h('label', { for: 'rw-redeem' }, R('redeemLabel')), h('div', { class: 'rw-redeem-row' }, codeInput, btn), redeemError),
        );
      } else {
        referredCard = h(
          'section',
          { class: 'card rw-referred', 'aria-labelledby': 'rw-referred-title' },
          h('h2', { class: 'card-title', id: 'rw-referred-title' }, icon('heart'), R('redeemTitle')),
          h('p', { class: 'rw-text muted' }, R('referralClosed', { days: REFERRAL_DAYS })),
        );
      }

      const acc = store.selectedAccount();
      const msa = acc?.type === 'msa';
      const verifyBtn = h('button', { type: 'button', class: d.mcVerified ? 'btn sm ghost' : 'btn tonal', onclick: (e) => verify(e.currentTarget) }, icon('shieldCheck'), R(d.mcVerified ? 'verifyAgain' : 'verifyButton'));
      const verifyCard = h(
        'section',
        { class: ['card', 'rw-verify', d.mcVerified && 'done'], 'aria-labelledby': 'rw-verify-title' },
        h('div', { class: 'card-head' }, h('h2', { class: 'card-title', id: 'rw-verify-title' }, icon('shieldCheck'), R('verifyTitle')), h('span', { class: ['pill', d.mcVerified ? 'good' : 'warn'] }, icon(d.mcVerified ? 'check' : 'alert'), R(d.mcVerified ? 'verified' : 'notVerified'))),
        h('p', { class: 'rw-text' }, R(d.mcVerified ? 'verifyDoneText' : 'verifyWhy')),
        h('p', { class: 'rw-privacy' }, icon('lock'), h('span', {}, R('verifyPrivacy'))),
        h(
          'div',
          { class: 'rw-verify-actions' },
          h('span', { class: 'rw-verify-account' }, acc ? avatarImg(msa ? acc.uuid : acc.name, 32, 'rw-verify-head') : null, h('span', {}, acc ? (msa ? R('verifyAccount', { name: acc.name }) : R('verifyOffline', { name: acc.name })) : R('verifyNoAccount'))),
          msa ? verifyBtn : h('button', { type: 'button', class: 'btn tonal', onclick: () => openAccounts() }, icon('user'), R('openAccounts')),
        ),
        verifyStatus,
      );
      return h('div', { class: 'rw-invite-view' }, inviteCard, h('div', { class: 'rw-invite-side' }, referredCard, verifyCard));
    }

    // ---------- Historial ----------
    function historyLabel(r) {
      if (r.reason === 'daily') {
        const day = Date.parse(`${r.ref}T00:00:00Z`);
        return Number.isFinite(day) ? R('hist_daily', { date: fmtDate(day, { day: 'numeric', month: 'long', timeZone: 'UTC' }) }) : R('hist_dailyPlain');
      }
      if (r.reason === 'achievement') return R('hist_achievement', { name: achievementName(r.ref) });
      if (r.reason === 'shop') return r.refund ? R('hist_shopRefund', { name: itemName(r.ref.slice('refund:'.length)) }) : R('hist_shop', { name: itemName(r.ref) });
      if (r.reason === 'mission') return R(String(r.ref).endsWith(':bonus') ? 'hist_missionBonus' : 'hist_mission');
      return R(`hist_${r.reason}`);
    }

    function historyPanel(d) {
      const rows = (Array.isArray(d.history) ? d.history : []).map(historyEntry);
      if (!rows.length) return emptyState('history', R('histEmpty'), R('histEmptyText'));
      return h(
        'section',
        { class: 'card rw-history', 'aria-label': R('tab_history') },
        h('ul', { class: 'list rw-hist-list' }, rows.map((r) =>
          h(
            'li',
            { class: 'list-item rw-hist' },
            h('span', { class: ['li-icon', 'rw-hist-icon', `is-${r.reason}`], 'aria-hidden': 'true' }, icon(r.icon)),
            h('div', { class: 'li-main' }, h('div', { class: 'li-title ellipsis' }, historyLabel(r)), h('div', { class: 'li-sub', title: r.at ? `${fmtDate(r.at)} ${fmtTime(r.at)}` : null }, r.at ? fmtAgo(r.at) : '')),
            h('span', { class: ['rw-delta', 'num', r.delta < 0 ? 'neg' : 'pos'] }, formatDelta(r.delta, locale())),
          ),
        )),
        h('p', { class: 'rw-hint small' }, R('histHint')),
      );
    }

    // ---------- Premium ----------
    function premiumPanel() {
      const panel = perksPanel();
      viewCleanups.push(() => panel.destroy?.());
      return h('div', { class: 'rw-premium' }, panel);
    }

    // ---------- Pestañas ----------
    function paintPanel() {
      const d = data();
      if (!d) return;
      viewCleanups.forEach((fn) => fn());
      viewCleanups = [];
      let view;
      if (st.tab === 'shop') view = shopPanel(d);
      else if (st.tab === 'invite') view = invitePanel(d);
      else if (st.tab === 'history') view = historyPanel(d);
      else view = premiumPanel();
      // Si el foco estaba adentro del campo del código, vuelve ahí después de redibujar
      const hadFocus = document.activeElement === codeInput;
      mount(body, h('div', { class: 'rw-panel', id: 'rw-panel', role: 'tabpanel', 'aria-labelledby': `rw-tab-${st.tab}` }, view));
      if (hadFocus && codeInput.isConnected) codeInput.focus({ preventScroll: true });
    }

    function show(id, fromUser) {
      st.tab = TABS.some((x) => x.id === id) ? id : 'shop';
      tabButtons.forEach((btn) => {
        const on = btn.dataset.tab === st.tab;
        btn.setAttribute('aria-selected', String(on));
        btn.tabIndex = on ? 0 : -1;
        btn.classList.toggle('active', on);
      });
      paintPanel();
      if (fromUser) history.replaceState(null, '', `#/rewards/${st.tab}`);
    }

    // ---------- Carga ----------
    async function loadShop() {
      st.itemsError = null;
      try {
        st.items = await b.shopItems();
        registerItems(st.items); // para dibujar tambien lo del Venus Pass (pass_*)
      } catch (err) {
        st.items = null;
        st.itemsError = err?.code === 'network' ? 'network' : 'unavailable';
      }
    }

    function paintError(code) {
      mount(
        root,
        pageHead(refreshBtn),
        h('div', { class: 'notice bad', role: 'alert' }, icon('alert'), h('div', { class: 'spacer' }, R(code === 'network' ? 'loadNetwork' : 'unavailable')), h('button', { type: 'button', class: 'btn sm', onclick: (e) => reload(e.currentTarget) }, icon('refresh'), t('common.retry'))),
      );
    }

    let shell = false;
    function paintAll() {
      const s = getSummary();
      if (!alive) return;
      if (!s.data) {
        if (s.error === 'noSession') paintSignedOut();
        else if (s.error) paintError(s.error);
        shell = false;
        return;
      }
      if (!shell) {
        mount(root, pageHead(refreshBtn), hero, tabs, body);
        shell = true;
        show(st.tab, false);
      } else if (st.tab !== 'premium') paintPanel(); // Premium se actualiza solo (onPremiumChange)
      paintHero();
    }

    async function reload(btn) {
      const release = btn ? setBusy(btn) : () => {};
      st.codeFailed = false;
      try {
        await Promise.all([loadSummary({ force: true }), loadShop(), loadExtras()]);
      } finally {
        release();
      }
      paintAll();
    }

    async function loadExtras() {
      const [profile, ps, stats] = await Promise.all([
        b.rpc('profile_public', { p_user: userAtRender }).catch((err) => {
          console.warn('[rewards] perfil', err?.code || err);
          return null;
        }),
        profileStyle(),
        api.invoke('stats:summary').catch(() => null),
      ]);
      st.profile = profile && typeof profile === 'object' ? profile : null;
      st.ps = ps;
      st.stats = stats;
    }

    mount(root, pageHead(refreshBtn), h('div', { class: 'rw-hero' }, skeleton('card', { lines: 3 }), skeleton('card', { lines: 3 })), skeleton('grid', { items: 6, min: 230 }));
    cleanups.push(onSummary(() => paintAll()));
    await Promise.all([loadSummary({ force: true }), loadShop(), loadExtras()]);
    if (!alive) return done;
    paintAll();
    sweepServerAchievements().catch(() => {});

    // El "vuelve en..." del premio diario se actualiza cada minuto
    const timer = setInterval(() => {
      if (alive && shell) paintHero();
    }, 60 * 1000);
    cleanups.push(() => clearInterval(timer));
    cleanups.push(() => viewCleanups.forEach((fn) => fn()));
    return done;
  },
};
