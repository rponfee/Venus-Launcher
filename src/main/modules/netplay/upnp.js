'use strict';
// Cliente UPnP IGD (Internet Gateway Device) en Node puro:
//   1) Descubrimiento SSDP (M-SEARCH por multicast 239.255.255.250:1900, por cada interfaz + unicast al router)
//   2) Descripcion del dispositivo (XML) -> servicio WANIPConnection / WANPPPConnection y su controlURL
//   3) Acciones SOAP: AddPortMapping, DeletePortMapping, GetExternalIPAddress, GetSpecificPortMappingEntry
const dgram = require('dgram');
const http = require('http');
const netinfo = require('./netinfo');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];
const SERVICE_RE = /^urn:schemas-upnp-org:service:(WANIPConnection|WANPPPConnection):(\d+)$/i;
const IGD_RE = /InternetGatewayDevice|WANIPConnection|WANPPPConnection|WANConnectionDevice/i;

// Codigos de error UPnP mas comunes (IGD v1/v2)
const ERRORS = {
  402: 'InvalidArgs',
  501: 'ActionFailed',
  606: 'ActionNotAuthorized',
  714: 'NoSuchEntryInArray',
  715: 'WildCardNotPermittedInSrcIP',
  716: 'WildCardNotPermittedInExtPort',
  718: 'ConflictInMappingEntry',
  724: 'SamePortValuesRequired',
  725: 'OnlyPermanentLeasesSupported',
  726: 'RemoteHostOnlySupportsWildcard',
  727: 'ExternalPortOnlySupportsWildcard',
  728: 'NoPortMapsAvailable',
  729: 'ConflictWithOtherMechanisms',
};

class UpnpError extends Error {
  constructor(code, description) {
    super(`UPnP ${code} ${description || ERRORS[code] || ''}`.trim());
    this.code = code;
    this.description = description || ERRORS[code] || '';
  }
}

function parseHeaders(text) {
  const out = {};
  const lines = String(text).split(/\r?\n/);
  out._status = lines[0] || '';
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function searchMessage(st) {
  return Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', `ST: ${st}`, '', ''].join('\r\n'));
}

// Busca routers con UPnP. Devuelve [{ location, st, server, from, localAddress }]
async function discover({ timeout = 2600, unicast = [] } = {}) {
  const ifaces = netinfo.localInterfaces().filter((i) => i.kind !== 'virtual');
  const bindAddrs = ifaces.length ? ifaces.map((i) => i.address) : [null];
  const found = new Map();
  const sockets = [];

  const onMessage = (localAddress) => (msg, rinfo) => {
    const headers = parseHeaders(msg.toString('utf8'));
    if (!/^HTTP\/1\.[01]\s+200/i.test(headers._status) && !/^NOTIFY/i.test(headers._status)) return;
    const location = headers.location;
    const st = headers.st || headers.nt || '';
    if (!location || !/^https?:\/\//i.test(location) || !IGD_RE.test(st)) return;
    if (!found.has(location)) found.set(location, { location, st, server: headers.server || '', from: rinfo.address, localAddress });
  };

  await Promise.all(
    bindAddrs.map(
      (addr) =>
        new Promise((resolve) => {
          let sock;
          try {
            sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          } catch {
            resolve();
            return;
          }
          sock.on('error', () => resolve());
          sock.on('message', onMessage(addr));
          sock.bind({ port: 0, address: addr || undefined }, () => {
            sockets.push(sock);
            try {
              if (addr) sock.setMulticastInterface(addr);
              sock.setMulticastTTL(4);
            } catch {
              /* sin multicast en esta interfaz */
            }
            const sendAll = () => {
              for (const st of SEARCH_TARGETS) {
                const msg = searchMessage(st);
                sock.send(msg, SSDP_PORT, SSDP_ADDR, () => {});
                for (const target of unicast) if (target) sock.send(msg, SSDP_PORT, target, () => {});
              }
            };
            sendAll();
            // UDP puede perder paquetes: segundo intento
            setTimeout(() => {
              try {
                sendAll();
              } catch {
                /* socket cerrado */
              }
            }, 450);
            resolve();
          });
        }),
    ),
  );

  await new Promise((r) => setTimeout(r, timeout));
  for (const s of sockets) {
    try {
      s.close();
    } catch {
      /* ya cerrado */
    }
  }
  return [...found.values()];
}

// GET http simple con limite de tamaño y tiempo
function httpGet(url, { timeout = 4000, maxBytes = 512 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout, headers: { Connection: 'close', 'User-Agent': 'VenusLauncher UPnP/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) req.destroy(new Error('Respuesta demasiado grande'));
        else chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tiempo de espera agotado')));
    req.on('error', reject);
  });
}

const decodeXml = (s) =>
  String(s || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

const escapeXml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);

function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i').exec(xml);
  return m ? decodeXml(m[1]) : '';
}

// Interpreta la descripcion del dispositivo y devuelve los servicios WAN con su URL de control absoluta.
function parseDescription(xml, location) {
  const urlBase = tag(xml, 'URLBase');
  const base = urlBase || location;
  const services = [];
  const re = /<(?:[\w.-]+:)?service\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?service>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const type = tag(block, 'serviceType');
    const sm = SERVICE_RE.exec(type);
    if (!sm) continue;
    const control = tag(block, 'controlURL');
    if (!control) continue;
    let controlUrl;
    try {
      controlUrl = new URL(control, base).href;
    } catch {
      continue;
    }
    services.push({ type, kind: sm[1], version: Number(sm[2]), controlUrl });
  }
  // Primero WANIPConnection:2, despues :1, despues PPP
  services.sort((a, b) => (a.kind === b.kind ? b.version - a.version : a.kind === 'WANIPConnection' ? -1 : 1));
  return {
    name: tag(xml, 'friendlyName'),
    manufacturer: tag(xml, 'manufacturer'),
    model: tag(xml, 'modelName'),
    services,
  };
}

// Llamada SOAP. args: [[nombre, valor], ...] en el orden de la especificacion (algunos routers lo exigen).
function soap(controlUrl, serviceType, action, args = [], { timeout = 5000 } = {}) {
  const body =
    '<?xml version="1.0"?>\r\n' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">` +
    args.map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('') +
    `</u:${action}></s:Body></s:Envelope>\r\n`;
  const u = new URL(controlUrl);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        timeout,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          'Content-Length': Buffer.byteLength(body),
          SOAPAction: `"${serviceType}#${action}"`,
          Connection: 'close',
          'User-Agent': 'VenusLauncher UPnP/1.0',
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size <= 256 * 1024) chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode === 200) {
            const out = {};
            const re = /<(?:[\w.-]+:)?(New\w+)\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:[\w.-]+:)?\1>)/g;
            let m;
            while ((m = re.exec(text))) out[m[1]] = decodeXml(m[2] || '');
            resolve(out);
            return;
          }
          const code = Number(tag(text, 'errorCode'));
          if (code) reject(new UpnpError(code, tag(text, 'errorDescription')));
          else reject(new Error(`HTTP ${res.statusCode} (${action})`));
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Tiempo de espera agotado (${action})`)));
    req.on('error', reject);
    req.end(body);
  });
}

class Gateway {
  constructor({ location, controlUrl, serviceType, name, manufacturer, model, localAddress }) {
    this.location = location;
    this.controlUrl = controlUrl;
    this.serviceType = serviceType;
    this.name = name || model || 'Router';
    this.manufacturer = manufacturer || '';
    this.model = model || '';
    this.localAddress = localAddress || null;
  }

  get host() {
    return new URL(this.controlUrl).hostname;
  }

  call(action, args, opts) {
    return soap(this.controlUrl, this.serviceType, action, args, opts);
  }

  async externalIp() {
    const r = await this.call('GetExternalIPAddress', [], { timeout: 3500 });
    return netinfo.isIPv4(r.NewExternalIPAddress) ? r.NewExternalIPAddress : null;
  }

  async addMapping({ externalPort, internalPort, protocol, internalClient, description, lease }) {
    await this.call('AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
      ['NewInternalPort', internalPort],
      ['NewInternalClient', internalClient],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', description],
      ['NewLeaseDuration', lease],
    ]);
  }

  async deleteMapping({ externalPort, protocol }) {
    await this.call('DeletePortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
    ], { timeout: 3000 });
  }

  // null si no existe el mapeo
  async getMapping({ externalPort, protocol }) {
    try {
      const r = await this.call('GetSpecificPortMappingEntry', [
        ['NewRemoteHost', ''],
        ['NewExternalPort', externalPort],
        ['NewProtocol', protocol],
      ], { timeout: 3500 });
      return {
        internalPort: Number(r.NewInternalPort) || null,
        internalClient: r.NewInternalClient || null,
        enabled: r.NewEnabled === '1' || r.NewEnabled === 'true',
        description: r.NewPortMappingDescription || '',
        lease: Number(r.NewLeaseDuration) || 0,
      };
    } catch (err) {
      if (err instanceof UpnpError && (err.code === 714 || err.code === 402)) return null;
      throw err;
    }
  }

  snapshot() {
    return { name: this.name, manufacturer: this.manufacturer, model: this.model, host: this.host, service: this.serviceType };
  }
}

// Busca el router y devuelve un Gateway listo para usar (o null si no hay UPnP).
async function findGateway({ timeout = 2600, gatewayIp = null } = {}) {
  const devices = await discover({ timeout, unicast: gatewayIp ? [gatewayIp] : [] });
  // Preferir el dispositivo que responde desde la puerta de enlace
  devices.sort((a, b) => (b.from === gatewayIp) - (a.from === gatewayIp));
  const seen = new Set();
  let fallback = null;
  for (const dev of devices) {
    if (seen.has(dev.location)) continue;
    seen.add(dev.location);
    let desc;
    try {
      desc = parseDescription(await httpGet(dev.location), dev.location);
    } catch {
      continue;
    }
    for (const svc of desc.services) {
      const host = new URL(svc.controlUrl).hostname;
      const localAddress = (await netinfo.localAddressFor(host)) || dev.localAddress;
      const gw = new Gateway({ location: dev.location, controlUrl: svc.controlUrl, serviceType: svc.type, name: desc.name, manufacturer: desc.manufacturer, model: desc.model, localAddress });
      try {
        const ip = await gw.externalIp();
        gw.lastExternalIp = ip;
        // Un servicio PPP sin conexion devuelve 0.0.0.0 o vacio: seguir buscando uno conectado
        if (ip && ip !== '0.0.0.0') return gw;
        if (!fallback) fallback = gw;
      } catch {
        if (!fallback) fallback = gw;
      }
    }
  }
  return fallback;
}

module.exports = { discover, findGateway, parseDescription, parseHeaders, soap, Gateway, UpnpError, SEARCH_TARGETS };
