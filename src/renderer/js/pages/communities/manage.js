// Administración de comunidades: formularios con RPC reales y controles bloqueados durante cada envío.
import { h, icon, mount, modal, ok, fail, confirmDialog } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/communities/backend.js';
import { COMMUNITY_LIMITS } from '../../features/communities/logic.js';
import { communityColor, CATEGORY_LIMIT, CHANNEL_KINDS, COMMUNITY_ICONS, COMMUNITY_BANNERS, COMMUNITY_THEMES, categoryGroups, channelIcon, iconGlyph, safeCommunityIcon, safeBanner, safeTheme, validateAppearance, validateCategoryName, validateChannelSettings, moveChannel, moveWithinCategory, isStaff } from './logic.js';
import { openChannelPermsDialog } from './perms.js';

const C = (key, vars) => t('communities.' + key, vars);
let formSeq = 0;
const field = (label, input, help) => {
  input.id ||= 'cm-edit-' + (++formSeq);
  return h('div', { class: 'field' }, h('label', { for: input.id }, C(label)), input, help ? h('p', { class: 'field-help' }, C(help)) : null);
};
const select = (values, value, label, prefix) => {
  const el = h('select', { class: 'input', 'aria-label': C(label) }, values.map(([id, text]) => h('option', { value: id, selected: id === value }, prefix ? C(prefix + id) : text)));
  el.value = value;
  return el;
};
const choices = (values, value, label, prefix) => select(values.map((id) => [id, id]), value, label, prefix);
const textInput = (value, max) => h('input', { class: 'input', value: value || '', maxlength: String(max), autocomplete: 'off' });
const textArea = (value, max, rows = 3) => h('textarea', { class: 'textarea', value: value || '', rows: String(rows), maxlength: String(max) });

/** Validar antes de tocar el backend; cerrar el modal no permite repetir una petición que sigue pendiente. */
function editor({ title, body, controls = [], validate, save, onSaved }) {
  let pending = false, closed = false;
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });
  const fields = h('fieldset', { class: 'cm-fields' }, body);
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const submit = h('button', { class: 'btn primary cm-editor-save', type: 'button' }, icon('save'), C('formSave'));
  const m = modal({ title: C(title), icon: 'settings', body: h('div', { class: 'stack cm-form' }, fields, error), footer: [cancel, submit], onClose: () => { closed = true; } });
  cancel.addEventListener('click', () => m.close());
  submit.addEventListener('click', async () => {
    if (pending || closed) return;
    const check = validate();
    error.hidden = !!check.ok;
    if (!check.ok) { error.textContent = C(check.error === 'bad_color' ? 'cmColorInvalid' : 'err_' + check.error); return; }
    pending = true;
    fields.disabled = submit.disabled = true;
    const before = controls.map((control) => control.disabled);
    controls.forEach((control) => { control.disabled = true; });
    try {
      const result = await save(check.value);
      if (!closed) { ok(C('formSaved')); m.close(); }
      await onSaved?.(result);
    } catch (err) {
      if (!closed) { error.textContent = errText(err); error.hidden = false; }
      else fail(C('actionError'), errText(err));
    } finally {
      pending = false;
      fields.disabled = submit.disabled = false;
      controls.forEach((control, i) => { control.disabled = before[i]; });
    }
  });
  return m;
}

export function openAppearanceForm(b, community, { reload } = {}) {
  if (community.myRole !== 'owner') return;
  const theme = choices(COMMUNITY_THEMES, safeTheme(community.theme), 'cmTheme', 'cmTheme_');
  const color = h('input', { class: 'input cm-color-input', type: 'color', value: communityColor(community.color) });
  const glyph = choices(COMMUNITY_ICONS, safeCommunityIcon(community.icon), 'cmIcon', 'cmIcon_');
  const banner = choices(COMMUNITY_BANNERS, safeBanner(community.banner), 'cmBanner', 'cmBanner_');
  const welcome = textArea(community.welcome, 2000);
  const rules = textArea(community.rules, 4000, 4);
  const preview = h('div', { class: 'cm-appearance-preview' });
  const draw = () => {
    preview.dataset.banner = safeBanner(banner.value);
    preview.style.setProperty('--cm-color', communityColor(color.value));
    mount(preview, icon(iconGlyph(safeCommunityIcon(glyph.value))), h('strong', {}, community.name));
  };
  for (const control of [color, glyph, banner]) control.addEventListener('input', draw);
  draw();
  return editor({
    title: 'cmCustomize',
    body: [preview, h('div', { class: 'cm-form-grid' }, field('cmTheme', theme), field('formColor', color), field('cmIcon', glyph), field('cmBanner', banner)), field('cmWelcome', welcome), field('cmRules', rules)],
    validate: () => validateAppearance({ theme: theme.value, color: color.value, icon: glyph.value, banner: banner.value, welcome: welcome.value, rules: rules.value }),
    save: (p_patch) => b.rpc('community_customize', { p_community: community.id, p_patch }),
    onSaved: reload,
  });
}

export function openChannelForm(b, community, { channel = null, categoryId = null, reload } = {}) {
  if (!isStaff(community.myRole)) return;
  const categories = community.categories || [];
  const kind = choices(CHANNEL_KINDS, channel?.kind || 'text', 'cmChannelType', 'cmKind_');
  kind.disabled = !!channel;
  const name = textInput(channel?.name, 30);
  const topic = textArea(channel?.topic, 500, 2);
  const glyph = choices(COMMUNITY_ICONS, safeCommunityIcon(channel?.icon, 'hash'), 'cmIcon', 'cmIcon_');
  const category = select([['', C('cmUncategorized')], ...categories.map((c) => [c.id, c.name])], channel?.categoryId || categoryId || '', 'cmCategory');
  const seconds = h('input', { class: 'input', type: 'number', min: '0', max: '21600', step: '1', value: String(channel?.slowmodeSeconds || 0) });
  const posting = choices(['members', 'staff'], channel?.postingRole || 'members', 'cmPosting', 'cmPosting_');
  const privateChannel = h('input', { type: 'checkbox', checked: channel?.isPrivate === true });
  const writeOptions = h('div', { class: 'cm-form-grid' }, field('cmSlowmode', seconds, 'cmSlowmodeHelp'), field('cmPosting', posting));
  const kindHelp = h('p', { class: 'field-help' });
  function syncKind() {
    writeOptions.hidden = kind.value === 'voice';
    posting.disabled = ['voice', 'announcement'].includes(kind.value);
    if (kind.value === 'announcement') posting.value = 'staff';
    if (kind.value === 'voice') { posting.value = 'members'; seconds.value = '0'; }
    kindHelp.textContent = C('cmKindHelp_' + kind.value);
  }
  kind.addEventListener('change', syncKind);
  syncKind();
  return editor({
    title: channel ? 'cmChannelEdit' : 'cmChannelCreate',
    body: [field('cmChannelType', kind), kindHelp, field('channelName', name), field('cmTopic', topic),
      h('div', { class: 'cm-form-grid' }, field('cmIcon', glyph), field('cmCategory', category)), writeOptions,
      h('label', { class: 'cm-check' }, privateChannel, h('span', {}, C('cmPrivate'))), h('p', { class: 'field-help' }, C('cmPrivateHelp'))],
    controls: [kind, posting],
    validate: () => validateChannelSettings({ kind: kind.value, name: name.value, topic: topic.value, icon: glyph.value, categoryId: category.value, slowmodeSeconds: seconds.value, postingRole: posting.value, isPrivate: privateChannel.checked }, categories),
    save: (p_patch) => channel
      ? b.rpc('community_channel_configure', { p_channel: channel.id, p_patch })
      : b.rpc('community_channel_create_configured', { p_community: community.id, p_kind: kind.value, p_name: p_patch.name, p_patch }),
    onSaved: reload,
  });
}

export function openCategoryForm(b, community, { category = null, reload } = {}) {
  if (!isStaff(community.myRole)) return;
  const name = textInput(category?.name, 40);
  return editor({ title: category ? 'cmCategoryEdit' : 'cmCategoryCreate', body: field('cmCategoryName', name),
    validate: () => validateCategoryName(name.value),
    save: (p_name) => b.rpc('community_category_save', { p_community: community.id, p_category: category?.id || null, p_name }),
    onSaved: reload });
}

const mutations = new WeakMap();
export async function changeCommunity(b, id, action, reload) {
  let busy = mutations.get(b);
  if (!busy) { busy = new Set(); mutations.set(b, busy); }
  if (busy.has(id)) return false;
  busy.add(id);
  try { await action(); await reload?.(); return true; }
  catch (err) { fail(C('actionError'), errText(err)); return false; }
  finally { busy.delete(id); }
}
export async function deleteChannel(b, community, channel, reload) {
  if (!isStaff(community.myRole)) return;
  if (!(await confirmDialog(C('channelDeleteTitle'), C('cmChannelDeleteConfirm', { name: channel.name }), { okText: C('delete'), danger: true }))) return;
  return changeCommunity(b, community.id, () => b.rpc('community_channel_delete', { p_channel: channel.id }), reload);
}
export async function deleteCategory(b, community, category, reload) {
  if (!isStaff(community.myRole)) return;
  if (!(await confirmDialog(C('cmCategoryDelete'), C('cmCategoryDeleteConfirm', { name: category.name }), { okText: C('delete'), danger: true }))) return;
  return changeCommunity(b, community.id, () => b.rpc('community_category_delete', { p_category: category.id }), reload);
}

export function channelMenuItems(b, community, channel, reload) {
  if (!isStaff(community.myRole)) return [];
  const move = (delta) => moveWithinCategory(community.channels, channel.id, delta);
  return [
    { icon: 'edit', label: C('cmChannelEdit'), run: () => openChannelForm(b, community, { channel, reload }) },
    { icon: 'shield', label: C('permMenu'), run: () => openChannelPermsDialog(b, community, channel, { reload }) },
    ...[-1, 1].filter((delta) => move(delta)).map((delta) => ({ icon: delta < 0 ? 'upCircle' : 'chevronDown', label: C(delta < 0 ? 'moveUp' : 'moveDown'),
      run: () => changeCommunity(b, community.id, () => b.rpc('community_channels_reorder', { p_community: community.id, p_ids: move(delta) }), reload) })),
    { icon: 'folder', label: C('cmMoveCategory'), run: () => {
      const category = select([['', C('cmUncategorized')], ...(community.categories || []).map((c) => [c.id, c.name])], channel.categoryId || '', 'cmCategory');
      editor({ title: 'cmMoveCategory', body: field('cmCategory', category), validate: () => ({ ok: true, value: category.value || null }),
        save: (categoryId) => b.rpc('community_channel_configure', { p_channel: channel.id, p_patch: { categoryId } }), onSaved: reload });
    } },
    { icon: 'trash', label: C('delete'), danger: true, run: () => deleteChannel(b, community, channel, reload) },
  ];
}

/** El acceso visible y el menú histórico abren la misma administración de categorías y canales. */
export function openChannelsManager(b, initial, { reload }) {
  if (!isStaff(initial.myRole)) return;
  let community = initial, closed = false, pending = false;
  const body = h('div', { class: 'stack cm-manager' });
  const m = modal({ title: C('cmManageChannels'), subtitle: community.name, icon: 'folder', body, onClose: () => { closed = true; } });
  const refresh = async () => {
    const next = await reload();
    if (closed) return next;
    if (!next || !isStaff(next.myRole)) { m.close(); return next; }
    community = next; draw(); return next;
  };
  const run = async (fn) => {
    if (pending || closed) return;
    pending = true; draw();
    try { await changeCommunity(b, community.id, fn, refresh); }
    finally { pending = false; if (!closed) draw(); }
  };
  const button = (label, glyph, onclick, disabled = false) => h('button', { class: 'icon-btn sm', type: 'button', disabled: pending || disabled, title: C(label), 'aria-label': C(label), onclick }, icon(glyph));
  function draw() {
    const groups = categoryGroups(community);
    const ids = groups.filter((g) => g.id).map((g) => g.id);
    const full = (community.channels || []).length >= (community.maxChannels ?? COMMUNITY_LIMITS.channels);
    mount(body,
      h('div', { class: 'row wrap cm-manager-actions' },
        h('button', { class: 'btn primary sm', type: 'button', disabled: pending || full, onclick: () => openChannelForm(b, community, { reload: refresh }) }, icon('plus'), C('cmChannelCreate')),
        h('button', { class: 'btn sm', type: 'button', disabled: pending || ids.length >= CATEGORY_LIMIT, onclick: () => openCategoryForm(b, community, { reload: refresh }) }, icon('folder'), C('cmCategoryCreate'))),
      h('p', { class: 'field-help' }, C('channelsHint', { n: community.channels?.length || 0, max: community.maxChannels ?? COMMUNITY_LIMITS.channels })),
      groups.map((g) => h('section', { class: 'cm-manage-group' },
        h('div', { class: 'cm-category-head' }, h('strong', { class: 'ellipsis' }, g.name || C('cmUncategorized')),
          button('cmChannelCreate', 'plus', () => openChannelForm(b, community, { categoryId: g.id, reload: refresh }), full),
          g.id ? [
            button('cmCategoryEdit', 'edit', () => openCategoryForm(b, community, { category: g, reload: refresh })),
            ...[-1, 1].map((delta) => button(delta < 0 ? 'moveUp' : 'moveDown', delta < 0 ? 'upCircle' : 'chevronDown',
              () => run(() => b.rpc('community_category_reorder', { p_community: community.id, p_ids: moveChannel(ids, g.id, delta) })), !moveChannel(ids, g.id, delta))),
            button('cmCategoryDelete', 'trash', () => deleteCategory(b, community, g, refresh)),
          ] : null),
        h('ul', { class: 'cm-channels' }, g.channels.map((ch) => h('li', { class: 'cm-manage-channel' }, icon(channelIcon(ch)),
          h('span', { class: 'ellipsis' }, ch.name), h('span', { class: 'badge' }, C('cmKind_' + ch.kind)),
          ...[-1, 1].map((delta) => button(delta < 0 ? 'moveUp' : 'moveDown', delta < 0 ? 'upCircle' : 'chevronDown',
            () => run(() => b.rpc('community_channels_reorder', { p_community: community.id, p_ids: moveWithinCategory(community.channels, ch.id, delta) })), !moveWithinCategory(community.channels, ch.id, delta))),
          button('cmChannelEdit', 'edit', () => openChannelForm(b, community, { channel: ch, reload: refresh })),
          button('permMenu', 'shield', () => openChannelPermsDialog(b, community, ch, { reload: refresh })),
          button('delete', 'trash', () => deleteChannel(b, community, ch, refresh))))))));
  }
  draw();
  return m;
}
