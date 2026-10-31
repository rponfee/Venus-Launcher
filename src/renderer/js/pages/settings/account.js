// Ajustes > Cuenta y nube: cuentas de Minecraft y cuenta de Venus (entrar, crear cuenta, confirmar el email con
// codigo, recuperar la contrasenia, perfil y codigo de amigo). La nube es siempre la del launcher
// (core/cloud-defaults.js): no se configura desde aca.
import { h, icon, mount, ok, fail, copyText, avatarImg, skeleton } from '../../ui.js';
import { store, api } from '../../store.js';
import { t } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { openAccounts } from '../../app.js';
import { sectionHead, card, field, fieldError, validateOnBlur, note, errorNote, emptyRow, msgBox, withBusy, secretField } from './shared.js';

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;
const RESEND_MS = 60000;

// Estado de los formularios: sobrevive a los redibujados (idioma, eventos de la nube). Nunca guarda contrasenias.
const form = { mode: 'signin', email: '', username: '', resendAt: 0, msg: null };

// Un solo boton primario en la seccion: el paso que falta primero (cuenta de Minecraft para jugar y
// despues entrar a la cuenta de Venus).
function primaryStep() {
  if (!(store.accounts?.accounts || []).length) return 'mc';
  if (cloud.isConfigured() && !cloud.isSignedIn()) return 'venus';
  return null;
}

// ---------------- Utilidades ----------------

// Mensajes de Supabase Auth en el idioma del usuario.
function authError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || err || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return t('settings.venusErrCredentials');
  if (['user_already_exists', 'email_exists'].includes(code) || /already registered|already exists/i.test(msg)) return t('settings.venusErrExists');
  if (code === 'same_password' || /different from the old/i.test(msg)) return t('settings.venusErrSamePassword');
  if (code === 'weak_password' || /password should|password is too|weak password/i.test(msg)) return t('settings.venusErrWeak');
  if (code === 'otp_expired' || /token has expired|invalid otp|otp.*(invalid|expired)|token.*(invalid|expired)/i.test(msg)) return t('settings.venusErrCode');
  if (code === 'reauthentication_needed' || /reauthenticat/i.test(msg)) return t('settings.venusErrReauth');
  if (/rate_limit/.test(code) || err?.status === 429 || /rate limit|security purposes/i.test(msg)) return t('settings.venusErrRate');
  if (code === 'signup_disabled' || /signups? not allowed|signup.*disabled/i.test(msg)) return t('settings.venusErrSignupDisabled');
  if (code === 'email_address_invalid' || /invalid.*email|email.*invalid/i.test(msg)) return t('settings.venusErrEmail');
  if (/database error saving new user/i.test(msg)) return t('settings.venusErrDb');
  if (err?.name === 'AuthRetryableFetchError' || /failed to fetch|fetch failed|network/i.test(msg)) return t('settings.venusErrNetwork');
  return msg ? t('settings.venusErrGeneric', { error: msg }) : t('settings.errUnknown');
}

const notConfirmed = (err) => String(err?.code || '') === 'email_not_confirmed' || /email not confirmed/i.test(String(err?.message || ''));

// ---------------- Cuentas de Minecraft ----------------

function mcCard(ctx) {
  const list = h('div', { class: 'cfg-mc-list' });
  const manageBtn = h('button', { type: 'button', class: 'btn sm', onclick: () => openAccounts() }, icon('users'), t('settings.mcManage'));
  const useAccount = (btn, acc) =>
    withBusy(btn, async () => {
      try {
        await api.accounts.select(acc.id);
        await store.refreshAccounts();
      } catch (err) {
        fail(t('settings.mcSelectError'), err);
      }
    });
  const draw = () => {
    if (!ctx.alive()) return;
    const accs = store.accounts?.accounts || [];
    const selId = store.selectedAccount()?.id;
    manageBtn.hidden = !accs.length;
    if (!accs.length) {
      mount(list, emptyRow('user', t('settings.mcNone'), t('settings.mcNoneSub'), h('button', { type: 'button', class: 'btn primary sm', onclick: () => openAccounts() }, icon('plus'), t('settings.mcAdd'))));
      return;
    }
    mount(
      list,
      accs.map((a) => {
        const active = a.id === selId;
        // Sesion de Microsoft vencida: se avisa con texto e icono y se ofrece volver a entrar.
        const sub = a.needsLogin
          ? h('div', { class: 'cfg-mc-sub is-warn', title: t('common.needsLoginHint') }, icon('alert'), h('span', {}, t('common.needsLogin')))
          : h('div', { class: 'cfg-mc-sub' }, a.type === 'msa' ? t('settings.mcMicrosoft') : t('settings.mcOffline'));
        let action;
        if (a.needsLogin) action = h('button', { type: 'button', class: 'btn sm', title: t('common.needsLoginHint'), onclick: () => openAccounts() }, icon('logIn'), t('common.needsLogin'));
        else if (active) action = h('span', { class: 'badge accent' }, icon('check'), t('settings.mcInUse'));
        else action = h('button', { type: 'button', class: 'btn sm ghost', title: t('settings.mcUseTitle', { name: a.name }), onclick: (e) => useAccount(e.currentTarget, a) }, t('settings.mcUse'));
        return h(
          'div',
          { class: ['cfg-mc', active && 'active', a.needsLogin && 'needs-login'] },
          avatarImg(a.type === 'msa' ? a.uuid : a.name, 64, 'cfg-mc-avatar'),
          h('div', { class: 'cfg-mc-main' }, h('div', { class: 'cfg-mc-name ellipsis', title: a.name }, a.name), sub),
          active && a.needsLogin ? h('span', { class: 'badge accent' }, icon('check'), t('settings.mcInUse')) : null,
          action,
        );
      }),
    );
  };
  draw();
  ctx.onCleanup(store.on('accounts', draw));
  return card({ title: t('settings.mcTitle'), iconName: 'gamepad', sub: t('settings.mcSub'), anchor: 'accounts', extra: manageBtn }, list);
}

// ---------------- Cuenta de Venus ----------------

const FEATURES = [
  ['users', 'featFriends'],
  ['message', 'featChat'],
  ['mic', 'featVoice'],
  ['share', 'featPacks'],
  ['cloudUpload', 'featSaves'],
  ['sparkles', 'featAi'],
];

function features() {
  return h(
    'div',
    { class: 'cfg-feats-wrap' },
    h('div', { class: 'cfg-mini-title' }, t('settings.featTitle')),
    h('div', { class: 'cfg-feats' }, FEATURES.map(([ic, key]) => h('div', { class: 'cfg-feat' }, h('span', { class: 'cfg-feat-icon', 'aria-hidden': 'true' }, icon(ic)), h('span', {}, t(`settings.${key}`))))),
  );
}

function venusCard(ctx) {
  const pill = h('span', { class: 'cfg-pill-slot' });
  const box = h('div', { class: 'cfg-venus' });
  let lastKey = null;
  let locked = false; // durante un pedido no se redibuja por eventos (se hace al terminar)
  let pending = false;
  let timer = null; // cuenta regresiva de "Reenviar"
  let profileAsked = null; // usuario cuyo perfil ya se volvio a pedir

  const viewKey = () => {
    if (!cloud.isConfigured()) return 'off';
    if (!cloud.isSignedIn()) return `out:${form.mode}`;
    const p = cloud.profile;
    return `in:${cloud.user?.id}:${p ? [p.username, p.display_name, p.friend_code, p.mc_name].join('|') : '-'}`;
  };

  const drawPill = () => {
    if (!cloud.isConfigured()) mount(pill, h('span', { class: 'pill' }, icon('cloud'), t('settings.venusPillOff')));
    else if (cloud.isSignedIn()) mount(pill, h('span', { class: 'pill good' }, icon('check'), t('settings.venusPillIn')));
    else mount(pill, h('span', { class: 'pill' }, icon('user'), t('settings.venusPillOut')));
  };

  const draw = (force = false) => {
    if (!ctx.alive()) return;
    if (locked && !force) {
      pending = true;
      return;
    }
    const key = viewKey();
    if (!force && key === lastKey) return;
    lastKey = key;
    clearInterval(timer);
    timer = null;
    drawPill();
    if (!cloud.isConfigured()) mount(box, offView());
    else if (cloud.isSignedIn()) mount(box, profileView());
    else mount(box, formsView());
  };
  const lock = () => {
    locked = true;
    pending = false;
  };
  const unlock = () => {
    locked = false;
    if (pending || viewKey() !== lastKey) draw(true);
    pending = false;
  };
  const switchMode = (mode) => {
    form.mode = mode;
    form.msg = null;
    draw(true);
  };

  // --- La nube de Venus no se pudo iniciar (no deberia pasar: el proyecto viene con el launcher) ---
  const offView = () => h('div', { class: 'cfg-venus-off' }, note('info', 'cloud', h('div', {}, t('settings.venusUnavailable'))), features());

  // --- Formularios (sin sesion) ---
  const resendButton = (onResend) => {
    const btn = h('button', { type: 'button', class: 'btn ghost sm num' });
    const tick = () => {
      if (btn.getAttribute('aria-busy') === 'true') return;
      const left = Math.ceil((form.resendAt - Date.now()) / 1000);
      btn.disabled = left > 0;
      mount(btn, icon('refresh'), left > 0 ? t('settings.venusResendIn', { s: left }) : t('settings.venusResend'));
      if (left <= 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    btn.addEventListener('click', () => withBusy(btn, onResend).then(tick));
    tick();
    clearInterval(timer);
    timer = setInterval(() => {
      if (!btn.isConnected) {
        clearInterval(timer);
        timer = null;
        return;
      }
      tick();
    }, 1000);
    return btn;
  };

  const emailInput = (id) => {
    const input = h('input', { class: 'input', type: 'email', id, value: form.email, autocomplete: 'email', spellcheck: 'false', placeholder: t('settings.venusEmailPh') });
    input.addEventListener('input', () => (form.email = input.value));
    return validateOnBlur(input, (v) => (EMAIL.test(v) ? null : t('settings.venusErrEmail')));
  };

  const codeInput = (id) =>
    validateOnBlur(
      h('input', { class: 'input code-input cfg-code-input', id, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, spellcheck: 'false', placeholder: t('settings.venusCodePh') }),
      (v) => (v.replace(/\D/g, '').length >= 6 ? null : t('settings.venusCodeInvalid')),
    );
  const codeDigits = (input) => input.value.replace(/\D/g, '');
  const newPassword = (id) => {
    const pass = secretField({ id, autocomplete: 'new-password', mono: false });
    validateOnBlur(pass.input, (v) => (v.length >= MIN_PASSWORD ? null : t('settings.venusPassShort', { count: MIN_PASSWORD })));
    return pass;
  };
  // Boton de envio: primario solo si entrar a la cuenta de Venus es lo que falta (un primario por vista).
  const submitBtn = (ic, text) => h('button', { type: 'submit', class: ['btn', primaryStep() === 'venus' && 'primary'], dataset: { cfgCta: 'venus' } }, icon(ic), text);

  const signInForm = (msg) => {
    const email = emailInput('cfg-v-email');
    const pass = secretField({ id: 'cfg-v-pass', autocomplete: 'current-password', mono: false });
    const submit = submitBtn('logIn', t('settings.venusSignInBtn'));
    const onSubmit = (e) => {
      e.preventDefault();
      msg.clear();
      const em = email.value.trim();
      const pw = pass.input.value;
      if (!EMAIL.test(em)) return fieldError(email, t('settings.venusErrEmail'), { focus: true });
      if (!pw) return fieldError(pass.input, t('settings.venusPassRequired'), { focus: true });
      form.email = em;
      withBusy(submit, async () => {
        lock();
        try {
          await cloud.signIn({ email: em, password: pw });
          form.msg = null;
          ok(t('settings.venusSignedInOk'));
        } catch (err) {
          if (notConfirmed(err)) {
            form.mode = 'verify';
            form.msg = { kind: 'info', text: t('settings.venusConfirmFirst', { email: em }) };
          } else msg.bad(authError(err));
        } finally {
          unlock();
        }
      });
    };
    return h(
      'form',
      { class: 'cfg-form', novalidate: true, onsubmit: onSubmit },
      field(t('settings.venusEmail'), email, { id: 'cfg-v-email' }),
      field(t('settings.venusPassword'), pass.el, { id: 'cfg-v-pass' }),
      h('div', { class: 'cfg-form-actions' }, submit, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => switchMode('reset') }, t('settings.venusForgot'))),
    );
  };

  const signUpForm = (msg) => {
    const user = h('input', { class: 'input', id: 'cfg-v-user', value: form.username, maxlength: 20, autocomplete: 'username', spellcheck: 'false', placeholder: t('settings.venusUserPh') });
    user.addEventListener('input', () => (form.username = user.value));
    validateOnBlur(user, (v) => (USERNAME.test(v) ? null : t('settings.venusUserInvalid')));
    const email = emailInput('cfg-v-email2');
    const pass = newPassword('cfg-v-pass2');
    const submit = submitBtn('userPlus', t('settings.venusCreateBtn'));
    const onSubmit = (e) => {
      e.preventDefault();
      msg.clear();
      const u = user.value.trim();
      const em = email.value.trim();
      const pw = pass.input.value;
      if (!USERNAME.test(u)) return fieldError(user, t('settings.venusUserInvalid'), { focus: true });
      if (!EMAIL.test(em)) return fieldError(email, t('settings.venusErrEmail'), { focus: true });
      if (pw.length < MIN_PASSWORD) return fieldError(pass.input, t('settings.venusPassShort', { count: MIN_PASSWORD }), { focus: true });
      form.username = u;
      form.email = em;
      withBusy(submit, async () => {
        lock();
        try {
          const res = await cloud.signUp({ email: em, password: pw, username: u });
          // Supabase no avisa si el email ya existe: devuelve un usuario sin identidades.
          if (res?.user && Array.isArray(res.user.identities) && res.user.identities.length === 0) {
            form.mode = 'signin';
            form.msg = { kind: 'bad', text: t('settings.venusErrExists') };
          } else if (res?.session) {
            form.mode = 'signin';
            form.msg = null;
            ok(t('settings.venusCreatedOk'));
          } else {
            form.mode = 'verify';
            form.resendAt = Date.now() + RESEND_MS;
            form.msg = { kind: 'info', text: t('settings.venusCodeSent', { email: em }) };
          }
        } catch (err) {
          msg.bad(authError(err));
        } finally {
          unlock();
        }
      });
    };
    return h(
      'form',
      { class: 'cfg-form', novalidate: true, onsubmit: onSubmit },
      field(t('settings.venusUser'), user, { id: 'cfg-v-user', hint: t('settings.venusUserHint') }),
      field(t('settings.venusEmail'), email, { id: 'cfg-v-email2' }),
      field(t('settings.venusPassword'), pass.el, { id: 'cfg-v-pass2', hint: t('settings.venusPassHint', { count: MIN_PASSWORD }) }),
      h('div', { class: 'cfg-form-actions' }, submit),
    );
  };

  const verifyForm = (msg) => {
    const code = codeInput('cfg-v-code');
    const submit = submitBtn('check', t('settings.venusVerifyBtn'));
    const onSubmit = (e) => {
      e.preventDefault();
      msg.clear();
      const digits = codeDigits(code);
      if (digits.length < 6) return fieldError(code, t('settings.venusCodeInvalid'), { focus: true });
      withBusy(submit, async () => {
        lock();
        try {
          await cloud.verifyEmailCode(form.email.trim(), digits, 'signup');
          form.mode = 'signin';
          form.msg = null;
          ok(t('settings.venusCreatedOk'));
        } catch (err) {
          msg.bad(authError(err));
        } finally {
          unlock();
        }
      });
    };
    const resend = resendButton(async () => {
      try {
        await cloud.resendSignupCode(form.email.trim());
        form.resendAt = Date.now() + RESEND_MS;
        msg.info(t('settings.venusResent', { email: form.email.trim() }));
      } catch (err) {
        msg.bad(authError(err));
      }
    });
    return h(
      'form',
      { class: 'cfg-form', novalidate: true, onsubmit: onSubmit },
      h('p', { class: 'cfg-text' }, t('settings.venusCodeHelp', { email: form.email.trim() })),
      field(t('settings.venusCode'), code, { id: 'cfg-v-code' }),
      h('div', { class: 'cfg-form-actions' }, submit, resend, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => switchMode('signup') }, t('settings.venusOtherEmail'))),
    );
  };

  const resetForm = (msg) => {
    const email = emailInput('cfg-v-email3');
    const submit = submitBtn('mail', t('settings.venusResetSend'));
    const onSubmit = (e) => {
      e.preventDefault();
      msg.clear();
      const em = email.value.trim();
      if (!EMAIL.test(em)) return fieldError(email, t('settings.venusErrEmail'), { focus: true });
      form.email = em;
      withBusy(submit, async () => {
        lock();
        try {
          await cloud.resetPassword(em);
          form.mode = 'resetCode';
          form.resendAt = Date.now() + RESEND_MS;
          form.msg = { kind: 'info', text: t('settings.venusResetSent', { email: em }) };
        } catch (err) {
          msg.bad(authError(err));
        } finally {
          unlock();
        }
      });
    };
    return h(
      'form',
      { class: 'cfg-form', novalidate: true, onsubmit: onSubmit },
      h('div', { class: 'cfg-form-title' }, icon('key'), t('settings.venusResetTitle')),
      h('p', { class: 'cfg-text' }, t('settings.venusResetHelp')),
      field(t('settings.venusEmail'), email, { id: 'cfg-v-email3' }),
      h('div', { class: 'cfg-form-actions' }, submit, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => switchMode('signin') }, icon('arrowLeft'), t('settings.venusBack'))),
    );
  };

  const resetCodeForm = (msg) => {
    const code = codeInput('cfg-v-code2');
    const pass = newPassword('cfg-v-newpass');
    const submit = submitBtn('check', t('settings.venusResetConfirm'));
    const onSubmit = (e) => {
      e.preventDefault();
      msg.clear();
      const digits = codeDigits(code);
      const pw = pass.input.value;
      if (digits.length < 6) return fieldError(code, t('settings.venusCodeInvalid'), { focus: true });
      if (pw.length < MIN_PASSWORD) return fieldError(pass.input, t('settings.venusPassShort', { count: MIN_PASSWORD }), { focus: true });
      withBusy(submit, async () => {
        lock();
        let verified = false;
        try {
          await cloud.verifyEmailCode(form.email.trim(), digits, 'recovery');
          verified = true;
          await cloud.updatePassword(pw);
          form.mode = 'signin';
          form.msg = null;
          ok(t('settings.venusPassChanged'), t('settings.venusPassChangedText'));
        } catch (err) {
          // Si el codigo sirvio ya hay sesion: la contrasenia se puede cambiar desde el perfil.
          if (verified) {
            form.mode = 'signin';
            form.msg = null;
            fail(t('settings.venusPassChangeFailed'), authError(err));
          } else msg.bad(authError(err));
        } finally {
          unlock();
        }
      });
    };
    const resend = resendButton(async () => {
      try {
        await cloud.resetPassword(form.email.trim());
        form.resendAt = Date.now() + RESEND_MS;
        msg.info(t('settings.venusResent', { email: form.email.trim() }));
      } catch (err) {
        msg.bad(authError(err));
      }
    });
    return h(
      'form',
      { class: 'cfg-form', novalidate: true, onsubmit: onSubmit },
      h('div', { class: 'cfg-form-title' }, icon('key'), t('settings.venusResetTitle')),
      h('p', { class: 'cfg-text' }, t('settings.venusResetCodeHelp', { email: form.email.trim() })),
      h('div', { class: 'form-grid cfg-grid-fit' }, field(t('settings.venusCode'), code, { id: 'cfg-v-code2' }), field(t('settings.venusNewPassword'), pass.el, { id: 'cfg-v-newpass' })),
      h('div', { class: 'cfg-form-actions' }, submit, resend, h('button', { type: 'button', class: 'btn ghost sm', onclick: () => switchMode('signin') }, icon('arrowLeft'), t('settings.venusBack'))),
      h('p', { class: 'small muted cfg-hint' }, t('settings.venusResetLinkHelp')),
    );
  };

  const formsView = () => {
    const box2 = msgBox();
    const msg = {
      bad: (text) => {
        form.msg = { kind: 'bad', text };
        box2.set('bad', text);
      },
      info: (text) => {
        form.msg = { kind: 'info', text };
        box2.set('info', text, 'mail');
      },
      clear: () => {
        form.msg = null;
        box2.clear();
      },
    };
    if (form.msg) box2.set(form.msg.kind, form.msg.text, form.msg.kind === 'info' ? 'mail' : undefined);
    const modes = { signup: signUpForm, verify: verifyForm, reset: resetForm, resetCode: resetCodeForm };
    const content = (modes[form.mode] || signInForm)(msg);
    const tabs = ['signin', 'signup'].includes(form.mode)
      ? h(
          'div',
          { class: 'segmented cfg-venus-tabs', role: 'tablist', 'aria-label': t('settings.venusTitle') },
          [
            ['signin', 'logIn'],
            ['signup', 'userPlus'],
          ].map(([m, ic]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(form.mode === m), class: form.mode === m ? 'active' : null, onclick: () => form.mode !== m && switchMode(m) }, icon(ic), t(`settings.venusTab_${m}`))),
        )
      : null;
    return h('div', { class: 'cfg-venus-out' }, h('div', { class: 'cfg-venus-form' }, tabs, content, box2.el), features());
  };

  // --- Con sesion: perfil, codigo de amigo, nombre visible, contrasenia ---
  const profileView = () => {
    const p = cloud.profile;
    const u = cloud.user;
    if (!p) {
      if (profileAsked !== u?.id) {
        profileAsked = u?.id;
        cloud
          .loadProfile()
          .catch(() => null)
          .then(() => draw(true));
        // Skeleton con la forma del perfil (avatar, nombre y codigo de amigo) mientras llega.
        return h(
          'div',
          { class: 'cfg-venus-in' },
          h('div', { class: 'cfg-v-head' }, skeleton('avatar', { size: 56, label: t('settings.venusLoadingProfile') }), h('div', { class: 'cfg-v-who' }, skeleton(2))),
          skeleton('block', { height: 64 }),
        );
      }
      return h(
        'div',
        { class: 'stack' },
        errorNote(t('settings.venusProfileError'), () => cloud.loadProfile().catch(() => null).then(() => draw(true))),
        h('div', { class: 'row wrap' }, signOutButton()),
      );
    }
    const name = p.display_name || p.username || u?.email || '';
    const avatar = p.mc_name ? avatarImg(p.mc_name, 64, 'cfg-v-avatar') : h('div', { class: 'cfg-v-avatar cfg-v-initial', 'aria-hidden': 'true' }, (name.trim()[0] || 'V').toUpperCase());

    const dn = h('input', { class: 'input', id: 'cfg-v-display', value: p.display_name || '', maxlength: 32, placeholder: p.username || '', autocomplete: 'nickname' });
    const saveName = h('button', { type: 'submit', class: 'btn sm', disabled: true }, icon('save'), t('settings.venusSaveName'));
    dn.addEventListener('input', () => {
      saveName.disabled = dn.value.trim() === (p.display_name || '');
    });
    const nameForm = h(
      'form',
      {
        class: 'cfg-inline-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          if (saveName.disabled) return;
          withBusy(saveName, async () => {
            try {
              await cloud.updateProfile({ display_name: dn.value.trim() || null });
              ok(t('settings.venusNameSaved'));
            } catch (err) {
              fail(t('settings.venusNameError'), authError(err));
            }
          });
        },
      },
      field(t('settings.venusDisplayName'), h('div', { class: 'cfg-input-row' }, dn, saveName), { id: 'cfg-v-display', hint: t('settings.venusDisplayHint') }),
    );

    // Cambiar contrasenia
    const np = newPassword('cfg-v-np1');
    const np2 = secretField({ id: 'cfg-v-np2', autocomplete: 'new-password', mono: false });
    validateOnBlur(np2.input, (v) => (v === np.input.value ? null : t('settings.venusPassMismatch')));
    const passMsg = msgBox();
    const passBtn = h('button', { type: 'submit', class: 'btn sm' }, icon('key'), t('settings.venusChangePassBtn'));
    const details = h(
      'details',
      { class: 'cfg-details' },
      h('summary', {}, icon('lock'), h('span', {}, t('settings.venusChangePass')), icon('chevronDown', 'cfg-details-chev')),
      h(
        'form',
        {
          class: 'cfg-form cfg-details-body',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            passMsg.clear();
            const a = np.input.value;
            if (a.length < MIN_PASSWORD) return fieldError(np.input, t('settings.venusPassShort', { count: MIN_PASSWORD }), { focus: true });
            if (a !== np2.input.value) return fieldError(np2.input, t('settings.venusPassMismatch'), { focus: true });
            withBusy(passBtn, async () => {
              try {
                await cloud.updatePassword(a);
                np.input.value = '';
                np2.input.value = '';
                details.open = false;
                ok(t('settings.venusPassChanged'));
              } catch (err) {
                passMsg.set('bad', authError(err));
              }
            });
          },
        },
        h('div', { class: 'form-grid cfg-grid-fit' }, field(t('settings.venusNewPassword'), np.el, { id: 'cfg-v-np1' }), field(t('settings.venusRepeatPassword'), np2.el, { id: 'cfg-v-np2' })),
        h('div', { class: 'cfg-form-actions' }, passBtn),
        passMsg.el,
      ),
    );

    return h(
      'div',
      { class: 'cfg-venus-in' },
      h(
        'div',
        { class: 'cfg-v-head' },
        avatar,
        h(
          'div',
          { class: 'cfg-v-who' },
          h('div', { class: 'cfg-v-name ellipsis', title: name }, name),
          h('div', { class: 'cfg-v-sub' }, p.username ? h('span', {}, `@${p.username}`) : null, u?.email ? h('span', { class: 'ellipsis', title: u.email }, u.email) : null),
        ),
        signOutButton(),
      ),
      p.friend_code
        ? h(
            'div',
            { class: 'cfg-v-code' },
            h('div', { class: 'cfg-v-code-text' }, h('div', { class: 'cfg-v-code-label' }, t('settings.venusFriendCode')), h('div', { class: 'small muted' }, t('settings.venusFriendCodeHint'))),
            h(
              'div',
              { class: 'cfg-code-chip' },
              h('span', { class: 'selectable' }, p.friend_code),
              h('button', { type: 'button', class: 'icon-btn sm', title: t('settings.venusCopyCode'), 'aria-label': t('settings.venusCopyCode'), onclick: () => copyText(p.friend_code, t('settings.venusCodeCopied')) }, icon('copy')),
            ),
          )
        : null,
      nameForm,
      details,
    );
  };

  const signOutButton = () =>
    h(
      'button',
      {
        type: 'button',
        class: 'btn sm ghost',
        onclick: (e) =>
          withBusy(e.currentTarget, async () => {
            try {
              await cloud.signOut();
              form.mode = 'signin';
              form.msg = null;
              ok(t('settings.venusSignedOut'));
            } catch (err) {
              fail(t('settings.venusSignOutError'), authError(err));
            }
          }),
      },
      icon('logout'),
      t('settings.venusSignOut'),
    );

  draw(true);
  ctx.onCleanup(cloud.on('auth', () => draw()));
  ctx.onCleanup(cloud.on('profile', () => draw()));
  ctx.onCleanup(cloud.on('config', () => draw()));
  ctx.onCleanup(() => clearInterval(timer));
  return card({ title: t('settings.venusTitle'), iconName: 'sparkles', sub: t('settings.venusSub'), anchor: 'venus', extra: pill }, box);
}

// ---------------- Seccion ----------------

// Funcion pura exportada para poder probarla.
export { authError };

export function renderCloud(body, ctx) {
  mount(body, sectionHead('cloud', 'cloud'), mcCard(ctx), venusCard(ctx));
  // Un solo primario: cuando cambia lo que falta (cuentas o sesion) se mueve al boton que corresponde.
  const paintPrimary = () => {
    if (!ctx.alive()) return;
    const step = primaryStep();
    body.querySelectorAll('[data-cfg-cta]').forEach((b) => b.classList.toggle('primary', b.dataset.cfgCta === step));
  };
  ctx.onCleanup(store.on('accounts', paintPrimary));
  ctx.onCleanup(cloud.on('auth', paintPrimary));
  ctx.onCleanup(cloud.on('config', paintPrimary));
}
