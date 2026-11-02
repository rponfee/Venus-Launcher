'use strict';
// Lectura de la salida del ayudante y armado de comandos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLine, encodeCommand, createLineSplitter, cleanText } = require('../protocol');

const ART = `data:image/jpeg;base64,${'A'.repeat(400)}==`;

test('ready: con y sin SMTC', () => {
  assert.deepEqual(parseLine('{"t":"ready","v":1,"smtc":true,"audio":true,"thumbs":true}'), { t: 'ready', version: 1, smtc: true, audio: true, thumbs: true, error: '' });
  const no = parseLine('{"t":"ready","v":1,"smtc":false,"audio":true,"error":"Unable to find type"}');
  assert.equal(no.smtc, false);
  assert.equal(no.error, 'Unable to find type');
});

test('sesiones: normaliza tipos, recorta textos y descarta lo inválido', () => {
  const line = JSON.stringify({
    t: 'sessions',
    system: 'Spotify.exe',
    list: [
      { id: 'Spotify.exe', app: 'Spotify.exe', title: `  Canción\u0007 con   espacios `, artist: 'A', album: 'B', key: 'CB3F3340', status: 4, position: 53393.7, start: 0, end: 94438, updated: 1793578620757, canPlay: true, canSeek: 'si' },
      { title: 'sin id' },
      'basura',
    ],
  });
  const m = parseLine(line);
  assert.equal(m.t, 'sessions');
  assert.equal(m.system, 'Spotify.exe');
  assert.equal(m.list.length, 1);
  const s = m.list[0];
  assert.equal(s.title, 'Canción con espacios');
  assert.equal(s.key, 'cb3f3340');
  assert.equal(s.position, 53394);
  assert.equal(s.updated, 1793578620757);
  assert.equal(s.canPlay, true);
  assert.equal(s.canSeek, false, 'solo true cuenta');
  assert.equal(s.canNext, false);
});

test('sesiones: lista de un elemento serializada como objeto y system desconocido', () => {
  const m = parseLine(JSON.stringify({ t: 'sessions', system: 'Otra.exe', list: { id: 'Chrome', app: 'Chrome', status: 5 } }));
  assert.equal(m.list.length, 1);
  assert.equal(m.system, '', 'el system tiene que ser una de las sesiones');
  const empty = parseLine('{"t":"sessions","system":"","list":[]}');
  assert.deepEqual(empty, { t: 'sessions', system: '', list: [] });
});

test('sesiones: valores fuera de rango', () => {
  const m = parseLine(JSON.stringify({ t: 'sessions', list: [{ id: 'x', status: 9, position: -5, end: 'mucho', updated: -62135596800000 }] }));
  const s = m.list[0];
  assert.equal(s.status, -1);
  assert.equal(s.position, 0);
  assert.equal(s.end, 0);
  assert.equal(s.updated, 0, 'DateTimeOffset.MinValue = no se sabe');
});

test('portada: solo data: URL de imagen y de 20 KB como mucho', () => {
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'Spotify.exe', key: 'ab', data: ART })).data, ART);
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'Spotify.exe', key: 'ab', data: null })).data, null);
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'x', data: 'https://example.com/a.jpg' })).data, null);
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'x', data: 'data:image/svg+xml;base64,PHN2Zz4=' })).data, null);
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'x', data: `data:image/jpeg;base64,${'A'.repeat(21000)}` })).data, null);
  assert.equal(parseLine(JSON.stringify({ t: 'art', id: 'x', data: 'data:image/jpeg;base64,AAA"onerror' })).data, null);
  assert.equal(parseLine(JSON.stringify({ t: 'art', data: ART })), null, 'sin id');
});

test('audio: pids válidos y volumen entre 0 y 1', () => {
  const m = parseLine(JSON.stringify({ t: 'audio', list: [{ pid: 34960, exe: 'Spotify.exe', pkg: '', volume: 1.2, muted: false, active: true }, { pid: 0, exe: 'x' }, { pid: 12, volume: 'x' }] }));
  assert.equal(m.list.length, 2);
  assert.deepEqual(m.list[0], { pid: 34960, exe: 'Spotify.exe', pkg: '', volume: 1, muted: false, active: true });
  assert.equal(m.list[1].volume, 0);
});

test('result: códigos conocidos y desconocidos', () => {
  assert.deepEqual(parseLine('{"t":"result","req":4,"ok":true,"error":null}'), { t: 'result', req: 4, ok: true, error: null });
  assert.equal(parseLine('{"t":"result","req":5,"ok":false,"error":"noSession"}').error, 'noSession');
  assert.equal(parseLine('{"t":"result","req":5,"ok":false,"error":"<script>"}').error, 'failed');
  assert.equal(parseLine('{"t":"result","ok":true}'), null, 'sin req');
});

test('líneas que no son mensajes', () => {
  for (const line of ['', '   ', 'hola', '{roto', '[1,2]', '{"t":"desconocido"}', '{"x":1}', null, 42, `{"t":"log","msg":"${'x'.repeat(200000)}"}`]) {
    assert.equal(parseLine(line), null, String(line).slice(0, 30));
  }
  assert.deepEqual(parseLine('﻿{"t":"log","msg":"poll: algo"}'), { t: 'log', msg: 'poll: algo' }, 'acepta BOM');
});

test('cleanText: control, separadores de línea y largo', () => {
  assert.equal(cleanText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0)}c`), 'a b c');
  assert.equal(cleanText('x'.repeat(400)).length, 300);
  assert.equal(cleanText(5), '');
});

test('encodeCommand: comandos de sesión', () => {
  assert.equal(encodeCommand({ cmd: 'toggle', id: 'Spotify.exe', req: 1 }), '{"cmd":"toggle","req":1,"id":"Spotify.exe"}\n');
  const seek = JSON.parse(encodeCommand({ cmd: 'seek', id: 'Chrome', position: 12345.6, req: 2 }));
  assert.deepEqual(seek, { cmd: 'seek', req: 2, id: 'Chrome', position: 12346 });
  assert.throws(() => encodeCommand({ cmd: 'next' }), TypeError, 'sin id');
  assert.throws(() => encodeCommand({ cmd: 'seek', id: 'x', position: -1 }), TypeError);
  assert.throws(() => encodeCommand({ cmd: 'seek', id: 'x', position: 'a' }), TypeError);
  assert.throws(() => encodeCommand({ cmd: 'borrar', id: 'x' }), TypeError);
  assert.throws(() => encodeCommand({ cmd: 'next', id: 'x', req: 0 }), TypeError);
});

test('encodeCommand: volumen y silencio', () => {
  assert.deepEqual(JSON.parse(encodeCommand({ cmd: 'setVolume', pids: [3, 3, -1, 'x', 7], volume: 1.7 })), { cmd: 'setVolume', pids: [3, 7], volume: 1 });
  assert.deepEqual(JSON.parse(encodeCommand({ cmd: 'setVolume', pids: [3], volume: 0.33333 })), { cmd: 'setVolume', pids: [3], volume: 0.333 });
  assert.deepEqual(JSON.parse(encodeCommand({ cmd: 'setMute', pids: [9], muted: true })), { cmd: 'setMute', pids: [9], muted: true });
  assert.deepEqual(JSON.parse(encodeCommand({ cmd: 'setMute', pids: [9], muted: 'sí' })), { cmd: 'setMute', pids: [9], muted: false });
  assert.throws(() => encodeCommand({ cmd: 'setVolume', pids: [], volume: 0.5 }), TypeError);
  assert.throws(() => encodeCommand({ cmd: 'setVolume', pids: [1], volume: NaN }), TypeError);
});

test('encodeCommand: sin argumentos', () => {
  assert.equal(encodeCommand({ cmd: 'quit' }), '{"cmd":"quit"}\n');
  assert.equal(encodeCommand({ cmd: 'poll', req: 3 }), '{"cmd":"poll","req":3}\n');
});

test('createLineSplitter: líneas partidas entre pedazos y CRLF', () => {
  const split = createLineSplitter();
  assert.deepEqual(split('{"t":"lo'), []);
  assert.deepEqual(split('g","msg":"a"}\r\n{"t":"log",'), ['{"t":"log","msg":"a"}']);
  assert.deepEqual(split('"msg":"b"}\n\n'), ['{"t":"log","msg":"b"}', '']);
  const small = createLineSplitter(10);
  assert.deepEqual(small('x'.repeat(50)), []);
  assert.deepEqual(small('ok\n'), ['ok'], 'descarta lo que no tenía salto y era gigante');
});
