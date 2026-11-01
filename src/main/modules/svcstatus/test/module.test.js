'use strict';
// Pruebas de punta a punta de la clasificación con los textos reales del launcher en los 14 idiomas: el módulo
// arma las plantillas desde src/main/i18n y core/i18n traduce los errores igual que en la app. Sin red.
const test = require('node:test');
const assert = require('node:assert/strict');
const i18n = require('../../../core/i18n');
const svcstatus = require('../../svcstatus');

const LANGS = ['es', 'en', 'pt', 'fr', 'de', 'it', 'nl', 'pl', 'ru', 'uk', 'tr', 'ja', 'ko', 'zh'];
const { t } = i18n;

function inLang(lang, fn) {
  const prev = i18n.getLanguage();
  i18n.setLanguage(lang);
  try {
    return fn();
  } finally {
    i18n.setLanguage(prev);
  }
}

const task = (text) => svcstatus.classify({ source: 'task', text });

test('errores de red y de descarga reales: se ofrece el panel en los 14 idiomas', () => {
  for (const lang of LANGS) {
    inLang(lang, () => {
      const net = task(t('storage.errNetwork', { host: 'piston-meta.mojang.com', error: 'ENOTFOUND' }));
      assert.deepEqual([net.network, net.ids, net.focus], [true, ['mojangMeta'], 'downloads'], `${lang} errNetwork`);
      assert.equal(task(t('storage.errTimeout', { host: 'libraries.minecraft.net' })).network, true, `${lang} errTimeout`);
      assert.equal(task(t('storage.errHttp', { status: 503, url: 'https://cdn.modrinth.com/data/x.jar' })).network, true, `${lang} errHttp 503`);
      const off = task(t('storage.errOffline', { host: 'api.modrinth.com' }));
      assert.equal(off.network && off.offline, true, `${lang} errOffline`);
      // Descargas que fallaron (todas las formas del plural: 1, 3 y 5 archivos)
      for (const count of [1, 3, 5, 21]) {
        const err = t('storage.errHttp', { status: 404, url: 'https://cdn.modrinth.com/data/x.jar' });
        assert.equal(task(t('storage.errSomeFailed', { count, name: 'x.jar', error: err })).network, true, `${lang} errSomeFailed ${count}`);
        assert.equal(task(t('packs.errDownloads', { count, file: 'x.jar', error: err })).network, true, `${lang} packs.errDownloads ${count}`);
      }
      const ai = task(t('ai.errNetwork'));
      assert.deepEqual([ai.network, ai.ids, ai.focus], [true, ['venus'], 'venus'], `${lang} ai.errNetwork`);
      assert.deepEqual(task(t('modrinth.errNetwork')).ids, ['modrinth'], `${lang} modrinth.errNetwork`);
      // Un 5xx con la URL (errHttp en ese idioma) dice qué servicio falló de su lado
      const http = task(t('storage.errSomeFailed', { count: 1, name: 'x.jar', error: t('storage.errHttp', { status: 503, url: 'https://cdn.modrinth.com/data/x.jar' }) }));
      assert.deepEqual(http.known, { kind: 'down', ids: ['modrinth'] }, `${lang} errHttp 503 known`);
    });
  }
});

test('errores de disco y de otro tipo reales: no se ofrece el panel en los 14 idiomas', () => {
  for (const lang of LANGS) {
    inLang(lang, () => {
      for (const text of [
        t('storage.errNoSpace', { name: 'x.jar' }),
        t('storage.errDiskAccess', { name: 'x.jar', error: 'EBUSY' }),
        t('storage.errDisk', { name: 'x.jar', error: 'EIO' }),
        t('storage.errSomeFailed', { count: 2, name: 'x.jar', error: t('storage.errNoSpace', { name: 'x.jar' }) }),
        t('storage.errHash', { algo: 'sha1', name: 'x.jar' }),
        t('instances.errNotFound'),
        t('minecraft.errVersionMissing', { id: '1.21.4' }),
        t('storage.errCancelled'),
      ]) {
        assert.equal(task(text).network, false, `${lang}: ${text}`);
      }
    });
  }
});

test('inicio de sesión con los textos reales: caída conocida sin consultar, el resto se comprueba', () => {
  for (const lang of LANGS) {
    inLang(lang, () => {
      const login = (code, vars) => svcstatus.classify({ source: 'login', code, text: t(`accounts.${code}`, vars) });
      assert.deepEqual(login('msUnavailable').known, { kind: 'down', ids: ['microsoft'] }, lang);
      assert.deepEqual(login('mcLoginFailed', { status: 503 }).known, { kind: 'down', ids: ['minecraftServices'] }, lang);
      assert.deepEqual(login('xblFailed', { status: 500 }).known, { kind: 'down', ids: ['xbox'] }, lang);
      assert.equal(login('mcLoginFailed', { status: 403 }).autoCheck, true, lang);
      assert.equal(login('network', { service: 'Xbox Live' }).autoCheck, true, lang);
      for (const code of ['cancelled', 'noGame', 'noProfile', 'codeExpired', 'mcRateLimited', 'xerr_2148916233']) assert.equal(login(code).network, false, `${lang} ${code}`);
    });
  }
});

test('las entradas raras del canal no rompen nada', async () => {
  for (const info of [null, undefined, 42, 'x', [], { source: 'task', text: { a: 1 } }, { source: 'login', code: 7 }, { source: 'task', text: 'x'.repeat(100000) }]) {
    const c = svcstatus.classify(info);
    assert.equal(typeof c.network, 'boolean');
    assert.ok(Array.isArray(c.ids));
  }
});
