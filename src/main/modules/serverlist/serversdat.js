'use strict';
// Lista de servidores del juego (servers.dat de cada instancia): NBT sin comprimir
//   { servers: List<Compound { name, ip, icon?, acceptTextures?, hidden? }> }
// Se edita el arbol con tipos para conservar los campos que no conocemos, se escribe de forma
// atomica y se deja servers.dat_old como copia (igual que hace el juego).
const fsp = require('fs/promises');
const nbt = require('../../core/nbt');
const { addressKey } = require('./address');

const { TAG, T } = nbt;

// Una escritura a la vez por archivo
const queues = new Map();
function serialize(file, fn) {
  const prev = queues.get(file) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  queues.set(file, tail);
  tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return run;
}

async function readTyped(file) {
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  if (!buf.length) return null;
  return nbt.readTyped(buf);
}

function serverItems(root) {
  const list = root?.value?.servers;
  if (!list || list.type !== TAG.List || !list.value) return [];
  return Array.isArray(list.value.items) ? list.value.items : [];
}

const tagValue = (c, k, type) => (c && c[k] && c[k].type === type ? c[k].value : null);
const isHidden = (c) => {
  const v = tagValue(c, 'hidden', TAG.Byte);
  return v !== null && Number(v) !== 0;
};

function toPlain(c) {
  const icon = tagValue(c, 'icon', TAG.String);
  const accept = tagValue(c, 'acceptTextures', TAG.Byte);
  const ip = tagValue(c, 'ip', TAG.String) || '';
  return {
    name: tagValue(c, 'name', TAG.String) || '',
    ip,
    key: addressKey(ip),
    icon: icon && /^[A-Za-z0-9+/=\s]+$/.test(icon) && icon.length < 300000 ? `data:image/png;base64,${icon.replace(/\s+/g, '')}` : null,
    acceptTextures: accept === null ? null : Number(accept) !== 0,
    hidden: isHidden(c),
  };
}

// Servidores visibles de un servers.dat ([] si no existe)
async function list(file, { includeHidden = false } = {}) {
  const root = await readTyped(file);
  return serverItems(root)
    .filter((it) => it.type === TAG.Compound && it.value)
    .map((it) => toPlain(it.value))
    .filter((s) => s.ip && (includeHidden || !s.hidden));
}

async function writeTyped(file, root) {
  const buf = nbt.write(root, { gzip: false });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.copyFile(file, `${file}_old`).catch(() => {});
  await fsp.rename(tmp, file);
}

function ensureList(root) {
  if (!root.value || typeof root.value !== 'object') root.value = {};
  const cur = root.value.servers;
  if (!cur || cur.type !== TAG.List || !cur.value) root.value.servers = T.list(TAG.Compound, []);
  const lst = root.value.servers.value;
  if (!Array.isArray(lst.items)) lst.items = [];
  if (lst.itemType !== TAG.Compound) {
    if (lst.items.length) throw new Error('servers.dat: formato desconocido');
    lst.itemType = TAG.Compound;
  }
  return lst.items;
}

const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);

/**
 * Agrega un servidor (o le cambia el nombre si ya estaba). -> { added, updated }
 */
function add(file, { name, ip }) {
  const key = addressKey(ip);
  return serialize(file, async () => {
    const root = (await readTyped(file)) || { name: '', value: {} };
    const items = ensureList(root);
    const nm = cleanName(name) || String(ip);
    const existing = items.find((it) => it.type === TAG.Compound && !isHidden(it.value) && addressKey(tagValue(it.value, 'ip', TAG.String)) === key);
    if (existing) {
      if (tagValue(existing.value, 'name', TAG.String) === nm) return { added: false, updated: false };
      existing.value.name = T.string(nm);
      await writeTyped(file, root);
      return { added: false, updated: true };
    }
    const entry = { type: TAG.Compound, value: { name: T.string(nm), ip: T.string(String(ip).trim()) } };
    // Los ocultos (los que el juego guarda al entrar por conexion directa) van al final
    const firstHidden = items.findIndex((it) => it.type === TAG.Compound && isHidden(it.value));
    if (firstHidden >= 0) items.splice(firstHidden, 0, entry);
    else items.push(entry);
    await writeTyped(file, root);
    return { added: true, updated: false };
  });
}

/**
 * Cambia nombre y/o direccion de un servidor guardado, conservando icono y demas campos.
 * Si no estaba, lo agrega. -> { updated, added }
 */
function update(file, oldIp, { name, ip }) {
  const key = addressKey(oldIp);
  return serialize(file, async () => {
    const root = (await readTyped(file)) || { name: '', value: {} };
    const items = ensureList(root);
    const matches = items.filter((it) => it.type === TAG.Compound && !isHidden(it.value) && addressKey(tagValue(it.value, 'ip', TAG.String)) === key);
    if (!matches.length) {
      items.push({ type: TAG.Compound, value: { name: T.string(cleanName(name) || String(ip)), ip: T.string(String(ip).trim()) } });
      await writeTyped(file, root);
      return { updated: false, added: true };
    }
    for (const it of matches) {
      if (name !== undefined && cleanName(name)) it.value.name = T.string(cleanName(name));
      if (ip !== undefined && String(ip).trim()) {
        if (addressKey(ip) !== key) delete it.value.icon; // otro servidor: el icono viejo ya no corresponde
        it.value.ip = T.string(String(ip).trim());
      }
    }
    await writeTyped(file, root);
    return { updated: true, added: false };
  });
}

/**
 * Quita un servidor (todas sus entradas visibles). -> cantidad quitada
 */
function remove(file, ip) {
  const key = addressKey(ip);
  return serialize(file, async () => {
    const root = await readTyped(file);
    if (!root) return 0;
    const items = serverItems(root);
    const keep = items.filter((it) => !(it.type === TAG.Compound && !isHidden(it.value) && addressKey(tagValue(it.value, 'ip', TAG.String)) === key));
    const removed = items.length - keep.length;
    if (!removed) return 0;
    root.value.servers.value.items = keep;
    await writeTyped(file, root);
    return removed;
  });
}

module.exports = { list, add, update, remove, readTyped };
