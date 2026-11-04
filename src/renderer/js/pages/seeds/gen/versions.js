// Versiones que calcula el visor: una fila por cada MC_* de 1.18 en adelante de biomes.h de cubiomes, cada una con la
// ultima revision de esa rama y su tabla de biomas. No se ofrece nada anterior a 1.18 (otro generador, sin portar).
export const MC_1_18 = 1;
export const MC_1_19_2 = 2;
export const MC_1_19_4 = 3;
export const MC_1_20 = 4;
export const MC_1_21_1 = 5;
export const MC_1_21_3 = 6;
export const MC_1_21_WD = 7;

export const VERSIONS = [
  { key: '1.21.4', mc: MC_1_21_WD, table: 'btree21wd', label: '1.21.4+', install: '1.21.4' },
  { key: '1.21.3', mc: MC_1_21_3, table: 'btree20', label: '1.21.2 – 1.21.3', install: '1.21.3' },
  { key: '1.21.1', mc: MC_1_21_1, table: 'btree20', label: '1.21 – 1.21.1', install: '1.21.1' },
  { key: '1.20', mc: MC_1_20, table: 'btree20', label: '1.20 – 1.20.6', install: '1.20.6' },
  { key: '1.19.4', mc: MC_1_19_4, table: 'btree19', label: '1.19.3 – 1.19.4', install: '1.19.4' },
  { key: '1.19.2', mc: MC_1_19_2, table: 'btree192', label: '1.19 – 1.19.2', install: '1.19.2' },
  { key: '1.18', mc: MC_1_18, table: 'btree18', label: '1.18 – 1.18.2', install: '1.18.2' },
];

export const versionByKey = (key) => VERSIONS.find((v) => v.key === key) || null;

// De una version del juego ("1.20.1") a la fila que la calcula; null si es anterior a 1.18 o no se entiende.
// Las versiones sin forma 1.x (las de 2026 en adelante, snapshots) caen en la mas nueva: cubiomes no las distingue.
export function versionForGame(id) {
  const m = String(id || '').match(/^1\.(\d+)(?:\.(\d+))?$/);
  if (!m) return /^\d{2}\.\d/.test(String(id || '')) ? VERSIONS[0] : null;
  const major = Number(m[1]);
  const patch = Number(m[2] || 0);
  if (major < 18) return null;
  if (major === 18) return versionByKey('1.18');
  if (major === 19) return versionByKey(patch <= 2 ? '1.19.2' : '1.19.4');
  if (major === 20) return versionByKey('1.20');
  if (major === 21 && patch <= 1) return versionByKey('1.21.1');
  if (major === 21 && patch <= 3) return versionByKey('1.21.3');
  return VERSIONS[0];
}

