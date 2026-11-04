// Comunidades: diálogos de crear y editar, canales (ordenar, renombrar, agregar y borrar), invitación y expulsados.
import { h, icon, mount, modal, ok, fail, setBusy, skeleton, emptyState, confirmDialog, copyText, fmtAgo, promptDialog } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/clans/backend.js';
import { COMMUNITY_LIMITS, validateChannelName, validateCommunityName, validateDescription } from '../../features/clans/logic.js';
import { headImg } from '../../social/profile-ui.js';
import { channelsByKind, moveChannel, personName } from './logic.js';

const C = (key, vars) => t(`clans.${key}`, vars);

export function openCommunityForm(b, { community = null, onSaved } = {}) {
  let isPublic = community ? community.isPublic !== false : true;
  const name = h('input', { class: 'input', id: 'cm-f-name', maxlength: String(COMMUNITY_LIMITS.nameMax), value: community?.name || '', autocomplete: 'off' });
  const description = h('textarea', { class: 'textarea', id: 'cm-f-desc', rows: '3', maxlength: String(COMMUNITY_LIMITS.description) }, community?.description || '');
  const hint = h('div', { class: 'field-help' });
  const seg = h('div', { class: 'segmented', role: 'group', 'aria-label': C('communityVisibility') });
  function drawSeg() {
    mount(seg, [['public', 'globe'], ['code', 'lock']].map(([id, ic]) => h('button', {
      type: 'button', class: (id === 'public') === isPublic ? 'active' : null, 'aria-pressed': String((id === 'public') === isPublic),
      onclick: () => { isPublic = id === 'public'; drawSeg(); },
    }, icon(ic), C(`visibility_${id}`))));
    hint.textContent = C(isPublic ? 'visibilityHint_public' : 'visibilityHint_code');
  }
  drawSeg();
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const save = h('button', { class: 'btn primary', type: 'button' }, icon(community ? 'save' : 'plus'), community ? C('formSave') : C('communityCreate'));
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const m = modal({
    title: community ? C('communityEditTitle') : C('communityCreateTitle'),
    icon: 'users',
    body: h('div', { class: 'stack cl-form' },
      h('div', { class: 'field' }, h('label', { for: 'cm-f-name' }, C('formName')), name, h('div', { class: 'field-help' }, C('communityNameHelp'))),
      h('div', { class: 'field' }, h('label', { for: 'cm-f-desc' }, C('formDescription')), description),
      h('div', { class: 'field' }, h('span', { class: 'label' }, C('communityVisibility')), seg, hint),
      community ? null : h('p', { class: 'card-sub' }, C('communityCreateHint')),
      error),
    footer: [cancel, save],
  });
  cancel.addEventListener('click', () => m.close());
  save.addEventListener('click', async () => {
    error.hidden = true;
    const checks = [validateCommunityName(name.value), validateDescription(description.value, COMMUNITY_LIMITS.description)];
    const bad = checks.find((x) => !x.ok);
    if (bad) {
      error.textContent = C(`err_${bad.error}`);
      error.hidden = false;
      return;
    }
    const done = setBusy(save);
    try {
      const saved = community
        ? await b.rpc('community_update', { p_community: community.id, p_patch: { name: checks[0].value, description: checks[1].value, isPublic } })
        : await b.rpc('community_create', { p_name: checks[0].value, p_description: checks[1].value, p_public: isPublic });
      ok(community ? C('formSaved') : C('communityCreated', { name: saved?.name || '' }));
      m.close();
      onSaved?.(saved);
    } catch (err) {
      error.textContent = errText(err);
      error.hidden = false;
    } finally {
      done();
    }
  });
}

/** Canales: mover, renombrar, borrar y agregar. reload() vuelve a pedir la comunidad y la devuelve. */
export function openChannelsDialog(b, start, { reload }) {
  let community = start;
  const body = h('div', { class: 'stack' });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const showError = (err) => {
    error.textContent = errText(err);
    error.hidden = false;
  };
  const run = async (fn) => {
    error.hidden = true;
    try {
      await fn();
      community = (await reload()) || community;
      draw();
    } catch (err) {
      showError(err);
    }
  };
  function row(ch, ids) {
    const up = moveChannel(ids, ch.id, -1);
    const down = moveChannel(ids, ch.id, 1);
    return h('li', { class: 'cl-row' },
      icon(ch.kind === 'voice' ? 'volume' : 'hash'),
      h('span', { class: 'cl-row-name ellipsis' }, ch.name),
      h('button', { class: 'icon-btn sm', type: 'button', disabled: !up, title: C('moveUp'), 'aria-label': C('moveUp'), onclick: () => run(() => b.rpc('community_channels_reorder', { p_community: community.id, p_ids: up })) }, icon('chevronDown', 'cl-flip')),
      h('button', { class: 'icon-btn sm', type: 'button', disabled: !down, title: C('moveDown'), 'aria-label': C('moveDown'), onclick: () => run(() => b.rpc('community_channels_reorder', { p_community: community.id, p_ids: down })) }, icon('chevronDown')),
      h('button', { class: 'icon-btn sm', type: 'button', title: C('rename'), 'aria-label': C('rename'), onclick: async () => {
        const name = await promptDialog(C('channelRename'), C('channelName'), { value: ch.name, okText: C('formSave') });
        if (name === null) return;
        const check = validateChannelName(name);
        if (!check.ok) return showError({ code: check.error });
        run(() => b.rpc('community_channel_rename', { p_channel: ch.id, p_name: check.value }));
      } }, icon('edit')),
      h('button', { class: 'icon-btn sm', type: 'button', title: C('delete'), 'aria-label': C('delete'), onclick: async () => {
        if (await confirmDialog(C('channelDeleteTitle'), C(ch.kind === 'voice' ? 'channelDeleteVoice' : 'channelDeleteText', { name: ch.name }), { okText: C('delete'), danger: true })) run(() => b.rpc('community_channel_delete', { p_channel: ch.id }));
      } }, icon('trash')));
  }
  function draw() {
    const { all } = channelsByKind(community.channels);
    const ids = all.map((c) => c.id);
    const add = (kind) => async () => {
      const name = await promptDialog(C(`channelAdd_${kind}`), C('channelName'), { okText: C('channelAdd') });
      if (name === null) return;
      const check = validateChannelName(name);
      if (!check.ok) return showError({ code: check.error });
      run(() => b.rpc('community_channel_create', { p_community: community.id, p_kind: kind, p_name: check.value }));
    };
    const full = all.length >= (community.maxChannels ?? COMMUNITY_LIMITS.channels);
    mount(body,
      h('p', { class: 'card-sub' }, C('channelsHint', { n: all.length, max: community.maxChannels ?? COMMUNITY_LIMITS.channels })),
      h('ul', { class: 'cl-list' }, all.map((ch) => row(ch, ids))),
      error,
      h('div', { class: 'row wrap' },
        h('button', { class: 'btn sm', type: 'button', disabled: full, onclick: add('text') }, icon('hash'), C('channelAdd_text')),
        h('button', { class: 'btn sm', type: 'button', disabled: full, onclick: add('voice') }, icon('volume'), C('channelAdd_voice'))));
  }
  draw();
  modal({ title: C('channelsTitle'), subtitle: community.name, icon: 'hash', body });
}

export function openInviteDialog(b, community, { reload }) {
  let code = community.inviteCode || '';
  const show = h('span', { class: 'kbd selectable priv cl-code' }, code);
  const regen = h('button', { class: 'btn sm ghost', type: 'button' }, icon('refresh'), C('regenCode'));
  regen.addEventListener('click', async () => {
    if (!(await confirmDialog(C('regenTitle'), C('regenTextCommunity'), { okText: C('regenCode') }))) return;
    const done = setBusy(regen);
    try {
      const res = await b.rpc('community_regen_code', { p_community: community.id });
      code = res?.inviteCode || code;
      show.textContent = code;
      ok(C('regenDone'));
      reload?.();
    } catch (err) {
      fail(C('actionError'), errText(err));
    } finally {
      done();
    }
  });
  modal({
    title: C('inviteCommunityTitle'),
    subtitle: community.name,
    icon: 'userPlus',
    size: 'sm',
    body: h('div', { class: 'stack' },
      h('p', { class: 'card-sub' }, C(community.isPublic ? 'inviteCommunityPublic' : 'inviteCommunityCode')),
      h('div', { class: 'cl-code-row' }, show, h('button', { class: 'icon-btn sm', type: 'button', title: C('copyCode'), 'aria-label': C('copyCode'), onclick: () => copyText(code, C('codeCopied')) }, icon('copy')), regen)),
  });
}

export function openBansDialog(b, community) {
  const list = h('ul', { class: 'cl-list' }, skeleton('list', { rows: 3 }));
  modal({ title: C('bansTitle'), subtitle: community.name, icon: 'ban', size: 'sm', body: h('div', { class: 'stack' }, h('p', { class: 'card-sub' }, C('bansHint')), list) });
  async function load() {
    try {
      const rows = await b.rpc('community_bans_list', { p_community: community.id });
      if (!rows?.length) return mount(list, emptyState('shield', C('bansEmpty'), ''));
      return mount(list, rows.map((p) => {
        const name = personName(p) || C('someone');
        const back = h('button', { class: 'btn sm', type: 'button' }, icon('undo'), C('unban'));
        back.addEventListener('click', async () => {
          const done = setBusy(back);
          try {
            await b.rpc('community_unban', { p_community: community.id, p_user: p.userId });
            ok(C('unbanned', { name }));
            load();
          } catch (err) {
            fail(C('actionError'), errText(err));
          } finally {
            done();
          }
        });
        return h('li', { class: 'cl-row' }, headImg(p, 32, 'cl-head'), h('span', { class: 'cl-row-name ellipsis' }, name), h('span', { class: 'cl-muted small' }, fmtAgo(Date.parse(p.at))), back);
      }));
    } catch (err) {
      return mount(list, emptyState('alert', errText(err), ''));
    }
  }
  load();
}
