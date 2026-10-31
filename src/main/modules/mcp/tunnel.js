'use strict';
// Tunel publico opcional para ChatGPT y claude.ai (necesitan una URL https publica): un "quick tunnel" de
// Cloudflare (https://<algo>.trycloudflare.com) hacia el servidor MCP local. Solo arranca cuando el usuario
// lo confirma en el panel, se corta al cerrar el launcher y no queda nada abierto.
//   - cloudflared se baja SOLO de los releases oficiales de GitHub (github.com/cloudflare/cloudflared): la URL
//     tiene que ser exactamente la del asset del release y el archivo se verifica con su tamaño y su SHA-256
//     (el "digest" que publica GitHub para el asset o, si falta, la lista "SHA256 Checksums" del release).
//     Sin un hash para comparar no se usa.
//   - Se guarda en <datos>/mcp/bin/ con un cloudflared.json { tag, asset, sha256, size } y se vuelve a
//     verificar antes de cada uso.
//   - Corre como proceso hijo: `cloudflared tunnel --no-autoupdate --config <vacio> --url http://127.0.0.1:<puerto>`
//     y se lee la URL https://*.trycloudflare.com de su salida.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn: nodeSpawn } = require('child_process');

const REPO = 'cloudflare/cloudflared';
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_URL = (tag, asset) => `https://github.com/${REPO}/releases/download/${tag}/${asset}`;
const URL_RE = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com\b/i;
const START_TIMEOUT_MS = 45000;
const MIN_SIZE = 5 * 1024 * 1024;
const MAX_SIZE = 250 * 1024 * 1024;

// Asset del release para esta plataforma (null si no hay).
function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'ia32' ? 'cloudflared-windows-386.exe' : 'cloudflared-windows-amd64.exe'; // arm64 usa la de x64 (emulada)
  if (platform === 'darwin') return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
  if (platform === 'linux') return { x64: 'cloudflared-linux-amd64', arm64: 'cloudflared-linux-arm64', arm: 'cloudflared-linux-arm', ia32: 'cloudflared-linux-386' }[arch] || null;
  return null;
}

// SHA-256 del asset en las notas del release ("cloudflared-windows-amd64.exe: <hash>").
function checksumFromBody(body, asset) {
  const esc = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)\\s*${esc}\\s*:\\s*([0-9a-f]{64})\\b`, 'i').exec(String(body || ''));
  return m ? m[1].toLowerCase() : null;
}

/** Valida el release de GitHub y devuelve { tag, asset, url, size, sha256 } (lanza con code si no sirve). */
function pickAsset(release, asset) {
  const fail = (code) => Object.assign(new Error(code), { code });
  if (!release || typeof release !== 'object') throw fail('release');
  const tag = String(release.tag_name || '');
  if (!/^[\w.-]{1,40}$/.test(tag)) throw fail('release');
  const a = (Array.isArray(release.assets) ? release.assets : []).find((x) => x && x.name === asset);
  if (!a) throw fail('asset');
  const url = String(a.browser_download_url || '');
  if (url !== ASSET_URL(tag, asset)) throw fail('url');
  const size = Number(a.size);
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) throw fail('size');
  const digest = typeof a.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null;
  const sha256 = digest || (asset.endsWith('.tgz') ? null : checksumFromBody(release.body, asset));
  if (!sha256) throw fail('checksum');
  return { tag, asset, url, size, sha256 };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * deps:
 *   dir            carpeta de binarios (<datos>/mcp/bin)
 *   getJson(url, { headers, signal })                        (core/http.getJson)
 *   download({ url, path, sha256, size }, { verify, signal, onBytes })   (core/http.download)
 *   spawn          child_process.spawn (inyectable)
 *   onChange(state)
 */
function createTunnel({ dir, getJson, download, spawn = nodeSpawn, platform = process.platform, arch = process.arch, releaseApi = RELEASE_API, assetUrl = ASSET_URL, onChange = () => {}, log = () => {}, startTimeoutMs = START_TIMEOUT_MS, extract = null } = {}) {
  let state = { state: 'stopped', url: null, host: null, error: null, progress: null, version: null, startedAt: null };
  let child = null;
  let starting = null;
  let stopping = false;
  let abortCtl = null;
  let verifiedThisRun = false;
  const tail = [];

  const exe = () => path.join(dir, platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const metaFile = () => path.join(dir, 'cloudflared.json');

  function set(patch) {
    state = { ...state, ...patch };
    try {
      onChange({ ...state });
    } catch {
      /* interfaz cerrada */
    }
  }

  async function installed() {
    try {
      const meta = JSON.parse(await fsp.readFile(metaFile(), 'utf8'));
      const st = await fsp.stat(exe());
      if (!meta || !/^[0-9a-f]{64}$/.test(meta.sha256 || '') || st.size !== meta.binSize) return null;
      if (!verifiedThisRun) {
        if ((await sha256File(exe())) !== meta.binSha256) return null;
        verifiedThisRun = true;
      }
      return meta;
    } catch {
      return null;
    }
  }

  // Baja (si hace falta) y verifica cloudflared. Devuelve la ruta del ejecutable.
  async function ensureBinary(signal) {
    const asset = assetFor(platform, arch);
    if (!asset) throw Object.assign(new Error('platform'), { code: 'platform' });
    const have = await installed();
    if (have && have.asset === asset) return exe();
    set({ state: 'downloading', progress: 0, error: null });
    const release = await getJson(releaseApi, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal });
    const pick = pickAsset(release, asset);
    if (pick.url !== assetUrl(pick.tag, asset)) throw Object.assign(new Error('url'), { code: 'url' });
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${asset}.download`);
    let done = 0;
    let lastPct = -1;
    await download({ url: pick.url, path: tmp, sha256: pick.sha256, size: pick.size, force: true }, {
      verify: 'hash',
      signal,
      onBytes: (n) => {
        done += n;
        const pct = Math.max(0, Math.min(100, Math.floor((done / pick.size) * 100)));
        if (pct !== lastPct) {
          lastPct = pct;
          set({ progress: pct / 100 });
        }
      },
    });
    // Verificacion propia (ademas de la de la descarga)
    const st = await fsp.stat(tmp);
    if (st.size !== pick.size || (await sha256File(tmp)) !== pick.sha256) {
      await fsp.rm(tmp, { force: true });
      throw Object.assign(new Error('checksum'), { code: 'checksum' });
    }
    if (asset.endsWith('.tgz')) {
      const out = path.join(dir, 'extract');
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.mkdir(out, { recursive: true });
      if (extract) await extract(tmp, out);
      else await require('tar').x({ file: tmp, cwd: out, filter: (p) => path.basename(p) === 'cloudflared' });
      await fsp.rm(exe(), { force: true });
      await fsp.rename(path.join(out, 'cloudflared'), exe());
      await fsp.rm(out, { recursive: true, force: true });
      await fsp.rm(tmp, { force: true });
    } else {
      await fsp.rm(exe(), { force: true });
      await fsp.rename(tmp, exe());
    }
    if (platform !== 'win32') await fsp.chmod(exe(), 0o755);
    const bin = await fsp.stat(exe());
    const meta = { tag: pick.tag, asset, sha256: pick.sha256, size: pick.size, binSha256: await sha256File(exe()), binSize: bin.size, at: Date.now() };
    await fsp.writeFile(metaFile(), JSON.stringify(meta, null, 2));
    verifiedThisRun = true;
    return exe();
  }

  /** Arranca el tunel hacia el puerto local. Devuelve { url, host }. */
  function start({ port, signal: outer } = {}) {
    if (state.state === 'running' && child) return Promise.resolve({ url: state.url, host: state.host });
    if (starting) return starting;
    stopping = false;
    abortCtl = new AbortController();
    const signal = abortCtl.signal;
    if (outer) {
      if (outer.aborted) abortCtl.abort();
      else outer.addEventListener('abort', () => abortCtl?.abort(), { once: true });
    }
    starting = (async () => {
      tail.length = 0;
      try {
        const bin = await ensureBinary(signal);
        const meta = await installed();
        set({ state: 'starting', progress: null, error: null, version: meta?.tag || null });
        const emptyConfig = path.join(dir, 'cloudflared-empty.yml');
        await fsp.writeFile(emptyConfig, '# Venus Launcher: tunel rapido sin configuracion propia\n{}\n');
        const result = await new Promise((resolve, reject) => {
          let settled = false;
          const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--config', emptyConfig, '--url', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
          child = proc;
          const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { code: 'timeout' })), startTimeoutMs);
          const onAbort = () => finish(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
          signal?.addEventListener('abort', onAbort, { once: true });
          function finish(err, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (err) {
              try {
                proc.kill();
              } catch {
                /* ya termino */
              }
              reject(err);
            } else resolve(value);
          }
          const onData = (buf) => {
            for (const line of String(buf).split(/\r?\n/)) {
              if (!line.trim()) continue;
              tail.push(line.slice(0, 300));
              if (tail.length > 40) tail.shift();
              const m = URL_RE.exec(line);
              if (m && !settled) finish(null, { url: `https://${m[1].toLowerCase()}.trycloudflare.com`, host: `${m[1].toLowerCase()}.trycloudflare.com` });
            }
          };
          proc.stdout.on('data', onData);
          proc.stderr.on('data', onData);
          proc.on('error', (err) => finish(Object.assign(new Error(err.message), { code: 'spawn' })));
          proc.on('exit', (code) => {
            if (child === proc) child = null;
            if (!settled) finish(Object.assign(new Error(`exit ${code}`), { code: /429|too many/i.test(tail.join('\n')) ? 'ratelimit' : 'exit', detail: tail.slice(-6).join('\n') }));
            else if (!stopping) {
              log('warn', `cloudflared termino (codigo ${code})`);
              set({ state: 'error', url: null, host: null, error: 'exited', detail: tail.slice(-6).join('\n') });
            }
          });
        });
        set({ state: 'running', url: result.url, host: result.host, error: null, startedAt: Date.now() });
        return result;
      } catch (err) {
        if (child) {
          try {
            child.kill();
          } catch {
            /* ya termino */
          }
          child = null;
        }
        const cancelled = stopping || err.code === 'cancelled' || signal.aborted;
        set(cancelled ? { state: 'stopped', url: null, host: null, progress: null, error: null } : { state: 'error', url: null, host: null, progress: null, error: err.code || 'error', detail: err.detail || err.message });
        if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
        throw err;
      } finally {
        starting = null;
      }
    })();
    return starting;
  }

  function stop() {
    stopping = true;
    abortCtl?.abort();
    const proc = child;
    child = null;
    if (proc) {
      try {
        proc.kill();
      } catch {
        /* ya termino */
      }
    }
    set({ state: 'stopped', url: null, host: null, error: null, progress: null, startedAt: null });
    return true;
  }

  return {
    start,
    stop,
    ensureBinary,
    get state() {
      return { ...state };
    },
    get host() {
      return state.state === 'running' ? state.host : null;
    },
    get running() {
      return state.state === 'running';
    },
  };
}

module.exports = { createTunnel, assetFor, pickAsset, checksumFromBody, sha256File, URL_RE, ASSET_URL, RELEASE_API };
