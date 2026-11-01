// Skins: vista previa en 3D de la skin de tu cuenta o de las de tu biblioteca (PNG propios), y cambio de
// skin y capa en tu cuenta de Microsoft con la API oficial de Minecraft Services. Ruta: #/skins
// Con una cuenta sin conexion (o sin cuenta) la vista previa y la biblioteca funcionan igual, sin red.
// Las texturas de la cuenta llegan como data: desde el proceso principal (skins:texture).
import { h, icon, mount, confirmDialog, promptDialog, toast, ok, fail, setBusy, skeleton, emptyState, sectionTitle, fmtDate, reducedMotion } from '../ui.js';
import { api, store } from '../store.js';
import { t } from '../i18n.js';
import { navigate, openAccounts } from '../app.js';
import { createViewer } from './skins/viewer.js';
import { loadImage, normalizeSkin, normalizeCape, mannequin } from './skins/texture.js';
import { variantLabel, skinThumb, headThumb, capeThumb, confirmChange, readDropped, problemOf } from './skins/parts.js';

let lastPick = null; // ultima skin elegida: se recuerda al volver a la pagina

export default {
  ns: ['skins'],
  css: ['pages/skins'],
  render(root) {
    const S = {
      alive: true,
      token: 0,
      account: undefined, // undefined: cargando · null: sin cuenta · { id, type, name, needsLogin }
      profile: undefined, // undefined: sin datos todavia · null: no hay · perfil de skins:profile
      profileLoading: false,
      problem: null, // { kind: 'login' | 'offlineMode' | 'noGame' | 'error', message }
      library: undefined,
      libraryError: null,
      max: 100,
      selected: lastPick, // 'account' o el id de una skin de la biblioteca
      userPicked: Boolean(lastPick), // si el jugador ya eligio, no se le cambia la seleccion sola
      accountSkin: null, // { canvas, legacy, url, pixelHash }
      accountSkinState: 'none', // 'none' | 'loading' | 'ready' | 'error'
      capes: new Map(), // id -> canvas | 'loading' | 'error'
      norm: new Map(), // id de la biblioteca -> { key, canvas, legacy } o { key, error }
      busy: null, // cambio en curso: 'apply', 'reset', 'save', 'cape:<id>'
    };
    const blank = mannequin();
    let shown = null;
    let shownCape = null;
    let barReady = false; // el visor avisa cambios desde que se crea, antes de que exista la barra
    let pauseIcon = null;
    let focusAfter = null; // control que recupera el foco cuando termina un cambio (mientras tanto queda deshabilitado)
    let accountsChanged = false; // las cuentas cambiaron durante un cambio en curso: se vuelve a leer al terminar
    let reloads = 0; // recargas seguidas por "la cuenta cambio" (para no quedar en un ciclo)

    // ---------- Encabezado y vista previa ----------
    const refreshBtn = h('button', { class: 'icon-btn', type: 'button', title: t('skins.refresh'), 'aria-label': t('skins.refresh'), onclick: () => refreshAll() }, icon('refresh'));
    const addBtn = h('button', { class: 'btn tonal', type: 'button', onclick: () => addSkins() }, icon('plus'), t('skins.add'));
    const viewer = createViewer({ label: t('skins.viewerLabel'), onChange: (v) => barReady && syncViewBar(v) });
    viewer.el.setAttribute('aria-describedby', 'sk-viewer-hint');
    const viewerStatus = h('div', { class: 'sk-viewer-status', role: 'status', 'aria-live': 'polite', hidden: true });
    const frontBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => viewer.show('front') }, t('skins.front'));
    const backBtn = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => viewer.show('back') }, t('skins.back'));
    const iconBtn = (name, label, onclick) => h('button', { class: 'icon-btn sm', type: 'button', title: label, 'aria-label': label, onclick }, icon(name));
    const rotL = iconBtn('skRotateCcw', t('skins.rotateLeft'), () => viewer.rotate(-45));
    const rotR = iconBtn('skRotateCw', t('skins.rotateRight'), () => viewer.rotate(45));
    const capeBtn = iconBtn('skCape', t('skins.showCape'), () => {
      viewer.setCapeVisible(!viewer.capeVisible);
      syncViewBar();
    });
    const pauseBtn = iconBtn('pause', t('skins.pauseAnimation'), () => {
      viewer.setPaused(!viewer.paused);
      syncViewBar();
    });
    const viewBar = h(
      'div',
      { class: 'sk-viewbar' },
      h('div', { class: 'segmented sk-seg', role: 'group', 'aria-label': t('skins.viewGroup') }, frontBtn, backBtn),
      h('div', { class: 'sk-viewbar-end' }, rotL, rotR, capeBtn, pauseBtn),
    );
    barReady = true;
    const stageCard = h(
      'section',
      { class: 'card sk-stage-card', 'aria-label': t('skins.previewTitle') },
      h('div', { class: 'sk-viewer-wrap' }, viewer.el, viewerStatus),
      viewBar,
      h('p', { class: 'sk-hint', id: 'sk-viewer-hint' }, t(viewer.has3d ? 'skins.viewerHint' : 'skins.viewerHintFlat')),
    );

    const accountCard = h('section', { class: 'card sk-account', 'aria-label': t('skins.accountTitle') });
    const detailCard = h('section', { class: 'card sk-detail', 'aria-labelledby': 'sk-detail-title' });
    const libCount = h('span', { class: 'sk-count' });
    const libraryHost = h('div', { class: 'sk-library' });
    const libSection = h('section', { class: 'sk-section', 'aria-label': t('skins.libraryTitle') }, sectionTitle(t('skins.libraryTitle'), libCount), libraryHost);
    const capesHost = h('div', { class: 'sk-capes-host' });
    const capesSection = h('section', { class: 'sk-section', 'aria-label': t('skins.capesTitle'), hidden: true }, sectionTitle(t('skins.capesTitle')), h('p', { class: 'sk-section-sub' }, t('skins.capesSub')), capesHost);

    const skRoot = h(
      'div',
      { class: 'sk-root' },
      h(
        'div',
        { class: 'page-head' },
        h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('skins.title')), h('p', { class: 'page-sub' }, t('skins.subtitle'))),
        h('div', { class: 'page-actions' }, refreshBtn, addBtn),
      ),
      h('div', { class: 'sk-layout' }, stageCard, h('div', { class: 'sk-side' }, accountCard, detailCard, libSection, capesSection)),
    );
    mount(root, skRoot);

    // Arrastrar PNG sobre la pagina los agrega a la biblioteca (tambien esta el boton Agregar)
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    let dragDepth = 0;
    root.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      dragDepth++;
      skRoot.classList.add('sk-dropping');
    });
    root.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) skRoot.classList.remove('sk-dropping');
    });
    root.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      skRoot.classList.remove('sk-dropping');
      const dropped = e.dataTransfer.files?.length || 0; // se lee antes de esperar: despues la lista queda vacia
      try {
        const files = await readDropped(e.dataTransfer.files);
        if (!files.length || !S.alive) return;
        const r = await api.invoke('skins:addData', files);
        // los que pasan de 20 no se mandan: se avisan igual
        if (r) r.skipped = Math.max(r.skipped || 0, dropped - files.length);
        afterAdd(r);
      } catch (err) {
        if (S.alive) fail(t('skins.addFailed'), err);
      }
    });

    // ---------- Estado derivado ----------
    const isMsa = () => S.account?.type === 'msa';
    const itemOf = (id) => (S.library || []).find((i) => i.id === id) || null;
    const inUse = (it) => Boolean(it?.pixelHash && S.accountSkin?.pixelHash && it.pixelHash === S.accountSkin.pixelHash);
    const accountTile = () => isMsa() && (S.profileLoading || S.profile === undefined || S.accountSkinState !== 'none');
    const currentInLibrary = () => (S.library || []).some((i) => inUse(i));

    // Por que no se puede cambiar la skin de la cuenta ahora (null = se puede). Mientras no se conoce la skin
    // actual tampoco: antes de reemplazarla hay que poder ofrecer guardar una copia.
    function blockReason() {
      if (S.account === undefined) return t('skins.reasonLoading');
      if (!S.account) return t('skins.reasonNoAccount');
      if (!isMsa()) return t('skins.reasonOffline');
      if (S.problem?.kind === 'login') return t('skins.reasonLogin');
      if (S.problem?.kind === 'offlineMode') return t('skins.reasonOfflineMode');
      if (S.problem?.kind === 'noGame') return t('skins.reasonNoGame');
      if (S.profileLoading || S.profile === undefined || S.accountSkinState === 'loading') return t('skins.reasonLoading');
      if (!S.profile) return t('skins.reasonProfile');
      return null;
    }

    // Por defecto se ve la skin de la cuenta; si no hay, la primera de la biblioteca.
    function ensureSelection() {
      const lib = S.library || [];
      // Mientras no se sabe la cuenta no se elige nada (asi no se ve una skin y enseguida otra)
      if (!S.userPicked && S.account === undefined) {
        S.selected = null;
        return;
      }
      if (!S.userPicked && accountTile()) {
        S.selected = 'account';
        return;
      }
      if (S.selected === 'account' && accountTile()) return;
      // La biblioteca todavia no llego: se conserva la skin recordada hasta saber si sigue estando
      if (S.selected && S.selected !== 'account' && S.library === undefined) return;
      if (S.selected && S.selected !== 'account' && itemOf(S.selected)) return;
      S.userPicked = false;
      if (accountTile()) S.selected = 'account';
      else S.selected = lib.find((i) => !i.broken)?.id || lib[0]?.id || null;
    }

    function pick(id) {
      S.userPicked = true;
      if (S.selected === id) return;
      S.selected = id;
      lastPick = id;
      drawAll();
    }

    // ---------- Carga ----------
    async function loadLibrary() {
      try {
        const r = await api.invoke('skins:library');
        if (!S.alive) return;
        S.library = Array.isArray(r?.items) ? r.items : [];
        S.max = r?.max || 100;
        S.libraryError = null;
      } catch (err) {
        if (!S.alive) return;
        console.warn('[skins] biblioteca:', err?.message);
        S.library = S.library || [];
        S.libraryError = err;
      }
      for (const it of S.library) {
        const key = `${it.pixelHash || it.sha1 || ''}:${it.updatedAt}`;
        if (it.broken || !it.image || S.norm.get(it.id)?.key === key) continue;
        try {
          S.norm.set(it.id, { key, ...normalizeSkin(await loadImage(it.image)) });
        } catch (err) {
          console.warn('[skins] no se pudo leer la skin', it.id, err?.message);
          S.norm.set(it.id, { key, error: true });
        }
        if (!S.alive) return;
      }
      ensureSelection();
      drawAll();
    }

    async function loadAccount({ force = false } = {}) {
      const token = ++S.token;
      S.account = undefined;
      S.problem = null;
      drawAll();
      let acc = null;
      try {
        acc = await api.invoke('skins:account');
      } catch (err) {
        console.warn('[skins] cuenta:', err?.message);
      }
      if (!S.alive || token !== S.token) return;
      S.account = acc || null;
      if (!isMsa()) {
        S.profile = null;
        S.accountSkin = null;
        S.accountSkinState = 'none';
        ensureSelection();
        drawAll();
        return;
      }
      S.profile = undefined;
      await loadProfile({ force, token });
    }

    async function loadProfile({ force = false, token = S.token } = {}) {
      S.profileLoading = true;
      S.problem = null;
      ensureSelection();
      drawAll();
      try {
        const p = await api.invoke('skins:profile', S.account.id, { force });
        if (!S.alive || token !== S.token) return;
        S.profileLoading = false;
        reloads = 0;
        setProfile(p);
      } catch (err) {
        if (!S.alive || token !== S.token) return;
        S.profileLoading = false;
        const kind = problemOf(err);
        // La cuenta elegida ya no es la que se ve: se vuelve a leer (como mucho dos veces seguidas)
        if ((kind === 'changed' || kind === 'offlineAccount') && ++reloads <= 2) {
          loadAccount();
          return;
        }
        S.profile = null;
        S.problem = { kind, message: err?.message || String(err) };
        S.accountSkin = null;
        S.accountSkinState = 'none';
        ensureSelection();
        drawAll();
      }
    }

    function setProfile(p) {
      S.profile = p || null;
      if (!p?.skin?.textureUrl) {
        S.accountSkin = null;
        S.accountSkinState = 'none';
      }
      ensureSelection();
      drawAll();
      loadAccountSkin();
      loadCapes();
    }

    async function loadAccountSkin() {
      const url = S.profile?.skin?.textureUrl;
      if (!url || (S.accountSkin?.url === url && S.accountSkinState === 'ready')) return;
      const token = S.token;
      S.accountSkinState = 'loading';
      drawAll();
      try {
        const tex = await api.invoke('skins:texture', url, 'skin');
        const n = normalizeSkin(await loadImage(tex.dataUrl));
        if (!S.alive || token !== S.token) return;
        S.accountSkin = { ...n, url, pixelHash: tex.pixelHash };
        S.accountSkinState = 'ready';
      } catch (err) {
        if (!S.alive || token !== S.token) return;
        console.warn('[skins] textura de la cuenta:', err?.message);
        S.accountSkin = null;
        S.accountSkinState = 'error';
      }
      ensureSelection();
      drawAll();
    }

    async function loadCapes() {
      const token = S.token;
      const capes = (S.profile?.capes || []).filter((c) => c.textureUrl && !(S.capes.get(c.id) instanceof HTMLCanvasElement));
      await Promise.all(
        capes.map(async (c) => {
          S.capes.set(c.id, 'loading');
          try {
            const tex = await api.invoke('skins:texture', c.textureUrl, 'cape');
            const canvas = normalizeCape(await loadImage(tex.dataUrl));
            if (token === S.token) S.capes.set(c.id, canvas);
          } catch (err) {
            console.warn('[skins] textura de la capa:', err?.message);
            if (token === S.token) S.capes.set(c.id, 'error');
          }
          if (S.alive && token === S.token) {
            drawCapes();
            updatePreview();
          }
        }),
      );
    }

    function refreshAll() {
      reloads = 0;
      const done = setBusy(refreshBtn);
      Promise.all([loadLibrary(), loadAccount({ force: true })]).finally(done);
    }

    // ---------- Dibujo ----------
    // Conserva el foco entre redibujos (los botones se vuelven a crear con el mismo data-sk-focus)
    function drawAll() {
      if (!S.alive) return;
      const active = document.activeElement;
      const inside = Boolean(active?.closest?.('.sk-root'));
      let focusKey = inside ? active.dataset?.skFocus || null : null;
      if (!inside && focusAfter && (!active || active === document.body)) focusKey = focusAfter;
      drawAccount();
      drawDetail();
      drawLibrary();
      drawCapes();
      updatePreview();
      if (focusKey) restoreFocus(focusKey);
    }

    // El boton de un cambio en curso queda deshabilitado y pierde el foco: vuelve a el cuando termina. Si
    // sigue deshabilitado (por ejemplo, la skin ya quedo en uso), el foco va a la skin elegida.
    function restoreFocus(key) {
      const el = root.querySelector(`[data-sk-focus="${CSS.escape(key)}"]`);
      if (el && !el.disabled) {
        el.focus({ preventScroll: true });
        if (key === focusAfter) focusAfter = null;
      } else if (S.busy) focusAfter = key;
      else {
        focusAfter = null;
        (root.querySelector('.sk-tile[aria-selected="true"]') || viewer.el).focus({ preventScroll: true });
      }
    }

    function busyButton(btn, key) {
      if (S.busy === key) setBusy(btn);
      return btn;
    }

    function drawAccount() {
      const acc = S.account;
      if (acc === undefined) {
        mount(accountCard, skeleton('list', { rows: 1, label: t('skins.loadingAccount') }));
        return;
      }
      const change = h('button', { class: 'btn ghost sm', type: 'button', dataset: { skFocus: 'accounts' }, onclick: () => openAccounts() }, icon('users'), t('skins.changeAccount'));
      if (!acc) {
        // El boton va debajo del texto: en la ventana minima, al costado, el texto quedaba en cuatro lineas
        mount(
          accountCard,
          h(
            'div',
            { class: 'sk-acc-row sk-acc-top' },
            h('div', { class: 'sk-acc-avatar' }, icon('user')),
            h(
              'div',
              { class: 'sk-acc-main' },
              h('div', { class: 'sk-acc-name' }, t('skins.noAccountTitle')),
              h('div', { class: 'sk-acc-sub' }, t('skins.noAccountText')),
              h('button', { class: 'btn tonal sm sk-notice-btn', type: 'button', dataset: { skFocus: 'accounts' }, onclick: () => openAccounts() }, icon('userPlus'), t('skins.addAccount')),
            ),
          ),
        );
        return;
      }
      const msa = acc.type === 'msa';
      const p = S.profile;
      let sub;
      if (!msa) sub = t('skins.offlineSub');
      else if (S.profileLoading || p === undefined) sub = t('skins.loadingProfile');
      else if (p) {
        const cape = p.capes.find((c) => c.id === p.activeCapeId);
        const variant = p.skin ? variantLabel(p.skin.variant) : t('skins.defaultSkin');
        sub = cape ? t('skins.accountSummary', { variant, cape: cape.alias || t('skins.capeUnnamed') }) : t('skins.accountSummaryNoCape', { variant });
      } else sub = t('skins.profileUnavailable');
      const avatar = h('div', { class: 'sk-acc-avatar' }, S.accountSkinState === 'ready' ? headThumb(S.accountSkin.canvas) : icon('user'));
      const row = h(
        'div',
        { class: 'sk-acc-row' },
        avatar,
        h(
          'div',
          { class: 'sk-acc-main' },
          h('div', { class: 'sk-acc-name' }, h('span', { class: 'ellipsis', title: acc.name }, acc.name), h('span', { class: ['badge', msa ? 'info' : ''] }, msa ? t('skins.microsoft') : t('skins.offlineBadge'))),
          h('div', { class: 'sk-acc-sub', title: sub }, sub),
        ),
        change,
      );
      const extra = [];
      if (!msa) {
        extra.push(
          h(
            'div',
            { class: 'notice info' },
            icon('info'),
            h('div', {}, h('div', {}, t('skins.offlineText')), h('button', { class: 'btn sm tonal sk-notice-btn', type: 'button', dataset: { skFocus: 'login' }, onclick: () => openAccounts() }, icon('logIn'), t('skins.loginMicrosoft'))),
          ),
        );
      } else if (S.problem) extra.push(problemNotice(S.problem));
      else if (p && !S.profileLoading) {
        extra.push(
          h(
            'div',
            { class: 'sk-acc-actions' },
            busyButton(h('button', { class: 'btn ghost sm', type: 'button', disabled: Boolean(S.busy) || !p.skin || Boolean(blockReason()), dataset: { skFocus: 'reset' }, onclick: resetSkin }, icon('undo'), t('skins.reset')), 'reset'),
          ),
        );
      }
      mount(accountCard, row, extra);
    }

    function problemNotice(pr) {
      const action = (label, ic, fn, key) => h('button', { class: 'btn sm tonal sk-notice-btn', type: 'button', dataset: { skFocus: key }, onclick: fn }, icon(ic), label);
      if (pr.kind === 'login') return h('div', { class: 'notice' }, icon('alert'), h('div', {}, h('div', {}, pr.message), action(t('skins.relogin'), 'logIn', () => openAccounts(), 'relogin')));
      if (pr.kind === 'offlineMode') return h('div', { class: 'notice info' }, icon('wifiOff'), h('div', {}, h('div', {}, pr.message), action(t('skins.openDownloads'), 'settings', () => navigate('settings/storage/downloads'), 'downloads')));
      const retry = () => action(t('common.retry'), 'refresh', () => loadProfile({ force: true }), 'retry');
      if (pr.kind === 'noGame') return h('div', { class: 'notice' }, icon('alert'), h('div', {}, h('div', {}, pr.message), retry()));
      return h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('div', {}, pr.message), retry()));
    }

    function drawDetail() {
      const sel = S.selected;
      const titleId = 'sk-detail-title';
      if (sel === 'account' && accountTile()) {
        detailCard.hidden = false;
        const p = S.profile;
        const loading = S.profileLoading || p === undefined || S.accountSkinState === 'loading';
        const saved = currentInLibrary();
        mount(
          detailCard,
          h('div', { class: 'sk-detail-head' }, h('h2', { class: 'sk-detail-title', id: titleId }, t('skins.currentSkin')), h('span', { class: 'badge good' }, icon('check'), t('skins.inAccount'))),
          h('p', { class: 'sk-detail-meta' }, loading ? t('skins.loadingSkin') : p?.skin ? t('skins.currentMeta', { variant: variantLabel(p.skin.variant), name: p.name }) : t('skins.profileUnavailable')),
          h(
            'div',
            { class: 'sk-actions' },
            busyButton(
              h(
                'button',
                { class: 'btn tonal', type: 'button', disabled: Boolean(S.busy) || loading || S.accountSkinState !== 'ready' || saved, dataset: { skFocus: 'saveCurrent' }, onclick: saveCurrent },
                icon(saved ? 'check' : 'download'),
                t(saved ? 'skins.alreadySavedBtn' : 'skins.saveCurrent'),
              ),
              'save',
            ),
          ),
          h('p', { class: 'sk-note' }, icon('info'), h('span', {}, t('skins.saveCurrentHint'))),
        );
        return;
      }
      const it = itemOf(sel);
      // Sin nada elegido la tarjeta no se muestra: la biblioteca vacia ya invita a agregar una skin
      detailCard.hidden = !it && (S.library === undefined || !S.library.length);
      if (!it) {
        mount(
          detailCard,
          h('h2', { class: 'sr-only', id: titleId }, t('skins.detailTitle')),
          emptyState('skShirt', t('skins.detailEmptyTitle'), t('skins.detailEmptyText')),
        );
        return;
      }
      const n = S.norm.get(it.id);
      const damaged = it.broken || n?.error;
      const current = inUse(it) && it.variant === S.profile?.skin?.variant; // ya es la skin de la cuenta, con el mismo modelo
      const reason = damaged ? t('skins.reasonDamaged') : blockReason() || (current ? t('skins.reasonInUse') : null);
      const seg = h(
        'div',
        { class: 'segmented sk-seg', role: 'group', 'aria-labelledby': 'sk-variant-label' },
        ['classic', 'slim'].map((v) =>
          h(
            'button',
            {
              type: 'button',
              class: it.variant === v ? 'active' : null,
              'aria-pressed': String(it.variant === v),
              disabled: damaged || (v === 'slim' && it.legacy),
              title: v === 'slim' && it.legacy ? t('skins.legacyOnlyClassic') : null,
              dataset: { skFocus: `variant:${v}` },
              onclick: () => setVariant(it, v),
            },
            variantLabel(v),
          ),
        ),
      );
      mount(
        detailCard,
        h(
          'div',
          { class: 'sk-detail-head' },
          h('h2', { class: 'sk-detail-title ellipsis', id: titleId, title: it.name }, it.name),
          h('div', { class: 'sk-detail-tools' }, iconAction('edit', t('skins.rename'), () => renameItem(it), 'rename'), iconAction('trash', t('skins.delete'), () => removeItem(it), 'delete', true)),
        ),
        h(
          'div',
          { class: 'sk-detail-meta' },
          inUse(it) ? h('span', { class: 'badge good' }, icon('check'), t('skins.inUse')) : null,
          it.legacy ? h('span', { class: 'badge', title: t('skins.legacyHint') }, t('skins.legacyBadge')) : null,
          damaged ? h('span', { class: 'badge bad' }, icon('alert'), t('skins.damaged')) : null,
          h('span', {}, t('skins.addedOn', { date: fmtDate(it.addedAt) })),
        ),
        h('div', { class: 'sk-field' }, h('span', { class: 'sk-label', id: 'sk-variant-label' }, t('skins.model')), seg, h('span', { class: 'sk-field-help' }, t('skins.modelHelp'))),
        h(
          'div',
          { class: 'sk-actions' },
          busyButton(h('button', { class: 'btn primary', type: 'button', disabled: Boolean(S.busy) || Boolean(reason), dataset: { skFocus: 'apply' }, onclick: applySelected }, icon('check'), t('skins.apply')), 'apply'),
          h('button', { class: 'btn', type: 'button', disabled: damaged, dataset: { skFocus: 'export' }, onclick: (e) => exportItem(it, e.currentTarget) }, icon('download'), t('skins.export')),
        ),
        reason ? h('p', { class: 'sk-reason' }, icon('info'), h('span', {}, reason)) : h('p', { class: 'sk-note' }, icon('info'), h('span', {}, t('skins.inGameNote'))),
      );
    }

    function iconAction(name, label, onclick, key, danger = false) {
      return h('button', { class: ['icon-btn sm', danger && 'danger'], type: 'button', title: label, 'aria-label': label, dataset: { skFocus: key }, onclick }, icon(name));
    }

    function tile({ id, name, art, meta, badge, broken }) {
      const selected = S.selected === id;
      return h(
        'div',
        {
          class: ['sk-tile', selected && 'active', broken && 'broken'],
          role: 'option',
          'aria-selected': String(selected),
          tabindex: selected ? '0' : '-1',
          title: name,
          dataset: { skFocus: `tile:${id}`, id },
          onclick: (e) => {
            pick(id);
            e.currentTarget.isConnected ? e.currentTarget.focus() : root.querySelector(`[data-sk-focus="tile:${CSS.escape(id)}"]`)?.focus();
          },
        },
        h('div', { class: 'sk-tile-art' }, art, badge || null),
        h('div', { class: 'sk-tile-name ellipsis' }, name),
        h('div', { class: 'sk-tile-meta', title: meta }, meta),
      );
    }

    function drawLibrary() {
      const lib = S.library;
      libCount.textContent = lib ? t('skins.libraryCount', { count: lib.length, max: S.max }) : '';
      if (lib === undefined) {
        mount(libraryHost, skeleton('grid', { items: 4, min: 128, label: t('skins.loadingLibrary') }));
        return;
      }
      const tiles = [];
      if (accountTile()) {
        const ready = S.accountSkinState === 'ready';
        tiles.push(
          tile({
            id: 'account',
            name: t('skins.currentSkin'),
            art: ready ? skinThumb(S.accountSkin.canvas, S.profile?.skin?.variant) : S.accountSkinState === 'error' ? icon('alert', 'sk-tile-icon') : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
            meta: ready ? t('skins.currentTileMeta', { variant: variantLabel(S.profile?.skin?.variant) }) : S.accountSkinState === 'error' ? t('skins.previewFailedShort') : t('skins.loadingShort'),
            badge: h('span', { class: 'sk-tile-badge', title: t('skins.inAccount') }, icon('user'), h('span', { class: 'sr-only' }, t('skins.inAccount'))),
          }),
        );
      }
      for (const it of lib) {
        const n = S.norm.get(it.id);
        const broken = it.broken || n?.error;
        tiles.push(
          tile({
            id: it.id,
            name: it.name,
            broken,
            art: broken ? icon('alert', 'sk-tile-icon') : n?.canvas ? skinThumb(n.canvas, it.variant) : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
            meta: broken ? t('skins.damaged') : it.legacy ? t('skins.legacyShort') : variantLabel(it.variant),
            badge: inUse(it) ? h('span', { class: 'sk-tile-badge good', title: t('skins.inUse') }, icon('check'), h('span', { class: 'sr-only' }, t('skins.inUse'))) : null,
          }),
        );
      }
      const notice = S.libraryError ? h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('div', {}, t('skins.libraryFailed')), h('button', { class: 'btn sm tonal sk-notice-btn', type: 'button', dataset: { skFocus: 'libraryRetry' }, onclick: () => loadLibrary() }, icon('refresh'), t('common.retry')))) : null;
      if (!tiles.length) {
        mount(
          libraryHost,
          notice,
          h(
            'div',
            { class: 'sk-drop-empty' },
            emptyState('skShirt', t('skins.emptyTitle'), t('skins.emptyText'), h('button', { class: 'btn tonal', type: 'button', dataset: { skFocus: 'addLibrary' }, onclick: () => addSkins() }, icon('plus'), t('skins.add'))),
          ),
        );
        return;
      }
      const grid = h('div', { class: 'sk-grid', role: 'listbox', 'aria-label': t('skins.libraryTitle'), 'aria-orientation': 'horizontal', onkeydown: onGridKey }, tiles);
      mount(libraryHost, notice, grid, h('p', { class: 'sk-drop-hint' }, icon('upload'), h('span', {}, t('skins.dropHint'))));
    }

    // Flechas, Inicio y Fin en la grilla (la seleccion sigue al foco: es solo la vista previa)
    function onGridKey(e) {
      const grid = e.currentTarget;
      const items = [...grid.querySelectorAll('[role="option"]')];
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      const cols = Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
      const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: items.length - 1 - i };
      if (!(e.key in moves)) return;
      e.preventDefault();
      const next = items[Math.min(items.length - 1, Math.max(0, i + moves[e.key]))];
      if (!next || next === items[i]) return;
      pick(next.dataset.id);
      root.querySelector(`[data-sk-focus="tile:${CSS.escape(next.dataset.id)}"]`)?.focus();
    }

    function drawCapes() {
      const p = S.profile;
      capesSection.hidden = !(isMsa() && p && !S.problem);
      if (capesSection.hidden) return;
      if (!p.capes.length) {
        mount(capesHost, h('p', { class: 'sk-empty-line' }, icon('info'), h('span', {}, t('skins.noCapes'))));
        return;
      }
      const blocked = Boolean(blockReason());
      const capeTile = (c) => {
        const id = c ? c.id : null;
        const active = (p.activeCapeId || null) === id;
        const tex = c ? S.capes.get(c.id) : null;
        const art = !c ? icon('skNoCape', 'sk-cape-none') : tex instanceof HTMLCanvasElement ? capeThumb(tex) : tex === 'error' || !c.textureUrl ? icon('alert', 'sk-cape-none') : h('div', { class: 'spinner', 'aria-hidden': 'true' });
        const name = c ? c.alias || t('skins.capeUnnamed') : t('skins.noCape');
        const btn = h(
          'button',
          {
            type: 'button',
            class: ['sk-cape', active && 'active'],
            'aria-pressed': String(active),
            disabled: Boolean(S.busy) || blocked,
            title: name,
            dataset: { skFocus: `cape:${id || 'none'}` },
            onclick: () => changeCape(c),
          },
          h('div', { class: 'sk-cape-art' }, art),
          h('span', { class: 'sk-cape-name ellipsis' }, name),
          active ? h('span', { class: 'sk-cape-check' }, icon('check'), h('span', { class: 'sr-only' }, t('skins.capeActive'))) : null,
        );
        if (S.busy === `cape:${id || 'none'}`) setBusy(btn);
        return btn;
      };
      mount(capesHost, h('div', { class: 'sk-capes', role: 'group', 'aria-label': t('skins.capesTitle') }, capeTile(null), p.capes.map(capeTile)));
    }

    function updatePreview() {
      let skin = null;
      let variant = 'classic';
      let status = '';
      if (S.selected === 'account') {
        if (S.accountSkinState === 'ready') {
          skin = S.accountSkin.canvas;
          variant = S.profile?.skin?.variant || 'classic';
        } else status = S.accountSkinState === 'error' ? t('skins.previewFailed') : t('skins.loadingSkin');
      } else if (S.selected) {
        const it = itemOf(S.selected);
        const n = it && S.norm.get(it.id);
        if (n?.canvas) {
          skin = n.canvas;
          variant = it.variant;
        } else if (it?.broken || n?.error) status = t('skins.previewFailed');
        else status = t('skins.loadingSkin');
      } else status = S.library === undefined || S.account === undefined ? t('skins.loadingSkin') : t('skins.previewEmpty');
      const target = skin || blank.canvas;
      if (!shown || shown.canvas !== target || shown.variant !== variant) {
        viewer.setSkin(target, variant);
        shown = { canvas: target, variant };
      }
      viewerStatus.textContent = status;
      viewerStatus.hidden = !status;
      viewer.el.classList.toggle('sk-placeholder', !skin);
      const capeId = S.profile?.activeCapeId;
      const tex = capeId ? S.capes.get(capeId) : null;
      const cape = isMsa() && tex instanceof HTMLCanvasElement ? tex : null;
      if (cape !== shownCape) {
        viewer.setCape(cape);
        shownCape = cape;
      }
      syncViewBar();
    }

    function syncViewBar(v = viewer.view()) {
      frontBtn.classList.toggle('active', v.side === 'front');
      frontBtn.setAttribute('aria-pressed', String(v.side === 'front'));
      backBtn.classList.toggle('active', v.side === 'back');
      backBtn.setAttribute('aria-pressed', String(v.side === 'back'));
      capeBtn.hidden = !viewer.hasCape;
      capeBtn.classList.toggle('active', viewer.capeVisible);
      capeBtn.setAttribute('aria-pressed', String(viewer.capeVisible));
      const capeLabel = t(viewer.capeVisible ? 'skins.hideCape' : 'skins.showCape');
      capeBtn.title = capeLabel;
      capeBtn.setAttribute('aria-label', capeLabel);
      pauseBtn.hidden = reducedMotion() || !viewer.has3d;
      const pauseLabel = t(viewer.paused ? 'skins.playAnimation' : 'skins.pauseAnimation');
      pauseBtn.title = pauseLabel;
      pauseBtn.setAttribute('aria-label', pauseLabel);
      pauseBtn.setAttribute('aria-pressed', String(viewer.paused));
      if (pauseIcon !== viewer.paused) {
        pauseIcon = viewer.paused;
        mount(pauseBtn, icon(viewer.paused ? 'play' : 'pause'));
      }
      for (const b of [rotL, rotR, frontBtn.parentElement]) b.hidden = !viewer.has3d;
    }

    // ---------- Acciones ----------
    function afterAdd(r) {
      if (!r || !S.alive) return;
      const added = r.added || [];
      const dups = r.duplicates || [];
      const failed = r.failed || [];
      if (added.length) ok(t('skins.added', { count: added.length }), added.length === 1 ? added[0].name : null);
      else if (dups.length) toast('info', t('skins.alreadyInLibrary'), dups.map((d) => d.name).join(', '));
      if (failed.length === 1) fail(t('skins.addFailedOne', { name: failed[0].name || t('skins.unnamedFile') }), failed[0].message);
      else if (failed.length > 1) fail(t('skins.addFailedMany', { count: failed.length }), failed[0].message);
      if (r.skipped) toast('info', t('skins.tooManyFiles', { count: r.skipped }));
      const first = added[0] || dups[0];
      if (first) {
        S.selected = first.id;
        S.userPicked = true;
        lastPick = first.id;
      }
      loadLibrary();
    }

    async function addSkins() {
      const done = setBusy(addBtn);
      try {
        afterAdd(await api.invoke('skins:add'));
      } catch (err) {
        if (S.alive) fail(t('skins.addFailed'), err);
      } finally {
        done();
      }
    }

    function actionError(err, title) {
      const kind = problemOf(err);
      if (kind === 'login' || kind === 'offlineMode' || kind === 'noGame') S.problem = { kind, message: err?.message || String(err) };
      fail(title, err);
      if (kind === 'changed' || kind === 'offlineAccount') accountsChanged = true; // se vuelve a leer al terminar
    }

    async function withChange(key, fn) {
      if (S.busy) return;
      S.busy = key;
      drawAll();
      try {
        await fn();
      } finally {
        S.busy = null;
        if (S.alive) {
          drawAll();
          focusAfter = null;
          if (accountsChanged) {
            accountsChanged = false;
            loadAccount();
          }
        }
      }
    }

    // Guarda antes la skin actual si el jugador lo pidio. false si no se pudo (y no se cambia nada).
    async function backupCurrent() {
      try {
        await api.invoke('skins:saveCurrent', S.account.id);
        await loadLibrary();
        return true;
      } catch (err) {
        if (S.alive) actionError(err, t('skins.backupFailed'));
        return false;
      }
    }

    async function applySelected() {
      const it = itemOf(S.selected);
      if (!it || S.busy || blockReason()) return;
      const answer = await confirmChange({
        title: t('skins.applyTitle'),
        text: t('skins.applyText', { skin: it.name, account: S.account.name, variant: variantLabel(it.variant) }),
        okText: t('skins.apply'),
        offerBackup: S.accountSkinState === 'ready' && !currentInLibrary() && !inUse(it),
        note: t('skins.inGameNote'),
      });
      if (!answer || !S.alive) return;
      await withChange('apply', async () => {
        if (answer.backup && !(await backupCurrent())) return;
        try {
          const view = await api.invoke('skins:apply', it.id, S.account.id, it.variant);
          if (!S.alive) return;
          ok(t('skins.applied', { skin: it.name }), t('skins.inGameNote'));
          if (view) setProfile(view);
          else loadProfile({ force: true });
        } catch (err) {
          if (S.alive) actionError(err, t('skins.applyFailed'));
        }
      });
    }

    async function resetSkin() {
      if (S.busy || blockReason()) return;
      const answer = await confirmChange({
        title: t('skins.resetTitle'),
        text: t('skins.resetText', { account: S.account.name }),
        okText: t('skins.resetOk'),
        offerBackup: S.accountSkinState === 'ready' && !currentInLibrary(),
        note: t('skins.inGameNote'),
      });
      if (!answer || !S.alive) return;
      await withChange('reset', async () => {
        if (answer.backup && !(await backupCurrent())) return;
        try {
          const view = await api.invoke('skins:reset', S.account.id);
          if (!S.alive) return;
          ok(t('skins.resetDone'), t('skins.inGameNote'));
          if (view) setProfile(view);
          else loadProfile({ force: true });
        } catch (err) {
          if (S.alive) actionError(err, t('skins.resetFailed'));
        }
      });
    }

    async function changeCape(c) {
      const id = c ? c.id : null;
      if (S.busy || blockReason() || (S.profile?.activeCapeId || null) === id) return;
      await withChange(`cape:${id || 'none'}`, async () => {
        try {
          const view = await api.invoke('skins:cape', id, S.account.id);
          if (!S.alive) return;
          ok(c ? t('skins.capeChanged', { name: c.alias || t('skins.capeUnnamed') }) : t('skins.capeHidden'), t('skins.inGameNote'));
          if (view) setProfile(view);
          else loadProfile({ force: true });
        } catch (err) {
          if (S.alive) actionError(err, t('skins.capeFailed'));
        }
      });
    }

    async function saveCurrent() {
      if (S.busy || !isMsa()) return;
      await withChange('save', async () => {
        try {
          const r = await api.invoke('skins:saveCurrent', S.account.id);
          if (!S.alive) return;
          if (r.duplicate) toast('info', t('skins.alreadyInLibrary'), r.item?.name);
          else ok(t('skins.savedCurrent'), r.item?.name);
          await loadLibrary();
        } catch (err) {
          if (S.alive) actionError(err, t('skins.saveFailed'));
        }
      });
    }

    async function setVariant(it, v) {
      if (it.variant === v) return;
      try {
        const upd = await api.invoke('skins:setVariant', it.id, v);
        if (!S.alive) return;
        Object.assign(it, { variant: upd.variant, updatedAt: upd.updatedAt });
        S.norm.set(it.id, { ...S.norm.get(it.id), key: `${it.pixelHash || it.sha1 || ''}:${it.updatedAt}` });
        drawAll();
      } catch (err) {
        if (S.alive) fail(t('skins.variantFailed'), err);
      }
    }

    async function renameItem(it) {
      const name = await promptDialog(t('skins.renameTitle'), t('skins.nameLabel'), { value: it.name, okText: t('skins.save') });
      if (!name || name === it.name || !S.alive) return;
      try {
        const upd = await api.invoke('skins:rename', it.id, name);
        if (!S.alive) return;
        Object.assign(it, { name: upd.name, updatedAt: upd.updatedAt });
        S.norm.set(it.id, { ...S.norm.get(it.id), key: `${it.pixelHash || it.sha1 || ''}:${it.updatedAt}` });
        drawAll();
      } catch (err) {
        if (S.alive) fail(t('skins.renameFailed'), err);
      }
    }

    async function removeItem(it) {
      if (!(await confirmDialog(t('skins.deleteTitle'), t('skins.deleteText', { name: it.name }), { okText: t('skins.delete'), danger: true }))) return;
      try {
        await api.invoke('skins:remove', it.id);
        if (!S.alive) return;
        S.norm.delete(it.id);
        S.library = (S.library || []).filter((i) => i.id !== it.id);
        if (S.selected === it.id) {
          S.selected = null;
          lastPick = null;
        }
        ensureSelection();
        drawAll();
        // El foco no se queda en "Borrar" de la skin siguiente: va a la skin que quedo elegida
        (root.querySelector('.sk-tile[aria-selected="true"]') || addBtn).focus({ preventScroll: true });
        ok(t('skins.deleted', { name: it.name }));
      } catch (err) {
        if (S.alive) fail(t('skins.deleteFailed'), err);
      }
    }

    async function exportItem(it, btn) {
      const done = setBusy(btn);
      try {
        const r = await api.invoke('skins:export', it.id);
        if (r && S.alive) ok(t('skins.exported'), r.name);
      } catch (err) {
        if (S.alive) fail(t('skins.exportFailed'), err);
      } finally {
        done();
      }
    }

    // ---------- Arranque ----------
    drawAll();
    loadLibrary();
    loadAccount();
    // Si cambian las cuentas durante un cambio en curso, se vuelve a leer la cuenta cuando termina
    const offAccounts = store.on('accounts', () => {
      if (!S.alive) return;
      reloads = 0;
      if (S.busy) accountsChanged = true;
      else loadAccount();
    });

    return () => {
      S.alive = false;
      S.token++;
      if (S.selected) lastPick = S.selected;
      offAccounts();
      viewer.destroy();
    };
  },
};
