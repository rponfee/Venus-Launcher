// Subir un clip a YouTube o TikTok, desde el visor de Clips. Siempre funciona el camino sin credenciales: abre la pagina de
// subida en el navegador, muestra el archivo en la carpeta y copia el titulo y la descripcion. Si el launcher trae los
// identificadores de las aplicaciones (modules/clipupload/config.js), ademas la subida directa con la cuenta del usuario,
// siempre con el aviso de que se sube y adonde, y solo al apretar "Subir".
import { h, icon, mount, modal, ok, fail, toast, setBusy, selectEl, fmtBytes, copyText, confirmDialog } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import './icons.js';

const C = (key, vars) => t(`clipstudio.${key}`, vars);
const OPEN_URL = { youtube: 'https://www.youtube.com/upload', tiktok: 'https://www.tiktok.com/tiktokstudio/upload' };
const PROVIDERS = ['youtube', 'tiktok'];
const PRIVACY = ['private', 'unlisted', 'public'];
const TITLE_MAX = { youtube: 100, tiktok: 150 };
const DESC_MAX = 4500;

let seq = 0;

function defaultTitle(item) {
  return String(item.world || item.instanceName || item.file || '').slice(0, 90);
}

const metaText = (title, description) => [title, description].filter(Boolean).join('\n\n');

/** Abre el dialogo de subida de un clip (item de worlds:media). */
export function openUpload(item) {
  let provider = 'youtube';
  let privacy = 'private';
  let status = null; // de clipupload:status
  let uploading = null; // { jobId }
  let connecting = false;
  const titleIn = h('input', { class: 'input', type: 'text', maxlength: TITLE_MAX.youtube, value: defaultTitle(item), 'aria-label': C('uploadTitleLabel') });
  const descIn = h('textarea', { class: 'input cs-textarea', rows: 3, maxlength: DESC_MAX, 'aria-label': C('uploadDescLabel') });
  descIn.value = C('uploadDefaultDesc');
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': C('uploadWhere') });
  const manualBox = h('div', { class: 'cs-up-section' });
  const directBox = h('div', { class: 'cs-up-section' });
  const bar = h('div', { class: 'progress' }, h('i'));
  const barText = h('span', { class: 'num' });
  const cancelBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => cancel() }, t('common.cancel'));
  const progress = h('div', { class: 'cs-progress', hidden: true, role: 'status', 'aria-live': 'polite' }, h('div', { class: 'row between' }, h('span', {}, C('uploadSending')), barText), bar, cancelBtn);

  const m = modal({
    title: C('uploadTitle'),
    subtitle: item.file,
    icon: 'upload',
    size: 'wide',
    body: h(
      'div',
      { class: 'cs-up' },
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('uploadWhere')), seg),
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('uploadTitleLabel')), titleIn),
      h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('uploadDescLabel')), descIn),
      manualBox,
      directBox,
      progress,
    ),
    onClose: () => {
      if (uploading) cancel();
      if (connecting) api.invoke('clipupload:cancelConnect').catch(() => {});
      off();
    },
  });

  const off = api.on('clipupload:progress', (e) => {
    if (e?.jobId !== uploading?.jobId) return;
    const pct = e.total ? Math.round((e.sent / e.total) * 100) : 0;
    bar.firstChild.style.width = `${pct}%`;
    barText.textContent = `${pct}% · ${fmtBytes(e.sent)} / ${fmtBytes(e.total)}`;
  });

  function drawTabs() {
    mount(
      seg,
      PROVIDERS.map((p) =>
        h(
          'button',
          {
            type: 'button',
            class: provider === p ? 'active' : '',
            'aria-pressed': String(provider === p),
            onclick: () => {
              if (uploading) return;
              provider = p;
              titleIn.maxLength = TITLE_MAX[p];
              draw();
            },
          },
          C(`provider_${p}`),
        ),
      ),
    );
  }

  // ---------- Sin credenciales ----------
  async function openManual() {
    const text = metaText(titleIn.value.trim(), descIn.value.trim());
    await copyText(text, C('uploadCopied'));
    api.invoke('worlds:showMedia', item.path).catch((err) => console.warn('[clipstudio] mostrar:', err?.message || err));
    api.app.openExternal(OPEN_URL[provider]).catch((err) => fail(C('openFailed'), err));
  }

  function drawManual() {
    mount(
      manualBox,
      h('h3', { class: 'cs-subtitle' }, C('uploadManualTitle')),
      h('p', { class: 'cs-help' }, C(`uploadManualText_${provider}`)),
      h('div', { class: 'row wrap' }, h('button', { class: 'btn', type: 'button', onclick: () => openManual() }, icon('external'), C(`uploadManualOpen_${provider}`))),
    );
  }

  // ---------- Directo ----------
  async function connect(btn) {
    const done = setBusy(btn);
    connecting = true;
    try {
      toast('info', C('connectOpening'), C('connectOpeningText'), 6000);
      await api.invoke('clipupload:connect', provider);
      ok(C('connectDone', { name: C(`provider_${provider}`) }));
      await loadStatus();
    } catch (err) {
      if (err?.code !== 'cancelled') fail(C('connectFailed'), err);
    } finally {
      connecting = false;
      done();
    }
  }

  async function revoke(btn) {
    if (!(await confirmDialog(C('revokeTitle'), C('revokeText', { name: C(`provider_${provider}`) }), { okText: C('revokeOk'), danger: true }))) return;
    const done = setBusy(btn);
    try {
      await api.invoke('clipupload:revoke', provider);
      ok(C('revokeDone'));
      await loadStatus();
    } catch (err) {
      fail(C('revokeFailed'), err);
    } finally {
      done();
    }
  }

  function cancel() {
    if (uploading) api.invoke('clipupload:cancel', uploading.jobId).catch(() => {});
  }

  async function upload(btn) {
    const title = titleIn.value.trim();
    if (provider === 'youtube' && !title) {
      titleIn.focus();
      fail(C('uploadFailed'), C('uploadNeedTitle'));
      return;
    }
    const where = C(provider === 'youtube' ? `uploadNoticeYoutube_${privacy}` : 'uploadNoticeTiktok');
    if (!(await confirmDialog(C('uploadConfirmTitle', { name: C(`provider_${provider}`) }), C('uploadConfirmText', { file: item.file, size: fmtBytes(item.size || 0), where }), { okText: C('uploadOk') }))) return;
    const jobId = `up${Date.now().toString(36)}${++seq}`;
    uploading = { jobId };
    const done = setBusy(btn);
    progress.hidden = false;
    bar.firstChild.style.width = '0%';
    barText.textContent = '';
    try {
      const res = await api.invoke('clipupload:upload', { jobId, provider, path: item.path, title, description: descIn.value.trim(), privacy });
      m.close();
      showDone(res);
    } catch (err) {
      if (err?.code === 'cancelled') toast('info', C('uploadCancelled'));
      else {
        fail(C('uploadFailed'), err);
        if (err?.code === 'session') await loadStatus();
      }
    } finally {
      uploading = null;
      progress.hidden = true;
      done();
    }
  }

  function drawDirect() {
    const st = status?.[provider];
    if (!st?.configured) {
      mount(directBox);
      directBox.hidden = true;
      return;
    }
    directBox.hidden = false;
    const name = C(`provider_${provider}`);
    if (!st.connected) {
      const btn = h('button', { class: 'btn tonal', type: 'button', onclick: () => connect(btn) }, icon('logIn'), C('connect', { name }));
      mount(directBox, h('h3', { class: 'cs-subtitle' }, C('uploadDirectTitle')), h('p', { class: 'cs-help' }, C(`uploadDirectText_${provider}`)), h('div', { class: 'row wrap' }, btn));
      return;
    }
    const upBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => upload(upBtn) }, icon('upload'), C('uploadOk'));
    const revokeBtn = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => revoke(revokeBtn) }, icon('csLogOut'), C('revokeOk'));
    const privacySel = selectEl(
      PRIVACY.map((p) => ({ value: p, label: C(`privacy_${p}`) })),
      privacy,
      (v) => {
        privacy = v;
        draw();
      },
    );
    privacySel.setAttribute('aria-label', C('uploadPrivacy'));
    mount(
      directBox,
      h('div', { class: 'row between' }, h('h3', { class: 'cs-subtitle' }, C('uploadDirectConnected', { name })), revokeBtn),
      provider === 'youtube' ? h('div', { class: 'cs-field' }, h('label', { class: 'cs-label' }, C('uploadPrivacy')), privacySel) : null,
      h('div', { class: 'notice info' }, icon('info'), h('div', {}, C('uploadNotice', { file: item.file, size: fmtBytes(item.size || 0), where: C(provider === 'youtube' ? `uploadNoticeYoutube_${privacy}` : 'uploadNoticeTiktok') }))),
      h('div', { class: 'row wrap' }, upBtn),
    );
  }

  function draw() {
    drawTabs();
    drawManual();
    drawDirect();
  }

  async function loadStatus() {
    try {
      status = await api.invoke('clipupload:status');
    } catch (err) {
      console.warn('[clipstudio] subir:', err?.message || err);
      status = null;
    }
    if (m.el.isConnected) draw();
  }

  draw();
  loadStatus();
  return m;
}

function showDone(res) {
  if (res?.provider === 'youtube') {
    const msg = h('div', { class: 'cap-toast' }, h('button', { class: 'btn sm', type: 'button', onclick: () => api.app.openExternal(res.studio || res.url).catch((err) => fail(C('openFailed'), err)) }, icon('external'), C('uploadOpenStudio')));
    toast('good', C('uploadDoneYoutube'), msg, 12000);
    return;
  }
  ok(res?.status === 'inbox' ? C('uploadDoneTiktok') : C('uploadProcessingTiktok'), C('uploadDoneTiktokText'));
}
