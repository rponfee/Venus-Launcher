'use strict';
// playit.gg como segundo proveedor de túneles (modo guiado).
//
// Por qué no se automatiza: el agente oficial actual (playit-cloud/playit-agent 1.x) dejó de ser un programa
// suelto. En Windows se instala con un .msi como servicio del sistema ("playitd", pide permisos de administrador),
// el CLI solo se conecta a ese servicio, y los túneles se crean desde la web de playit.gg con la cuenta del
// usuario. Descargarlo y manejarlo desde el launcher no sería confiable (servicio, UAC, cuenta, versiones).
// Entonces Venus guía al usuario (descarga oficial en el navegador + túnel "Minecraft Java" hacia 127.0.0.1:<puerto>)
// y guarda la dirección que le da playit.gg para mostrarla, copiarla, probarla y mandarla a amigos.
const DOWNLOAD_URL = 'https://playit.gg/download';
const DASHBOARD_URL = 'https://playit.gg/account/tunnels';

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// Acepta "algo.joinmc.link", "147.185.221.20:12345", "tcp://host:puerto". Devuelve { host, port, address } o null.
function normalizeAddress(input) {
  const s = String(input || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  if (!s || s.length > 260) return null;
  const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const host = m[1];
  const port = m[2] ? Number(m[2]) : null;
  if (!HOST_RE.test(host) && !IPV4_RE.test(host)) return null;
  if (port !== null && !(port > 0 && port < 65536)) return null;
  return { host, port, address: port && port !== 25565 ? `${host}:${port}` : host };
}

module.exports = { DOWNLOAD_URL, DASHBOARD_URL, normalizeAddress };
