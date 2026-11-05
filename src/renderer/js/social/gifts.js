// Regalos (3.1): "Regalar" en la tarjeta de un amigo (puntos o un cosmetico de la tienda, RPC gift_send de 0027) y
// la bandeja del que recibe: un aviso cuando points_me muestra un gift_in nuevo (o al arrancar), comparando con
// settings.rewards.lastGiftSeen y pidiendo el detalle a gifts_received.
//   openGiftDialog({ id, name, profile }) · startGiftWatch() (idempotente; lo llaman Mensajes y las tarjetas)
import { h, icon, mount, modal, ok, fail, toast, setBusy, skeleton, confirmDialog, emptyState, registerIcons } from '../ui.js';
import { t, loadNs } from '../i18n.js';
import { cloud } from '../cloud.js';
import { store } from '../store.js';
import { social } from '../social.js';
import { LIMITS, SHOP_CATALOG, validateGift, giftSentToday, registerItems } from '../features/profile-editor/model.js';
import { ensureProfileStyle, applyFrame, titleLabel, premiumChip, styledName } from './profile-style.js';
import { headImg, fetchPublicProfile, forgetPublicProfile } from './profile-ui.js';
import { newGifts, latestGiftAt, hasNewGiftIn } from './logic.js';

registerIcons({ scGift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>' });

const P = (k, vars) => t(`profile.${k}`, vars);
const errorKey = (err) => {
  const m = /\b(bad_amount|daily_limit|not_enough_points|not_friends|owned|premium_item|bad_item|blocked|target_banned)\b/.exec(String(err?.message || err?.code || ''));
  return m ? `err_gift_${m[1]}` : null;
};

async function itemLabel(id) {
  try {
    await loadNs('rewards');
    const r = await import('../features/rewards.js');
    return r.itemName(id);
  } catch {
    return id;
  }
}

async function loadShop() {
  try {
    const { data, error } = await cloud.client.from('shop_items').select('id,kind,price,premium_only,active,sort,data,source').order('sort');
    if (error) throw error;
    registerItems(data);
    // Lo del Venus Pass se gana jugando: no se regala
    const list = (data || [])
      .filter((r) => ['frame', 'name_effect', 'badge_style', 'title'].includes(r.kind) && r.active !== false && !r.premium_only && (r.source || 'shop') === 'shop')
      .map((r) => ({ id: r.id, kind: r.kind, price: r.price, premiumOnly: false, active: true, style: r.data?.style || r.data?.effect || r.data?.title || r.id.replace(/^[a-z]+_/, '') }));
    return list.length ? list : SHOP_CATALOG.filter((i) => !i.premiumOnly);
  } catch (err) {
    console.warn('[profile] shop_items:', err?.message || err);
    return SHOP_CATALOG.filter((i) => !i.premiumOnly);
  }
}

async function loadPoints() {
  try {
    const { data, error } = await cloud.client.rpc('points_me');
    if (error) throw error;
    return { balance: Number(data?.balance) || 0, sentToday: giftSentToday(data?.history) };
  } catch (err) {
    console.warn('[profile] points_me:', err?.message || err);
    return { balance: 0, sentToday: 0 };
  }
}

function itemPreview(it) {
  if (it.kind === 'frame') return applyFrame(h('span', { class: 'sc-headwrap pf-gift-head', style: { width: '36px', height: '36px' } }, headImg({ username: 'Steve' }, 36)), { equipped: { frame: it.id }, hasStyle: true });
  if (it.kind === 'title') return h('span', { class: 'pf-title', dataset: { title: it.style } }, titleLabel(it.style));
  if (it.kind === 'badge_style') return premiumChip({ premium: false, equipped: { badgeStyle: it.id }, hasStyle: true });
  if (it.kind === 'name_effect') return styledName({ displayName: 'Steve', nameStyle: { effect: it.style }, hasStyle: true }, { size: 'md', animate: false });
  return null;
}

/** Dialogo Regalar a un amigo: { id, name, profile? } (perfil publico, para marcar lo que ya tiene equipado). */
export async function openGiftDialog(friend) {
  await ensureProfileStyle();
  await loadNs('rewards').catch(() => null);
  const name = friend.name || t('social.someone');
  const body = h('div', { class: 'pf-gift' }, skeleton('card', { lines: 3, label: P('giftLoading') }));
  const sendBtn = h('button', { class: 'btn primary', type: 'button', disabled: true }, icon('scGift'), P('giftSend'));
  const d = modal({ title: P('giftTitle', { name }), subtitle: P('giftSub'), icon: 'scGift', body, footer: [h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => d.close() }, P('cancel')), sendBtn] });
  const [points, items, pub] = await Promise.all([loadPoints(), loadShop(), friend.profile ? Promise.resolve(friend.profile) : fetchPublicProfile(friend.id)]);
  if (!d.el.isConnected) return d;
  const equipped = Object.values(pub?.equipped || {});
  const st = { tab: 'points', amount: 50, item: null, ...points };
  const amount = h('input', { class: 'input num', type: 'number', min: LIMITS.giftMin, max: LIMITS.giftMax, step: 10, value: st.amount, 'aria-label': P('giftAmount') });
  const err = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const tabs = h('div', { class: 'segmented pf-gift-tabs', role: 'tablist' });
  const panel = h('div', { class: 'pf-gift-panel' });
  const info = h('div', { class: 'pf-gift-info' });
  const labels = new Map();
  for (const it of items) labels.set(it.id, await itemLabel(it.id));
  const setErr = (text) => {
    err.hidden = !text;
    mount(err, text ? [icon('alert'), h('span', {}, text)] : []);
  };
  const check = () => {
    const it = items.find((i) => i.id === st.item) || null;
    const code = validateGift({ kind: st.tab, value: st.tab === 'points' ? st.amount : st.item, balance: st.balance, sentToday: st.sentToday, item: it, ownedByTarget: equipped });
    sendBtn.disabled = Boolean(code) || (st.tab === 'item' && !st.item);
    setErr(code && (st.tab === 'points' || st.item) ? P(`err_gift_${code}`) : '');
  };
  amount.addEventListener('input', () => {
    st.amount = Math.round(Number(amount.value) || 0);
    check();
  });
  const drawTabs = () =>
    mount(
      tabs,
      ['points', 'item'].map((id) => h('button', { type: 'button', role: 'tab', class: st.tab === id ? 'active' : '', 'aria-selected': String(st.tab === id), onclick: () => ((st.tab = id), drawTabs(), drawPanel()) }, icon(id === 'points' ? 'star' : 'sparkles'), P(`giftTab_${id}`))),
    );
  const drawPanel = () => {
    if (st.tab === 'points') {
      mount(panel, h('div', { class: 'field' }, h('label', {}, P('giftAmount')), amount, h('div', { class: 'field-help' }, P('giftAmountHint'))), h('div', { class: 'chips' }, [10, 50, 100, 250, 500].map((n) => h('button', { class: 'chip', type: 'button', onclick: () => ((amount.value = String(n)), (st.amount = n), check()) }, `${n} VP`))));
    } else if (!items.length) mount(panel, emptyState('sparkles', P('giftNoItems'), ''));
    else {
      mount(
        panel,
        h('p', { class: 'field-help' }, P('giftItemHint')),
        h(
          'div',
          { class: 'pfe-radios pf-gift-items', role: 'radiogroup', 'aria-label': P('giftTab_item') },
          items.map((it) => {
            const owned = equipped.includes(it.id);
            const active = st.item === it.id;
            return h(
              'button',
              { type: 'button', role: 'radio', class: ['pfe-radio', active && 'active', owned && 'locked'], 'aria-checked': String(active), disabled: owned, title: owned ? P('giftOwned') : labels.get(it.id), onclick: () => ((st.item = it.id), drawPanel(), check()) },
              h('span', { class: 'pfe-item-art' }, itemPreview(it)),
              h('span', { class: 'pfe-radio-label' }, labels.get(it.id)),
              h('span', { class: 'pf-gift-price num' }, owned ? P('giftOwned') : `${it.price} VP`),
            );
          }),
        ),
      );
    }
    check();
  };
  const drawInfo = () => mount(info, h('span', { class: 'pill' }, icon('star'), P('giftBalance', { points: st.balance })), st.sentToday ? h('span', { class: 'pill warn' }, P('giftSentToday', { points: st.sentToday })) : null);
  drawTabs();
  drawPanel();
  drawInfo();
  mount(body, info, tabs, panel, err);
  sendBtn.addEventListener('click', async () => {
    const it = items.find((i) => i.id === st.item);
    const question = st.tab === 'points' ? P('giftConfirmPoints', { points: st.amount, name }) : P('giftConfirmItem', { item: labels.get(st.item) || st.item, name, price: it?.price ?? 0 });
    if (!(await confirmDialog(P('gift'), question, { okText: P('giftSend') }))) return;
    const release = setBusy(sendBtn);
    try {
      const { data, error } = await cloud.client.rpc('gift_send', { p_to: friend.id, p_kind: st.tab, p_value: st.tab === 'points' ? String(st.amount) : st.item });
      if (error) throw error;
      st.balance = Number(data?.balance) || 0;
      forgetPublicProfile(friend.id);
      import('../features/rewards.js').then((r) => r.loadSummary?.({ force: true })).catch(() => {});
      d.close();
      ok(P('giftSent'), P('giftSentText', { name }));
    } catch (e) {
      const key = errorKey(e);
      fail(P('giftFailed'), key ? P(key) : e);
      if (key === 'err_gift_not_enough_points' || key === 'err_gift_daily_limit') {
        Object.assign(st, await loadPoints());
        drawInfo();
        check();
      }
    } finally {
      release();
    }
  });
  return d;
}

// ---------- Bandeja del que recibe ----------
let watching = false;
let pulling = null;
let warned = false;
const lastSeen = () => store.settings?.rewards?.lastGiftSeen || null;

async function pull({ silent = false } = {}) {
  if (pulling) return pulling;
  pulling = (async () => {
    try {
      await cloud.ready();
      if (!cloud.isSignedIn()) return;
      const seen = lastSeen();
      const { data, error } = await cloud.client.rpc('gifts_received', { p_since: seen });
      if (error) throw error;
      const list = Array.isArray(data) ? data : [];
      const latest = latestGiftAt(list, seen);
      // La primera vez (sin marca) no se avisa nada viejo: solo se guarda hasta donde se vio
      const fresh = seen && !silent ? newGifts(list, seen) : [];
      if (fresh.length) {
        await ensureProfileStyle();
        for (const g of fresh.slice(-3)) {
          const from = g.from?.displayName || g.from?.username || t('social.someone');
          const text = g.kind === 'points' ? P('giftReceivedPoints', { name: from, points: g.points }) : P('giftReceivedItem', { name: from, item: await itemLabel(g.value) });
          toast('ok', P('giftReceivedTitle'), text, 8000);
        }
        import('../features/rewards.js').then((r) => r.loadSummary?.({ force: true })).catch(() => {});
      }
      if (latest && latest !== seen) await store.setSettings({ rewards: { lastGiftSeen: latest } });
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[profile] regalos:', err?.message || err);
      }
    } finally {
      pulling = null;
    }
  })();
  return pulling;
}

/** Empieza a mirar la bandeja de regalos (una sola vez por sesion de la interfaz). */
export function startGiftWatch() {
  if (watching) return;
  watching = true;
  import('../features/rewards.js')
    .then((r) => r.onSummary?.((s) => hasNewGiftIn(s?.data?.history, lastSeen()) && pull()))
    .catch(() => {});
  cloud.on?.('auth', () => setTimeout(() => pull(), 2500));
  setTimeout(() => pull(), 1500);
}
