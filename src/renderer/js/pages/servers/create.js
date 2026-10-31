// Asistente para crear un servidor: tipo -> version y recursos -> mundo, jugadores y EULA.
import { h, icon, mount, modal, fail, toast, selectEl, switchEl, loading, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { loadTypes, typeMeta, KIND_ORDER, KIND_ICON, memLabel, motdNodes, animateObfuscated, tryInvoke } from './common.js';

// "1.20.4" >= "1.19"? (las snapshots semanales cuentan como nuevas)
export function mcAtLeast(v, min) {
  const parse = (s) => {
    const m = String(s).match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : [999, 0, 0];
  };
  const a = parse(v);
  const b = parse(min);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function levelTypeOptions(mc) {
  const modern = mcAtLeast(mc, '1.19');
  const ids = modern ? ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'] : ['default', 'flat', 'largeBiomes', 'amplified'];
  const keys = ['normal', 'flat', 'large_biomes', 'amplified', 'single_biome_surface'];
  return ids.map((id, i) => ({ value: id, label: t(`servers.levelType_${keys[i]}`) }));
}

async function totalMemoryMb() {
  try {
    const info = await api.system.info();
    return Math.floor(info.totalMem / 1048576);
  } catch {
    return 8192;
  }
}

export function ramSlider(value, maxMb, onChange) {
  const max = Math.max(2048, Math.min(32768, Math.floor((maxMb - 1024) / 512) * 512));
  const label = h('span', { class: 'kbd sv-ram-value', 'aria-hidden': 'true' }, memLabel(value));
  const input = h('input', { type: 'range', class: 'range', min: 512, max, step: 512, value: Math.min(value, max), 'aria-label': t('servers.wzRam'), 'aria-valuetext': memLabel(Math.min(value, max)) });
  input.addEventListener('input', () => {
    label.textContent = memLabel(Number(input.value));
    input.setAttribute('aria-valuetext', memLabel(Number(input.value)));
    onChange(Number(input.value));
  });
  return {
    label,
    input,
    marks: h('div', { class: 'ram-marks' }, h('span', {}, '512 MB'), h('span', {}, memLabel(Math.round(max / 2 / 512) * 512)), h('span', {}, memLabel(max))),
  };
}

let fieldSeq = 0;
function field(label, control, hint) {
  // La etiqueta queda unida al control (clic en la etiqueta y nombre para el lector de pantalla)
  if (!control.id) control.id = `sv-wz-f${++fieldSeq}`;
  return h('div', { class: 'field' }, h('label', { for: control.id }, label), control, hint ? h('div', { class: 'field-help' }, hint) : null);
}

// Error de un campo: texto + aria-invalid (vacio no ocupa lugar)
function fieldError(id) {
  const el = h('div', { class: 'field-error sv-err', id, role: 'alert' });
  return {
    el,
    set(input, text) {
      input.setAttribute('aria-invalid', text ? 'true' : 'false');
      mount(el, text ? [icon('alert'), h('span', {}, text)] : null);
    },
  };
}

function toggleRow(title, sub, checked, onChange) {
  return h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, title), sub ? h('div', { class: 'tr-sub' }, sub) : null), switchEl(checked, onChange, title));
}

export async function openCreateWizard({ onCreated, type: presetType } = {}) {
  const types = await loadTypes();
  const account = store.selectedAccount();
  const totalMb = await totalMemoryMb();
  const st = {
    step: 0,
    type: presetType && types.some((x) => x.id === presetType) ? presetType : 'paper',
    snapshots: false,
    versions: [],
    mc: null,
    loaderList: [],
    loaderVersion: 'latest',
    name: t('servers.wzDefaultName'),
    port: null,
    mem: totalMb >= 12000 ? 4096 : totalMb >= 7000 ? 3072 : 2048,
    memTouched: false,
    motd: '',
    gamemode: 'survival',
    difficulty: 'normal',
    maxPlayers: 10,
    seed: '',
    levelType: '',
    hardcore: false,
    pvp: true,
    onlineMode: account?.type === 'msa',
    whitelist: false,
    opMe: Boolean(account),
    eula: false,
    creating: false,
  };
  const meta = () => typeMeta(st.type);
  const isProxy = () => meta().kind === 'proxy';

  const body = h('div', { class: 'sv-wizard' });
  const steps = h('div', { class: 'sv-steps', role: 'list' });
  const backBtn = h('button', { class: 'btn ghost' }, icon('chevronLeft'), t('common.previous'));
  const nextBtn = h('button', { class: 'btn primary' }, t('common.next'), icon('chevronRight'));
  const createBtn = h('button', { class: 'btn primary' }, icon('server'), t('servers.wzCreate'));
  const cancelBtn = h('button', { class: 'btn ghost' }, t('common.cancel'));

  const STEP_KEYS = ['wzStepType', 'wzStepVersion', 'wzStepWorld'];
  const drawSteps = () =>
    mount(
      steps,
      STEP_KEYS.map((k, i) =>
        h(
          'div',
          { class: ['sv-step', i === st.step && 'active', i < st.step && 'done'], role: 'listitem', 'aria-current': i === st.step ? 'step' : null },
          h('span', { class: 'sv-step-n' }, i < st.step ? icon('check') : String(i + 1)),
          h('span', {}, t(`servers.${k}`)),
        ),
      ),
    );

  // ---------- Paso 1: tipo ----------
  const drawTypeStep = () => {
    const groups = KIND_ORDER.map((kind) => {
      const list = types.filter((x) => x.kind === kind);
      if (!list.length) return null;
      return h(
        'div',
        { class: 'sv-kind' },
        h('div', { class: 'sv-kind-head' }, icon(KIND_ICON[kind]), h('span', { class: 'sv-kind-name' }, t(`servers.kind_${kind}`)), h('span', { class: 'sv-kind-desc' }, t(`servers.kindDesc_${kind}`))),
        h(
          'div',
          { class: 'sv-type-grid' },
          list.map((x) =>
            h(
              'button',
              {
                class: ['sv-type', st.type === x.id && 'active'],
                style: { '--c': x.color },
                'aria-pressed': st.type === x.id ? 'true' : 'false',
                onclick: () => {
                  if (st.type !== x.id) {
                    st.type = x.id;
                    st.mc = null;
                    st.versions = [];
                    st.loaderVersion = 'latest';
                    st.port = null;
                  }
                  draw();
                },
                ondblclick: () => go(1),
              },
              h('span', { class: 'sv-type-letter', 'aria-hidden': 'true' }, x.letter),
              h('span', { class: 'sv-type-main' }, h('span', { class: 'sv-type-name' }, x.name, x.experimental ? h('span', { class: 'badge warn' }, t('servers.experimental')) : null, x.deprecated ? h('span', { class: 'badge bad' }, t('servers.deprecated')) : null, x.slow ? h('span', { class: 'badge' }, icon('clock'), t('servers.slowBuild')) : null), h('span', { class: 'sv-type-desc' }, x.description || '')),
              h('span', { class: 'sv-type-check', 'aria-hidden': 'true' }, icon('check')),
            ),
          ),
        ),
      );
    });
    const notes = [];
    if (isProxy()) notes.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, h('strong', {}, t('servers.proxyWhatTitle')), ' ', t('servers.proxyWhatText'))));
    mount(body, h('div', { class: 'stack' }, notes, groups));
  };

  // ---------- Paso 2: version y recursos ----------
  const versionBox = h('div', { class: 'field' });
  const loaderBox = h('div', { class: 'field' });

  async function loadVersions() {
    const type = st.type;
    const snaps = st.snapshots;
    mount(versionBox, h('label', {}, isProxy() ? t('servers.wzProxyVersion') : t('servers.wzVersion')), h('div', { class: 'row small muted' }, h('div', { class: 'spinner' }), t('common.loading')));
    try {
      const list = await api.invoke('servers:versions', type, { snapshots: snaps });
      if (st.type !== type || st.snapshots !== snaps) return;
      st.versions = list;
      if (!st.mc || !list.includes(st.mc)) st.mc = list[0] || null;
      mount(
        versionBox,
        h('label', { for: 'sv-wz-version' }, isProxy() ? t('servers.wzProxyVersion') : t('servers.wzVersion')),
        list.length
          ? (() => {
              const sel = selectEl(list.map((v) => ({ value: v, label: v })), st.mc, (v) => {
                st.mc = v;
                loadLoaders();
                updateButtons();
              });
              sel.id = 'sv-wz-version';
              return sel;
            })()
          : h('div', { class: 'small muted' }, t('servers.wzNoVersions')),
      );
      loadLoaders();
    } catch (err) {
      if (st.type === type) {
        mount(
          versionBox,
          h('label', {}, t('servers.wzVersion')),
          h('div', { class: 'notice bad sv-error' }, icon('alert'), h('div', {}, t('servers.wzVersionsError'), h('div', { class: 'tiny' }, err.message)), h('button', { class: 'btn sm', onclick: () => loadVersions() }, icon('refresh'), t('common.retry'))),
        );
      }
    }
    updateButtons();
  }

  async function loadLoaders() {
    if (!meta().loaderVersions || !st.mc) {
      mount(loaderBox);
      st.loaderVersion = 'latest';
      return;
    }
    const type = st.type;
    const mc = st.mc;
    mount(loaderBox, h('label', {}, t('servers.wzLoaderVersion', { name: meta().name })), h('div', { class: 'row small muted' }, h('div', { class: 'spinner' }), t('common.loading')));
    const list = await tryInvoke('servers:loaderVersions', [type, mc], null).catch(() => null) || (await api.loaders.versions(type, mc).catch(() => []));
    if (st.type !== type || st.mc !== mc) return;
    st.loaderList = list;
    const pick = list.find((l) => l.recommended) || list.find((l) => l.stable) || list[0];
    st.loaderVersion = pick?.version || 'latest';
    const loaderSel = list.length
      ? selectEl(
          list.slice(0, 200).map((l) => ({ value: l.version, label: `${l.label || l.version}${l.recommended ? ` · ${t('servers.recommended')}` : !l.stable ? ` · ${t('servers.beta')}` : ''}` })),
          st.loaderVersion,
          (v) => (st.loaderVersion = v),
        )
      : null;
    if (loaderSel) loaderSel.id = 'sv-wz-loader';
    mount(loaderBox, h('label', { for: loaderSel ? 'sv-wz-loader' : null }, t('servers.wzLoaderVersion', { name: meta().name })), loaderSel || h('div', { class: 'small muted' }, t('servers.wzNoLoader')));
  }

  const defaultMem = totalMb >= 12000 ? 4096 : totalMb >= 7000 ? 3072 : 2048;
  const drawVersionStep = async () => {
    if (st.port === null) st.port = (await tryInvoke('servers:suggestPort', [st.type], 25565).catch(() => 25565)) || 25565;
    // Un proxy necesita poca memoria: se propone 1 GB salvo que el usuario la haya cambiado.
    if (!st.memTouched) st.mem = isProxy() ? 1024 : defaultMem;
    const m = meta();
    const nameErr = fieldError('sv-wz-name-err');
    const portErr = fieldError('sv-wz-port-err');
    const nameInput = h('input', { class: 'input', id: 'sv-wz-name', value: st.name, maxlength: 60, required: true, 'aria-describedby': 'sv-wz-name-err' });
    const checkName = () => nameErr.set(nameInput, String(st.name || '').trim() ? null : t('servers.wzNameRequired'));
    const portOk = () => Number.isInteger(st.port) && st.port >= 1 && st.port <= 65535;
    const checkPort = () => portErr.set(portInput, portOk() ? null : t('servers.wzPortInvalid'));
    nameInput.addEventListener('input', () => {
      st.name = nameInput.value;
      if (nameInput.getAttribute('aria-invalid') === 'true') checkName();
      updateButtons();
    });
    // Se valida al salir del campo; si ya estaba marcado, el error se va apenas se corrige
    nameInput.addEventListener('blur', checkName);
    const portInput = h('input', { class: 'input num', id: 'sv-wz-port', type: 'number', min: 1, max: 65535, value: st.port, required: true, 'aria-describedby': 'sv-wz-port-err sv-wz-port-help' });
    portInput.addEventListener('input', () => {
      st.port = Number(portInput.value);
      if (portInput.getAttribute('aria-invalid') === 'true') checkPort();
      updateButtons();
    });
    portInput.addEventListener('blur', checkPort);
    const ram = ramSlider(st.mem, totalMb, (v) => {
      st.mem = v;
      st.memTouched = true;
    });
    ram.input.id = 'sv-wz-ram';
    const notes = [];
    if (m.slow) notes.push(h('div', { class: 'notice' }, icon('clock'), t('servers.wzSpigotNote')));
    if (m.id === 'folia') notes.push(h('div', { class: 'notice' }, icon('alert'), t('servers.wzFoliaNote')));
    if (m.kind === 'hybrid') notes.push(h('div', { class: 'notice' }, icon('alert'), t('servers.wzHybridNote')));
    if (m.deprecated) notes.push(h('div', { class: 'notice' }, icon('alert'), t('servers.wzWaterfallNote')));
    mount(
      body,
      h(
        'div',
        { class: 'stack' },
        notes,
        h(
          'div',
          { class: 'form-grid' },
          h('div', { class: 'field' }, h('label', { for: 'sv-wz-name' }, t('servers.wzName')), nameInput, nameErr.el),
          versionBox,
          h('div', { class: 'field' }, h('label', { for: 'sv-wz-port' }, t('servers.wzPort')), portInput, portErr.el, h('div', { class: 'field-help', id: 'sv-wz-port-help' }, isProxy() ? t('servers.wzProxyPortHint') : t('servers.wzPortHint'))),
          loaderBox,
          m.snapshots ? h('div', { class: 'full' }, toggleRow(t('servers.wzSnapshots'), t('servers.wzSnapshotsHint'), st.snapshots, (v) => ((st.snapshots = v), loadVersions()))) : null,
          h(
            'div',
            { class: 'full sv-ram' },
            h('div', { class: 'row' }, h('label', { class: 'label spacer', for: 'sv-wz-ram' }, t('servers.wzRam')), ram.label),
            ram.input,
            ram.marks,
            h('div', { class: 'field-help' }, isProxy() ? t('servers.wzRamProxyHint') : t('servers.wzRamHint', { total: memLabel(Math.round(totalMb / 1024) * 1024) })),
          ),
        ),
      ),
    );
    loadVersions();
  };

  // ---------- Paso 3: mundo y jugadores ----------
  const drawWorldStep = () => {
    if (isProxy()) {
      mount(
        body,
        h(
          'div',
          { class: 'stack' },
          h('div', { class: 'notice info' }, icon('svProxy'), h('div', {}, h('strong', {}, t('servers.proxyWhatTitle')), ' ', t('servers.proxyWhatText'))),
          h('div', { class: 'card flat sv-steps-list' }, h('div', { class: 'card-title' }, icon('list'), t('servers.proxyStepsTitle')), h('ol', { class: 'steps' }, h('li', {}, t('servers.proxyStep1')), h('li', {}, t('servers.proxyStep2')), h('li', {}, t('servers.proxyStep3')), h('li', {}, t('servers.proxyStep4')))),
        ),
      );
      return;
    }
    const motdInput = h('input', { class: 'input', id: 'sv-wz-motd', value: st.motd, maxlength: 120, placeholder: t('servers.wzMotdPlaceholder', { name: st.name || t('servers.wzDefaultName') }) });
    const preview = h('div', { class: 'sv-motd-mini' });
    const drawPreview = () => mount(preview, motdNodes(st.motd || t('servers.wzMotdPlaceholder', { name: st.name || t('servers.wzDefaultName') })));
    motdInput.addEventListener('input', () => {
      st.motd = motdInput.value;
      drawPreview();
    });
    drawPreview();
    animateObfuscated(preview);
    const players = h('input', { class: 'input', id: 'sv-wz-players', type: 'number', min: 1, max: 1000, value: st.maxPlayers });
    players.addEventListener('input', () => (st.maxPlayers = Number(players.value) || 10));
    const seed = h('input', { class: 'input', id: 'sv-wz-seed', value: st.seed, placeholder: t('servers.wzSeedRandom') });
    seed.addEventListener('input', () => (st.seed = seed.value));
    const eula = h('input', { type: 'checkbox', checked: st.eula, id: 'sv-wz-eula' });
    eula.addEventListener('change', () => {
      st.eula = eula.checked;
      updateButtons();
    });
    const offlineAccount = account && account.type !== 'msa';
    mount(
      body,
      h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'form-grid' },
          field(t('servers.wzGamemode'), selectEl(['survival', 'creative', 'adventure', 'spectator'].map((v) => ({ value: v, label: t(`servers.gamemode_${v}`) })), st.gamemode, (v) => (st.gamemode = v))),
          field(t('servers.wzDifficulty'), selectEl(['peaceful', 'easy', 'normal', 'hard'].map((v) => ({ value: v, label: t(`servers.difficulty_${v}`) })), st.difficulty, (v) => (st.difficulty = v))),
          h('div', { class: 'field' }, h('label', { for: 'sv-wz-players' }, t('servers.wzMaxPlayers')), players),
          h('div', { class: 'field' }, h('label', { for: 'sv-wz-seed' }, t('servers.wzSeed')), seed),
          field(t('servers.wzLevelType'), selectEl([{ value: '', label: t('servers.levelType_default') }, ...levelTypeOptions(st.mc)], st.levelType, (v) => (st.levelType = v))),
          h('div', { class: 'field' }, h('label', { for: 'sv-wz-motd' }, t('servers.wzMotd')), motdInput, preview),
        ),
        h(
          'div',
          { class: 'card flat sv-toggles' },
          toggleRow(t('servers.wzOnlineMode'), offlineAccount ? t('servers.wzOnlineModeOffline') : t('servers.wzOnlineModeHint'), st.onlineMode, (v) => (st.onlineMode = v)),
          toggleRow(t('servers.wzWhitelist'), t('servers.wzWhitelistHint'), st.whitelist, (v) => (st.whitelist = v)),
          account ? toggleRow(t('servers.wzOpMe', { name: account.name }), t('servers.wzOpMeHint'), st.opMe, (v) => (st.opMe = v)) : null,
          toggleRow(t('servers.wzPvp'), null, st.pvp, (v) => (st.pvp = v)),
          toggleRow(t('servers.wzHardcore'), t('servers.wzHardcoreHint'), st.hardcore, (v) => (st.hardcore = v)),
        ),
        h(
          'label',
          { class: 'sv-eula', for: 'sv-wz-eula' },
          eula,
          h(
            'div',
            {},
            t('servers.wzEulaPre'),
            ' ',
            h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.app.openExternal('https://aka.ms/MinecraftEULA')) }, t('servers.wzEulaLink'), ' ', icon('external')),
            '. ',
            t('servers.wzEulaPost'),
          ),
        ),
      ),
    );
  };

  function valid() {
    if (st.step >= 1) {
      if (!st.mc) return false;
      if (!String(st.name || '').trim()) return false;
      if (!Number.isInteger(st.port) || st.port < 1 || st.port > 65535) return false;
    }
    if (st.step === 2 && !isProxy() && !st.eula) return false;
    return !st.creating;
  }

  function updateButtons() {
    backBtn.classList.toggle('hidden', st.step === 0);
    nextBtn.classList.toggle('hidden', st.step === 2);
    createBtn.classList.toggle('hidden', st.step !== 2);
    nextBtn.disabled = st.step === 1 && !valid();
    createBtn.disabled = !valid();
  }

  async function draw() {
    drawSteps();
    updateButtons();
    if (st.step === 0) drawTypeStep();
    else if (st.step === 1) {
      mount(body, loading());
      await drawVersionStep();
    } else drawWorldStep();
    updateButtons();
    body.closest('.modal-body')?.scrollTo({ top: 0 });
  }

  function go(step) {
    st.step = Math.max(0, Math.min(2, step));
    draw();
  }

  backBtn.addEventListener('click', () => go(st.step - 1));
  nextBtn.addEventListener('click', () => go(st.step + 1));
  createBtn.addEventListener('click', async () => {
    if (!valid()) return;
    st.creating = true;
    updateButtons();
    mount(createBtn, icon('server'), t('servers.wzCreating'));
    const release = setBusy(createBtn);
    try {
      const srv = await api.servers.create({
        name: st.name.trim(),
        type: st.type,
        mcVersion: st.mc,
        loaderVersion: st.loaderVersion,
        port: st.port,
        memory: { min: Math.min(1024, st.mem), max: st.mem },
        motd: st.motd.trim(),
        maxPlayers: st.maxPlayers,
        gamemode: st.gamemode,
        difficulty: st.difficulty,
        onlineMode: st.onlineMode,
        pvp: st.pvp,
        hardcore: st.hardcore,
        seed: st.seed.trim(),
        levelType: st.levelType || undefined,
        whitelist: st.whitelist,
        op: st.opMe && account ? { name: account.name, uuid: account.type === 'msa' ? account.uuid : null } : null,
        eula: isProxy() ? undefined : st.eula,
      });
      m.close();
      toast('info', t('servers.toastCreatedTitle'), t('servers.toastCreatedText', { name: srv.name }), 5000);
      onCreated?.(srv);
    } catch (err) {
      st.creating = false;
      release();
      mount(createBtn, icon('server'), t('servers.wzCreate'));
      updateButtons();
      fail(t('servers.errCreate'), err);
    }
  });

  const m = modal({
    title: t('servers.wzTitle'),
    size: 'wide',
    body: h('div', { class: 'sv-wizard-wrap' }, steps, body),
    footer: [cancelBtn, h('span', { class: 'spacer' }), backBtn, nextBtn, createBtn],
  });
  m.el.classList.add('sv-modal');
  cancelBtn.addEventListener('click', () => m.close());
  draw();
  return m;
}
