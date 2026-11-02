// Compartir desde Clips: link firmado (lo hace worlds: shareMedia de pages/worlds/media.js), mandarlo a un amigo
// (señal 'media-share' { url, kind, name }) y destacar una captura en el perfil (featureCapture del editor de perfiles).
import { h, icon, mount, modal, ok, fail, setBusy, avatarImg } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { cloud } from '../../cloud.js';
import { social } from '../../social.js';
import { shareMedia } from '../worlds/media.js';

const RENEW_BEFORE = 24 * 3600 * 1000;

// ---------- Avisos de cuenta y servicio ----------

function signInNotice() {
  const m = modal({
    title: t('clips.signInTitle'),
    size: 'sm',
    body: h('p', { class: 'cl-modal-text' }, t('clips.signInText')),
    footer: [
      h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('clips.cancel')),
      h(
        'button',
        {
          class: 'btn primary',
          type: 'button',
          onclick: () => {
            m.close();
            navigate('settings/cloud');
          },
        },
        icon('settings'),
        t('clips.goToAccount'),
      ),
    ],
  });
}

async function requireAccount() {
  await Promise.resolve(cloud.ready()).catch(() => {});
  if (!cloud.isConfigured() || !cloud.isSignedIn()) {
    signInNotice();
    return null;
  }
  return cloud.user;
}

// ---------- Link ----------

// URL firmada vigente del item; si no la tiene, la sube con el flujo de worlds (confirma, sube y muestra el link)
export async function ensureLink(item) {
  const fresh = (info) => info?.url && (!info.expiresAt || info.expiresAt > Date.now() + RENEW_BEFORE);
  let map = await api.invoke('worlds:shared').catch(() => ({}));
  if (fresh(map?.[item.sharedKey])) return map[item.sharedKey].url;
  await shareMedia(item);
  map = await api.invoke('worlds:shared').catch(() => ({}));
  return fresh(map?.[item.sharedKey]) ? map[item.sharedKey].url : null;
}

// ---------- Mandar a un amigo ----------

function friendsList() {
  let raw = [];
  try {
    raw = Array.isArray(social?.friends) ? social.friends : [];
  } catch {
    raw = [];
  }
  return raw
    .filter((f) => f && f.id)
    .map((f) => ({ id: f.id, name: f.name || f.profile?.display_name || f.profile?.username || '?', mc: f.profile?.mc_name || null, online: Boolean(f.presence && f.presence !== 'offline') }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

export async function sendToFriend(item) {
  if (!(await requireAccount())) return;
  if (typeof social?.sendSignal !== 'function' || social.state !== 'ready') {
    fail(t('clips.sendFailed'), t('clips.friendsUnavailable'));
    return;
  }
  const friends = friendsList();
  const list = h('div', { class: 'cl-friends', role: 'list' });
  const m = modal({
    title: item.kind === 'clip' ? t('clips.sendClipTitle') : t('clips.sendShotTitle'),
    subtitle: item.file,
    icon: 'send',
    body: h('div', { class: 'stack' }, h('p', { class: 'cl-modal-text' }, t('clips.sendText')), list),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('clips.close'))],
  });
  if (!friends.length) {
    mount(
      list,
      h(
        'div',
        { class: 'cl-empty-line' },
        icon('userPlus'),
        h('span', { class: 'spacer' }, t('clips.noFriends')),
        h(
          'button',
          {
            class: 'btn sm',
            type: 'button',
            onclick: () => {
              m.close();
              navigate('messages');
            },
          },
          icon('message'),
          t('clips.goFriends'),
        ),
      ),
    );
    return;
  }
  mount(
    list,
    friends.map((f) => {
      const btn = h('button', { class: 'btn sm', type: 'button', 'aria-label': t('clips.sendTo', { name: f.name }) }, icon('send'), t('clips.send'));
      btn.addEventListener('click', async () => {
        if (btn.getAttribute('aria-disabled') === 'true') return;
        const done = setBusy(btn);
        try {
          const url = await ensureLink(item);
          if (!url) {
            done();
            return;
          }
          await social.sendSignal(f.id, 'media-share', { url, kind: item.kind === 'clip' ? 'clip' : 'screenshot', name: String(item.file || '').slice(0, 120) });
          done();
          mount(btn, icon('check'), t('clips.sent'));
          btn.classList.add('good');
          btn.setAttribute('aria-disabled', 'true');
          ok(t('clips.sentTo', { name: f.name }));
        } catch (err) {
          done();
          fail(t('clips.sendFailed'), err);
        }
      });
      return h(
        'div',
        { class: 'cl-friend', role: 'listitem' },
        h('span', { class: 'cl-friend-av' }, avatarImg(f.mc || f.name, 64, 'cl-avatar'), h('span', { class: ['cl-dot', f.online && 'on'], 'aria-hidden': 'true' })),
        h('div', { class: 'cl-friend-main' }, h('div', { class: 'cl-friend-name ellipsis', title: f.name }, f.name), h('div', { class: 'cl-friend-sub' }, f.online ? t('clips.online') : t('clips.offline'))),
        btn,
      );
    }),
  );
}

// ---------- Destacar en el perfil ----------

// Lo hace el editor de perfiles (agente D: features/profile-editor.js, featureCapture): sube a profile-media,
// agrega a `featured` (hasta 3; si ya hay 3 pregunta si reemplazar) y avisa. Aca solo se le pasa la imagen como
// Blob, leida por los canales de worlds (asi no depende de que el canvas acepte una URL file:).
export async function featureOnProfile(item) {
  if (item.kind !== 'screenshot') return false;
  let editor = null;
  try {
    editor = await import('../../features/profile-editor.js');
  } catch (err) {
    console.warn('[clips] editor de perfiles:', err?.message || err);
  }
  if (typeof editor?.featureCapture !== 'function') {
    fail(t('clips.featureFailed'), t('clips.errService'));
    return false;
  }
  let blob;
  try {
    const file = await api.invoke('worlds:readMedia', item.path);
    blob = new Blob([file.data], { type: file.mime });
  } catch (err) {
    fail(t('clips.featureFailed'), err);
    return false;
  }
  return editor.featureCapture({ src: blob, title: String(item.world || item.instanceName || '').slice(0, 60) });
}
