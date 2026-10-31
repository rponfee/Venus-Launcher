// "Servidor espejo con un clic": crea un servidor a partir de una instancia (mismo loader y version,
// mods de servidor, configuracion y opcionalmente un mundo).
import { h, icon, mount, modal, fail, toast, selectEl, switchEl, loading, emptyState, instanceIcon, loaderBadge, fmtBytes, fmtAgo, setBusy } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { navigate } from '../../app.js';
import { loadTypes, typeMeta, typeBadge, failUnlessTask } from './common.js';
import { ramSlider } from './create.js';

const SUPPORTED = new Set(['vanilla', 'optifine', 'fabric', 'quilt', 'forge', 'neoforge']);

export async function openMirrorDialog({ instanceId, onCreated } = {}) {
  await loadTypes();
  if (!store.instances.length) await store.refreshInstances().catch(() => {});
  const account = store.selectedAccount();
  const st = { instanceId: instanceId || null, plan: null, include: new Set(), extras: new Set(), world: '', type: 'paper', name: '', mem: 4096, onlineMode: account?.type === 'msa', eula: false, busy: false, opMe: Boolean(account) };
  let totalMb = 8192;
  try {
    totalMb = Math.floor((await api.system.info()).totalMem / 1048576);
  } catch {
    /* sin info del sistema */
  }
  st.mem = totalMb >= 12000 ? 6144 : totalMb >= 7000 ? 4096 : 3072;

  const body = h('div', { class: 'sv-mirror' });
  const createBtn = h('button', { class: 'btn primary', disabled: true }, icon('copy'), t('servers.mrCreate'));
  const cancelBtn = h('button', { class: 'btn ghost' }, t('common.cancel'));

  const eligible = store.instances.filter((i) => SUPPORTED.has(i.loader));

  function update() {
    createBtn.disabled = !st.plan || !st.eula || st.busy || !st.name.trim();
    // Mientras se elige la instancia no hay nada para crear: el boton aparece con el plan
    createBtn.hidden = !st.plan && !st.busy;
  }

  function pickInstance() {
    st.plan = null;
    update();
    if (!eligible.length) {
      mount(body, emptyState('layers', t('servers.mrNoInstances'), t('servers.mrNoInstancesText'), h('button', { class: 'btn', onclick: () => (m.close(), navigate('versions')) }, icon('plus'), t('servers.mrCreateInstance'))));
      return;
    }
    mount(
      body,
      h('p', { class: 'sv-mirror-intro' }, t('servers.mrIntro')),
      h(
        'div',
        { class: 'sv-inst-grid' },
        eligible.map((inst) =>
          h(
            'button',
            { class: 'sv-inst', onclick: () => analyze(inst.id) },
            instanceIcon(inst),
            h('span', { class: 'sv-inst-main' }, h('span', { class: 'sv-inst-name ellipsis', title: inst.name }, inst.name), h('span', { class: 'sv-inst-sub' }, loaderBadge(inst.preset === 'iris' ? 'iris' : inst.loader), h('span', { class: 'num' }, inst.mcVersion))),
            icon('chevronRight'),
          ),
        ),
      ),
    );
  }

  async function analyze(id) {
    st.instanceId = id;
    st.plan = null;
    update();
    mount(body, loading(t('servers.mrAnalyzing')));
    try {
      const plan = await api.invoke('servers:mirrorPreview', id, {});
      st.plan = plan;
      st.include = new Set(plan.mods.filter((x) => x.include).map((x) => x.file));
      st.extras = new Set(plan.extras);
      st.type = plan.type;
      st.name = t('servers.mrDefaultName', { name: plan.instance.name });
      drawPlan();
    } catch (err) {
      mount(
        body,
        h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, h('strong', {}, t('servers.mrAnalyzeError')), h('div', {}, err.message))),
        h('div', { class: 'row wrap' }, h('button', { class: 'btn ghost', onclick: pickInstance }, icon('chevronLeft'), t('common.back')), h('button', { class: 'btn', onclick: () => analyze(id) }, icon('refresh'), t('common.retry'))),
      );
    }
    update();
  }

  function modRow(mod) {
    const sideLabel = mod.side === 'client' ? t('servers.mrSideClient') : mod.side === 'server' ? t('servers.mrSideServer') : mod.side === 'both' ? t('servers.mrSideBoth') : t('servers.mrSideUnknown');
    const cls = mod.side === 'client' ? 'bad' : mod.side === 'unknown' ? 'warn' : 'good';
    return h(
      'div',
      { class: ['sv-mod', !st.include.has(mod.file) && 'off'] },
      h('div', { class: 'li-icon' }, mod.icon ? h('img', { src: mod.icon, alt: '', loading: 'lazy' }) : icon('box')),
      h('div', { class: 'li-main' }, h('div', { class: 'li-title' }, mod.title), h('div', { class: 'li-sub' }, `${mod.file} · ${fmtBytes(mod.size)}`)),
      h('span', { class: ['pill', cls], title: mod.source === 'modrinth' ? t('servers.mrSourceModrinth') : mod.source === 'metadata' ? t('servers.mrSourceMeta') : t('servers.mrSourceUnknown') }, sideLabel),
      switchEl(st.include.has(mod.file), (v) => {
        if (v) st.include.add(mod.file);
        else st.include.delete(mod.file);
        drawPlan();
      }, t('servers.mrIncludeMod', { name: mod.title })),
    );
  }

  function drawPlan() {
    const plan = st.plan;
    const inst = plan.instance;
    const clientOnly = plan.mods.filter((x) => x.side === 'client').length;
    const included = plan.mods.filter((x) => st.include.has(x.file)).length;
    const nameInput = h('input', { class: 'input', id: 'sv-mr-name', value: st.name, maxlength: 60 });
    nameInput.addEventListener('input', () => {
      st.name = nameInput.value;
      update();
    });
    const ram = ramSlider(st.mem, totalMb, (v) => (st.mem = v));
    const eula = h('input', { type: 'checkbox', id: 'sv-mr-eula', checked: st.eula });
    eula.addEventListener('change', () => {
      st.eula = eula.checked;
      update();
    });
    const target = typeMeta(st.type);
    const worldSel = selectEl([{ value: '', label: t('servers.mrWorldNone') }, ...plan.worlds.map((w) => ({ value: w.name, label: `${w.name} · ${fmtAgo(w.lastPlayed)}` }))], st.world, (v) => (st.world = v));
    worldSel.id = 'sv-mr-world';
    ram.input.id = 'sv-mr-ram';
    mount(
      body,
      h(
        'div',
        { class: 'sv-mirror-head' },
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('servers.mrFrom')), h('strong', { class: 'ellipsis', title: inst.name }, inst.name), loaderBadge(inst.loader === 'optifine' ? 'optifine' : inst.loader), h('span', { class: 'badge' }, inst.mcVersion)),
        icon('arrowRight'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, t('servers.mrTo')), typeBadge(st.type), h('span', { class: 'badge' }, icon('box'), inst.mcVersion)),
        h('button', { class: 'btn sm ghost', onclick: pickInstance }, t('servers.mrChange')),
      ),
      plan.vanillaChoice
        ? h(
            'div',
            { class: 'field' },
            h('div', { class: 'label', id: 'sv-mr-type-label' }, t('servers.mrVanillaType')),
            h(
              'div',
              { class: 'segmented', role: 'group', 'aria-labelledby': 'sv-mr-type-label' },
              ['paper', 'purpur', 'vanilla'].map((ty) =>
                h('button', { class: st.type === ty ? 'active' : '', 'aria-pressed': st.type === ty ? 'true' : 'false', onclick: () => ((st.type = ty), drawPlan()) }, typeMeta(ty).name),
              ),
            ),
            h('div', { class: 'field-help' }, t('servers.mrVanillaHint')),
          )
        : null,
      h(
        'div',
        { class: 'form-grid' },
        h('div', { class: 'field' }, h('label', { for: 'sv-mr-name' }, t('servers.wzName')), nameInput),
        h('div', { class: 'field' }, h('label', { for: 'sv-mr-world' }, t('servers.mrWorld')), worldSel, h('div', { class: 'field-help' }, t('servers.mrWorldHint'))),
        h('div', { class: 'full sv-ram' }, h('div', { class: 'row' }, h('label', { class: 'label spacer', for: 'sv-mr-ram' }, t('servers.wzRam')), ram.label), ram.input, ram.marks),
      ),
      plan.mods.length
        ? h(
            'div',
            { class: 'stack' },
            h('div', { class: 'sv-mods-head' }, h('div', { class: 'label spacer' }, t('servers.mrMods', { included, total: plan.mods.length })), clientOnly ? h('span', { class: 'pill bad' }, icon('alert'), t('servers.mrClientOnly', { count: clientOnly })) : null),
            h('div', { class: 'sv-mod-list' }, plan.mods.map(modRow)),
            h('div', { class: 'field-help' }, t('servers.mrModsHint')),
          )
        : h('div', { class: 'notice info' }, icon('info'), target.kind === 'plugins' ? t('servers.mrNoModsPlugins') : t('servers.mrNoMods')),
      plan.extras.length
        ? h(
            'div',
            { class: 'sv-extras' },
            h('span', { class: 'label' }, t('servers.mrExtras')),
            plan.extras.map((f) =>
              h(
                'label',
                { class: ['chip', st.extras.has(f) && 'active'] },
                h('input', {
                  type: 'checkbox',
                  class: 'sv-chip-check',
                  checked: st.extras.has(f),
                  onchange: (e) => {
                    if (e.target.checked) st.extras.add(f);
                    else st.extras.delete(f);
                    drawPlan();
                  },
                }),
                `${f}/`,
              ),
            ),
          )
        : null,
      h(
        'div',
        { class: 'card flat sv-toggles' },
        h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('servers.wzOnlineMode')), h('div', { class: 'tr-sub' }, account?.type !== 'msa' && account ? t('servers.wzOnlineModeOffline') : t('servers.wzOnlineModeHint'))), switchEl(st.onlineMode, (v) => (st.onlineMode = v), t('servers.wzOnlineMode'))),
        account ? h('div', { class: 'toggle-row' }, h('div', { class: 'tr-text' }, h('div', { class: 'tr-title' }, t('servers.wzOpMe', { name: account.name })), h('div', { class: 'tr-sub' }, t('servers.wzOpMeHint'))), switchEl(st.opMe, (v) => (st.opMe = v), t('servers.wzOpMe', { name: account.name }))) : null,
      ),
      h(
        'label',
        { class: 'sv-eula', for: 'sv-mr-eula' },
        eula,
        h('div', {}, t('servers.wzEulaPre'), ' ', h('a', { href: '#', onclick: (e) => (e.preventDefault(), api.app.openExternal('https://aka.ms/MinecraftEULA')) }, t('servers.wzEulaLink'), ' ', icon('external')), '. ', t('servers.wzEulaPost')),
      ),
    );
    update();
  }

  createBtn.addEventListener('click', async () => {
    if (createBtn.disabled) return;
    st.busy = true;
    update();
    mount(createBtn, icon('copy'), t('servers.wzCreating'));
    const release = setBusy(createBtn);
    try {
      const srv = await api.invoke('servers:createFromInstance', st.instanceId, {
        name: st.name.trim(),
        type: st.type,
        include: [...st.include],
        extras: [...st.extras],
        world: st.world || null,
        memory: { min: Math.min(1024, st.mem), max: st.mem },
        onlineMode: st.onlineMode,
        op: st.opMe && account ? { name: account.name, uuid: account.type === 'msa' ? account.uuid : null } : null,
        eula: st.eula,
      });
      m.close();
      const excluded = srv.mirror?.excluded?.length || 0;
      toast('good', t('servers.mrDoneTitle'), excluded ? t('servers.mrDoneExcluded', { name: srv.name, count: excluded }) : t('servers.mrDoneText', { name: srv.name }), 7000);
      onCreated?.(srv);
    } catch (err) {
      st.busy = false;
      release();
      mount(createBtn, icon('copy'), t('servers.mrCreate'));
      update();
      failUnlessTask(store, t('servers.errCreate'), err);
    }
  });

  const m = modal({ title: t('servers.mrTitle'), size: 'wide', body, footer: [cancelBtn, h('span', { class: 'spacer' }), createBtn] });
  m.el.classList.add('sv-modal');
  cancelBtn.addEventListener('click', () => m.close());
  if (st.instanceId && eligible.some((i) => i.id === st.instanceId)) analyze(st.instanceId);
  else pickInstance();
  return m;
}
