'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GameLogReader, systemMessage, settingUser, compileTemplate, wantedKey } = require('../gamelog');

// Tablas de prueba con las mismas claves de los archivos de idioma del juego (solo las que hacen falta)
const EN = {
  'death.attack.mob': '%1$s was slain by %2$s',
  'death.attack.mob.item': '%1$s was slain by %2$s using %3$s',
  'death.attack.player': '%1$s was slain by %2$s',
  'death.attack.badRespawnPoint.message': '%1$s was killed by %2$s',
  'death.attack.generic': '%1$s died',
  'death.attack.drown': '%1$s drowned',
  'death.fell.accident.generic': '%1$s fell from a high place',
  'chat.type.advancement.task': '%s has made the advancement %s',
  'chat.type.advancement.challenge': '%s has completed the challenge %s',
  'chat.type.advancement.goal': '%s has reached the goal %s',
  'chat.type.achievement': '%s has just earned the achievement %s',
  'advancements.end.kill_dragon.title': 'Free the End',
  'achievement.theEnd2': 'The End.',
  'achievement.killWither': 'The Beginning.',
  'entity.minecraft.ender_dragon': 'Ender Dragon',
  'entity.minecraft.wither': 'Wither',
  'entity.minecraft.warden': 'Warden',
  'entity.minecraft.elder_guardian': 'Elder Guardian',
};
// Espanol de Espana y de Argentina (el jugador de los registros reales de abajo jugaba en es_es)
const ES = {
  'death.attack.mob': '%1$s fue asesinado por %2$s',
  'chat.type.advancement.task': '%s ha conseguido el progreso %s',
  'chat.type.advancement.challenge': '%s ha completado el desafío %s',
  'chat.type.advancement.goal': '%s ha alcanzado el objetivo %s',
};
const ES_AR = {
  'death.attack.mob': '%1$s fue asesinado/a por %2$s',
  'death.fell.accident.generic': '%1$s se cayó de un lugar muy alto',
  'chat.type.advancement.task': '%s acaba de conseguir el progreso %s',
  'advancements.end.kill_dragon.title': 'La libertad del End',
  'entity.minecraft.ender_dragon': 'Enderdragón',
  'entity.minecraft.elder_guardian': 'Guardián mayor',
};
const reader = (tables = [EN, ES], player = 'Steve') => new GameLogReader({ player, tables });
const read = (line, tables, player) => reader(tables, player).read(line);

test('lineas reales de 26.1 y 26.2 (de los logs de un jugador, con el nombre cambiado)', () => {
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve ha conseguido el progreso [Monster Hunter]'), { reason: 'advancement', title: 'Monster Hunter' });
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve ha completado el desafío [Cúbreme de netherita]'), { reason: 'advancement', title: 'Cúbreme de netherita' });
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve ha alcanzado el objetivo [Faroneitor]'), { reason: 'advancement', title: 'Faroneitor' });
  // Servidor con el equipo o rango delante del nombre
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] DontHurt Steve ha conseguido el progreso [Vístete]'), { reason: 'advancement', title: 'Vístete' });
  // El servidor integrado de Forge lo escribe tambien
  assert.deepEqual(read('[21:40:12] [Server thread/INFO]: Steve ha conseguido el progreso [Cúbreme de diamantes]'), { reason: 'advancement', title: 'Cúbreme de diamantes' });
  // Minijuegos: frases propias del servidor que el juego igual reconoce
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve fue asesinado por qzixg. MUERTE FINAL!'), { reason: 'death' });
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve was killed by coolcos123.'), { reason: 'death' });
  assert.deepEqual(read('[21:40:12] [Render thread/INFO]: [System] [CHAT] Steve fell into the void.'), { reason: 'death' });
});

test('lineas reales que no son eventos del jugador local', () => {
  const none = [
    '[21:40:12] [Render thread/INFO]: [System] [CHAT] coolcos123 was killed by Steve.', // el muerto es otro
    '[21:40:12] [Render thread/INFO]: [System] [CHAT] coolcos123 was killed by Steve. FINAL KILL!',
    '[21:18:58] [Render thread/INFO]: [System] [CHAT] Steve joined (2/4)!',
    '[21:18:51] [Render thread/INFO]: [System] [CHAT] §b[MVP§c+§b] Steve§f §6spooked into the lobby!',
    '[15:38:55] [Render thread/INFO]:   BeforeConstant found STRING constant: value = [{}] [CHAT] {}, stringValue = null', // un mixin hablando de la cadena
    '[15:38:55] [Render thread/INFO]:       BeforeConstant found LdcInsn [CHAT] Steve died',
    '[21:21:07] [Server thread/WARN]: Steve died',
  ];
  for (const line of none) assert.equal(read(line), null, line);
});

test('formatos de otras versiones y cargadores', () => {
  // 1.7 a 1.12: "Client thread" y logros viejos
  assert.deepEqual(read('[18:03:09] [Client thread/INFO]: [CHAT] Steve has just earned the achievement [Getting Wood]'), { reason: 'advancement', title: 'Getting Wood' });
  assert.deepEqual(read('[18:03:09] [Client thread/INFO]: [CHAT] Steve has made the advancement [Stone Age]'), { reason: 'advancement', title: 'Stone Age' });
  // Forge 1.12 (hilo "main" y clase en el medio)
  assert.deepEqual(read('[18:03:09] [main/INFO] [net.minecraft.client.gui.GuiNewChat]: [CHAT] Steve fell from a high place'), { reason: 'death' });
  // 1.13 a 1.18
  assert.deepEqual(read('[18:03:09] [Render thread/INFO]: [CHAT] Steve drowned'), { reason: 'death' });
  // Forge y NeoForge de ahora
  assert.deepEqual(read('[02Nov2026 18:03:09.123] [Render thread/INFO] [net.minecraft.client.gui.components.ChatComponent/]: [System] [CHAT] Steve was slain by Zombie'), { reason: 'death' });
  // Fabric en desarrollo (el registrador entre parentesis)
  assert.deepEqual(read('[18:03:09] [Render thread/INFO] (Minecraft) [CHAT] Steve drowned'), { reason: 'death' });
  // Con "using" y un arma con nombre entre corchetes
  assert.deepEqual(read('[18:03:09] [Render thread/INFO]: [System] [CHAT] Steve was slain by Alex using [Espada]'), { reason: 'death' });
  // Lo que arma LogParser del XML de log4j es igual a la linea comun
  assert.deepEqual(read('[18:03:09] [Render thread/INFO]: [CHAT] Steve died\njava.lang.Exception: nada'), { reason: 'death' });
});

test('solo el jugador local: nombres parecidos, chat que copia el texto y otros jugadores', () => {
  const none = [
    '[1] [Render thread/INFO]: [System] [CHAT] Alex was slain by Zombie',
    '[1] [Render thread/INFO]: [System] [CHAT] Steve2 was slain by Zombie',
    '[1] [Render thread/INFO]: [System] [CHAT] xSteve was slain by Zombie',
    '[1] [Render thread/INFO]: [System] [CHAT] Alex was slain by Steve',
    '[1] [Render thread/INFO]: [System] [CHAT] Alex has made the advancement [Stone Age]',
    '[1] [Render thread/INFO]: [CHAT] <Alex> Steve was slain by Zombie',
    '[1] [Render thread/INFO]: [Not Secure] [CHAT] <Alex> Steve has made the advancement [Stone Age]',
    '[1] [Render thread/INFO]: [Not Secure] [CHAT] Steve was slain by Zombie',
    '[1] [Render thread/INFO]: [Modified] [CHAT] Steve was slain by Zombie',
    '[1] [Render thread/INFO]: [System] [CHAT] [VIP] Alex: Steve was slain by Zombie',
    '[1] [Server thread/INFO]: <Alex> Steve was slain by Zombie',
    '[1] [Server thread/INFO]: Alex fell from a high place',
  ];
  for (const line of none) assert.equal(read(line), null, line);
  // Mayusculas y rangos
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] steve drowned'), { reason: 'death' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] §c[VIP] §fSteve§r drowned'), { reason: 'death' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] ~Steve drowned'), { reason: 'death' });
  // Sin saber quien es el jugador, nada
  assert.equal(new GameLogReader({ tables: [EN] }).read('[1] [Render thread/INFO]: [CHAT] Steve died'), null);
});

test('la cuenta del log manda sobre la de la partida (y solo la primera vez)', () => {
  assert.equal(settingUser('[15:38:55] [Render thread/INFO]: Setting user: Steve_1'), 'Steve_1');
  assert.equal(settingUser('[15:38:55] [main/INFO]: Setting user: Alex'), 'Alex');
  assert.equal(settingUser('[1] [Render thread/INFO]: [CHAT] Setting user: Alex'), null);
  assert.equal(settingUser('[1] [Server thread/INFO]: Setting user: Alex'), null);
  assert.equal(settingUser('Setting user: Alex'), null);
  const r = new GameLogReader({ player: 'Otro', tables: [EN] });
  assert.equal(r.read('[1] [Render thread/INFO]: Setting user: Steve'), null);
  assert.deepEqual(r.read('[1] [Render thread/INFO]: [CHAT] Steve died'), { reason: 'death' });
  assert.equal(r.read('[1] [Render thread/INFO]: [CHAT] Otro died'), null);
  r.read('[1] [Render thread/INFO]: Setting user: Alex');
  assert.deepEqual(r.read('[1] [Render thread/INFO]: [CHAT] Steve died'), { reason: 'death' }, 'no cambia despues');
  // Sin cuenta de la partida (partida sin chequeos previos) alcanza con el log
  const s = new GameLogReader({ tables: [EN] });
  s.read('[1] [Render thread/INFO]: Setting user: Steve');
  assert.deepEqual(s.read('[1] [Render thread/INFO]: [CHAT] Steve died'), { reason: 'death' });
});

test('recargar recursos avisa (puede haber cambiado el idioma)', () => {
  assert.deepEqual(read('[21:17:36] [Render thread/INFO]: Reloading ResourceManager: vanilla, file/venus-launcher'), { setup: 'reload' });
});

test('jefes: logro que solo se consigue matandolo y muerte anunciada con el formato del juego', () => {
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve has made the advancement [Free the End]'), { reason: 'boss', boss: 'ender_dragon', title: 'Free the End' });
  assert.deepEqual(read('[1] [Client thread/INFO]: [CHAT] Steve has just earned the achievement [The End.]'), { reason: 'boss', boss: 'ender_dragon', title: 'The End.' });
  assert.deepEqual(read('[1] [Client thread/INFO]: [CHAT] Steve has just earned the achievement [The Beginning.]'), { reason: 'boss', boss: 'wither', title: 'The Beginning.' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [CHAT] Wither was slain by Steve'), { reason: 'boss', boss: 'wither' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [CHAT] The Ender Dragon was slain by Steve using [Espada]'), { reason: 'boss', boss: 'ender_dragon' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [CHAT] Warden was slain by Steve'), { reason: 'boss', boss: 'warden' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [CHAT] Elder Guardian was slain by Steve'), { reason: 'boss', boss: 'elder_guardian' });
  // Que un jefe te mate es una muerte; que lo mate otro, nada; y un mob comun tampoco es un jefe
  assert.deepEqual(read('[1] [Render thread/INFO]: [CHAT] Steve was slain by Wither'), { reason: 'death' });
  assert.equal(read('[1] [Render thread/INFO]: [CHAT] Wither was slain by Alex'), null);
  assert.equal(read('[1] [Render thread/INFO]: [CHAT] Zombie was slain by Steve'), null);
  assert.equal(read('[1] [Render thread/INFO]: [CHAT] Alex has made the advancement [Free the End]'), null);
});

test('otros idiomas: las plantillas del juego valen sin frases fijas', () => {
  const es = [EN, ES_AR];
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve fue asesinado/a por Zombi', es), { reason: 'death' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve se cayó de un lugar muy alto', es), { reason: 'death' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve acaba de conseguir el progreso [Edad de piedra]', es), { reason: 'advancement', title: 'Edad de piedra' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve acaba de conseguir el progreso [La libertad del End]', es), { reason: 'boss', boss: 'ender_dragon', title: 'La libertad del End' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Guardián mayor fue asesinado/a por Steve', es), { reason: 'boss', boss: 'elder_guardian' });
  assert.equal(read('[1] [Render thread/INFO]: [System] [CHAT] Alex fue asesinado/a por Steve', es), null);
  // Sin espacios y con el nombre pegado al texto
  const ja = { 'death.attack.mob': '%1$sは%2$sに殺害された', 'chat.type.advancement.task': '%sが進捗%sを達成しました' };
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steveはゾンビに殺害された', [EN, ja]), { reason: 'death' });
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steveが進捗[石器時代]を達成しました', [EN, ja]), { reason: 'advancement', title: '石器時代' });
  assert.equal(read('[1] [Render thread/INFO]: [System] [CHAT] Alexはゾンビに殺害された', [EN, ja]), null);
  const ko = { 'death.attack.generic': '%1$s이(가) 죽었습니다' };
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve이(가) 죽었습니다', [EN, ko]), { reason: 'death' });
  const de = { 'chat.type.advancement.task': '%s hat den Fortschritt %s erzielt' };
  assert.deepEqual(read('[1] [Render thread/INFO]: [System] [CHAT] Steve hat den Fortschritt [Steinzeit] erzielt', [EN, de]), { reason: 'advancement', title: 'Steinzeit' });
  // Un mensaje en un idioma cuya tabla no se cargo no se detecta (esta documentado)
  assert.equal(read('[1] [Render thread/INFO]: [System] [CHAT] Steve fue asesinado/a por Zombi', [EN]), null);
});

test('plantillas: argumentos numerados, %% y plantillas que no sirven', () => {
  const name = 'Steve';
  assert.ok(compileTemplate('%1$s was slain by %2$s', { 1: name }).test('Steve was slain by Zombie'));
  assert.ok(compileTemplate('%2$s killed %1$s', { 1: name }).test('Zombie killed Steve'));
  assert.ok(compileTemplate('%s died at 100%%', { 1: name }).test('Steve died at 100%'));
  assert.equal(compileTemplate('%s', { 1: name }), null, 'sin texto propio coincidiria con cualquier cosa');
  assert.equal(compileTemplate('Intentional Game Design', { 1: name }), null, 'no menciona al jugador');
  assert.equal(compileTemplate('', { 1: name }), null);
  assert.ok(compileTemplate(' %1$s fell off  ', { 1: name }).test('Steve fell off'), 'traducciones con espacios de mas');
  assert.equal(compileTemplate(null, { 1: name }), null);
  assert.ok(wantedKey('death.attack.mob'));
  assert.ok(wantedKey('death.fell.accident.generic'));
  assert.ok(wantedKey('chat.type.advancement.task'));
  assert.ok(!wantedKey('death.screen.title'));
  assert.ok(!wantedKey('death.attack.message_too_long'));
  assert.ok(!wantedKey('block.minecraft.stone'));
  // Un nombre con simbolos raros (cuentas sin conexion) no rompe la expresion
  const r = new GameLogReader({ player: 'a(b)+[c]', tables: [EN] });
  assert.deepEqual(r.read('[1] [Render thread/INFO]: [CHAT] a(b)+[c] died'), { reason: 'death' });
  assert.equal(r.read('x'.repeat(5000)), null);
  assert.equal(r.read(null), null);
});
