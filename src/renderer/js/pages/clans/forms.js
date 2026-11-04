// Clanes: diálogos de crear, editar e invitar. Los nombres se validan acá para avisar antes y el servidor vuelve a hacerlo.
import { h, icon, mount, modal, ok, setBusy, skeleton, emptyState } from '../../ui.js';
import { t } from '../../i18n.js';
import { errText } from '../../features/clans/backend.js';
import { emblemBadge, tagChip } from '../../features/clans/tag.js';
import { tellFriend } from '../../features/clans.js';
import { headImg } from '../../social/profile-ui.js';
import { CLAN_LIMITS, COLORS, EMBLEMS, safeColor, safeEmblem, validateClanForm, validateClanName, validateDescription, validateTag } from '../../features/clans/logic.js';

const C = (key, vars) => t(`clans.${key}`, vars);

/** clan: el que se edita (el nombre y el tag ya no cambian) o nada para crear uno. onSaved(clan) al terminar. */
export function openClanForm(b, { clan = null, onSaved } = {}) {
  let color = safeColor(clan?.color);
  let emblem = safeEmblem(clan?.emblem);
  const name = h('input', { class: 'input', id: 'cl-f-name', maxlength: String(CLAN_LIMITS.nameMax), value: clan?.name || '', readonly: clan ? true : null, autocomplete: 'off' });
  const tag = h('input', { class: 'input cl-f-tag', id: 'cl-f-tag', maxlength: String(CLAN_LIMITS.tagMax), value: clan?.tag || '', readonly: clan ? true : null, autocomplete: 'off', spellcheck: 'false' });
  const description = h('textarea', { class: 'textarea', id: 'cl-f-desc', rows: '3', maxlength: String(CLAN_LIMITS.description) }, clan?.description || '');
  const open = h('input', { type: 'checkbox', checked: clan?.isOpen === true, id: 'cl-f-open' });
  const preview = h('div', { class: 'cl-f-preview' });
  const colors = h('div', { class: 'cl-swatches', role: 'radiogroup', 'aria-label': C('formColor') });
  const emblems = h('div', { class: 'cl-emblem-grid', role: 'radiogroup', 'aria-label': C('formEmblem') });
  const error = h('div', { class: 'field-error', role: 'alert', hidden: true });

  function paint() {
    mount(preview, emblemBadge({ emblem, color }, { size: 'md' }), h('strong', { class: 'ellipsis' }, name.value.trim() || C('formPreviewName')), tagChip({ tag: tag.value.trim().toUpperCase() || 'TAG', color }));
    mount(colors, COLORS.map((c) => h('button', {
      type: 'button', class: ['cl-swatch', c === color && 'active'], role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, style: { '--cl-c': c },
      onclick: () => { color = c; paint(); },
    })));
    mount(emblems, EMBLEMS.map((e) => h('button', {
      type: 'button', class: ['cl-emblem-pick', e === emblem && 'active'], role: 'radio', 'aria-checked': String(e === emblem), 'aria-label': C(`emblem_${e}`), title: C(`emblem_${e}`),
      onclick: () => { emblem = e; paint(); },
    }, icon(e))));
  }

  const hintFor = (check, el) => {
    const bad = el.value.trim() !== '' && !check.ok;
    el.classList.toggle('invalid', bad);
    return bad ? C(`err_${check.error}`) : '';
  };
  const nameHint = h('div', { class: 'field-help', id: 'cl-f-name-help' }, C('formNameHelp'));
  const tagHint = h('div', { class: 'field-help', id: 'cl-f-tag-help' }, C('formTagHelp'));
  name.addEventListener('input', () => {
    nameHint.textContent = hintFor(validateClanName(name.value), name) || C('formNameHelp');
    paint();
  });
  tag.addEventListener('input', () => {
    tagHint.textContent = hintFor(validateTag(tag.value), tag) || C('formTagHelp');
    paint();
  });

  const save = h('button', { class: 'btn primary', type: 'button' }, icon(clan ? 'save' : 'plus'), clan ? C('formSave') : C('formCreate'));
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, C('cancel'));
  const m = modal({
    title: clan ? C('formEditTitle') : C('formCreateTitle'),
    icon: 'shield',
    body: h('div', { class: 'stack cl-form' },
      preview,
      h('div', { class: 'cl-form-row' },
        h('div', { class: 'field cl-grow' }, h('label', { for: 'cl-f-name' }, C('formName')), name, clan ? null : nameHint),
        h('div', { class: 'field' }, h('label', { for: 'cl-f-tag' }, C('formTag')), tag, clan ? null : tagHint)),
      clan ? h('p', { class: 'card-sub' }, C('formFixed')) : null,
      h('div', { class: 'field' }, h('label', { for: 'cl-f-desc' }, C('formDescription')), description),
      h('div', { class: 'field' }, h('span', { class: 'label' }, C('formColor')), colors),
      h('div', { class: 'field' }, h('span', { class: 'label' }, C('formEmblem')), emblems),
      h('label', { class: 'cl-check', for: 'cl-f-open' }, open, h('span', {}, h('strong', {}, C('formOpen')), h('span', { class: 'field-help cl-block' }, C('formOpenHelp')))),
      error),
    footer: [cancel, save],
  });
  paint();
  cancel.addEventListener('click', () => m.close());
  save.addEventListener('click', async () => {
    error.hidden = true;
    const check = clan ? validateDescription(description.value, CLAN_LIMITS.description) : validateClanForm({ name: name.value, tag: tag.value, description: description.value, color, emblem });
    const fail = (code) => { error.textContent = C(`err_${code}`); error.hidden = false; };
    if (!check.ok) return fail(check.error);
    const done = setBusy(save);
    try {
      const saved = clan
        ? await b.rpc('clan_update', { p_patch: { description: description.value.trim(), color, emblem, isOpen: open.checked } })
        : await b.rpc('clan_create', { p_name: name.value.trim(), p_tag: tag.value.trim().toUpperCase(), p_description: description.value.trim(), p_color: color, p_emblem: emblem, p_open: open.checked });
      ok(clan ? C('formSaved') : C('formCreated', { name: saved?.name || '' }));
      m.close();
      onSaved?.(saved);
    } catch (err) {
      error.textContent = errText(err);
      error.hidden = false;
    } finally {
      done();
    }
    return undefined;
  });
}

/** Invitar a un amigo: la lista de amigos que todavía no están invitados ni en este clan. */
export function openClanInvite(b, clan, { onChanged } = {}) {
  const taken = new Set([...(clan.members || []).map((x) => x.userId), ...(clan.invited || []).map((x) => x.user?.userId)]);
  const list = h('div', { class: 'cl-list cl-invite-list' }, skeleton('list', { rows: 3 }));
  const m = modal({ title: C('inviteTitle'), subtitle: C('inviteSub'), icon: 'userPlus', size: 'sm', body: list });
  b.friends().then((friends) => {
    const rows = friends.filter((f) => !taken.has(f.id));
    if (!rows.length) return mount(list, emptyState('users', C('inviteNone'), C('inviteNoneText')));
    return mount(list, rows.map((f) => {
      const btn = h('button', { class: 'btn sm tonal', type: 'button' }, icon('send'), C('inviteSend'));
      btn.addEventListener('click', async () => {
        const done = setBusy(btn);
        try {
          await b.rpc('clan_invite', { p_user: f.id });
          tellFriend(f.id);
          mount(btn, icon('check'), C('inviteSent'));
          btn.disabled = true;
          onChanged?.();
        } catch (err) {
          m.el.querySelector('.field-error')?.remove();
          list.prepend(h('div', { class: 'field-error', role: 'alert' }, errText(err)));
        } finally {
          done();
          if (btn.textContent === C('inviteSent')) btn.disabled = true;
        }
      });
      return h('div', { class: 'cl-row' }, headImg(f.profile || { username: f.name }, 32, 'cl-head'), h('span', { class: 'cl-row-name ellipsis' }, f.name), btn);
    }));
  }).catch((err) => mount(list, emptyState('alert', errText(err), '')));
}
