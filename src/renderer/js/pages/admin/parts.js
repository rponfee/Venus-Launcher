// Piezas compartidas por las pestañas del panel de administración: llamadas al proceso principal, formatos,
// tarjetas, estados de error y el resumen de las acciones en lote.
import { h, icon, mount, modal, toast, fail } from '../../ui.js';
import { api } from '../../store.js';
import { t, locale, getLanguage } from '../../i18n.js';

export const T = (key, vars) => t(`admin.${key}`, vars);

// Montos como en los pagos del launcher ("US$ 9,25" en español, como billing).
const CURRENCY_LOCALES = { es: 'es-AR', en: 'en-US', pt: 'pt-BR' };

/** Acción del panel (Edge Function "admin" por el proceso principal). Lanza el Error con err.code. */
export function call(action, payload) {
  return api.invoke('admin:call', action, payload || {});
}

// ---------- Formatos ----------

/** Dólares. precise: los montos chicos (gasto de IA) con hasta 4 decimales ("US$ 0,0042"). */
export function fmtUsd(value, { precise = false } = {}) {
  const n = Number(value) || 0;
  const max = precise && Math.abs(n) > 0 && Math.abs(n) < 1 ? 4 : 2;
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALES[getLanguage()] || locale(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: max }).format(n);
  } catch {
    return `US$ ${n.toFixed(max)}`;
  }
}

/** Centavos de dólar -> "US$ 9,25". */
export const fmtCents = (cents) => fmtUsd((Number(cents) || 0) / 100);

export function fmtInt(n) {
  try {
    return new Intl.NumberFormat(locale()).format(Number(n) || 0);
  } catch {
    return String(n ?? 0);
  }
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

/** Más de 50 años: un baneo o silencio "permanente". */
export const isPermanent = (iso) => Number.isFinite(ms(iso)) && ms(iso) - Date.now() > 50 * 365 * 86400000;

export function fmtDay(iso) {
  const v = ms(iso);
  if (!Number.isFinite(v)) return '—';
  return new Date(v).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso) {
  const v = ms(iso);
  if (!Number.isFinite(v)) return '—';
  return new Date(v).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(iso) {
  const v = ms(iso);
  if (!Number.isFinite(v)) return T('never');
  const diff = (v - Date.now()) / 1000;
  const abs = Math.abs(diff);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    if (abs < 60) return T('justNow');
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
    if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), 'month');
    return rtf.format(Math.round(diff / (86400 * 365)), 'year');
  } catch {
    return fmtDay(iso);
  }
}

/** Fecha local (YYYY-MM-DD de un input date) -> ISO del final de ese día en la hora de la PC. */
export function endOfDayIso(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59).toISOString();
}

/** Para el atributo min de un input date: mañana en la hora de la PC. */
export function tomorrowInput() {
  const d = new Date(Date.now() + 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Piezas ----------

export function kpi({ icon: ic, label, value, foot, tone }) {
  return h(
    'div',
    { class: ['card', 'kpi', 'adm-kpi', tone && `adm-kpi-${tone}`] },
    h('div', { class: 'kpi-label' }, icon(ic), label),
    h('div', { class: 'kpi-value', title: typeof value === 'string' ? value : null }, value),
    foot ? h('div', { class: 'kpi-foot' }, foot) : null,
  );
}

export function card({ icon: ic, title, sub, actions, cls } = {}, ...body) {
  return h(
    'section',
    { class: ['card', 'adm-card', cls] },
    h(
      'div',
      { class: 'adm-card-head' },
      h('div', { class: 'adm-card-titles' }, h('h2', { class: 'card-title' }, ic ? icon(ic) : null, title), sub ? h('div', { class: 'card-sub' }, sub) : null),
      actions && actions.filter(Boolean).length ? h('div', { class: 'adm-card-actions' }, actions.filter(Boolean)) : null,
    ),
    ...body,
  );
}

/** Error de una vista: qué pasó + Reintentar (y el botón a Ajustes si es de sesión o de nube). */
export function errorBox(err, onRetry) {
  return h(
    'div',
    { class: 'notice bad adm-error', role: 'alert' },
    icon('alert'),
    h('div', { class: 'spacer' }, h('div', { class: 'adm-error-title' }, T('loadError')), h('div', { class: 'small' }, err?.message || String(err || ''))),
    onRetry ? h('button', { class: 'btn sm', type: 'button', onclick: onRetry }, icon('refresh'), T('retry')) : null,
  );
}

export function skeletonRows(rows = 6) {
  return h(
    'div',
    { class: 'skeleton-group adm-skel', role: 'status', 'aria-live': 'polite', 'aria-busy': 'true' },
    h('span', { class: 'sr-only' }, T('loading')),
    h('div', { class: 'skeleton-shapes', 'aria-hidden': 'true' }, Array.from({ length: rows }, () => h('span', { class: 'skeleton skeleton-line adm-skel-row' }))),
  );
}

export function planBadge(plan) {
  if (!plan) return h('span', { class: 'badge adm-plan-none' }, T('noPlan'));
  const cls = !plan.active ? 'adm-plan-off' : plan.source === 'support' ? 'accent' : 'info';
  const source = ['support', 'stripe', 'admin', 'manual'].includes(plan.source) ? T(`source_${plan.source}`) : plan.source || null;
  return h('span', { class: ['badge', cls], title: source }, plan.name || plan.id);
}

/** Pastillas de estado de un usuario (siempre con texto, nunca solo color). */
export function statePills(user) {
  const pills = [];
  const mod = user.moderation || {};
  if (user.isAdmin) pills.push(h('span', { class: 'pill info' }, icon('shieldCheck'), T('pill_admin')));
  if (mod.banned) pills.push(h('span', { class: 'pill bad', title: mod.banReason || null }, icon('ban'), T('pill_banned')));
  if (mod.muted) pills.push(h('span', { class: 'pill warn' }, icon('volumeX'), T('pill_muted')));
  if (user.emailConfirmed === false) pills.push(h('span', { class: 'pill warn' }, icon('mail'), T('pill_unconfirmed')));
  const p = user.plan;
  if (p && (p.stripeStatus === 'past_due' || p.stripeStatus === 'unpaid')) pills.push(h('span', { class: 'pill bad' }, icon('alert'), T('pill_pastDue')));
  else if (p && p.active && p.cancelAtPeriodEnd) pills.push(h('span', { class: 'pill warn' }, icon('clock'), T('pill_canceling')));
  return pills;
}

export function displayName(user) {
  return user?.username || user?.displayName || user?.email || user?.id || '?';
}

// ---------- Resultados de las acciones en lote ----------

const ITEM_ERRORS = new Set(['self', 'target_admin', 'not_found', 'stripe', 'stripe_not_configured', 'stripe_mode', 'auth', 'db', 'unknown_plan', 'not_applied', 'error']);

/** Toast con el resumen y, si hubo fallas o avisos, un diálogo con el detalle. onCancelStripe(userId) opcional. */
export function showBulkResult(res, { names = new Map(), onCancelStripe } = {}) {
  const results = Array.isArray(res?.results) ? res.results : [];
  const ok = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const warnings = (Array.isArray(res?.warnings) ? res.warnings : []).filter((w) => w && w.code);
  if (!failed.length) toast('good', T('doneAll', { count: ok }));
  else if (ok) toast('bad', T('donePartial', { ok, total: results.length }), null, 7000);
  else toast('bad', T('doneNone', { count: results.length }), null, 7000);
  if (!failed.length && !warnings.length) return;

  const nameOf = (id, email) => names.get(id) || email || id;
  const body = h('div', { class: 'stack adm-result' });
  if (failed.length) {
    body.append(
      h('div', { class: 'adm-result-title' }, icon('alert'), T('failedTitle', { count: failed.length })),
      h(
        'ul',
        { class: 'adm-result-list' },
        failed.map((r) => h('li', {}, h('b', {}, nameOf(r.id)), ' — ', ITEM_ERRORS.has(r.error) ? T(`err_${r.error}`) : T('err_error'))),
      ),
    );
  }
  const byCode = new Map();
  for (const w of warnings) {
    if (!byCode.has(w.code)) byCode.set(w.code, []);
    byCode.get(w.code).push(w);
  }
  for (const [code, list] of byCode) {
    const known = ['stripe_active', 'stripe_unchecked', 'signout_failed', 'files_not_removed', 'stripe_not_canceled', 'audit_failed'].includes(code);
    body.append(h('div', { class: 'notice' }, icon('alert'), h('div', {}, known ? T(`warn_${code}`, { count: list.length }) : code)));
    if (code === 'stripe_active' && onCancelStripe) {
      body.append(
        h(
          'ul',
          { class: 'adm-result-list' },
          list.map((w) =>
            h(
              'li',
              { class: 'adm-result-row' },
              h('span', { class: 'ellipsis' }, nameOf(w.id, w.email)),
              h('button', { class: 'btn sm danger', type: 'button', onclick: () => onCancelStripe(w.id, nameOf(w.id, w.email)) }, icon('x'), T('act_cancelStripe')),
            ),
          ),
        ),
      );
    }
  }
  const m = modal({ title: T('resultTitle'), body, footer: [h('button', { class: 'btn primary', type: 'button', onclick: () => m.close() }, T('close'))] });
}

/** Error de una acción: toast con el mensaje ya traducido (y el campo, si el servidor lo marcó). */
export function failAction(err) {
  fail(T('actionFailed'), err);
}

/** Etiqueta + campo + ayuda (con ids enlazados para el lector de pantalla). */
let fieldSeq = 0;
export function field(label, control, help) {
  const id = control.id || `adm-f-${++fieldSeq}`;
  control.id = id;
  const helpId = help ? `${id}-help` : null;
  if (helpId) control.setAttribute('aria-describedby', helpId);
  return h('div', { class: 'field' }, h('label', { for: id }, label), control, help ? h('div', { class: 'field-help', id: helpId }, help) : null);
}

export function mountInto(el, ...children) {
  mount(el, ...children);
  return el;
}
