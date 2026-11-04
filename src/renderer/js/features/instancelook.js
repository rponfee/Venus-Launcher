// Fondo, color y música por instancia, y links venus://. Arranca solo con el launcher (lista STARTUP de app.js).
// El aspecto de la instancia seleccionada o que está corriendo se aplica como un cambio pasajero con setInstanceLook
// de appearance.js: al salir de ella vuelve el aspecto global, sin que se haya tocado ningún ajuste.
// Contrato: startup(), openInstanceLook(inst, { onSaved? }) (diálogo), previewLook(look) y endPreview() (mientras
// el diálogo está abierto), activeLookInstance() (de qué instancia es lo que se ve). Diálogo en instancelook/dialog.js,
// links en instancelook/links.js, "¿Qué cambia?" en instancelook/changelog.js y lógica pura en instancelook/logic.js.
import { h, icon, ensureCss } from '../ui.js';
import { store } from '../store.js';
import { t, loadNs } from '../i18n.js';
import { registerSettingsCard } from '../settings-cards.js';
import { setInstanceLook, isLite, onAppearanceChange } from '../appearance.js';
import { lookPatch, pickLookInstance } from './instancelook/logic.js';
import { startLinks } from './instancelook/links.js';
import { modUpdatesPanel } from './instancelook/changelog.js';

let started = false;
let applied = 'null';
let preview; // undefined = sin vista previa
let activeInstance = null;

function apply(look) {
  const patch = lookPatch(look, { lite: isLite() });
  const key = JSON.stringify(patch);
  if (key === applied) return;
  applied = key;
  setInstanceLook(patch);
}

function refresh() {
  activeInstance = pickLookInstance({ instances: store.instances, running: store.running, selectedId: store.settings?.selectedInstance });
  apply(preview !== undefined ? preview : activeInstance?.look);
}

// Vista previa del diálogo: se ve al instante y no se guarda.
export function previewLook(look) {
  preview = look ?? null;
  refresh();
}

export function endPreview() {
  preview = undefined;
  refresh();
}

export function activeLookInstance() {
  return activeInstance;
}

export async function openInstanceLook(inst, opts) {
  const { openLookDialog } = await import('./instancelook/dialog.js');
  return openLookDialog(inst, opts);
}

// Ajustes → Apariencia muestra los ajustes globales: si se está viendo el aspecto de una instancia, se avisa.
function lookNotice() {
  if (!activeInstance) return null;
  const el = h('div', { class: 'notice info it-look-notice' }, icon('info'), h('div', {}, t('instancetools.lookNotice', { name: activeInstance.name })));
  // Ajustes las agrega al final: este aviso tiene que verse antes de tocar nada.
  queueMicrotask(() => el.parentElement?.prepend(el));
  return el;
}

export async function startup() {
  if (started) return;
  started = true;
  ensureCss('features/instancetools');
  await loadNs('instancetools').catch((err) => console.warn('[instancelook] textos', err));
  registerSettingsCard('appearance', lookNotice);
  registerSettingsCard('updates', () => modUpdatesPanel());
  store.on('instances', refresh);
  store.on('running', refresh);
  store.on('settings', refresh);
  onAppearanceChange(refresh);
  refresh();
  startLinks();
}
