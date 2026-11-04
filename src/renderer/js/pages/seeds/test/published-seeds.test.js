// Semillas publicadas con coordenadas: lo mas cerca del juego que se puede llegar sin abrirlo (no se levanta un servidor
// para no aceptar la EULA de Mojang en nombre del dueno). Lista de https://www.minecraft-guides.com/seeds/1-21/mansion/
// consultada el 2026-11-03 (el sitio dice que comprobo cada semilla en el juego; no pudimos confirmarlo). Coordenadas tal
// como las publica, en bloques; las fortalezas (stronghold) van en la esquina del chunk y el port da la escalera, a (+4, +4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SeedWorld, loadTree } from '../gen/world.js';
import { versionByKey } from '../gen/versions.js';
import { STRUCTURES } from '../gen/structures.js';

const LIST = [
  ['1605713702489912095', [['mansion', 96, 144], ['trial_chambers', 80, -240], ['village', 96, -368], ['village', 224, -752], ['ancient_city', 528, -656], ['village', -192, 848], ['stronghold', -1680, 224]]],
  ['3091511126463952058', [['mansion', 416, 416], ['trial_chambers', 160, 256], ['monument', 48, 304], ['village', -320, 96], ['village', 1184, 816], ['ancient_city', 1248, 1360], ['stronghold', 1456, -816]]],
  ['-355128122639172906', [['mansion', 80, 304], ['trail_ruins', 80, 240], ['trial_chambers', 288, 160], ['stronghold', 2272, -272]]],
  ['4060427127518573501', [['trial_chambers', 80, 240], ['monument', 48, 272], ['mansion', 576, 144], ['village', 880, 656], ['stronghold', 848, 1840]]],
  ['8902169093031739612', [['ancient_city', 128, 176], ['trail_ruins', 256, 112], ['village', -352, 112], ['mansion', 304, 272], ['trial_chambers', -288, 336], ['stronghold', 896, -1280]]],
  ['-3473886483654133555', [['trial_chambers', 336, 0], ['village', 64, -384], ['mansion', 400, 128], ['village', -496, 16], ['outpost', 560, -224], ['swamp_hut', -768, 80], ['village', 256, -784], ['stronghold', 144, -2112]]],
  ['-9040134192719551933', [['trial_chambers', 256, 96], ['mansion', 336, 144], ['trail_ruins', 32, -544], ['monument', -848, 208], ['stronghold', 848, 1728]]],
  ['-1246939648888992098', [['jungle_temple', 80, -144], ['village', 80, 192], ['trial_chambers', 144, 160], ['trail_ruins', -272, -304], ['mansion', 272, -336], ['village', -368, 400], ['village', 240, 656], ['ancient_city', -752, 64]]],
  ['8920078797906777021', [['trial_chambers', -368, 272], ['mansion', -688, 512], ['monument', -192, -272], ['stronghold', -704, 1632]]],
  ['2965478343720343130', [['village', 560, -208], ['mansion', 480, -480], ['monument', -256, -176], ['trail_ruins', 640, -240], ['trial_chambers', 256, 320], ['village', -240, -432], ['ancient_city', 512, -672]]],
];

// Esta ciudad antigua aparece en la lista, pero la validacion de biomas de cubiomes (y por lo tanto la nuestra) la descarta:
// la posicion coincide, y en el punto que se revisa el Abismo empieza una celda mas abajo. La interfaz la muestra como dudosa.
const KNOWN_MISS = '2965478343720343130|ancient_city|512|-672';

test('las coordenadas publicadas coinciden con las del port', async () => {
  const tree = await loadTree(versionByKey('1.21.1').table);
  let checked = 0;
  const misses = [];
  for (const [seed, items] of LIST) {
    const w = new SeedWorld({ seed: BigInt(seed), version: '1.21.1', dim: 0, tree });
    // Las de la lista estan en el primer anillo: no hace falta calcular las 128
    const it = w.finder.strongholds();
    const strong = items.some(([type]) => type === 'stronghold') ? [it.next().value, it.next().value, it.next().value] : [];
    for (const [type, x, z] of items) {
      checked++;
      if (type === 'stronghold') {
        assert.ok(strong.some((p) => p.x === x + 4 && p.z === z + 4), `${seed} fortaleza ${x},${z}`);
        continue;
      }
      const size = STRUCTURES[type].size * 16;
      const rx = Math.floor(x / size);
      const rz = Math.floor(z / size);
      assert.equal(w.finder.position(type, rx, rz), true, `${seed} ${type} sin intento`);
      assert.deepEqual([w.finder.x, w.finder.z], [x, z], `${seed} ${type}`);
      const found = w.finder.evaluate(type, rx, rz);
      assert.ok(found, `${seed} ${type} descartada del todo`);
      if (found.doubt) misses.push(`${seed}|${type}|${x}|${z}`);
    }
  }
  assert.equal(checked, 61);
  assert.deepEqual(misses, [KNOWN_MISS]);
});
