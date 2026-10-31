'use strict';
// Exportacion de estadisticas: CSV de sesiones (listo para Excel / Hojas de calculo) y JSON completo.
const { t, getLanguage } = require('../../core/i18n');

// Idiomas que usan coma decimal: Excel espera ";" como separador de columnas.
const COMMA_DECIMAL = new Set(['es', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr']);
const pad = (n) => String(n).padStart(2, '0');

function localStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fileDate(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Los textos que empiezan con = + - @ llevan un apostrofo adelante para que Excel no los tome como formulas.
function csvCell(value, sep) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return s.includes(sep) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sessionsCsv(sessions, lang = getLanguage()) {
  const comma = COMMA_DECIMAL.has(lang);
  const sep = comma ? ';' : ',';
  const num = (n) => {
    const s = (Math.round(n * 10) / 10).toFixed(1);
    return comma ? s.replace('.', ',') : s;
  };
  const header = [
    t('stats.csvStart'),
    t('stats.csvEnd'),
    t('stats.csvMinutes'),
    t('stats.csvInstance'),
    t('stats.csvVersion'),
    t('stats.csvLoader'),
    t('stats.csvCrashed'),
    t('stats.csvExitCode'),
    t('stats.csvReason'),
  ];
  const rows = [...sessions]
    .sort((a, b) => a.start - b.start)
    .map((s) => [
      localStamp(s.start),
      localStamp(s.end),
      num((s.end - s.start) / 60000),
      s.name || s.instanceId,
      s.mcVersion || '',
      s.loader || '',
      s.crashed ? t('stats.csvYes') : t('stats.csvNo'),
      s.code ?? '',
      s.reason || '',
    ]);
  // BOM para que Excel detecte UTF-8 (tildes y eñes)
  return `﻿${[header, ...rows].map((r) => r.map((c) => csvCell(c, sep)).join(sep)).join('\r\n')}\r\n`;
}

function statsJson({ data, report, places, ingame, appVersion }) {
  const strip = (r) => {
    if (!r) return null;
    const { milestones, ...rest } = r;
    return { ...rest, milestones: (milestones || []).map((m) => ({ id: m.id, group: m.group, target: m.target, value: m.value, achievedAt: m.achievedAt ? new Date(m.achievedAt).toISOString() : null })) };
  };
  return JSON.stringify(
    {
      format: 'venus-launcher-stats',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      app: { name: 'Venus Launcher', version: appVersion || null },
      firstUse: data?.firstUse ? new Date(data.firstUse).toISOString() : null,
      report: strip(report),
      sessions: (data?.sessions || []).map((s) => ({ ...s, startIso: new Date(s.start).toISOString(), endIso: new Date(s.end).toISOString() })),
      archived: data?.archived || null,
      places: places || null,
      ingame: ingame || null,
    },
    null,
    2,
  );
}

module.exports = { sessionsCsv, statsJson, fileDate, csvCell };
