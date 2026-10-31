'use strict';
// Modelos y niveles de esfuerzo del asistente (funciones puras, se prueban sin red):
//   modelOptions(aiStatus)   modelos que se pueden elegir ahora, con sus esfuerzos y las preguntas que quedan
//   fitChoice(choice, opts)  ajusta una eleccion guardada a lo que permite el plan
//   budgetOf(quota)          gasto del mes del plan
// Todo sale de la cuota del plan (QuotaV2 del backend).
const ai = require('../ai');

const ORDER = ['haiku', 'sonnet', 'opus'];

// Una cuota ya vencida (la hora de renovacion paso) cuenta como renovada.
function renewed(resetIso, now) {
  const at = resetIso ? Date.parse(resetIso) : NaN;
  return Number.isFinite(at) && at <= now;
}

// { used, limit } -> { used, limit, remaining }; limit null = sin limite.
function limitOf(x, resetIso, now) {
  if (!x || typeof x !== 'object') return null;
  const used = renewed(resetIso, now) ? 0 : Math.max(0, Number(x.used) || 0);
  const limit = x.limit === null || x.limit === undefined || Number(x.limit) === 2147483647 || !Number.isFinite(Number(x.limit)) ? null : Math.max(0, Number(x.limit));
  return { used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
}

function budgetOf(quota, now = Date.now()) {
  const b = quota?.budget;
  if (!b || typeof b !== 'object') return null;
  const limitUsd = Number(b.limitUsd);
  // El saldo se renueva únicamente al confirmar un nuevo pago en el servidor.
  const usedUsd = Math.max(0, Number(b.usedUsd) || 0);
  if (!Number.isFinite(limitUsd) || limitUsd <= 0) return { usedUsd, limitUsd: null, remainingUsd: null, exhausted: false };
  return { usedUsd, limitUsd, remainingUsd: Math.max(0, Math.round((limitUsd - usedUsd) * 100) / 100), exhausted: usedUsd >= limitUsd };
}

// Lista de opciones para el selector del asistente. [] = no hay IA o no hay plan.
function modelOptions(st, now = Date.now()) {
  if (!st || st.enabled === false || !st.provider) return [];
  const q = st.quota;
  if (q && typeof q === 'object' && Array.isArray(q.models)) {
    if (q.status === 'none') return [];
    const resets = q.resets && typeof q.resets === 'object' ? q.resets : {};
    const budget = budgetOf(q, now);
    const out = [];
    for (const m of q.models) {
      const id = ai.modelAlias(m?.id) || ai.modelAlias(m?.model);
      if (!id || out.some((o) => o.id === id)) continue;
      const efforts = Array.isArray(m.efforts) ? ai.EFFORTS.filter((e) => m.efforts.includes(e)) : [...ai.EFFORTS];
      if (!efforts.length) continue;
      const daily = limitOf(m.daily, resets.daily, now);
      const weekly = limitOf(m.weekly, resets.weekly, now);
      const left = [daily?.remaining, weekly?.remaining].filter((n) => typeof n === 'number');
      // Si hay mas de un limite agotado, manda el que tarda mas en renovarse
      let blocked = null;
      let resetAt = null;
      if (daily?.remaining === 0) [blocked, resetAt] = ['daily', resets.daily || null];
      if (weekly?.remaining === 0) [blocked, resetAt] = ['weekly', resets.weekly || null];
      if (budget?.exhausted) [blocked, resetAt] = ['budget', resets.monthly || null];
      out.push({
        id,
        model: (typeof m.model === 'string' && m.model) || ai.MODEL_ALIASES[id],
        label: ai.modelLabel(id, q),
        efforts,
        daily,
        weekly,
        remaining: left.length ? Math.min(...left) : null,
        blocked,
        resetAt,
      });
    }
    return out;
  }
  return [];
}

// Ajusta { model, effort } a las opciones: un modelo que no esta pasa al primero del plan y el esfuerzo al
// permitido mas parecido. Sin opciones (no se sabe el plan) devuelve la eleccion normalizada.
function fitChoice(choice = {}, options = []) {
  const model = ai.modelAlias(choice?.model);
  const effort = ai.normalizeEffort(choice?.effort) || 'medium';
  if (!Array.isArray(options) || !options.length) return { model, effort };
  const opt = options.find((o) => o.id === model) || options[0];
  return { model: opt.id, effort: ai.bestEffort(effort, opt.efforts) || effort };
}

module.exports = { modelOptions, fitChoice, budgetOf, normalizeModel: ai.modelAlias, normalizeEffort: ai.normalizeEffort, ORDER };
