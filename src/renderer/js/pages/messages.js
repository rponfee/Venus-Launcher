// Mensajes: amigos con presencia y lo que estan jugando, solicitudes de amistad y chat privado en tiempo real.
// Todo pasa por social.js (Supabase). Sin nube o sin sesion muestra como activarlo (Ajustes > Cuenta y nube).
// Clases con prefijo .msg- (pagina) y .sc- (piezas sociales compartidas), en styles/pages/messages.css.
import { h, icon, mount, fail, ok, toast, copyText, confirmDialog, emptyState, skeleton, setBusy, reducedMotion, fmtTime, fmtAgo, fmtDate } from '../ui.js';
import { t, locale } from '../i18n.js';
import { navigate } from '../app.js';
import { social, MAX_MESSAGE } from '../social.js';
import { displayName, activityLine, isJoinable, presenceLabel, isOnline, bannerBackground } from '../social/cosmetics.js';
import {
  headImg,
  headWithDot,
  badgeChips,
  popMenu,
  statusMenu,
  openProfile,
  openMyProfile,
  joinFriend,
  inviteToVoice,
  confirmRemoveFriend,
  confirmBlock,
} from '../social/profile-ui.js';
import { renderBody, isJumbo, openEmojiPicker, closeEmojiPicker, insertAtCursor, EMOJIS, QUICK_REACTIONS } from '../social/richtext.js';

const drafts = new Map(); // borradores por conversacion (sobreviven al cambiar de pagina)
const GROUP_MS = 5 * 60_000;
const REACTION_SET = [...QUICK_REACTIONS, ...EMOJIS.filter((e) => !QUICK_REACTIONS.includes(e))];
const CODE_RE = /^venus-?[a-z0-9]{6}$/i;
const USER_RE = /^@?[A-Za-z0-9_]{3,20}$/;

// ---------- Formatos ----------
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();

function dayKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, now)) return t('messages.today');
  if (isSameDay(d, yesterday)) return t('messages.yesterday');
  return d.toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

function shortTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (isSameDay(d, now)) return fmtTime(d);
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return t('messages.yesterday');
  if (now - d < 6 * 86400000) return d.toLocaleDateString(locale(), { weekday: 'short' });
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
}

function fullTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(locale(), { dateStyle: 'full', timeStyle: 'short' });
}

function preview(last) {
  if (!last) return '';
  return last.deleted ? t('messages.deletedShort') : String(last.body || '').replace(/\s+/g, ' ');
}

const typingDots = () => h('span', { class: 'msg-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));

export default {
  ns: ['messages', 'social'],
  css: ['pages/messages'],
  render(root, params) {
    const page = new MessagesPage(root, params[0] || null);
    page.start();
    return () => page.destroy();
  },
};

// Silencio o baneo vigente de la cuenta (social.moderation, rpc my_moderation de 0012): { kind, until } o null.
// "Permanente" en el panel de administración = 100 años: se muestra sin fecha.
const FOREVER_MS = 50 * 365 * 86400000;
function activeModeration() {
  const m = social.moderation;
  if (!m) return null;
  const live = (flag, until) => flag && (!until || Date.parse(until) > Date.now());
  const forever = (until) => !until || Date.parse(until) - Date.now() > FOREVER_MS;
  if (live(m.banned, m.bannedUntil)) return { kind: 'banned', until: forever(m.bannedUntil) ? null : m.bannedUntil };
  if (live(m.muted, m.mutedUntil)) return { kind: 'muted', until: forever(m.mutedUntil) ? null : m.mutedUntil };
  return null;
}

// =====================================================================
// Pagina
// =====================================================================
class MessagesPage {
  constructor(root, userId) {
    this.root = root;
    this.userId = userId;
    this.tab = 'chats';
    this.query = '';
    this.addOpen = false;
    this.layout = false;
    this.chat = null;
    this.els = {};
    this.offs = [];
    this.dirty = new Set();
    this.raf = 0;
  }

  start() {
    this.offs.push(
      social.on('state', () => this.render()),
      social.on('ready', () => this.render()),
      social.on('friends', () => this.schedule('list', 'tabs', 'chat')),
      social.on('requests', () => this.schedule('list', 'tabs', 'chat')),
      social.on('presence', () => this.schedule('list', 'chat')),
      social.on('profile', () => this.schedule('me')),
      social.on('status', () => this.schedule('status', 'notice')),
      social.on('outbox', () => this.schedule('status')),
      social.on('moderation', () => {
        this.schedule('mod');
        this.chat?.updateComposerState();
      }),
      social.on('chat', (e) => this.chat?.onChat(e)),
      social.on('typing', (e) => {
        this.schedule('list');
        this.chat?.onTyping(e);
      }),
    );
    this.render();
  }

  destroy() {
    this.destroyed = true;
    this.offs.forEach((off) => off());
    cancelAnimationFrame(this.raf);
    this.chat?.destroy();
    closeEmojiPicker();
    social.setActive(null);
  }

  schedule(...parts) {
    for (const p of parts) this.dirty.add(p);
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      const d = this.dirty;
      this.dirty = new Set();
      if (!this.layout || this.destroyed) return;
      if (d.has('mod')) this.renderModeration();
      if (d.has('me')) this.renderMe();
      if (d.has('status')) this.renderStatus();
      if (d.has('tabs')) this.renderTabs();
      if (d.has('list')) this.renderList();
      if (d.has('chat')) this.renderMain();
      if (d.has('notice')) this.chat?.renderNotice();
    });
  }

  render() {
    if (this.destroyed) return;
    if (social.state === 'ready') {
      if (!this.layout) this.mountLayout();
      else this.schedule('me', 'status', 'tabs', 'list', 'chat');
      return;
    }
    this.layout = false;
    this.chat?.destroy();
    this.chat = null;
    this.mountState(social.state);
  }

  head(actions) {
    return h(
      'div',
      { class: 'page-head msg-head' },
      h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('messages.title')), h('p', { class: 'page-sub' }, t('messages.subtitle'))),
      actions || null,
    );
  }

  // ---------- Estados sin chat (sin nube, sin sesion, cargando, error) ----------
  mountState(state) {
    this.root.classList.remove('msg-fill');
    if (state === 'idle' || state === 'loading') {
      this.root.classList.add('msg-fill');
      mount(this.root, this.head(), this.skeleton());
      return;
    }
    if (state === 'signedOut') {
      mount(
        this.root,
        this.head(),
        this.hero({
          title: t('messages.signInTitle'),
          text: t('messages.signInText'),
          action: h('button', { class: 'btn primary', onclick: () => navigate('settings/cloud/venus') }, icon('logIn'), t('messages.signInAction')),
        }),
      );
      return;
    }
    // La nube del launcher no está disponible o al servidor le falta el módulo social: un aviso para el usuario
    // (el detalle técnico queda en el log) y Reintentar
    if (state === 'disabled' || state === 'missingSchema') {
      mount(this.root, this.head(), h('section', { class: 'card msg-state msg-error', role: 'status' }, emptyState('clock', t('messages.serviceTitle'), t('messages.serviceText'), h('div', { class: 'row wrap msg-center' }, this.retryButton('primary')))));
      return;
    }
    // Error: que paso + como seguir + reintentar
    mount(
      this.root,
      this.head(),
      h(
        'section',
        { class: 'card msg-state msg-error', role: 'alert' },
        emptyState(
          'alert',
          t('messages.errorTitle'),
          social.error?.message || t('messages.errorText'),
          h('div', { class: 'row wrap msg-center' }, this.retryButton('primary')),
        ),
      ),
    );
  }

  retryButton(variant) {
    const btn = h('button', { class: ['btn', variant] }, icon('refresh'), t('messages.retry'));
    btn.addEventListener('click', async () => {
      const done = setBusy(btn);
      try {
        await social.retry();
      } finally {
        done();
      }
    });
    return btn;
  }

  hero({ title, text, action }) {
    const feature = (ic, ft, fx) => h('li', { class: 'msg-feature' }, h('span', { class: 'msg-feature-icon', 'aria-hidden': 'true' }, icon(ic)), h('div', {}, h('div', { class: 'msg-feature-title' }, ft), h('div', { class: 'msg-feature-text' }, fx)));
    const fakeRow = (w, dot) => h('div', { class: 'msg-art-row' }, h('span', { class: 'msg-art-head' }, h('i', { class: ['msg-art-dot', dot] })), h('span', { class: 'msg-art-lines' }, h('i', { style: { width: `${w}%` } }), h('i', { style: { width: `${w - 22}%` } })));
    return h(
      'section',
      { class: 'card msg-hero', 'aria-labelledby': 'msg-hero-title' },
      h(
        'div',
        { class: 'msg-hero-main' },
        h('div', { class: 'msg-hero-kicker' }, icon('users'), t('messages.heroKicker')),
        h('h2', { class: 'msg-hero-title', id: 'msg-hero-title' }, title),
        h('p', { class: 'msg-hero-text' }, text),
        h(
          'ul',
          { class: 'msg-features' },
          feature('message', t('messages.feat1Title'), t('messages.feat1Text')),
          feature('gamepad', t('messages.feat2Title'), t('messages.feat2Text')),
          feature('mic', t('messages.feat3Title'), t('messages.feat3Text')),
        ),
        h('div', { class: 'msg-hero-actions' }, action),
      ),
      h(
        'div',
        { class: 'msg-hero-art', 'aria-hidden': 'true' },
        h('img', { class: 'msg-hero-planet', src: 'assets/logo-256.png', alt: '' }),
        h('div', { class: 'msg-art-card' }, fakeRow(78, 'online'), fakeRow(64, 'online'), fakeRow(70, 'away'), fakeRow(52, 'offline')),
        h('div', { class: 'msg-art-bubble a' }, h('i'), h('i')),
        h('div', { class: 'msg-art-bubble b' }, h('i')),
      ),
    );
  }

  // Esqueleto con la forma real de la pagina: lista de amigos a la izquierda y una charla a la derecha
  skeleton() {
    const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
    const bubble = (side, width) => h('div', { class: ['msg-skel-bubble', side] }, side === 'theirs' ? bone('skeleton-circle', { width: '28px', height: '28px' }) : null, bone('msg-skel-b', { width }));
    return h(
      'div',
      { class: 'msg-layout' },
      h(
        'aside',
        { class: 'card msg-side msg-skel' },
        h('div', { class: 'msg-skel-top', 'aria-hidden': 'true' }, h('div', { class: 'msg-skel-me' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line', { width: '56%' }), bone('skeleton-line', { width: '38%' }))), bone('msg-skel-search')),
        skeleton('list', { rows: 6, label: t('messages.loading') }),
      ),
      h(
        'section',
        { class: 'card msg-main msg-skel', 'aria-hidden': 'true' },
        h('div', { class: 'msg-skel-head' }, bone('skeleton-icon'), h('div', { class: 'skeleton-lines' }, bone('skeleton-line', { width: '32%' }), bone('skeleton-line', { width: '20%' }))),
        h('div', { class: 'msg-skel-msgs' }, bubble('theirs', '44%'), bubble('theirs', '28%'), bubble('mine', '36%'), bubble('theirs', '52%'), bubble('mine', '24%')),
        h('div', { class: 'msg-skel-compose' }, bone('msg-skel-input')),
      ),
    );
  }

  // ---------- Layout principal ----------
  mountLayout() {
    this.layout = true;
    this.root.classList.add('msg-fill');
    const e = this.els;
    e.status = h('div', { class: 'page-actions' });
    e.me = h('div', { class: 'msg-me' });
    e.search = h('input', { class: 'input', type: 'search', placeholder: t('messages.searchPlaceholder'), 'aria-label': t('messages.search'), value: this.query });
    e.search.addEventListener('input', () => {
      this.query = e.search.value;
      this.renderList();
    });
    e.search.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        e.list.querySelector('[data-id]')?.focus();
      }
    });
    e.addBtn = h('button', { class: 'icon-btn', type: 'button', title: t('messages.addFriend'), 'aria-label': t('messages.addFriend'), 'aria-expanded': 'false', 'aria-controls': 'msg-add', onclick: () => this.toggleAdd() }, icon('userPlus'));
    e.add = h('div', { class: 'msg-add', id: 'msg-add', hidden: true });
    e.tabs = h('div', { class: 'segmented msg-tabs', role: 'tablist', 'aria-label': t('messages.friendsRegion') });
    e.tabs.addEventListener('keydown', (ev) => this.tabsKey(ev));
    e.list = h('div', { class: 'msg-list', id: 'msg-list', role: 'tabpanel' });
    e.main = h('section', { class: 'card msg-main', 'aria-label': t('messages.chatRegion') });
    e.mod = h('div', { class: 'msg-mod', hidden: true });
    mount(
      this.root,
      this.head(e.status),
      e.mod,
      h(
        'div',
        { class: 'msg-layout' },
        h('aside', { class: 'card msg-side', 'aria-label': t('messages.friendsRegion') }, e.me, h('div', { class: 'msg-tools-row' }, h('div', { class: 'input-icon msg-search' }, icon('search'), e.search), e.addBtn), e.add, e.tabs, e.list),
        e.main,
      ),
    );
    this.renderModeration();
    this.renderMe();
    this.renderStatus();
    this.renderTabs();
    this.renderList();
    if (!social.friends.length && !social.requests.incoming.length) this.toggleAdd(true, false);
    this.renderMain();
  }

  // Aviso de cuenta silenciada o suspendida (antes de que el usuario escriba)
  renderModeration() {
    const el = this.els.mod;
    if (!el) return;
    const mod = activeModeration();
    el.hidden = !mod;
    if (!mod) {
      mount(el);
      return;
    }
    const date = mod.until ? fmtDate(Date.parse(mod.until), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : null;
    const banned = mod.kind === 'banned';
    const text = banned ? (date ? t('messages.modBannedUntil', { date }) : t('messages.modBannedText')) : date ? t('messages.modMutedUntil', { date }) : t('messages.modMutedText');
    mount(el, h('div', { class: ['notice', banned && 'bad', 'msg-mod-note'], role: 'status' }, icon(banned ? 'ban' : 'micOff'), h('div', {}, h('strong', {}, t(banned ? 'messages.modBannedTitle' : 'messages.modMutedTitle')), h('div', {}, text))));
  }

  renderStatus() {
    const st = social.status;
    const map = { online: ['good', t('messages.connOnline')], connecting: ['warn', t('messages.connConnecting')], offline: ['bad', t('messages.connOffline')] };
    const [cls, label] = map[st] || map.offline;
    const pending = social.outbox.length;
    mount(
      this.els.status,
      pending ? h('span', { class: 'pill warn', title: t('messages.queuedTitle') }, icon('clock'), t('messages.queued', { count: pending })) : null,
      h('span', { class: ['pill', cls, 'msg-conn'], role: 'status' }, h('span', { class: ['msg-conn-dot', st], 'aria-hidden': 'true' }), label),
      h('button', { class: 'btn sm', type: 'button', onclick: () => openMyProfile() }, icon('palette'), t('messages.myProfile')),
    );
  }

  renderMe() {
    const me = social.me;
    const pres = social.presenceOf(social.userId);
    const name = displayName(me) || t('social.you');
    const sub = me?.status_text || presenceLabel(pres.presence);
    mount(
      this.els.me,
      h('span', { class: 'msg-me-banner', style: { background: bannerBackground(me?.banner) } }),
      h(
        'button',
        { class: 'msg-me-open', type: 'button', title: t('messages.editProfile'), onclick: () => openMyProfile() },
        headWithDot(me, pres.presence, 40),
        h('span', { class: 'msg-me-main' }, h('span', { class: 'msg-me-name ellipsis' }, name), h('span', { class: 'msg-me-sub ellipsis', title: sub }, sub)),
      ),
      h('button', { class: 'icon-btn sm msg-me-status', type: 'button', title: t('messages.changeStatus'), 'aria-label': t('messages.changeStatus'), 'aria-haspopup': 'menu', onclick: (ev) => statusMenu(ev.currentTarget) }, icon('chevronDown')),
    );
  }

  renderTabs() {
    const incoming = social.requests.incoming.length;
    const online = social.friends.filter((f) => isOnline(f.presence)).length;
    const hadFocus = this.els.tabs.contains(document.activeElement);
    const tab = (id, ic, label, extra) =>
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          id: `msg-tab-${id}`,
          title: label,
          'aria-selected': String(this.tab === id),
          'aria-controls': 'msg-list',
          tabindex: this.tab === id ? 0 : -1,
          class: this.tab === id ? 'active' : '',
          onclick: () => this.selectTab(id),
        },
        icon(ic),
        h('span', { class: 'msg-tab-label' }, label),
        extra,
      );
    mount(
      this.els.tabs,
      tab('chats', 'users', t('messages.tabFriends'), social.friends.length ? h('span', { class: 'msg-tab-count', title: t('messages.onlineCount', { count: online }) }, `${online}/${social.friends.length}`) : null),
      tab('requests', 'scInbox', t('messages.tabRequests'), incoming ? h('span', { class: 'msg-tab-badge', 'aria-label': t('messages.pendingCount', { count: incoming }) }, String(incoming)) : null),
    );
    this.els.list.setAttribute('aria-labelledby', `msg-tab-${this.tab}`);
    if (hadFocus) this.els.tabs.querySelector(`#msg-tab-${this.tab}`)?.focus();
  }

  selectTab(id) {
    this.tab = id;
    this.renderTabs();
    this.renderList();
  }

  // Flechas izquierda/derecha entre "Amigos" y "Solicitudes"
  tabsKey(ev) {
    if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft' && ev.key !== 'Home' && ev.key !== 'End') return;
    ev.preventDefault();
    const ids = ['chats', 'requests'];
    const i = ids.indexOf(this.tab);
    const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? ids.length - 1 : (i + (ev.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    this.selectTab(ids[next]);
    this.els.tabs.querySelector(`#msg-tab-${ids[next]}`)?.focus();
  }

  // ---------- Agregar amigo ----------
  toggleAdd(force, focus = true) {
    const wasOpen = this.addOpen;
    this.addOpen = typeof force === 'boolean' ? force : !this.addOpen;
    const e = this.els;
    e.addBtn.classList.toggle('active', this.addOpen);
    e.addBtn.setAttribute('aria-expanded', String(this.addOpen));
    e.add.hidden = !this.addOpen;
    // La bienvenida no repite "Agregar amigo" como accion principal mientras el formulario esta abierto
    if (wasOpen !== this.addOpen && !this.userId && this.layout) this.renderMain();
    if (!this.addOpen) return;
    const inputId = 'msg-add-input';
    const input = h('input', { class: 'input', id: inputId, placeholder: t('messages.addPlaceholder'), maxlength: 24, spellcheck: false, autocomplete: 'off', value: this.addPrefill || '' });
    this.addPrefill = '';
    const msg = h('div', { class: 'msg-add-msg', role: 'status' });
    const btn = h('button', { class: 'btn primary sm', type: 'submit' }, icon('userPlus'), t('messages.sendRequest'));
    const show = (kind, text) => {
      msg.className = `msg-add-msg ${kind}`;
      mount(msg, icon(kind === 'good' ? 'check' : 'alert'), h('span', {}, text));
      if (kind === 'bad') input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    };
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      if (msg.classList.contains('bad')) mount(msg);
    });
    const form = h(
      'form',
      {
        class: 'msg-add-form',
        onsubmit: async (ev) => {
          ev.preventDefault();
          const q = input.value.trim();
          if (!q) return input.focus();
          const done = setBusy(btn);
          try {
            const r = await social.addFriend(q);
            const name = social.nameOf(r?.user_id);
            const texts = {
              sent: t('messages.requestSent', { name }),
              accepted: t('messages.nowFriends', { name }),
              already_sent: t('messages.alreadySent', { name }),
              already_friends: t('messages.alreadyFriends', { name }),
            };
            show('good', texts[r?.result] || texts.sent);
            input.value = '';
            if (r?.result === 'accepted' || r?.result === 'already_friends') this.openUser(r.user_id);
          } catch (err) {
            show('bad', err.message);
            input.focus();
          } finally {
            done();
          }
        },
      },
      input,
      h('div', { class: 'msg-add-submit' }, btn),
    );
    input.setAttribute('aria-describedby', 'msg-add-hint');
    const code = social.me?.friend_code;
    mount(
      e.add,
      h('label', { class: 'msg-add-title', id: 'msg-add-hint', for: inputId }, t('messages.addFriendTitle')),
      form,
      msg,
      code
        ? h(
            'div',
            { class: 'msg-add-code' },
            h('span', {}, t('messages.yourCode')),
            h('span', { class: 'kbd selectable' }, code),
            h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(code, t('social.codeCopied')) }, icon('copy')),
          )
        : null,
    );
    if (focus) setTimeout(() => input.focus(), 20);
  }

  // ---------- Lista ----------
  renderList() {
    const list = this.els.list;
    const focusedId = list.contains(document.activeElement) ? document.activeElement?.dataset?.id : null;
    const top = list.scrollTop;
    mount(list, this.tab === 'requests' ? this.requestsView() : this.friendsView());
    list.scrollTop = top;
    if (focusedId) list.querySelector(`[data-id="${CSS.escape(focusedId)}"]`)?.focus();
  }

  friendsView() {
    const all = social.friends;
    if (!all.length) {
      return emptyState('users', t('messages.noFriendsTitle'), t('messages.noFriendsText'), h('button', { class: 'btn sm', type: 'button', onclick: () => this.toggleAdd(true) }, icon('userPlus'), t('messages.addFriend')));
    }
    const q = norm(this.query.trim());
    const shown = q ? all.filter((f) => norm(f.name).includes(q) || norm(f.profile?.username).includes(q)) : all;
    if (!shown.length) {
      const raw = this.query.trim();
      const canAdd = CODE_RE.test(raw) || USER_RE.test(raw);
      return h(
        'div',
        { class: 'msg-nomatch' },
        h('div', { class: 'msg-nomatch-text' }, icon('search'), h('span', {}, t('messages.noMatches', { query: raw }))),
        canAdd
          ? h(
              'button',
              {
                class: 'btn sm',
                type: 'button',
                onclick: () => {
                  this.addPrefill = raw;
                  this.toggleAdd(true);
                },
              },
              icon('userPlus'),
              h('span', { class: 'ellipsis' }, t('messages.addQuery', { query: raw })),
            )
          : null,
      );
    }
    const online = shown.filter((f) => isOnline(f.presence));
    const offline = shown.filter((f) => !isOnline(f.presence));
    return [
      online.length ? h('div', { class: 'msg-group', role: 'heading', 'aria-level': '2' }, t('messages.groupOnline', { count: online.length })) : null,
      ...online.map((f) => this.friendItem(f)),
      offline.length ? h('div', { class: 'msg-group', role: 'heading', 'aria-level': '2' }, t('messages.groupOffline', { count: offline.length })) : null,
      ...offline.map((f) => this.friendItem(f)),
    ];
  }

  subline(f) {
    if (f.typing) return { cls: 'typing', text: t('messages.typingShort'), dots: true };
    const last = f.lastMessage;
    if (f.unread && last && last.senderId !== social.userId) return { cls: 'unread', text: preview(last) };
    if (f.activity) return { cls: 'activity', icon: 'gamepad', text: activityLine(f.activity) };
    if (last) return { cls: '', text: last.senderId === social.userId ? t('messages.youPrefix', { text: preview(last) }) : preview(last) };
    if (f.statusText) return { cls: '', text: f.statusText };
    if (f.presence === 'offline' && f.lastSeen) return { cls: '', text: t('social.lastSeen', { ago: fmtAgo(f.lastSeen) }) };
    return { cls: '', text: presenceLabel(f.presence) };
  }

  friendItem(f) {
    const active = f.id === this.userId;
    const sub = this.subline(f);
    return h(
      'div',
      {
        class: ['msg-item', active && 'active', f.unread && 'has-unread', f.presence === 'offline' && 'is-offline'],
        role: 'button',
        tabindex: 0,
        dataset: { id: f.id },
        'aria-current': active ? 'true' : null,
        'aria-label': f.unread ? t('messages.itemAriaUnread', { name: f.name, count: f.unread }) : t('messages.itemAria', { name: f.name, presence: presenceLabel(f.presence) }),
        onclick: () => this.openUser(f.id),
        onkeydown: (ev) => this.itemKey(ev, () => this.openUser(f.id)),
        oncontextmenu: (ev) => {
          ev.preventDefault();
          this.friendMenu(ev.currentTarget, f);
        },
      },
      headWithDot(f.profile, f.presence, 40),
      h(
        'div',
        { class: 'msg-item-main' },
        h('div', { class: 'msg-item-top' }, h('span', { class: 'msg-item-name ellipsis', title: f.name }, f.name), badgeChips(f.profile, { compact: true, max: 2 }), f.lastAt ? h('span', { class: 'msg-item-time' }, shortTime(f.lastAt)) : null),
        h('div', { class: ['msg-item-sub', sub.cls] }, sub.dots ? typingDots() : null, sub.icon ? icon(sub.icon) : null, h('span', { class: 'ellipsis', title: sub.text }, sub.text)),
      ),
      f.unread ? h('span', { class: 'msg-unread', 'aria-hidden': 'true' }, f.unread > 99 ? '99+' : String(f.unread)) : null,
    );
  }

  itemKey(ev, open) {
    if (ev.target !== ev.currentTarget) return;
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      open();
    } else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const items = [...this.els.list.querySelectorAll('[data-id]')];
      const i = items.indexOf(ev.currentTarget);
      const next = items[i + (ev.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
      else if (ev.key === 'ArrowUp') this.els.search.focus();
    } else if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) {
      // Menu contextual con el teclado
      const f = social.friendById(ev.currentTarget.dataset.id);
      if (f) {
        ev.preventDefault();
        this.friendMenu(ev.currentTarget, f);
      }
    }
  }

  friendMenu(anchor, f) {
    popMenu(anchor, [
      { label: t('messages.openChat'), icon: 'message', run: () => this.openUser(f.id) },
      { label: t('messages.viewProfile'), icon: 'user', run: () => openProfile(f.id) },
      isJoinable(f.activity) ? { label: t('social.join'), icon: 'play', run: () => joinFriend(f) } : null,
      { label: t('social.inviteVoice'), icon: 'mic', run: () => inviteToVoice(f) },
      { label: t('social.remove'), icon: 'scUserMinus', danger: true, run: () => confirmRemoveFriend(f) },
      { label: t('social.block'), icon: 'ban', danger: true, run: () => confirmBlock(f) },
    ]);
  }

  requestsView() {
    const { incoming, outgoing } = social.requests;
    const blocked = social.blocked;
    if (!incoming.length && !outgoing.length && !blocked.length) {
      return emptyState('scInbox', t('messages.noRequestsTitle'), t('messages.noRequestsText'), h('button', { class: 'btn sm', type: 'button', onclick: () => this.toggleAdd(true) }, icon('userPlus'), t('messages.addFriend')));
    }
    const guard = (fn, done) => async (ev) => {
      ev.stopPropagation();
      const btn = ev.currentTarget;
      btn.disabled = true;
      try {
        await fn();
        if (done) ok(done);
      } catch (err) {
        fail(t('social.actionFailed'), err);
        btn.disabled = false;
      }
    };
    const item = (r, actions) => {
      const sub = t('messages.reqSub', { user: r.profile?.username || '?', ago: fmtAgo(Date.parse(r.at)) });
      return h(
        'div',
        { class: 'msg-req', role: 'button', tabindex: 0, dataset: { id: r.id }, 'aria-label': r.name, onclick: () => openProfile(r.id), onkeydown: (ev) => this.itemKey(ev, () => openProfile(r.id)) },
        headImg(r.profile, 40),
        h('div', { class: 'msg-item-main' }, h('div', { class: 'msg-item-name ellipsis', title: r.name }, r.name), h('div', { class: 'msg-item-sub' }, h('span', { class: 'ellipsis', title: sub }, sub))),
        h('div', { class: 'msg-req-actions' }, actions),
      );
    };
    const btn = (ic, label, cls, run) => h('button', { class: ['icon-btn', 'sm', cls], type: 'button', title: label, 'aria-label': label, onclick: run }, icon(ic));
    const group = (text) => h('div', { class: 'msg-group', role: 'heading', 'aria-level': '2' }, text);
    return [
      incoming.length ? group(t('messages.incoming', { count: incoming.length })) : null,
      ...incoming.map((r) =>
        item(r, [
          btn('check', t('social.accept'), 'msg-ok', guard(() => social.acceptRequest(r.id), t('messages.nowFriends', { name: r.name }))),
          btn('x', t('social.decline'), 'danger', guard(() => social.declineRequest(r.id))),
        ]),
      ),
      outgoing.length ? group(t('messages.outgoing', { count: outgoing.length })) : null,
      ...outgoing.map((r) => item(r, [btn('x', t('social.cancelRequest'), 'danger', guard(() => social.cancelRequest(r.id)))])),
      blocked.length ? group(t('messages.blockedList', { count: blocked.length })) : null,
      ...blocked.map((r) => item(r, [h('button', { class: 'btn sm', type: 'button', onclick: guard(() => social.unblockUser(r.id), t('messages.unblocked', { name: r.name })) }, t('social.unblock'))])),
    ];
  }

  // ---------- Panel derecho ----------
  openUser(userId) {
    if (!userId) return;
    if (this.userId === userId && this.chat) {
      this.chat.focus();
      return;
    }
    this.userId = userId;
    history.replaceState(null, '', `#/messages/${encodeURIComponent(userId)}`);
    this.renderList();
    this.renderMain();
  }

  closeChat() {
    this.userId = null;
    history.replaceState(null, '', '#/messages');
    social.setActive(null);
    this.renderList();
    this.renderMain();
  }

  renderMain() {
    if (!this.layout) return;
    if (!this.userId) {
      this.chat?.destroy();
      this.chat = null;
      mount(this.els.main, this.welcome());
      return;
    }
    const isFriend = social.isFriend(this.userId);
    if (this.chat && this.chat.userId === this.userId && this.chat.wasFriend === isFriend) {
      this.chat.refresh();
      return;
    }
    this.chat?.destroy();
    this.chat = new ChatView(this, this.userId);
    mount(this.els.main, this.chat.el);
    this.chat.start();
  }

  welcome() {
    const me = social.me;
    const code = me?.friend_code;
    return h(
      'div',
      { class: 'msg-welcome' },
      h('div', { class: 'msg-welcome-art', 'aria-hidden': 'true' }, h('img', { src: 'assets/logo-256.png', alt: '', class: 'msg-welcome-planet' }), h('span', { class: 'msg-orbit a' }, icon('message')), h('span', { class: 'msg-orbit b' }, icon('gamepad')), h('span', { class: 'msg-orbit c' }, icon('heart'))),
      h('h2', { class: 'msg-welcome-title' }, social.friends.length ? t('messages.welcomeTitle') : t('messages.welcomeTitleNew')),
      h('p', { class: 'msg-welcome-text' }, social.friends.length ? t('messages.welcomeText') : t('messages.welcomeTextNew')),
      code
        ? h(
            'div',
            { class: 'msg-code' },
            h('span', { class: 'msg-code-label' }, t('messages.yourCode')),
            h('span', { class: 'msg-code-value selectable' }, code),
            h('button', { class: 'icon-btn sm', type: 'button', title: t('social.copyCode'), 'aria-label': t('social.copyCode'), onclick: () => copyText(code, t('social.codeCopied')) }, icon('copy')),
          )
        : null,
      h(
        'div',
        { class: 'row wrap msg-welcome-actions' },
        h('button', { class: ['btn', !this.addOpen && 'primary'], type: 'button', onclick: () => this.toggleAdd(true) }, icon('userPlus'), t('messages.addFriend')),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => openMyProfile() }, icon('palette'), t('messages.customizeProfile')),
      ),
    );
  }
}

// =====================================================================
// Conversacion con un amigo
// =====================================================================
class ChatView {
  constructor(page, userId) {
    this.page = page;
    this.userId = userId;
    this.wasFriend = social.isFriend(userId);
    this.chatId = null;
    this.replyTo = null;
    this.editing = null;
    this.unreadFrom = null;
    this.rows = new Map();
    this.newBelow = 0;
    this.mounted = false;
    this.el = h('div', { class: 'msg-chat' });
    this.headEl = h('div', { class: 'msg-chat-head' });
    this.noticeEl = h('div', { class: 'msg-chat-notice', role: 'status', hidden: true });
    this.scroller = h('div', { class: 'msg-scroll', role: 'region', 'aria-label': t('messages.history'), tabindex: 0 });
    this.list = h('div', { class: 'msg-msgs' });
    this.jump = h('button', { class: 'msg-jump', type: 'button', hidden: true, onclick: () => this.scrollToBottom(true) });
    this.typingEl = h('div', { class: 'msg-typing' });
    this.announcer = h('div', { class: 'sr-only', 'aria-live': 'polite' }); // lectores de pantalla: solo los mensajes nuevos
    this.composer = h('div', { class: 'msg-composer' });
    this.scroller.append(this.list);
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    // Si el area de mensajes cambia de tamaño (respuesta, textarea que crece, ventana) y estaba al final, sigue al final.
    this.stick = true;
    this.resizer = new ResizeObserver(() => {
      if (this.stick && this.mounted) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    this.resizer.observe(this.scroller);
  }

  friend() {
    return social.friendById(this.userId);
  }

  profile() {
    return this.friend()?.profile || social.profileOf(this.userId) || { id: this.userId };
  }

  name() {
    return this.friend()?.name || displayName(this.profile()) || t('social.someone');
  }

  async start() {
    this.renderHead();
    if (!this.wasFriend) {
      this.renderNotFriend();
      return;
    }
    mount(this.el, this.headEl, this.loadingView());
    try {
      this.chatId = social.chatIdFor(this.userId) || (await social.ensureChat(this.userId));
      if (this.destroyed) return;
      const chat = social.chat(this.chatId);
      const myRead = chat?.myLastRead || null;
      const hadUnread = chat?.unread || 0;
      social.setActive(this.userId);
      await social.loadMessages(this.chatId);
      if (this.destroyed) return;
      if (hadUnread && myRead) {
        const first = chat.messages.find((m) => m.sender_id !== social.userId && !m._local && Date.parse(m.created_at) > Date.parse(myRead));
        this.unreadFrom = first?.id || null;
      }
      this.mountChat();
      this.renderMessages('open');
      social.markRead(this.chatId);
    } catch (err) {
      if (this.destroyed) return;
      mount(
        this.el,
        this.headEl,
        h('div', { class: 'msg-chat-empty', role: 'alert' }, emptyState('alert', t('messages.chatErrorTitle'), err.message, h('button', { class: 'btn primary', type: 'button', onclick: () => this.start() }, icon('refresh'), t('messages.retry')))),
      );
    }
  }

  // Mientras carga la conversacion: globos fantasma con la forma de una charla
  loadingView() {
    const bone = (cls, style) => h('span', { class: `skeleton ${cls}`, style });
    const bubble = (side, width) => h('div', { class: ['msg-skel-bubble', side] }, side === 'theirs' ? bone('skeleton-circle', { width: '28px', height: '28px' }) : null, bone('msg-skel-b', { width }));
    return h(
      'div',
      { class: 'msg-loading', role: 'status', 'aria-busy': 'true' },
      h('span', { class: 'sr-only' }, t('messages.loadingChat')),
      h('div', { class: 'msg-skel-msgs', 'aria-hidden': 'true' }, bubble('theirs', '42%'), bubble('mine', '34%'), bubble('theirs', '56%'), bubble('theirs', '30%'), bubble('mine', '46%')),
    );
  }

  destroy() {
    this.destroyed = true;
    this.resizer.disconnect();
    closeEmojiPicker();
    if (this.chatId && this.input) {
      const v = this.editing ? this.savedDraft || '' : this.input.value;
      if (v.trim()) drafts.set(this.chatId, v);
      else drafts.delete(this.chatId);
    }
  }

  focus() {
    this.input?.focus();
  }

  refresh() {
    this.renderHead();
    if (this.mounted) {
      this.renderNotice();
      this.updateComposerState();
    } else if (!this.wasFriend) this.renderNotFriend();
  }

  // ---------- Cabecera ----------
  renderHead() {
    const f = this.friend();
    const profile = this.profile();
    const name = this.name();
    // no rehacer la cabecera si no cambio nada visible (conserva el foco del teclado)
    const key = JSON.stringify([name, Boolean(f), f?.presence, f?.activity, f?.statusText, f?.presence === 'offline' ? f?.lastSeen : 0, profile.banner, profile.badges, profile.username, profile.mc_name, profile.mc_uuid]);
    if (key === this.headKey) return;
    this.headKey = key;
    this.headEl.style.setProperty('--msg-banner', bannerBackground(profile.banner));
    let sub;
    if (f?.activity) {
      sub = h('div', { class: 'msg-chat-sub activity', title: activityLine(f.activity) }, icon('gamepad'), h('span', { class: 'ellipsis' }, activityLine(f.activity)));
    } else if (f) {
      const label = f.presence === 'offline' && f.lastSeen ? t('social.lastSeen', { ago: fmtAgo(f.lastSeen) }) : presenceLabel(f.presence);
      sub = h('div', { class: 'msg-chat-sub' }, h('span', { class: 'msg-chat-presence' }, label), f.statusText ? h('span', { class: 'msg-chat-statustext ellipsis', title: f.statusText }, f.statusText) : null);
    } else {
      sub = h('div', { class: 'msg-chat-sub' }, profile.username ? `@${profile.username}` : '');
    }
    const iconBtn = (ic, label, run, extra = {}) => h('button', { class: 'icon-btn sm', type: 'button', title: extra.title || label, 'aria-label': label, 'aria-haspopup': extra.popup || null, disabled: extra.disabled, onclick: (ev) => run(ev.currentTarget) }, icon(ic));
    mount(
      this.headEl,
      h('button', { class: 'icon-btn sm msg-back', type: 'button', title: t('messages.closeChat'), 'aria-label': t('messages.closeChat'), onclick: () => this.page.closeChat() }, icon('chevronLeft')),
      h(
        'button',
        { class: 'msg-chat-who', type: 'button', title: t('messages.viewProfile'), onclick: () => openProfile(this.userId) },
        headWithDot(profile, f ? f.presence : null, 42),
        h('div', { class: 'msg-chat-titles' }, h('div', { class: 'msg-chat-name' }, h('span', { class: 'ellipsis', title: name }, name), badgeChips(profile, { compact: true, max: 4 })), sub),
      ),
      h(
        'div',
        { class: 'msg-chat-actions' },
        // Unirse al servidor del amigo es "jugar": verde, como su linea de actividad
        f && isJoinable(f.activity)
          ? h('button', { class: 'btn tonal sm msg-join', type: 'button', title: t('messages.joinTitle', { address: f.activity.address }), 'aria-label': t('messages.joinTitle', { address: f.activity.address }), onclick: () => joinFriend(f) }, icon('play'), h('span', { class: 'msg-lbl' }, t('social.join')))
          : null,
        f ? iconBtn('mic', t('social.inviteVoice'), () => inviteToVoice(f), { disabled: f.presence === 'offline', title: f.presence === 'offline' ? t('social.friendOffline') : t('social.inviteVoice') }) : null,
        iconBtn('user', t('messages.viewProfile'), () => openProfile(this.userId)),
        f
          ? iconBtn(
              'more',
              t('messages.more'),
              (anchor) =>
                popMenu(anchor, [
                  { label: t('messages.viewProfile'), icon: 'user', run: () => openProfile(this.userId) },
                  { label: t('social.remove'), icon: 'scUserMinus', danger: true, run: () => confirmRemoveFriend(f) },
                  { label: t('social.block'), icon: 'ban', danger: true, run: () => confirmBlock(f) },
                ]),
              { popup: 'menu' },
            )
          : null,
      ),
    );
  }

  renderNotice() {
    if (!this.mounted) return;
    const offline = social.status === 'offline';
    this.noticeEl.hidden = !offline;
    mount(this.noticeEl, offline ? [icon('wifiOff'), h('span', {}, t('messages.offlineNotice'))] : []);
  }

  // Sin amistad (solicitud pendiente, bloqueado o desconocido).
  renderNotFriend() {
    const incoming = social.requests.incoming.find((r) => r.id === this.userId);
    const outgoing = social.requests.outgoing.find((r) => r.id === this.userId);
    const profile = social.profileOf(this.userId);
    const name = this.name();
    const act = (fn, done) => async (ev) => {
      const release = setBusy(ev.currentTarget);
      try {
        await fn();
        if (done) ok(done);
      } catch (err) {
        fail(t('social.actionFailed'), err);
        release();
      }
    };
    let body;
    if (incoming) {
      body = [
        h('div', { class: 'msg-empty-title' }, t('messages.wantsToBeFriends', { name })),
        h('div', { class: 'msg-empty-text' }, t('messages.wantsToBeFriendsText')),
        h(
          'div',
          { class: 'row wrap msg-center' },
          h('button', { class: 'btn ghost', type: 'button', onclick: act(() => social.declineRequest(this.userId)) }, icon('x'), t('social.decline')),
          h('button', { class: 'btn primary', type: 'button', onclick: act(() => social.acceptRequest(this.userId), t('messages.nowFriends', { name })) }, icon('check'), t('social.accept')),
        ),
      ];
    } else if (outgoing) {
      body = [
        h('div', { class: 'msg-empty-title' }, t('messages.requestPending', { name })),
        h('div', { class: 'msg-empty-text' }, t('messages.requestPendingText')),
        h('div', { class: 'row msg-center' }, h('button', { class: 'btn ghost', type: 'button', onclick: act(() => social.cancelRequest(this.userId)) }, icon('x'), t('social.cancelRequest'))),
      ];
    } else if (profile) {
      body = [h('div', { class: 'msg-empty-title' }, t('messages.notFriendTitle', { name })), h('div', { class: 'msg-empty-text' }, t('messages.notFriendText'))];
    } else {
      body = [h('div', { class: 'msg-empty-title' }, t('messages.unknownUserTitle')), h('div', { class: 'msg-empty-text' }, t('messages.unknownUserText'))];
    }
    mount(this.el, this.headEl, h('div', { class: 'msg-chat-empty' }, profile ? headImg(profile, 72, 'msg-empty-head') : h('div', { class: 'msg-empty-icon', 'aria-hidden': 'true' }, icon('user')), ...body));
  }

  // ---------- Mensajes ----------
  mountChat() {
    this.mounted = true;
    this.buildComposer();
    mount(this.el, this.headEl, this.noticeEl, h('div', { class: 'msg-scroll-wrap' }, this.scroller, this.jump), this.typingEl, this.composer, this.announcer);
    this.renderNotice();
    this.renderTyping();
  }

  sameGroup(a, b) {
    if (!a || !b || a.sender_id !== b.sender_id) return false;
    if (b.id === this.unreadFrom || dayKey(a.created_at) !== dayKey(b.created_at)) return false;
    return Date.parse(b.created_at) - Date.parse(a.created_at) < GROUP_MS;
  }

  renderMessages(mode = 'keep') {
    const chat = social.chat(this.chatId);
    if (!chat || !this.mounted) return;
    const sc = this.scroller;
    const near = this.isNearBottom();
    const fromBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    const top = sc.scrollTop;
    const frag = document.createDocumentFragment();
    this.rows.clear();
    const msgs = chat.messages;
    if (chat.hasMore) {
      frag.append(h('div', { class: 'msg-older' }, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => this.loadOlder() }, icon('history'), t('messages.loadOlder'))));
    } else if (msgs.length) {
      frag.append(h('div', { class: 'msg-start' }, headImg(this.profile(), 56), h('div', { class: 'msg-start-title' }, this.name()), h('div', { class: 'msg-start-text' }, t('messages.startOfChat', { name: this.name() }))));
    }
    let lastDay = null;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const day = dayKey(m.created_at);
      if (day !== lastDay) {
        frag.append(h('div', { class: 'msg-day', role: 'separator' }, h('span', {}, dayLabel(m.created_at))));
        lastDay = day;
      }
      if (m.id === this.unreadFrom) frag.append(h('div', { class: 'msg-new', role: 'separator' }, h('span', {}, t('messages.newMessages'))));
      frag.append(this.messageEl(m, !this.sameGroup(msgs[i - 1], m), !this.sameGroup(m, msgs[i + 1])));
    }
    if (!msgs.length) frag.append(this.emptyChat());
    mount(this.list, frag);
    if (mode === 'open') {
      const marker = this.list.querySelector('.msg-new');
      if (marker) sc.scrollTop = Math.max(0, marker.offsetTop - sc.clientHeight / 3);
      else this.scrollToBottom();
    } else if (mode === 'older') sc.scrollTop = sc.scrollHeight - sc.clientHeight - fromBottom;
    else if (mode === 'bottom' || near) this.scrollToBottom();
    else sc.scrollTop = top;
    this.stick = this.isNearBottom();
  }

  emptyChat() {
    return h(
      'div',
      { class: 'msg-empty-chat' },
      headImg(this.profile(), 64, 'msg-empty-head'),
      h('div', { class: 'msg-empty-title' }, t('messages.emptyChatTitle', { name: this.name() })),
      h('div', { class: 'msg-empty-text' }, t('messages.emptyChatText')),
      h('button', { class: 'btn sm', type: 'button', onclick: () => this.send('👋') }, h('span', { class: 'msg-wave', 'aria-hidden': 'true' }, '👋'), t('messages.wave')),
    );
  }

  messageEl(m, first, last) {
    const mine = m.sender_id === social.userId;
    const local = m._local || null;
    const row = h('div', {
      class: ['msg-row', mine ? 'mine' : 'theirs', first && 'first', last && 'last', local && `is-${local}`, m.deleted && 'is-deleted'],
      dataset: { id: m.id, first: first ? '1' : '', last: last ? '1' : '' },
    });
    const meta = h(
      'span',
      { class: 'msg-meta' },
      m.edited_at && !m.deleted ? h('span', { class: 'msg-edited', title: fullTime(m.edited_at) }, t('messages.edited')) : null,
      h('time', { datetime: m.created_at, title: fullTime(m.created_at) }, fmtTime(m.created_at)),
      mine && !m.deleted ? this.receiptEl(m) : null,
    );
    let bubble;
    if (m.deleted) bubble = h('div', { class: 'msg-bubble deleted' }, icon('ban'), h('span', { class: 'msg-text' }, t('messages.deletedMessage')), meta);
    else {
      const keys = local ? null : mine ? 'R E' : 'R';
      if (isJumbo(m.body)) bubble = h('div', { class: 'msg-bubble jumbo', tabindex: 0, 'aria-keyshortcuts': keys }, h('span', { class: 'msg-jumbo' }, m.body), meta);
      else bubble = h('div', { class: 'msg-bubble', tabindex: 0, 'aria-keyshortcuts': keys }, m.reply_to ? this.quoteEl(m.reply_to) : null, h('span', { class: 'msg-text' }, renderBody(m.body)), meta);
    }
    bubble.addEventListener('dblclick', (ev) => {
      if (ev.target.closest('a, button') || m.deleted || local) return;
      this.startReply(m);
    });
    // Con el teclado: R responde y E edita (los mios), sin salir del globo
    bubble.addEventListener('keydown', (ev) => {
      if (ev.target !== bubble || m.deleted || local || ev.ctrlKey || ev.altKey || ev.metaKey) return;
      const k = ev.key.toLowerCase();
      if (k === 'r') {
        ev.preventDefault();
        this.startReply(m);
      } else if (k === 'e' && mine) {
        ev.preventDefault();
        this.startEdit(m);
      }
    });
    const reacts = m.deleted ? [] : social.reactionsOf(this.chatId, m.id);
    const col = h(
      'div',
      { class: 'msg-col' },
      bubble,
      reacts.length
        ? h(
            'div',
            { class: 'msg-reacts' },
            reacts.map((r) =>
              h(
                'button',
                {
                  class: ['msg-react', r.mine && 'mine'],
                  type: 'button',
                  title: r.names.join(', '),
                  'aria-pressed': String(r.mine),
                  'aria-label': t('messages.reactionAria', { emoji: r.emoji, count: r.count }),
                  onclick: () => this.react(m, r.emoji),
                },
                h('span', { class: 'msg-react-emoji' }, r.emoji),
                h('span', { class: 'msg-react-n' }, String(r.count)),
              ),
            ),
          )
        : null,
      local === 'failed'
        ? h(
            'div',
            { class: 'msg-failed', role: 'alert' },
            icon('alert'),
            h('span', { class: 'ellipsis', title: m._error || '' }, m._error || t('messages.notSent')),
            h('button', { class: 'msg-linkbtn', type: 'button', onclick: () => social.retryMessage(m.id) }, t('messages.retry')),
            h('button', { class: 'msg-linkbtn', type: 'button', onclick: () => social.discardMessage(this.chatId, m.id) }, t('messages.discard')),
          )
        : null,
    );
    const gutter = mine ? null : h('div', { class: 'msg-gutter' }, last ? headImg(this.profile(), 28) : null);
    row.append(...[gutter, col, m.deleted || local === 'pending' ? null : this.toolsEl(m, mine)].filter(Boolean));
    this.rows.set(m.id, row);
    return row;
  }

  receiptEl(m) {
    if (m._local === 'pending') return h('span', { class: 'msg-receipt pending', role: 'img', title: t('messages.sending'), 'aria-label': t('messages.sending') }, icon('clock'));
    if (m._local === 'failed') return h('span', { class: 'msg-receipt failed', role: 'img', title: t('messages.notSent'), 'aria-label': t('messages.notSent') }, icon('alert'));
    const read = social.isRead(this.chatId, m);
    const label = read ? t('messages.read') : t('messages.sent');
    return h('span', { class: ['msg-receipt', read && 'read'], role: 'img', title: label, 'aria-label': label }, icon(read ? 'scCheckCheck' : 'check'));
  }

  quoteEl(id) {
    const q = social.quoted(this.chatId, id);
    const who = q ? (q.sender_id === social.userId ? t('social.you') : this.name()) : '';
    const text = !q ? t('messages.quoteMissing') : q.deleted ? t('messages.deletedMessage') : String(q.body || '').replace(/\s+/g, ' ').slice(0, 140);
    return h(
      'button',
      {
        class: 'msg-quote',
        type: 'button',
        title: t('messages.goToMessage'),
        onclick: (ev) => {
          ev.stopPropagation();
          this.scrollToMessage(id);
        },
      },
      who ? h('span', { class: 'msg-quote-name' }, who) : null,
      h('span', { class: 'msg-quote-text' }, text),
    );
  }

  toolsEl(m, mine) {
    const local = Boolean(m._local);
    const btn = (ic, label, run, cls) =>
      h(
        'button',
        {
          class: ['msg-tool', cls],
          type: 'button',
          title: label,
          'aria-label': label,
          onclick: (ev) => {
            ev.stopPropagation();
            run(ev.currentTarget);
          },
        },
        icon(ic),
      );
    return h(
      'div',
      { class: 'msg-tools', role: 'toolbar', 'aria-label': t('messages.messageActions') },
      local ? null : btn('scSmilePlus', t('messages.react'), (anchor) => this.reactPicker(m, anchor)),
      local ? null : btn('scReply', t('messages.reply'), () => this.startReply(m)),
      mine && !local ? btn('edit', t('messages.edit'), () => this.startEdit(m)) : null,
      btn('copy', t('messages.copy'), () => copyText(m.body, t('messages.copied'))),
      mine ? btn('trash', t('messages.delete'), () => this.confirmDelete(m), 'danger') : null,
    );
  }

  updateRow(id) {
    const old = this.rows.get(id);
    const m = social.chat(this.chatId)?.byId.get(id);
    if (!old || !m || old.classList.contains('is-pending') || old.classList.contains('is-failed') !== (m._local === 'failed')) return false;
    if (m._local === 'pending') return false;
    const near = this.isNearBottom();
    const el = this.messageEl(m, old.dataset.first === '1', old.dataset.last === '1');
    old.replaceWith(el);
    if (near) this.scrollToBottom();
    return true;
  }

  updateReceipts() {
    const chat = social.chat(this.chatId);
    if (!chat) return;
    for (const m of chat.messages) {
      if (m.sender_id !== social.userId || m.deleted) continue;
      const old = this.rows.get(m.id)?.querySelector('.msg-receipt');
      if (old) old.replaceWith(this.receiptEl(m));
    }
  }

  onChat(e) {
    if (!this.mounted || !this.chatId || e.chatId !== this.chatId) return;
    switch (e.kind) {
      case 'insert': {
        const mine = e.message?.sender_id === social.userId;
        const near = this.isNearBottom();
        this.renderMessages(mine ? 'bottom' : 'keep');
        if (!mine && !near) this.bumpNew();
        if (!mine && e.message && !e.message.deleted) this.announcer.textContent = t('messages.announce', { name: this.name(), text: e.message.body });
        break;
      }
      case 'update':
      case 'reaction':
        if (!this.updateRow(e.message?.id || e.messageId)) this.renderMessages('keep');
        break;
      case 'read':
        this.updateReceipts();
        break;
      case 'older':
        this.renderMessages('older');
        break;
      default:
        this.renderMessages('keep');
    }
  }

  onTyping(e) {
    if (e.chatId === this.chatId) this.renderTyping();
  }

  renderTyping() {
    const on = Boolean(this.chatId && social.isTyping(this.chatId));
    this.typingEl.classList.toggle('on', on);
    mount(this.typingEl, on ? [typingDots(), h('span', {}, t('messages.typingName', { name: this.name() }))] : []);
  }

  // ---------- Scroll ----------
  isNearBottom() {
    const sc = this.scroller;
    return sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90;
  }

  scrollToBottom(smooth = false) {
    const sc = this.scroller;
    sc.scrollTo({ top: sc.scrollHeight, behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' });
    this.stick = true;
    this.newBelow = 0;
    this.jump.hidden = true;
  }

  bumpNew() {
    this.newBelow += 1;
    this.drawJump();
  }

  drawJump() {
    this.jump.hidden = false;
    mount(this.jump, icon('scArrowDown'), h('span', { class: 'num' }, this.newBelow ? t('messages.newBelow', { count: this.newBelow }) : t('messages.jumpLatest')));
  }

  onScroll() {
    const sc = this.scroller;
    this.stick = this.isNearBottom();
    if (sc.scrollTop < 120) this.loadOlder();
    if (this.stick) {
      this.newBelow = 0;
      this.jump.hidden = true;
    } else if (this.jump.hidden && sc.scrollHeight - sc.scrollTop - sc.clientHeight > 480) this.drawJump();
  }

  async loadOlder() {
    const chat = social.chat(this.chatId);
    if (!chat?.hasMore || chat.loadingOlder || this.loadingOlder) return;
    this.loadingOlder = true;
    const btn = this.list.querySelector('.msg-older .btn');
    const done = setBusy(btn);
    try {
      await social.loadOlder(this.chatId);
    } catch (err) {
      fail(t('messages.loadFailed'), err);
    } finally {
      done();
      this.loadingOlder = false;
    }
  }

  scrollToMessage(id) {
    const row = this.rows.get(id);
    if (!row) {
      toast('info', t('messages.quoteNotLoaded'), t('messages.quoteNotLoadedText'));
      return;
    }
    const sc = this.scroller;
    const top = Math.max(0, row.offsetTop - sc.clientHeight / 2 + row.offsetHeight / 2);
    sc.scrollTo({ top, behavior: reducedMotion() ? 'auto' : 'smooth' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
    row.querySelector('.msg-bubble')?.focus({ preventScroll: true });
  }

  // ---------- Acciones ----------
  react(m, emoji) {
    social.toggleReaction(this.chatId, m.id, emoji).catch((err) => fail(t('messages.reactFailed'), err));
  }

  reactPicker(m, anchor) {
    openEmojiPicker(anchor, (emoji) => this.react(m, emoji), { label: t('messages.react'), set: REACTION_SET });
  }

  startReply(m) {
    if (this.editing) this.cancelContext();
    this.replyTo = m;
    this.renderContext();
    this.input?.focus();
  }

  startEdit(m) {
    if (!this.input) return;
    if (!this.editing) this.savedDraft = this.input.value;
    this.replyTo = null;
    this.editing = m;
    this.input.value = m.body;
    this.renderContext();
    this.autoGrow();
    this.updateCounter();
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  cancelContext() {
    if (this.editing && this.input) {
      this.input.value = this.savedDraft || '';
      this.savedDraft = '';
      this.autoGrow();
      this.updateCounter();
    }
    this.editing = null;
    this.replyTo = null;
    this.renderContext();
  }

  renderContext() {
    const m = this.editing || this.replyTo;
    if (!this.ctx) return;
    this.ctx.hidden = !m;
    this.composer.classList.toggle('editing', Boolean(this.editing));
    if (!m) {
      mount(this.ctx);
      return;
    }
    const who = m.sender_id === social.userId ? t('social.you') : this.name();
    const text = String(m.body || '').replace(/\s+/g, ' ');
    mount(
      this.ctx,
      icon(this.editing ? 'edit' : 'scReply'),
      h('div', { class: 'msg-context-main' }, h('div', { class: 'msg-context-title' }, this.editing ? t('messages.editing') : t('messages.replyingTo', { name: who })), h('div', { class: 'msg-context-text ellipsis', title: text }, text)),
      h('button', { class: 'icon-btn sm', type: 'button', title: t('messages.cancelContext'), 'aria-label': t('messages.cancelContext'), onclick: () => this.cancelContext() }, icon('x')),
    );
  }

  async confirmDelete(m) {
    if (m._local) {
      social.discardMessage(this.chatId, m.id);
      return;
    }
    if (!(await confirmDialog(t('messages.deleteTitle'), t('messages.deleteConfirm'), { okText: t('messages.delete'), danger: true }))) return;
    try {
      await social.deleteMessage(this.chatId, m.id);
    } catch (err) {
      fail(t('messages.deleteFailed'), err);
    }
  }

  // ---------- Escribir ----------
  buildComposer() {
    const name = this.name();
    this.ctx = h('div', { class: 'msg-context', role: 'status', hidden: true });
    this.input = h('textarea', { class: 'msg-input', rows: 1, maxlength: MAX_MESSAGE, placeholder: t('messages.placeholder', { name }), 'aria-label': t('messages.placeholder', { name }) });
    this.input.value = drafts.get(this.chatId) || '';
    this.counter = h('span', { class: 'msg-counter', 'aria-live': 'polite' });
    this.emojiBtn = h(
      'button',
      { class: 'icon-btn msg-emoji-btn', type: 'button', title: t('messages.emoji'), 'aria-label': t('messages.emoji'), 'aria-haspopup': 'dialog', onclick: () => openEmojiPicker(this.emojiBtn, (e) => insertAtCursor(this.input, e), { label: t('messages.emoji') }) },
      icon('smile'),
    );
    this.sendBtn = h('button', { class: 'btn primary msg-send', type: 'button', title: t('messages.send'), 'aria-label': t('messages.send'), onclick: () => this.submit() }, icon('send'));
    this.input.addEventListener('input', () => {
      this.autoGrow();
      this.updateCounter();
      this.updateSendState();
      if (!this.editing) {
        if (this.input.value.trim()) social.sendTyping(this.chatId);
        if (this.input.value.trim()) drafts.set(this.chatId, this.input.value);
        else drafts.delete(this.chatId);
      }
    });
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        this.submit();
      } else if (ev.key === 'Escape' && (this.replyTo || this.editing)) {
        ev.preventDefault();
        ev.stopPropagation();
        this.cancelContext();
      } else if (ev.key === 'ArrowUp' && !this.input.value && !this.editing) {
        const chat = social.chat(this.chatId);
        const last = [...(chat?.messages || [])].reverse().find((m) => m.sender_id === social.userId && !m.deleted && !m._local);
        if (last) {
          ev.preventDefault();
          this.startEdit(last);
        }
      }
    });
    this.lockNote = h('div', { class: 'msg-locked', role: 'status', hidden: true });
    mount(this.composer, this.ctx, this.lockNote, h('div', { class: 'msg-compose-row' }, this.emojiBtn, h('div', { class: 'msg-input-wrap' }, this.input, this.counter), this.sendBtn));
    this.autoGrow();
    this.updateCounter();
    this.updateComposerState();
    setTimeout(() => !this.destroyed && this.input.focus(), 30);
  }

  updateComposerState() {
    if (!this.input) return;
    const isFriend = social.isFriend(this.userId);
    // Cuenta silenciada o suspendida: no se puede escribir (el aviso completo está arriba de la página)
    const mod = activeModeration();
    const canWrite = isFriend && !mod;
    this.input.disabled = !canWrite;
    this.emojiBtn.disabled = !canWrite;
    this.lockNote.hidden = canWrite;
    let note = [];
    if (mod) note = [icon(mod.kind === 'banned' ? 'ban' : 'micOff'), h('span', {}, t(mod.kind === 'banned' ? 'messages.modBannedShort' : 'messages.modMutedShort'))];
    else if (!isFriend) note = [icon('lock'), h('span', {}, t('messages.notFriendsAnymore', { name: this.name() }))];
    mount(this.lockNote, note);
    this.updateSendState();
  }

  // Enviar solo se habilita con texto (si todavia son amigos y la cuenta puede escribir)
  updateSendState() {
    if (!this.sendBtn) return;
    this.sendBtn.disabled = !social.isFriend(this.userId) || Boolean(activeModeration()) || !this.input.value.trim();
  }

  autoGrow() {
    const el = this.input;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }

  updateCounter() {
    const len = this.input?.value.length || 0;
    const show = len > MAX_MESSAGE - 300;
    this.counter.textContent = show ? `${len}/${MAX_MESSAGE}` : '';
    this.counter.classList.toggle('warn', len > MAX_MESSAGE - 100);
  }

  async submit() {
    const text = this.input.value;
    if (!text.trim()) return;
    if (this.editing) {
      const m = this.editing;
      this.editing = null;
      this.input.value = this.savedDraft || '';
      this.savedDraft = '';
      this.renderContext();
      this.autoGrow();
      this.updateCounter();
      this.updateSendState();
      try {
        await social.editMessage(this.chatId, m.id, text);
      } catch (err) {
        fail(t('messages.editFailed'), err);
      }
      return;
    }
    await this.send(text, this.replyTo?.id || null);
  }

  async send(text, replyTo = null) {
    try {
      await social.sendMessage(this.chatId, text, { replyTo });
      if (this.input && text === this.input.value) {
        this.input.value = '';
        drafts.delete(this.chatId);
      }
      this.replyTo = null;
      this.renderContext();
      this.autoGrow();
      this.updateCounter();
      this.updateSendState();
      this.scrollToBottom(true);
    } catch (err) {
      fail(t('messages.sendFailed'), err);
    }
  }
}
