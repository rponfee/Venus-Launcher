'use strict';
// Estado de los servicios: el veredicto para el jugador ("es tu conexión" o "es un servicio"). Sin Electron.
//  offline       el modo sin conexión del launcher está activado (no se consultó nada)
//  internet      tu conexión no responde
//  tls           algo en la PC (antivirus, proxy o la fecha y hora) rompe las conexiones seguras
//  dns           internet anda, pero no se encuentran los servidores por nombre
//  internetSlow  tu conexión anda muy lenta
//  blocked       internet anda, pero no responde ningún servicio de varias empresas (firewall, antivirus, red)
//  down          esos servicios no responden (ids)
//  slow          esos servicios andan lentos (ids)
//  ok            todo responde: el problema es otro
const { companyOf } = require('./services');

function idsOf(list) {
  return list.map((r) => r.id);
}

// summary: { offlineMode, internet ('ok', 'down' o 'unknown'), internetReason, internetSlow, dns, results }
// scope: ids que importan para este veredicto (sin lista = todos los resultados).
function computeVerdict(summary, scope) {
  if (!summary || summary.offlineMode) return { kind: 'offline', ids: [] };
  const inScope = Array.isArray(scope) && scope.length ? new Set(scope) : null;
  const rel = (summary.results || []).filter((r) => r && r.id !== 'internet' && r.state !== 'skipped' && (!inScope || inScope.has(r.id)));
  const down = rel.filter((r) => r.state === 'down');
  const slow = rel.filter((r) => r.state === 'slow');
  // Un 5xx es el servicio contestando con un error: seguro que es de ellos, no de tu conexión. Lo mismo un servicio
  // que el launcher acaba de ver fallar de su lado ('failed': un 5xx al iniciar sesión o en una descarga).
  const answered = down.filter((r) => r.reason === 'http' || r.reason === 'failed');

  if (summary.internet === 'down') return { kind: summary.internetReason === 'tls' ? 'tls' : 'internet', ids: idsOf(down) };
  if (down.length && !answered.length) {
    if (summary.dns === 'down' && down.every((r) => r.reason === 'dns')) return { kind: 'dns', ids: idsOf(down) };
    if (down.every((r) => r.reason === 'tls')) return { kind: 'tls', ids: idsOf(down) };
    // Nadie contestó y no hubo forma de probar la conexión: lo más probable es la conexión.
    if (summary.internet === 'unknown') return { kind: 'internet', ids: idsOf(down) };
    if (summary.internetSlow) return { kind: 'internetSlow', ids: idsOf(down) };
    const companies = new Set(down.map((r) => companyOf(r.id)));
    if (rel.length >= 3 && down.length === rel.length && companies.size >= 2) return { kind: 'blocked', ids: idsOf(down) };
  }
  if (down.length) return { kind: 'down', ids: idsOf(down) };
  if (summary.internetSlow) return { kind: 'internetSlow', ids: idsOf(slow) };
  if (slow.length) return { kind: 'slow', ids: idsOf(slow) };
  return { kind: 'ok', ids: [] };
}

module.exports = { computeVerdict };
