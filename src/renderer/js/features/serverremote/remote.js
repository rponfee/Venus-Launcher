// Tarjeta "Control remoto desde el celular" de la pestaña Red de un servidor. Apagado por defecto y por servidor: al
// prender muestra el QR, la dirección con el código y quién está conectado, con un botón para cortarlo.
// remoteCard(serverId) -> Element con .destroy(). El proceso principal está en modules/serverremote.js.
import { h, icon, mount, registerIcons, selectEl, setBusy, fail, ok, copyText, confirmDialog, fmtAgo } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';

const R = (key, vars) => t(`serverremote.${key}`, vars);
const LIVE_MS = 5000;

registerIcons({
  srPhone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  srPlug: '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
});

// El QR lleva el token: se dibuja en un canvas propio con zona blanca alrededor, sea cual sea el tema
function qrCanvas(qr) {
  const QUIET = 4;
  const scale = Math.max(3, Math.min(8, Math.floor(240 / (qr.size + QUIET * 2))));
  const side = (qr.size + QUIET * 2) * scale;
  const canvas = h('canvas', { class: 'sr-qr', width: side, height: side, role: 'img', 'aria-label': R('qrAlt') });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = '#000000';
  qr.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '1') ctx.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
  });
  return canvas;
}

function deviceName(device) {
  return [device?.os, device?.browser].filter(Boolean).join(' · ') || R('unknownDevice');
}

export function remoteCard(serverId) {
  const el = h('div', { class: 'card sr-card' });
  const head = h('div', {});
  const body = h('div', { class: 'stack sr-body' });
  mount(el, head, body);
  let status = { on: false };
  let addresses = [];
  let pick = null;
  let drawnUrl = null;
  let liveBox = null;
  let alive = true;

  mount(
    head,
    h('h2', { class: 'card-title' }, icon('srPhone'), R('title')),
    h('div', { class: 'card-sub' }, R('subtitle')),
  );

  const act = async (e, channel, args, errKey, after) => {
    const release = setBusy(e.currentTarget);
    try {
      status = await api.invoke(channel, serverId, ...args);
      after?.();
      draw();
    } catch (err) {
      fail(R(errKey), err);
    } finally {
      release();
    }
  };

  function drawOff() {
    drawnUrl = null;
    const noLan = !addresses.length;
    const sel = addresses.length > 1 ? selectEl(addresses.map((a) => ({ value: a.address, label: `${a.name} · ${a.address}` })), pick, (v) => (pick = v)) : null;
    sel?.setAttribute('aria-label', R('addressLabel'));
    sel?.classList.add('priv');
    mount(
      body,
      noLan ? h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, R('noLan'))) : null,
      h('div', { class: 'notice info' }, icon('shieldCheck'), h('div', {}, R('firewallNote'))),
      h(
        'div',
        { class: 'row wrap' },
        sel,
        h('button', { class: 'btn', type: 'button', disabled: noLan, onclick: (e) => act(e, 'serverremote:start', [{ address: pick }], 'errStart') }, icon('srPlug'), R('turnOn')),
      ),
    );
  }

  function drawLive() {
    if (!liveBox) return;
    const left = Math.ceil(Math.max(0, (status.expiresAt || 0) - Date.now()) / 60000);
    const clients = status.clients || [];
    mount(
      liveBox,
      h('div', { class: 'small muted' }, icon('clock'), ' ', R('expiresIn', { hours: Math.floor(left / 60), minutes: left % 60 })),
      status.rejected ? h('div', { class: 'small sr-rejected', role: 'status' }, icon('alert'), ' ', R('rejected', { count: status.rejected })) : null,
      h('div', { class: 'label sr-clients-title' }, R('connectedTitle')),
      clients.length
        ? h(
            'div',
            { class: 'list sr-clients' },
            clients.map((c) =>
              h(
                'div',
                { class: 'list-item sr-client' },
                h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, deviceName(c.device)), h('div', { class: 'li-sub' }, h('span', { class: 'priv' }, c.ip), ' · ', c.connected ? R('connectedNow') : R('connectedAgo', { time: fmtAgo(c.lastSeen) }))),
                h('button', { class: 'btn sm danger', type: 'button', onclick: (e) => kick(e, c) }, icon('x'), R('kick')),
              ),
            ),
          )
        : h('div', { class: 'small muted' }, R('nobody')),
    );
  }

  async function kick(e, client) {
    const btn = e.currentTarget;
    if (!(await confirmDialog(R('kickTitle'), R('kickText', { device: deviceName(client.device) }), { danger: true, okText: R('kick') }))) return;
    await act({ currentTarget: btn }, 'serverremote:kick', [client.ip], 'errAction', () => ok(R('kickDone')));
  }

  function drawOn() {
    // El QR y el código solo se redibujan si cambian: lo que se actualiza solo es la lista de conectados
    if (status.url === drawnUrl && liveBox) {
      drawLive();
      return;
    }
    drawnUrl = status.url;
    liveBox = h('div', { class: 'stack sr-live' });
    const copyLink = h('button', { class: 'btn sm', type: 'button', onclick: () => copyText(status.url, R('linkCopied')) }, icon('copy'), R('copyLink'));
    const copyCode = h('button', { class: 'icon-btn sm', type: 'button', title: R('copyCode'), 'aria-label': R('copyCode'), onclick: () => copyText(status.code, R('codeCopied')) }, icon('copy'));
    const copyBase = h('button', { class: 'icon-btn sm', type: 'button', title: R('copyAddress'), 'aria-label': R('copyAddress'), onclick: () => copyText(status.baseUrl, R('addressCopied')) }, icon('copy'));
    mount(
      body,
      h(
        'div',
        { class: 'sr-on' },
        qrCanvas(status.qr),
        h(
          'div',
          { class: 'stack sr-pair' },
          h('p', { class: 'small text-2 sr-step' }, R('stepQr')),
          h('p', { class: 'small text-2 sr-step' }, R('stepCode')),
          h('div', { class: 'sr-kv' }, h('span', { class: 'sr-k' }, R('addressLabel')), h('span', { class: 'kbd selectable priv sr-v' }, status.baseUrl), copyBase),
          h('div', { class: 'sr-kv' }, h('span', { class: 'sr-k' }, R('codeLabel')), h('span', { class: 'kbd selectable priv sr-v' }, status.code), copyCode),
          h('div', { class: 'row wrap' }, copyLink),
        ),
      ),
      liveBox,
      h('div', { class: 'notice' }, icon('alert'), h('div', {}, R('lanNote'))),
      h(
        'div',
        { class: 'row wrap' },
        h('button', { class: 'btn sm ghost', type: 'button', title: R('rotateHint'), onclick: (e) => act(e, 'serverremote:rotate', [], 'errAction', () => ok(R('rotated'))) }, icon('refresh'), R('rotate')),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm danger', type: 'button', onclick: (e) => act(e, 'serverremote:stop', [], 'errAction') }, icon('stop'), R('turnOff')),
      ),
    );
    drawLive();
  }

  function draw() {
    if (!alive) return;
    if (status.on) drawOn();
    else {
      liveBox = null;
      drawOff();
    }
  }

  async function refresh() {
    try {
      const [next, list] = await Promise.all([api.invoke('serverremote:status', serverId), status.on ? addresses : api.invoke('serverremote:addresses')]);
      if (!alive) return;
      status = next;
      addresses = Array.isArray(list) ? list : [];
      if (!addresses.some((a) => a.address === pick)) pick = addresses[0]?.address || null;
      draw();
    } catch (err) {
      console.warn('[serverremote]', err?.message || err);
    }
  }

  const offChanged = api.on('serverremote:changed', (id) => {
    if (id === serverId) refresh();
  });
  const offSettings = store.on('settings', () => status.on && drawOn());
  const timer = setInterval(() => {
    if (!document.hidden && status.on) refresh();
  }, LIVE_MS);
  el.destroy = () => {
    alive = false;
    clearInterval(timer);
    offChanged();
    offSettings();
  };
  refresh();
  return el;
}
