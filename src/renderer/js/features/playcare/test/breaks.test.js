// Recordatorio de descansos y tope de horas por dia (sin DOM, reloj a mano).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBreaks, createBreakState, tick, todayMinutes, continuousMinutes, todayPatch, dayKey, LIMIT_REPEAT_MS, MAX_GAP_MS } from '../breaks-logic.js';

const MIN = 60000;

// Juega `minutes` minutos en ticks de 30 s y junta los avisos.
function play(state, cfg, from, minutes, day, playing = true) {
  const events = [];
  for (let t = from; t <= from + minutes * MIN; t += 30000) events.push(...tick(state, cfg, { now: t, playing, day }));
  return events;
}

test('ajustes por defecto y rangos', () => {
  assert.deepEqual(normalizeBreaks(undefined), { enabled: false, everyMin: 60, dailyLimitMin: 0 });
  assert.deepEqual(normalizeBreaks({ enabled: true, everyMin: 1, dailyLimitMin: -4 }), { enabled: true, everyMin: 5, dailyLimitMin: 0 });
  assert.deepEqual(normalizeBreaks({ enabled: 'si', everyMin: 'x', dailyLimitMin: 90000 }), { enabled: false, everyMin: 60, dailyLimitMin: 1440 });
  assert.equal(dayKey(new Date(2026, 10, 3, 23, 59)), '2026-11-03');
});

test('aviso de descanso cada N minutos seguidos, y se corta al cerrar el juego', () => {
  const cfg = normalizeBreaks({ enabled: true, everyMin: 60 });
  const day = '2026-11-03';
  const st = createBreakState(null, day);
  const t0 = 1_000_000;
  assert.deepEqual(play(st, cfg, t0, 59, day), []);
  const first = play(st, cfg, t0 + 59.5 * MIN, 1, day);
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'break');
  assert.equal(first[0].minutes, 60);
  // Entre los 60 y los 120 no vuelve a avisar; a los 120, si.
  assert.deepEqual(play(st, cfg, t0 + 61 * MIN, 58, day), []);
  const second = play(st, cfg, t0 + 119.5 * MIN, 1, day);
  assert.equal(second.length, 1);
  assert.equal(second[0].minutes, 120);
  assert.equal(continuousMinutes(st), 120);
  assert.equal(todayMinutes(st), 120);
  // Cierra el juego: el rato seguido vuelve a cero, el dia se mantiene.
  tick(st, cfg, { now: t0 + 121 * MIN, playing: false, day });
  assert.equal(continuousMinutes(st), 0);
  assert.equal(todayMinutes(st), 120);
  // Vuelve a abrirlo: cuenta de nuevo desde cero (sin aviso hasta los 60 seguidos).
  assert.deepEqual(play(st, cfg, t0 + 130 * MIN, 59, day), []);
  assert.equal(play(st, cfg, t0 + 189.5 * MIN, 1, day).length, 1);
});

test('tope diario: avisa al llegar, repite cada 10 minutos y se reinicia al cambiar el dia', () => {
  const cfg = normalizeBreaks({ enabled: true, everyMin: 600, dailyLimitMin: 120 });
  const day = '2026-11-03';
  const st = createBreakState({ day, minutes: 100 }, day); // ya jugo 100 minutos hoy (settings.play.today)
  assert.equal(todayMinutes(st), 100);
  const t0 = 5_000_000;
  assert.deepEqual(play(st, cfg, t0, 19, day), []);
  const hit = play(st, cfg, t0 + 19.5 * MIN, 1, day);
  assert.equal(hit.length, 1);
  assert.deepEqual([hit[0].type, hit[0].minutes, hit[0].limit], ['limit', 120, 120]);
  // Sigue jugando: el aviso se repite recien a los 10 minutos.
  assert.deepEqual(play(st, cfg, t0 + 21 * MIN, 8, day), []);
  const again = play(st, cfg, t0 + 29.5 * MIN, LIMIT_REPEAT_MS / MIN, day);
  assert.equal(again.length, 1);
  assert.equal(again[0].type, 'limit');
  // Cambia el dia (sigue jugando): el contador del dia vuelve a cero y no hay aviso hasta las 2 horas de nuevo.
  const nextDay = '2026-11-04';
  const after = play(st, cfg, t0 + 41 * MIN, 30, nextDay);
  assert.deepEqual(after, []);
  assert.equal(st.day, nextDay);
  assert.ok(todayMinutes(st) <= 31);
  assert.deepEqual(todayPatch(st), { day: nextDay, minutes: todayMinutes(st) });
});

test('lo guardado de otro dia no cuenta, y un salto largo del reloj (la PC durmio) no suma', () => {
  const cfg = normalizeBreaks({ enabled: true, everyMin: 60 });
  const st = createBreakState({ day: '2026-11-02', minutes: 300 }, '2026-11-03');
  assert.equal(todayMinutes(st), 0);
  play(st, cfg, 0, 30, '2026-11-03');
  assert.equal(todayMinutes(st), 30);
  assert.equal(continuousMinutes(st), 30);
  tick(st, cfg, { now: 30 * MIN + MAX_GAP_MS + 1000, playing: true, day: '2026-11-03' });
  assert.equal(todayMinutes(st), 30);
  assert.equal(continuousMinutes(st), 0);
  // Despues del salto vuelve a contar normal.
  play(st, cfg, 30 * MIN + MAX_GAP_MS + 1000, 10, '2026-11-03');
  assert.equal(todayMinutes(st), 40);
  assert.equal(continuousMinutes(st), 10);
});

test('apagado: cuenta el tiempo pero no avisa', () => {
  const cfg = normalizeBreaks({ enabled: false, everyMin: 30, dailyLimitMin: 30 });
  const st = createBreakState(null, '2026-11-03');
  assert.deepEqual(play(st, cfg, 0, 90, '2026-11-03'), []);
  assert.equal(todayMinutes(st), 90);
});
