'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const logic = require('../logic');

test('atajos: normaliza, exige modificador y rechaza lo invalido', () => {
  assert.equal(logic.normalizeAccelerator('alt+shift+f8'), 'Alt+Shift+F8');
  assert.equal(logic.normalizeAccelerator(' Shift + Control + s '), 'Ctrl+Shift+S');
  assert.equal(logic.normalizeAccelerator('CommandOrControl+Alt+R'), 'CmdOrCtrl+Alt+R');
  assert.equal(logic.normalizeAccelerator('Ctrl+PrintScreen'), 'Ctrl+PrintScreen');
  assert.equal(logic.normalizeAccelerator('Ctrl++'), 'Ctrl+Plus');
  assert.equal(logic.normalizeAccelerator('F13'), 'F13', 'F13 a F24 sin modificador');
  assert.equal(logic.normalizeAccelerator('F2'), null, 'F2 solo le quitaria la captura al juego');
  assert.equal(logic.normalizeAccelerator('a'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+A+B'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+Nada'), null);
  assert.equal(logic.normalizeAccelerator('Ctrl+Shift'), null);
  assert.equal(logic.normalizeAccelerator(''), null);
  assert.equal(logic.normalizeAccelerator(42), null);
});

test('atajos de los ajustes: por defecto, vacios a proposito y repetidos', () => {
  assert.deepEqual(logic.normalizeShortcuts(undefined), { ...logic.DEFAULTS.shortcuts });
  assert.deepEqual(logic.normalizeShortcuts({ replay: '', record: null, screenshot: 'ctrl+f12' }), { replay: '', record: '', screenshot: 'Ctrl+F12' });
  const dup = logic.normalizeShortcuts({ replay: 'Alt+X', record: 'alt+x', screenshot: 'basura' });
  assert.deepEqual(dup, { replay: 'Alt+X', record: '', screenshot: '' });
});

test('ajustes: valores por defecto y validacion', () => {
  const d = logic.normalizeSettings(null);
  assert.equal(d.replay, false, 'la repeticion arranca apagada');
  assert.equal(d.replaySeconds, 60);
  assert.equal(d.quality, '1080p');
  assert.equal(d.fps, 30);
  assert.equal(d.level, 'medium');
  assert.equal(d.recordLimit, 0, 'la grabacion no tiene limite si no se elige uno');
  assert.equal(d.audio, true);
  assert.equal(d.copyTo, '');
  const s = logic.normalizeSettings({ replay: true, quality: 'basura', fps: '60', audio: false, copyTo: 'relativa/no' });
  assert.equal(s.replay, true);
  assert.equal(s.quality, '1080p');
  assert.equal(s.fps, 60);
  assert.equal(s.audio, false);
  assert.equal(s.copyTo, '');
  const abs = path.resolve('/tmp/clips');
  assert.equal(logic.normalizeSettings({ copyTo: abs }).copyTo, path.normalize(abs));
});

test('ajustes de antes siguen valiendo y lo fuera de rango se corrige', () => {
  // Lo que guardaba la 6.0: quality 720p/1080p/native, fps 30/60 y sin largo de repeticion
  for (const q of ['720p', '1080p', 'native']) assert.equal(logic.normalizeSettings({ quality: q }).quality, q);
  for (const f of [30, 60]) assert.equal(logic.normalizeSettings({ fps: f }).fps, f);
  const old = logic.normalizeSettings({ replay: true, quality: 'native', fps: 60, audio: true, shortcuts: { replay: 'Alt+Shift+F8' } });
  assert.equal(old.replaySeconds, 60, 'antes eran 60 s fijos');
  assert.equal(old.level, 'medium');
  // Nombres de la resolucion: 2K y 1440p son lo mismo; 4K = 2160p
  assert.equal(logic.normalizeSettings({ quality: '2K' }).quality, '1440p');
  assert.equal(logic.normalizeSettings({ quality: '4k' }).quality, '2160p');
  assert.equal(logic.normalizeSettings({ quality: '1440' }).quality, '1440p');
  // fps: al mas cercano de la lista
  assert.equal(logic.normalizeSettings({ fps: 50 }).fps, 45);
  assert.equal(logic.normalizeSettings({ fps: 240 }).fps, 120);
  assert.equal(logic.normalizeSettings({ fps: 1 }).fps, 30);
  assert.equal(logic.normalizeSettings({ fps: 'x' }).fps, 30);
  assert.equal(logic.normalizeSettings({ fps: true }).fps, 30);
  assert.deepEqual(logic.FPS, [30, 45, 60, 80, 120]);
  // Largo de la repeticion: 30 s a 30 minutos, para todos
  assert.equal(logic.normalizeSettings({ replaySeconds: 300 }).replaySeconds, 300);
  assert.equal(logic.normalizeSettings({ replaySeconds: 99999 }).replaySeconds, 1800);
  assert.equal(logic.normalizeSettings({ replaySeconds: 5 }).replaySeconds, 30);
  assert.equal(logic.normalizeSettings({ replaySeconds: null }).replaySeconds, 60);
  assert.deepEqual(logic.REPLAY_LENGTHS, [30, 60, 120, 300, 600, 900, 1800]);
  // Calidad y limite de la grabacion
  assert.equal(logic.normalizeSettings({ level: 'ultra' }).level, 'medium');
  assert.equal(logic.normalizeSettings({ level: 'high' }).level, 'high');
  assert.equal(logic.normalizeSettings({ recordLimit: 60 }).recordLimit, 60);
  assert.equal(logic.normalizeSettings({ recordLimit: 45 }).recordLimit, 30, 'al mas cercano');
  assert.equal(logic.normalizeSettings({ recordLimit: -3 }).recordLimit, 0);
  assert.equal(logic.normalizeSettings({ recordLimit: 99999 }).recordLimit, 240);
});

test('plataforma: un solo lugar decide si hay grabacion', () => {
  assert.deepEqual(logic.platformSupport('win32'), { capture: true, audio: true });
  assert.equal(logic.platformSupport('darwin').capture, false, 'macOS: hasta que el port lo pruebe');
  assert.equal(logic.platformSupport('linux').capture, false);
});

test('calidad: tamanio dentro de la caja, sin agrandar y con lados pares', () => {
  assert.deepEqual(logic.fitSize(2560, 1440, '1080p'), { width: 1920, height: 1080 });
  assert.deepEqual(logic.fitSize(1280, 720, '1080p'), { width: 1280, height: 720 });
  assert.deepEqual(logic.fitSize(1921, 1081, '720p'), { width: 1278, height: 720 });
  assert.deepEqual(logic.fitSize(800, 2000, '720p'), { width: 288, height: 720 });
  assert.deepEqual(logic.fitSize(1920, 1080, '2160p'), { width: 1920, height: 1080 }, '4K con una ventana de 1080p: no se agranda');
  assert.deepEqual(logic.qualityBox('1440p'), { width: 2560, height: 1440 });
  assert.deepEqual(logic.qualityBox('2160p'), { width: 3840, height: 2160 });
  assert.deepEqual(logic.qualityBox('native'), { width: 3840, height: 2160 });
  assert.deepEqual(logic.qualityBox('native', { width: 2560, height: 1440 }), { width: 2560, height: 1440 }, 'nativa = la pantalla');
  assert.deepEqual(logic.qualityBox('native', { width: 5120, height: 2880 }), { width: 3840, height: 2160 }, 'con tope en 4K');
});

test('tabla de bitrate: crece con resolucion, fps y calidad, con topes', () => {
  const b = (w, h, f, l = 'medium', c = 'vp9') => logic.targetBitrate(w, h, f, l, c);
  assert.ok(b(1280, 720, 30) < b(1920, 1080, 30) && b(1920, 1080, 30) < b(2560, 1440, 30) && b(2560, 1440, 30) < b(3840, 2160, 30));
  for (let i = 1; i < logic.FPS.length; i++) assert.ok(b(1920, 1080, logic.FPS[i]) > b(1920, 1080, logic.FPS[i - 1]), `${logic.FPS[i]} fps`);
  assert.ok(b(1920, 1080, 60) < b(1920, 1080, 30) * 2, '60 fps no cuesta el doble');
  assert.ok(b(1920, 1080, 60, 'low') < b(1920, 1080, 60) && b(1920, 1080, 60) < b(1920, 1080, 60, 'high'));
  assert.ok(b(1920, 1080, 60, 'medium', 'av1') < b(1920, 1080, 60) && b(1920, 1080, 60) < b(1920, 1080, 60, 'medium', 'h264'));
  // Valores de referencia (Media, VP9): ~10 Mbps a 1080p60, ~18 a 1440p60, ~40 a 4K60
  const mbps = (n) => Math.round(n / 1e5) / 10;
  assert.ok(mbps(b(1920, 1080, 60)) > 8 && mbps(b(1920, 1080, 60)) < 12, `${mbps(b(1920, 1080, 60))}`);
  assert.ok(mbps(b(2560, 1440, 60)) > 15 && mbps(b(2560, 1440, 60)) < 21, `${mbps(b(2560, 1440, 60))}`);
  assert.ok(mbps(b(3840, 2160, 60)) > 35 && mbps(b(3840, 2160, 60)) < 45, `${mbps(b(3840, 2160, 60))}`);
  assert.equal(b(10, 10, 30), logic.MIN_BPS);
  assert.equal(b(7680, 4320, 120, 'high', 'h264'), logic.MAX_BPS);
  // Por hardware se pide menos (la GPU gasta ~2,1 veces lo pedido a 60 fps y mas con mas fps)
  assert.ok(logic.bitrateFor(1920, 1080, 60, 'medium', 'av1', true) < logic.bitrateFor(1920, 1080, 60, 'medium', 'av1', false) / 2);
  assert.ok(logic.hwOvershoot(120) > logic.hwOvershoot(60) && logic.hwOvershoot(60) > logic.hwOvershoot(30));
  // Lo que se espera que ocupe: sin saber el codec, el peor caso
  assert.ok(logic.expectedBitrate(1920, 1080, 60) >= logic.expectedBitrate(1920, 1080, 60, 'medium', 'vp8'));
  assert.ok(logic.expectedBitrate(1920, 1080, 60) > logic.expectedBitrate(1920, 1080, 60, 'medium', 'av1', true));
});

test('la grabadora calcula el mismo bitrate que el proceso principal', async () => {
  const { bitrateFor } = await import(pathToFileURL(path.join(__dirname, '..', '..', '..', '..', 'renderer', 'js', 'recorder', 'bitrate.js')).href);
  for (const level of logic.LEVELS) {
    const model = JSON.parse(JSON.stringify(logic.bitrateModel(level))); // viaja por IPC
    for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [1366, 768]]) {
      for (const fps of logic.FPS) {
        for (const codec of ['vp9', 'vp8', 'av1', 'h264']) {
          for (const hw of [false, true]) assert.equal(bitrateFor(w, h, fps, model, codec, hw), logic.bitrateFor(w, h, fps, level, codec, hw), `${level} ${w}x${h}@${fps} ${codec} ${hw}`);
        }
      }
    }
  }
});

test('codec: por software, VP9 hasta 1080p30 y VP8 mas arriba; por hardware AV1, H.264 y VP9', () => {
  assert.deepEqual(logic.codecOrder({ width: 1920, height: 1080, fps: 30 }), ['vp9', 'vp8']);
  assert.deepEqual(logic.codecOrder({ width: 1280, height: 720, fps: 60 }), ['vp9', 'vp8']);
  assert.deepEqual(logic.codecOrder({ width: 1920, height: 1080, fps: 60 }), ['vp8', 'vp9']);
  assert.deepEqual(logic.HW_CODECS, ['av1', 'h264', 'vp9']);
  assert.ok(!logic.codecOrder({ width: 3840, height: 2160, fps: 120 }).includes('h264'), 'H.264 por software sale todo cuadro clave');
});

test('lo que de verdad se graba: ventana mas chica, monitor y codec elegido', () => {
  const display = { width: 2560, height: 1440, hz: 60 };
  const p = logic.effective({ quality: '2160p', fps: 120 }, { display, window: { width: 1920, height: 1080 } });
  assert.equal(p.width, 1920);
  assert.equal(p.height, 1080);
  assert.equal(p.fps, 120, 'los fps no se recortan: con el juego sin VSync la captura da mas que los Hz');
  assert.ok(p.notes.includes('window') && p.notes.includes('monitor'));
  assert.equal(p.codec, null);
  const q = logic.effective({ quality: '1080p', fps: 60 }, { display, window: { width: 2560, height: 1440 }, codec: 'av1', hardware: true });
  assert.deepEqual([q.width, q.height, q.notes.length], [1920, 1080, 0]);
  assert.equal(q.bitrate, logic.bitrateFor(1920, 1080, 60, 'medium', 'av1', true));
  assert.equal(q.expected, logic.targetBitrate(1920, 1080, 60, 'medium', 'av1'));
  // Nativa: el tamanio de la ventana, sin aviso de "mas chica"
  assert.deepEqual(logic.effective({ quality: 'native' }, { display, window: { width: 1280, height: 720 } }).notes, []);
  // Nativa con la ventana en otra pantalla, mas grande que la principal: se graba entera (tope 4K)
  const big = logic.effective({ quality: 'native' }, { display: { width: 1920, height: 1080 }, window: { width: 2560, height: 1440 } });
  assert.deepEqual([big.width, big.height], [2560, 1440]);
  // Sin saber la pantalla, ningun aviso de monitor
  assert.deepEqual(logic.effective({ fps: 120 }).notes, []);
});

test('espacio en disco: duracion x resolucion x fps x calidad', () => {
  const mb = (n) => Math.round(n / (1024 * 1024));
  const plan = (o, env) => logic.effective(o, env);
  const p1080 = plan({ quality: '1080p', fps: 30 });
  // A 1080p30 Media, peor caso: unos 70 MB por minuto de buffer (antes ~60 MB con 0,11 bpp)
  assert.ok(mb(logic.replayDisk(60, p1080)) > 50 && mb(logic.replayDisk(60, p1080)) < 100, `${mb(logic.replayDisk(60, p1080))} MB`);
  assert.ok(logic.replayDisk(300, p1080) > logic.replayDisk(60, p1080) * 4);
  assert.ok(logic.replayDisk(60, plan({ quality: '1080p', fps: 60 })) > logic.replayDisk(60, p1080));
  assert.ok(logic.replayDisk(60, plan({ quality: '2160p', fps: 30 })) > logic.replayDisk(60, p1080));
  assert.ok(logic.replayDisk(60, plan({ quality: '1080p', fps: 30, level: 'high' })) > logic.replayDisk(60, p1080));
  assert.ok(logic.replayDisk(60, p1080, false) < logic.replayDisk(60, p1080, true), 'el audio suma');
  // 30 minutos a 4K 120 Alta: decenas de GB (por eso se muestra y se frena)
  const gb = logic.replayDisk(1800, plan({ quality: '2160p', fps: 120, level: 'high' })) / 1024 ** 3;
  assert.ok(gb > 20 && gb < 40, `${gb} GB`);
  assert.equal(logic.estimateBytes(10, { expected: 8e6 }, false), 1e7);
});

test('lugar en el disco: deja un margen, sin saberlo no molesta y el buffer tiene tope', () => {
  const need = 300 * 1024 * 1024;
  assert.equal(logic.hasDiskRoom(need + logic.DISK_MARGIN, need), true);
  assert.equal(logic.hasDiskRoom(need + logic.DISK_MARGIN - 1, need), false);
  assert.equal(logic.hasDiskRoom(0, need), false);
  assert.equal(logic.hasDiskRoom(null, need), true);
  const GB = 1024 ** 3;
  assert.equal(logic.ringMaxBytes(GB), 1.5 * GB, 'una vez y media lo estimado');
  assert.equal(logic.ringMaxBytes(10), 512 * 1024 * 1024, 'al menos 512 MB');
  assert.equal(logic.ringMaxBytes(GB, 3 * GB), 1.5 * GB);
  assert.equal(logic.ringMaxBytes(GB, Math.round(2.2 * GB)), Math.round(2.2 * GB) - GB, 'nunca deja menos de 1 GB libre');
  assert.equal(logic.ringMaxBytes(GB, 1.5 * GB), GB, 'pero no menos de lo necesario (eso ya lo frena hasDiskRoom)');
});

test('presets de un clic', () => {
  assert.deepEqual(logic.presetValues('light'), { quality: '720p', fps: 30, level: 'medium' });
  assert.deepEqual(logic.presetValues('balanced'), { quality: '1080p', fps: 60, level: 'medium' });
  assert.deepEqual(logic.presetValues('max', { width: 2560, height: 1440 }), { quality: '1440p', fps: 120, level: 'high' });
  assert.deepEqual(logic.presetValues('max', { width: 3840, height: 2160 }), { quality: '2160p', fps: 60, level: 'high' });
  assert.equal(logic.presetValues('otro'), null);
  assert.equal(logic.activePreset({ quality: '1080p', fps: 60 }), 'balanced');
  assert.equal(logic.activePreset({ quality: '1080p', fps: 45 }), 'custom');
  assert.equal(logic.activePreset({ quality: '2160p', fps: 60, level: 'high' }, { width: 3840, height: 2160 }), 'max');
  assert.equal(logic.activePreset({}), 'custom', 'lo de siempre (1080p30) no es ningun preset');
  assert.ok(logic.load(logic.effective(logic.presetValues('max'))) > logic.BALANCED_LOAD);
  assert.ok(logic.load(logic.effective(logic.presetValues('light'))) < logic.BALANCED_LOAD);
});

test('cuando la PC no llega: diagnostico y degradacion de a un paso', () => {
  assert.equal(logic.assessRate({ target: 60, delivered: 60, encoded: 59 }), 'ok');
  assert.equal(logic.assessRate({ target: 60, delivered: 60, encoded: 39 }), 'encoder', 'VP9 por software a 1080p60');
  assert.equal(logic.assessRate({ target: 120, delivered: 60, encoded: 60, hardware: true }), 'source', 'la GPU da abasto: es el juego (VSync) o la pantalla');
  assert.equal(logic.assessRate({ target: 60, delivered: 34, encoded: 34 }), 'encoder', 'VP8 por software a 4K60: Chromium frena la captura y delivered baja igual');
  assert.equal(logic.assessRate({ target: 60, delivered: null, encoded: 20 }), 'encoder', 'sin estadisticas decide el tipo de codificador');
  assert.equal(logic.assessRate({ target: 60, delivered: null, encoded: 20, hardware: true }), 'source');
  assert.equal(logic.assessRate({ target: 60, delivered: 60, encoded: 30, hardware: true }), 'encoder', 'cuadros perdidos a la vista: bajar aunque sea por hardware');
  assert.equal(logic.assessRate({ target: 0, delivered: 0, encoded: 0 }), 'ok');
  assert.deepEqual(logic.stepDown({ quality: '1440p', fps: 120 }), { quality: '1440p', fps: 80 });
  assert.deepEqual(logic.stepDown({ quality: '1440p', fps: 80 }), { quality: '1440p', fps: 60 });
  assert.deepEqual(logic.stepDown({ quality: '2160p', fps: 60 }), { quality: '1440p', fps: 60 });
  assert.deepEqual(logic.stepDown({ quality: '1080p', fps: 60 }), { quality: '720p', fps: 60 });
  assert.deepEqual(logic.stepDown({ quality: '720p', fps: 60 }), { quality: '720p', fps: 45 });
  assert.deepEqual(logic.stepDown({ quality: 'native', fps: 60 }, 1440), { quality: '1080p', fps: 60 });
  assert.equal(logic.stepDown({ quality: '720p', fps: 30 }), null, 'no hay nada mas abajo');
  // Que no lleguen cuadros (ventana minimizada, pantalla de carga) no es culpa del codificador
  assert.equal(logic.assessRate({ target: 60, delivered: 0, encoded: 0 }), 'source');
  assert.equal(logic.assessRate({ target: 60, delivered: null, encoded: 0 }), 'source');
  // Con una ventana mas chica que la calidad elegida, se saltean las cajas que no la achican
  assert.deepEqual(logic.stepDown({ quality: '2160p', fps: 60 }, 1080), { quality: '720p', fps: 60 });
  assert.deepEqual(logic.stepDown({ quality: '1440p', fps: 60 }, 1080), { quality: '720p', fps: 60 });
  assert.equal(logic.stepDown({ quality: '1080p', fps: 30 }, 480), null, 'ventana de 480: bajar a 720p no cambia nada');
  assert.deepEqual(logic.stepDown({ quality: '1080p', fps: 60 }, 1080), { quality: '720p', fps: 60 });
  // Siempre termina
  let cur = { quality: '2160p', fps: 120 };
  let n = 0;
  while (cur && n < 20) {
    cur = logic.stepDown(cur);
    n++;
  }
  assert.ok(n < 20);
});

test('nombres: fecha local como la de Minecraft y carpeta por tipo', () => {
  const d = new Date(2026, 10, 1, 18, 3, 9);
  assert.equal(logic.stamp(d), '2026-11-01_18.03.09');
  assert.equal(logic.fileName('screenshot', d), '2026-11-01_18.03.09_venus.png');
  assert.equal(logic.fileName('clip', d), '2026-11-01_18.03.09_replay.webm');
  assert.equal(logic.fileName('recording', d), '2026-11-01_18.03.09_rec.webm');
  assert.equal(logic.fileName('clip', d, 'death'), '2026-11-01_18.03.09_auto-death.webm');
  assert.equal(logic.fileName('clip', d, 'advancement'), '2026-11-01_18.03.09_auto-advancement.webm');
  assert.equal(logic.fileName('clip', d, 'boss'), '2026-11-01_18.03.09_auto-boss.webm');
  assert.equal(logic.fileName('clip', d, 'otro'), '2026-11-01_18.03.09_replay.webm');
  assert.equal(logic.fileName('recording', d, 'death'), '2026-11-01_18.03.09_rec.webm', 'solo los clips llevan motivo');
  assert.throws(() => logic.fileName('otro', d));
  const inst = path.join('C:', 'datos', 'instances', 'abc');
  assert.equal(logic.folderFor(inst, 'screenshot'), path.join(inst, 'screenshots'));
  assert.equal(logic.folderFor(inst, 'clip'), path.join(inst, 'clips'));
  assert.equal(logic.folderFor(inst, 'recording'), path.join(inst, 'recordings'));
  // worlds/media.js lista esas carpetas y entiende la fecha del nombre
  const media = require('../../worlds/media');
  assert.ok(media.CLIP_DIRS.includes('clips') && media.CLIP_DIRS.includes('recordings'));
  assert.equal(media.nameTime(logic.fileName('clip', d)), d.getTime());
  assert.equal(media.nameTime(logic.fileName('clip', d, 'death')), d.getTime());
});

test('nombre unico y nombre de la exportacion', async () => {
  const taken = new Set(['x.webm', 'x-2.webm'].map((n) => path.join('d', n)));
  assert.equal(await logic.uniqueName('d', 'x.webm', async (p) => taken.has(p)), 'x-3.webm');
  assert.equal(await logic.uniqueName('d', 'y.webm', async () => false), 'y.webm');
  assert.equal(logic.exportName('2026-11-01_18.03.09_replay.webm', 'vertical'), '2026-11-01_18.03.09_replay_vertical.webm');
  assert.equal(logic.exportName('clip_vertical-2.webm', 'horizontal'), 'clip_edit.webm', 'no apila sufijos');
  assert.equal(logic.exportName('../../malo:<>.mp4', 'vertical'), 'malo__vertical.webm');
  assert.equal(logic.exportName('', 'x'), 'clip_edit.webm');
  assert.equal(logic.exportName('2026-11-01_18.03.09_auto-boss.webm', 'vertical'), '2026-11-01_18.03.09_auto-boss_vertical.webm', 'lo exportado conserva el motivo');
});

test('juego a capturar: el abierto mas reciente que no sea de prueba', () => {
  assert.equal(logic.pickGame({}), null);
  const st = {
    a: { state: 'running', pid: 10, startedAt: 100 },
    b: { state: 'running', pid: 20, startedAt: 300, quiet: true },
    c: { state: 'running', pid: 30, startedAt: 200 },
    d: { state: 'preparing', pid: 40, startedAt: 400 },
  };
  assert.deepEqual(logic.pickGame(st), { instanceId: 'c', pid: 30, startedAt: 200 });
});
