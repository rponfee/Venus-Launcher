// Entrar con la cuenta de Venus: los mismos métodos de js/cloud.js, todos con email y código (nunca hay una redirección).
import { h, icon, mount, notice } from '../dom.js';
import { authErrorKey } from '../logic.js';

const USERNAME = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6,10}$/;
const RESEND_MS = 60_000;
const MIN_PASSWORD = 6; // como en el launcher

export function renderLogin(root, { client, tr }) {
  const form = { mode: 'signin', email: '', username: '', msg: null, resendAt: 0, recoveryVerified: false };

  const field = (id, label, attrs) => {
    const input = h('input', { id, class: 'input', ...attrs });
    return { input, el: h('label', { class: 'field', for: id }, h('span', { class: 'field-label' }, label), input) };
  };

  const setMsg = (kind, key, vars) => {
    form.msg = key ? { kind, text: tr(key, vars) } : null;
  };

  async function busy(btn, run) {
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      console.warn('[app] cuenta', err?.code || err?.message);
      const key = authErrorKey(err);
      if (key === 'auth_not_confirmed') {
        form.mode = 'verify';
        setMsg('info', 'auth_not_confirmed');
      } else {
        setMsg('bad', key);
      }
      draw();
    } finally {
      btn.disabled = false;
    }
  }

  function wrap(title, subtitle, onsubmit, fields, submitText, extra) {
    const submit = h('button', { class: 'btn primary wide', type: 'submit' }, submitText);
    const el = h(
      'form',
      {
        class: 'login-form',
        novalidate: true,
        onsubmit: (e) => {
          e.preventDefault();
          busy(submit, onsubmit);
        },
      },
      h('h2', {}, title),
      subtitle ? h('p', { class: 'muted' }, subtitle) : null,
      form.msg ? notice(form.msg.kind, form.msg.text) : null,
      fields.map((f) => f.el),
      submit,
      extra,
    );
    return el;
  }

  const linkBtn = (text, onclick) => h('button', { class: 'btn link', type: 'button', onclick }, text);
  const goto = (mode) => async () => {
    if (form.recoveryVerified) {
      await client.auth.signOut({ scope: 'local' });
      form.recoveryVerified = false;
    }
    form.mode = mode;
    form.msg = null;
    draw();
  };

  function signinForm() {
    const email = field('l-email', tr('login_email'), { type: 'email', value: form.email, autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' });
    const pass = field('l-pass', tr('login_password'), { type: 'password', autocomplete: 'current-password' });
    return wrap(
      tr('login_title'),
      tr('login_subtitle'),
      async () => {
        form.email = email.input.value.trim();
        if (!EMAIL.test(form.email)) throw Object.assign(new Error('invalid email'), { code: 'email_address_invalid' });
        const { error } = await client.auth.signInWithPassword({ email: form.email, password: pass.input.value });
        if (error) throw error;
      },
      [email, pass],
      tr('login_submit'),
      h('div', { class: 'login-links' }, linkBtn(tr('login_forgot'), goto('reset')), linkBtn(tr('login_create'), goto('signup'))),
    );
  }

  function signupForm() {
    const user = field('l-user', tr('login_username'), { value: form.username, autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', maxlength: 20 });
    const email = field('l-email', tr('login_email'), { type: 'email', value: form.email, autocomplete: 'email', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' });
    const pass = field('l-pass', tr('login_password'), { type: 'password', autocomplete: 'new-password' });
    return wrap(
      tr('signup_title'),
      null,
      async () => {
        form.username = user.input.value.trim();
        form.email = email.input.value.trim();
        if (!USERNAME.test(form.username)) {
          setMsg('bad', 'signup_bad_user');
          draw();
          return;
        }
        if (!EMAIL.test(form.email)) throw Object.assign(new Error('invalid email'), { code: 'email_address_invalid' });
        if (pass.input.value.length < MIN_PASSWORD) {
          setMsg('bad', 'auth_weak');
          draw();
          return;
        }
        const { data, error } = await client.auth.signUp({ email: form.email, password: pass.input.value, options: { data: { username: form.username } } });
        if (error) throw error;
        // Supabase no avisa si el email ya existe: devuelve un usuario sin identidades.
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          form.mode = 'signin';
          setMsg('bad', 'auth_exists');
          draw();
          return;
        }
        if (!data?.session) {
          form.mode = 'verify';
          form.resendAt = Date.now() + RESEND_MS;
          setMsg('info', 'verify_sent');
          draw();
        }
      },
      [user, email, pass],
      tr('signup_submit'),
      h('div', { class: 'login-links' }, linkBtn(tr('login_back'), goto('signin'))),
    );
  }

  function codeField() {
    return field('l-code', tr('verify_code'), { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, pattern: '[0-9]*' });
  }

  function verifyForm() {
    const code = codeField();
    const resend = linkBtn(tr('verify_resend'), async () => {
      if (Date.now() < form.resendAt) {
        setMsg('info', 'verify_wait');
        draw();
        return;
      }
      await busy(resend, async () => {
        const { error } = await client.auth.resend({ type: 'signup', email: form.email });
        if (error) throw error;
        form.resendAt = Date.now() + RESEND_MS;
        setMsg('info', 'verify_sent');
        draw();
      });
    });
    return wrap(
      tr('verify_title'),
      tr('verify_text', { email: form.email }),
      async () => {
        const token = code.input.value.replace(/\D/g, '');
        if (!CODE.test(token)) {
          setMsg('bad', 'auth_code');
          draw();
          return;
        }
        const { error } = await client.auth.verifyOtp({ email: form.email, token, type: 'signup' });
        if (error) throw error;
      },
      [code],
      tr('verify_submit'),
      h('div', { class: 'login-links' }, resend, linkBtn(tr('login_back'), goto('signin'))),
    );
  }

  function resetForm() {
    const email = field('l-email', tr('login_email'), { type: 'email', value: form.email, autocomplete: 'username', inputmode: 'email', autocapitalize: 'none', spellcheck: 'false' });
    return wrap(
      tr('reset_title'),
      tr('reset_text'),
      async () => {
        form.email = email.input.value.trim();
        if (!EMAIL.test(form.email)) throw Object.assign(new Error('invalid email'), { code: 'email_address_invalid' });
        const { error } = await client.auth.resetPasswordForEmail(form.email);
        if (error) throw error;
        form.mode = 'resetCode';
        setMsg('info', 'reset_sent');
        draw();
      },
      [email],
      tr('reset_submit'),
      h('div', { class: 'login-links' }, linkBtn(tr('login_back'), goto('signin'))),
    );
  }

  function resetCodeForm() {
    const code = codeField();
    const pass = field('l-pass', tr('reset_new'), { type: 'password', autocomplete: 'new-password' });
    return wrap(
      tr('reset_title'),
      tr('verify_text', { email: form.email }),
      async () => {
        const token = code.input.value.replace(/\D/g, '');
        if (!form.recoveryVerified && !CODE.test(token)) {
          setMsg('bad', 'auth_code');
          draw();
          return;
        }
        if (pass.input.value.length < MIN_PASSWORD) {
          setMsg('bad', 'auth_weak');
          draw();
          return;
        }
        if (!form.recoveryVerified) {
          const res = await client.auth.verifyOtp({ email: form.email, token, type: 'recovery' });
          if (res.error) throw res.error;
          form.recoveryVerified = true;
        }
        const up = await client.auth.updateUser({ password: pass.input.value });
        if (up.error) throw up.error;
      },
      form.recoveryVerified ? [pass] : [code, pass],
      tr('reset_save'),
      h('div', { class: 'login-links' }, linkBtn(tr('login_back'), goto('signin'))),
    );
  }

  function draw() {
    const forms = { signup: signupForm, verify: verifyForm, reset: resetForm, resetCode: resetCodeForm };
    mount(
      root,
      h(
        'main',
        { class: 'login' },
        h('div', { class: 'login-brand' }, h('img', { src: 'assets/icon-192.png', alt: '', width: 72, height: 72, class: 'login-logo' }), h('h1', { class: 'pixel' }, 'Venus')),
        (forms[form.mode] || signinForm)(),
        h('p', { class: 'login-foot muted' }, icon('gamepad', 16), tr('login_foot')),
      ),
    );
  }

  draw();
}
