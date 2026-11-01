'use strict';
// Modo de capturas de skins (solo con VENUS_DEVSHOT, VENUS_SKINS_FAKE=1 y sin empaquetar): una cuenta de
// Microsoft de ejemplo y una API falsa que guarda los cambios en memoria. Las texturas son los PNG propios
// de la carpeta VENUS_SKINS_FAKE_DIR (skin.png y cape-<nombre>.png). Nunca habla con ningun servidor.
// VENUS_SKINS_FAKE_ERROR=<codigo> hace fallar el perfil con ese codigo (rateLimited, network...).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseProfile } = require('./api');

const UUID = '7e57c0de7e57c0de7e57c0de7e57c0de';

function createFake({ fail, dir, scenario = '' }) {
  const read = (name) => {
    try {
      return fs.readFileSync(path.join(dir, name));
    } catch {
      return null;
    }
  };
  const textures = new Map(); // hash -> bytes
  const urlFor = (bytes) => {
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    textures.set(hash, bytes);
    return `http://textures.minecraft.net/texture/${hash}`;
  };
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    files = [];
  }
  const skin = read('skin.png');
  const state = {
    skin: skin ? { id: 'fake-skin', url: urlFor(skin), variant: /slim/i.test(process.env.VENUS_SKINS_FAKE_VARIANT || '') ? 'SLIM' : 'CLASSIC' } : null,
    capes: files
      .filter((f) => /^cape-[\w-]+\.png$/.test(f))
      .sort()
      .map((f, i) => ({ id: `0000000${i}-0000-4000-8000-00000000000${i}`, alias: f.slice(5, -4).replace(/_/g, ' '), url: urlFor(read(f)) })),
    activeCape: 0,
  };
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const profile = () =>
    parseProfile({
      id: UUID,
      name: 'VenusTester',
      skins: state.skin ? [{ ...state.skin, state: 'ACTIVE' }] : [],
      capes: state.capes.map((c, i) => ({ ...c, state: i === state.activeCape ? 'ACTIVE' : 'INACTIVE' })),
    });

  const api = {
    async getProfile() {
      await delay(500);
      if (scenario) throw fail(scenario);
      return profile();
    },
    async uploadSkin(token, { bytes, variant }) {
      await delay(900);
      state.skin = { id: 'fake-skin', url: urlFor(bytes), variant: variant.toUpperCase() };
      return profile();
    },
    async resetSkin() {
      await delay(600);
      state.skin = null;
      return profile();
    },
    async showCape(token, capeId) {
      await delay(600);
      const i = state.capes.findIndex((c) => c.id === capeId);
      if (i < 0) throw fail('capeRejected');
      state.activeCape = i;
      return profile();
    },
    async hideCape() {
      await delay(600);
      state.activeCape = -1;
      return profile();
    },
    async fetchTexture(url) {
      await delay(150);
      const bytes = textures.get(String(url).split('/').pop());
      if (!bytes) throw fail('textureMissing');
      return bytes;
    },
  };

  const account = { id: 'msa-fake', type: 'msa', name: 'VenusTester', uuid: UUID, needsLogin: false };
  const accounts = {
    async list() {
      return { selected: account.id, accounts: [{ ...account }] };
    },
    async getLaunchAccount() {
      return { type: 'msa', name: account.name, uuid: UUID, accessToken: 'fake-token' };
    },
  };
  return { api, accounts };
}

module.exports = { createFake };
