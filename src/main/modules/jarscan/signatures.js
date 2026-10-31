'use strict';
// Firmas y listas para el análisis de seguridad de mods.
// Fuentes de Fractureiser: investigación pública https://github.com/fractureiser-investigation/fractureiser
// (docs/tech.md y docs/users.md) y las firmas de bytecode de nekodetector / jar-infection-scanner.

// ---------- Fractureiser ----------

// SHA-1 (y un SHA-256) de jars infectados conocidos (docs/tech.md, "Infected Mods and Plugins").
const KNOWN_SHA1 = new Map([
  ['33677ca0e4c565b1f34baa74a79c09a3b690bf41', 'Skyblock Core (Fractureiser)'],
  ['2db855a7f40c015f8c9ca7cbab69e1f1aafa210b', 'Dungeonz (Fractureiser)'],
  ['284a4449e58868036b2bafdfb5a210fd0480ef4a', 'Haven Elytra (Fractureiser)'],
  ['0c6576bdc6d1b92d581c18f3a150905ad97fa080', 'Vault Integrations (Fractureiser)'],
  ['c55c3e9d6a4355f36b0710ab189d5131a290df26', 'AutoBroadcast (Fractureiser)'],
  ['32536577d5bb074abd493ad98dc12ccc86f30172', 'Museum Curator Advanced (Fractureiser)'],
  ['a4b6385d1140c111549d95eab25cb51922eefba2', 'Display Entity Editor (Fractureiser)'],
  // Etapas 1, 2 y 3 (por si alguien las mete en la carpeta mods)
  ['dc43c4685c3f47808ac207d1667cc1eb915b2d82', 'Fractureiser stage 1 (dl.jar)'],
  ['52d08736543a240b0cbbbf2da03691ae525bb119', 'Fractureiser stage 2 (lib.jar)'],
  ['6ec85c8112c25abe4a71998eb32480d266408863', 'Fractureiser stage 2 (lib.jar)'],
  ['c2d0c87a1fe99e3c44a52c48d8bcf65a67b3e9a5', 'Fractureiser stage 3 (client.jar)'],
  ['e299bf5a025f5c3fff45d017c3c2f467fa599915', 'Fractureiser stage 3 (client.jar)'],
]);
const KNOWN_SHA256 = new Map([['1d1aaccdc13244e980c0c024610ecc77ea2674a33a52129edf1bb4ce3b2cc2fc', 'Floating Damage (Fractureiser)']]);

// Indicadores de red y de persistencia. confirmed: si aparecen ocultos o junto a código de red, es malware seguro.
const IOC_STRINGS = [
  { s: '85.217.144.130', family: 'fractureiser' },
  { s: '107.189.3.101', family: 'fractureiser' },
  { s: 'files-8ie.pages.dev', family: 'fractureiser' },
  { s: 'libwebgl64.jar', family: 'fractureiser' },
  { s: 'systemd-utility.service', family: 'fractureiser' },
  { s: '.config/.data/lib.jar', family: 'fractureiser' },
  { s: 'neko.run', family: 'fractureiser', exact: true },
  { s: 'java_dev_neko_nekoclient', family: 'fractureiser' },
  { s: 'dev.neko.nekoclient', family: 'fractureiser' },
  { s: 'dev/neko/nekoclient', family: 'fractureiser' },
  { s: 'dev.neko.nekoinjector', family: 'fractureiser' },
  { s: 'dev/neko/nekoinjector', family: 'fractureiser' },
  { s: 'skyrage.de', family: 'skyrage' },
  { s: '95.214.27.172', family: 'skyrage' },
  { s: 'microsoftedgeupdatetaskmachinevm', family: 'skyrage' },
  { s: 'microsoft-vm-core', family: 'skyrage' },
  { s: '/bin/vmd-gnu', family: 'skyrage' },
  { s: 'vmd-gnu.service', family: 'skyrage' },
];

// Paquetes del malware (cliente y plantilla de inyección de NekoClient).
const IOC_PACKAGES = ['dev/neko/nekoclient/', 'dev/neko/nekoinjector/'];

// Metodo inyectado por la etapa 0: estatico, nombre "_" + 32 hex, llamado desde <clinit>.
const INJECTED_METHOD = /^_[0-9a-f]{32}$/;

// Firmas de bytecode (secuencias de llamadas en un mismo método, en orden y con huecos permitidos).
// SIG1: cargador reflexivo de la etapa 0 (URLClassLoader -> Utility.run).
const SIG_STAGE0 = [
  'java/lang/Class.forName(Ljava/lang/String;)Ljava/lang/Class;',
  'java/lang/Class.getConstructor',
  'java/net/URL.<init>',
  'java/lang/reflect/Constructor.newInstance',
  'java/lang/Class.forName(Ljava/lang/String;ZLjava/lang/ClassLoader;)Ljava/lang/Class;',
  'java/lang/Class.getMethod',
  'java/lang/reflect/Method.invoke',
];
// SIG2: variante que ejecuta un comando en base64 con Runtime.exec.
const SIG_STAGE0B = [
  'java/lang/Runtime.getRuntime',
  'java/util/Base64.getDecoder',
  'java/util/Base64$Decoder.decode(Ljava/lang/String;)[B',
  'java/lang/String.<init>([B)V',
  'java/io/File.getPath',
  'java/lang/Runtime.exec([Ljava/lang/String;)Ljava/lang/Process;',
];

// ---------- APIs (banderas por referencia del constant pool) ----------

const F = {
  NET: 1 << 0,
  EXEC: 1 << 1,
  CLASSLOAD: 1 << 2,
  REFLECT: 1 << 3,
  B64: 1 << 4,
  FILEW: 1 << 5,
  STRBYTES: 1 << 6, // new String(byte[] / char[]) -> posibles textos ocultos
  SESSION: 1 << 7,
  ENV: 1 << 8,
  URLCL: 1 << 9, // URLClassLoader puntual
  NATIVE: 1 << 10, // System.load / loadLibrary
};

// owner -> { '*': flag } o { nombre: flag }
const API = {
  'java/net/URL': { openConnection: F.NET, openStream: F.NET },
  'java/net/URLConnection': { connect: F.NET, getInputStream: F.NET, getOutputStream: F.NET },
  'java/net/HttpURLConnection': { '*': F.NET },
  'javax/net/ssl/HttpsURLConnection': { '*': F.NET },
  'java/net/http/HttpClient': { '*': F.NET },
  'java/net/http/HttpClient$Builder': { '*': F.NET },
  'java/net/http/HttpRequest': { '*': F.NET },
  'java/net/http/HttpRequest$Builder': { '*': F.NET },
  'java/net/Socket': { '<init>': F.NET, connect: F.NET, getOutputStream: F.NET },
  'java/nio/channels/SocketChannel': { open: F.NET, connect: F.NET },
  'okhttp3/OkHttpClient': { '*': F.NET },
  'okhttp3/Request$Builder': { '*': F.NET },
  'java/lang/Runtime': { exec: F.EXEC },
  'java/lang/ProcessBuilder': { '<init>': F.EXEC, start: F.EXEC, command: F.EXEC },
  'java/net/URLClassLoader': { '<init>': F.CLASSLOAD | F.URLCL, newInstance: F.CLASSLOAD | F.URLCL },
  'java/lang/ClassLoader': { defineClass: F.CLASSLOAD },
  'java/security/SecureClassLoader': { defineClass: F.CLASSLOAD },
  'java/lang/invoke/MethodHandles$Lookup': { defineClass: F.CLASSLOAD, defineHiddenClass: F.CLASSLOAD },
  'sun/misc/Unsafe': { defineClass: F.CLASSLOAD, defineAnonymousClass: F.CLASSLOAD },
  'jdk/internal/misc/Unsafe': { defineClass: F.CLASSLOAD },
  'java/lang/Class': { forName: F.REFLECT, getMethod: F.REFLECT, getDeclaredMethod: F.REFLECT, getConstructor: F.REFLECT },
  'java/lang/reflect/Method': { invoke: F.REFLECT },
  'java/lang/reflect/Constructor': { newInstance: F.REFLECT },
  'java/util/Base64': { getDecoder: F.B64, getMimeDecoder: F.B64, getUrlDecoder: F.B64 },
  'java/util/Base64$Decoder': { decode: F.B64 },
  'javax/xml/bind/DatatypeConverter': { parseBase64Binary: F.B64 },
  'org/apache/commons/codec/binary/Base64': { decodeBase64: F.B64, decode: F.B64 },
  'java/io/FileOutputStream': { '<init>': F.FILEW },
  'java/io/FileWriter': { '<init>': F.FILEW },
  'java/nio/file/Files': { write: F.FILEW, writeString: F.FILEW, copy: F.FILEW, newOutputStream: F.FILEW },
  'java/lang/System': { getenv: F.ENV, load: F.NATIVE, loadLibrary: F.NATIVE },
  // token de sesión de Minecraft: 1.8-1.12 (MCP/SRG), Fabric (intermediary), mojmap (NeoForge) y nombres de desarrollo
  'net/minecraft/util/Session': { func_148254_d: F.SESSION, func_111286_b: F.SESSION, getToken: F.SESSION, getSessionID: F.SESSION },
  'net/minecraft/class_320': { method_1674: F.SESSION, method_1675: F.SESSION },
  'net/minecraft/client/User': { getAccessToken: F.SESSION, getSessionId: F.SESSION },
  'net/minecraft/client/util/Session': { getAccessToken: F.SESSION, getSessionId: F.SESSION },
  'net/minecraft/client/session/Session': { getAccessToken: F.SESSION, getSessionId: F.SESSION },
};
const API_PREFIX = [
  ['org/apache/http/client/', F.NET],
  ['org/apache/http/impl/client/', F.NET],
  ['org/apache/hc/client5/', F.NET],
  ['kong/unirest/', F.NET],
  ['com/mashape/unirest/', F.NET],
];

function refFlags(ref) {
  const byOwner = API[ref.owner];
  let flags = 0;
  if (byOwner) flags |= (byOwner[ref.name] || 0) | (byOwner['*'] || 0);
  else {
    for (const [prefix, f] of API_PREFIX) if (ref.owner.startsWith(prefix)) flags |= f;
  }
  if (ref.owner === 'java/lang/String' && ref.name === '<init>' && /^\(\[[BC]/.test(ref.desc)) flags |= F.STRBYTES;
  return flags;
}

// ---------- Textos sospechosos ----------

// Filtro rápido: solo los textos que pasan esto se revisan en detalle.
const QUICK = /https?:|discord|webhook|telegram|leveldb|local storage|login data|local state|user data|encrypted_key|os_crypt|key4\.db|logins\.json|cookies\.sqlite|bravesoftware|opera software|yandexbrowser|firefox|launcher_|tlauncher|accounts\.json|accounts\.dat|tdata|loginusers|filezilla|wallet|exodus|electrum|metamask|nkbihfbeog|pastebin|paste\.ee|paste\.gg|rentry|hastebin|controlc|ghostbin|transfer\.sh|file\.io|gofile|anonfiles|filebin|0x0\.st|ipify|ip-api|icanhazip|checkip|ipinfo|\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|pages\.dev|skyrage|neko|vmd-gnu|microsoft-vm|edgeupdatetask|libwebgl|systemd-utility|\.data\/lib\.jar|allatori|obfuscated|zelix|skidfuscator|branchlock|superblaubeere|[a-z0-9+/]{120}|dqw4w9wgxcq|\\w-\]\{2[46]\}|mfa\\\./i;

const WEBHOOK_FULL = /https?:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d{15,22}\/[\w-]{40,100}/i;
const WEBHOOK_ANY = /discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks/i;
const TELEGRAM_FULL = /api\.telegram\.org\/bot\d{6,12}:[\w-]{30,}/i;
const TELEGRAM_ANY = /api\.telegram\.org\/bot/i;
const DISCORD_TOKEN_REGEX = /\[\\w-\]\{24\}|\[\\w-\]\{26\}|mfa\\\.\[\\w-\]\{84\}|dqw4w9wgxcq:/i;
const PASTE_SITES = /(?:pastebin\.com\/raw|paste\.ee\/r\/|rentry\.(?:co|org)\/[\w-]+\/raw|hastebin\.com\/raw|controlc\.com|ghostbin\.|paste\.gg\/p\/)/i;
const FILE_DROPS = /(?:transfer\.sh|file\.io|gofile\.io|anonfiles\.com|filebin\.net|0x0\.st)\b/i;
const IP_LOOKUP = /(?:api\.ipify\.org|ip-api\.com|icanhazip\.com|checkip\.amazonaws\.com|ipinfo\.io)/i;
const IP_URL = /https?:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::\d+)?/i;
const URL_ANY = /https?:\/\/[^\s"'<>]{4,}/i;
const OBF_MARKS = /ALLATORIxDEMO|Obfuscated (?:by|with) (?:Allatori|Zelix|ZKM|Stringer|Skidfuscator|Branchlock|Radon|Caesium|Bozar|Paramorphism|qProtect|Binscure)|superblaubeere27|skidfuscator|branchlock/i;

// Rutas de credenciales (normalizadas: minúsculas y con "/").
const CREDENTIAL_PATHS = [
  { re: /discord(?:canary|ptb)?\/local storage\/leveldb|local storage\/leveldb/, kind: 'discord' },
  { re: /\blightcord\b|discordcanary|discordptb/, kind: 'discord' },
  { re: /user data\/(?:default|profile)|login data|\blocal state\b|encrypted_key|os_crypt|key4\.db|logins\.json|cookies\.sqlite|google\/chrome\/user data|bravesoftware|opera software|yandexbrowser|mozilla\/firefox\/profiles/, kind: 'browser' },
  { re: /launcher_accounts(?:_microsoft_store)?\.json|launcher_msa_credentials|tlauncherprofiles|labymod\/accounts\.json|\.lunarclient\/settings\/game\/accounts\.json|feather\/accounts\.json|polymc\/accounts\.json|prismlauncher\/accounts\.json|multimc\/accounts\.json|badlion client\/accounts|essential\/microsoft_accounts\.json/, kind: 'minecraft' },
  { re: /wallet\.dat|exodus\/exodus\.wallet|electrum\/wallets|atomic\/local storage|nkbihfbeogaeaoehlefnkodbefgpgknn|metamask/, kind: 'wallet' },
  { re: /telegram desktop\/tdata|loginusers\.vdf|filezilla\/recentservers\.xml/, kind: 'other' },
];

// Base64 largo: se decodifica para ver qué esconde.
const BASE64_BLOB = /^[A-Za-z0-9+/]{120,}={0,2}$/;

function decodeBase64Blob(s) {
  const clean = s.replace(/\s+/g, '');
  if (!BASE64_BLOB.test(clean) || clean.length % 4 === 1) return null;
  let buf;
  try {
    buf = Buffer.from(clean, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 64) return null;
  const head = buf.subarray(0, 4);
  if (head.readUInt32BE(0) === 0xcafebabe) return { kind: 'class', buf };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return { kind: 'zip', buf };
  if (head[0] === 0x4d && head[1] === 0x5a) return { kind: 'exe', buf };
  if (head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return { kind: 'elf', buf };
  // texto legible
  let printable = 0;
  const sample = buf.subarray(0, 2048);
  for (const b of sample) if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) printable++;
  if (printable / sample.length > 0.92) {
    const text = buf.toString('utf8');
    if (/^#!|powershell|cmd(?:\.exe)? \/c|bash -c|curl |wget |invoke-webrequest|frombase64string/i.test(text)) return { kind: 'script', buf, text };
    if (URL_ANY.test(text)) return { kind: 'url', buf, text };
    return { kind: 'text', buf, text };
  }
  return { kind: 'binary', buf };
}

// IP pública (no privada ni local) en una URL.
function publicIpUrl(s) {
  const m = IP_URL.exec(s);
  if (!m) return null;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || a >= 224) return null;
  return m[0];
}

// Strings imprimibles de un binario (para clases que no se pueden leer o nativos).
function rawStrings(buf, min = 6, max = 4000) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const b = i < buf.length ? buf[i] : 0;
    const ok = b >= 32 && b < 127;
    if (ok && start < 0) start = i;
    else if (!ok && start >= 0) {
      if (i - start >= min) {
        out.push(buf.toString('latin1', start, Math.min(i, start + 2000)));
        if (out.length >= max) break;
      }
      start = -1;
    }
  }
  return out;
}

module.exports = {
  KNOWN_SHA1,
  KNOWN_SHA256,
  IOC_STRINGS,
  IOC_PACKAGES,
  INJECTED_METHOD,
  SIG_STAGE0,
  SIG_STAGE0B,
  F,
  refFlags,
  QUICK,
  WEBHOOK_FULL,
  WEBHOOK_ANY,
  TELEGRAM_FULL,
  TELEGRAM_ANY,
  DISCORD_TOKEN_REGEX,
  PASTE_SITES,
  FILE_DROPS,
  IP_LOOKUP,
  URL_ANY,
  OBF_MARKS,
  CREDENTIAL_PATHS,
  decodeBase64Blob,
  publicIpUrl,
  rawStrings,
};
