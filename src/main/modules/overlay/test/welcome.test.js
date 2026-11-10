'use strict';
// Logica de la interfaz de la 6.1 (src/renderer/js/overlay/logic.js), sin DOM: que diseno listo coincide, la vista previa
// de la bienvenida, el texto de "No molestar", cuando se muestra el aviso de la actualizacion y que guarda el paso del
// overlay de la bienvenida.
const test = require('node:test');
const assert = require('node:assert/strict');
const { esm } = require('./helpers');
const config = require('../config');

const PRESETS = JSON.parse(JSON.stringify(config.PRESETS));
const widgets = (patch = {}) => config.normalize({ widgets: patch }).widgets;

test('disenos: se reconoce el que coincide con los widgets prendidos; si no, es propio', async () => {
  const { matchPreset } = await esm('logic.js');
  for (const id of config.PRESET_IDS) assert.equal(matchPreset(widgets(config.presetPatch(id)), PRESETS), id, id);
  assert.equal(matchPreset(widgets(), PRESETS), 'full', 'de fabrica estan todos prendidos');
  const custom = widgets({ ...config.presetPatch('minimal'), music: { enabled: true } });
  assert.equal(matchPreset(custom, PRESETS), null);
  // El tamano o la posicion no cambian el diseno
  assert.equal(matchPreset(widgets({ ...config.presetPatch('performance'), perf: { enabled: true, scale: 1.5, anchor: 'tr' } }), PRESETS), 'performance');
  assert.equal(matchPreset(null, PRESETS), null);
  assert.equal(matchPreset(widgets(), null), null);
});

test('vista previa de la bienvenida: solo los widgets que prende el diseno, con sus opciones', async () => {
  const { previewWidgets } = await esm('logic.js');
  const base = widgets();
  const minimal = previewWidgets(base, PRESETS.minimal);
  assert.deepEqual(Object.keys(minimal), ['voice', 'alerts']);
  assert.equal(minimal.voice.show, 'speaking');
  assert.equal(minimal.voice.anchor, base.voice.anchor, 'la posicion es la de ahora');
  assert.equal(base.voice.show, 'all', 'no cambia lo que recibio');
  assert.deepEqual(Object.keys(previewWidgets(base, PRESETS.performance)), ['perf']);
  assert.deepEqual(Object.keys(previewWidgets(base, null)), config.WIDGETS, 'sin diseno: lo que este prendido');
  assert.deepEqual(previewWidgets(null, PRESETS.full), {});
});

test('no molestar: el texto dice si esta prendido, hasta cuando y cuantos minutos quedan (redondeando para arriba)', async () => {
  const { dndLabel } = await esm('logic.js');
  assert.deepEqual(dndLabel(null), { key: 'dndStateOff' });
  assert.deepEqual(dndLabel({ on: false }), { key: 'dndStateOff' });
  assert.deepEqual(dndLabel({ on: true, game: true, until: null }), { key: 'dndStateGame' });
  assert.deepEqual(dndLabel({ on: true, game: false, until: 1000 + 14 * 60000 + 1 }, 1000), { key: 'dndStateUntil', minutes: 15 });
  assert.deepEqual(dndLabel({ on: true, game: false, until: 1000 + 5000 }, 1000), { key: 'dndStateUntil', minutes: 1 }, 'nunca "0 minutos"');
});

test('aviso de la actualizacion: solo pendiente y fuera de la bienvenida', async () => {
  const { offNoticeDue } = await esm('logic.js');
  assert.equal(offNoticeDue({ overlay: { offNotice: 'pending' } }), true);
  assert.equal(offNoticeDue({ overlay: { offNotice: 'pending' } }, { onboarding: true }), false);
  assert.equal(offNoticeDue({ overlay: { offNotice: 'seen' } }), false);
  assert.equal(offNoticeDue({ overlay: { enabled: false } }), false, 'instalacion nueva');
  assert.equal(offNoticeDue(null), false);
});

test('bienvenida: apagado guarda que esta apagado; prendido guarda el diseno elegido', async () => {
  const { welcomeOverlayPatch } = await esm('logic.js');
  assert.deepEqual(welcomeOverlayPatch({ on: false, preset: 'full', presets: PRESETS }), { enabled: false });
  const on = welcomeOverlayPatch({ on: true, preset: 'minimal', presets: PRESETS });
  assert.equal(on.enabled, true);
  assert.deepEqual(on.widgets, PRESETS.minimal, 'primera vez: el diseno con el que lo prendio');
  on.widgets.voice.enabled = false;
  assert.equal(PRESETS.minimal.voice.enabled, true, 'es una copia');
  // Lo que guarda es una configuracion valida para el proceso principal
  const saved = config.normalize(welcomeOverlayPatch({ on: true, preset: 'performance', presets: PRESETS }));
  assert.equal(saved.enabled, true);
  assert.deepEqual(config.WIDGETS.filter((w) => saved.widgets[w].enabled), ['perf']);
});

test('bienvenida: al volver a abrirla con el overlay ya prendido no se pisan los widgets salvo que elija otro diseno', async () => {
  const { welcomeOverlayPatch } = await esm('logic.js');
  assert.deepEqual(welcomeOverlayPatch({ on: true, preset: 'minimal', wasOn: true, picked: false, presets: PRESETS }), { enabled: true });
  assert.deepEqual(welcomeOverlayPatch({ on: true, preset: 'full', wasOn: true, picked: true, presets: PRESETS }).widgets, PRESETS.full);
  assert.deepEqual(welcomeOverlayPatch({ on: true, preset: 'nada', presets: PRESETS }), { enabled: true }, 'un diseno que no existe no rompe nada');
  assert.deepEqual(welcomeOverlayPatch({ on: true, preset: 'minimal', presets: null }), { enabled: true });
});
