// Datos y PC (3.2): copias automáticas de mundos, modo familia, llevar todo a otra PC y sincronizar ajustes. Acá se suman
// sus tarjetas a Ajustes y se escuchan sus avisos; cada función está en features/datatools/. El historial de rendimiento
// es una pestaña de pages/performance.js. Todo el trabajo pesado corre en el proceso principal (modules/worldbackups,
// family, portability y perfhistory) salvo la sincronización, que usa la sesión de Supabase de la interfaz.
import { h, mount, ensureCss } from '../ui.js';
import { loadNs } from '../i18n.js';
import { registerSettingsCard } from '../settings-cards.js';
import { backupsCard, startBackupNotices } from './datatools/backups.js';
import { familyCard, startFamilyNotices } from './datatools/family.js';
import { portabilityCard } from './datatools/portability.js';
import { syncCard, startSettingsSync } from './datatools/settingssync.js';

let started = false;

export function startup() {
  if (started) return;
  started = true;
  ensureCss('features/datatools');
  const ready = loadNs('datatools').catch(() => {});
  // Las tarjetas se registran ya (Ajustes puede abrirse enseguida) y se dibujan cuando están los textos. El ancla va en el
  // contenedor: un enlace directo la encuentra aunque la tarjeta llegue un instante después.
  const slot = (section, anchor, build) =>
    registerSettingsCard(section, (ctx) => {
      const host = h('div', { class: 'dt-slot', dataset: { anchor } });
      ready.then(() => {
        if (ctx.alive()) mount(host, build(ctx));
      });
      return host;
    });
  slot('general', 'family', familyCard);
  slot('cloud', 'settingssync', syncCard);
  slot('data', 'backups', backupsCard);
  slot('data', 'portability', portabilityCard);
  ready.then(() => {
    startBackupNotices();
    startFamilyNotices();
    startSettingsSync();
  });
}
