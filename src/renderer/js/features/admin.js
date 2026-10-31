// Panel de administración: lo agrega al menú SOLO si la cuenta de Venus con sesión es admin (email de
// app_admin_emails, confirmado; lo responde la RPC is_admin por el canal admin:me). Para el resto de los usuarios
// no hace nada. Vuelve a revisar cuando cambia la sesión (iniciar o cerrar sesión, otra cuenta).
//   startup()   lo llama app.js al abrir el launcher (se puede llamar más de una vez)
// El servidor verifica al admin en cada acción: esto solo decide si se ve el menú. Guía: docs/admin.md.
import { api } from '../store.js';
import { cloud } from '../cloud.js';
import { t, loadNs } from '../i18n.js';
import { registerPage, unregisterPage } from '../app.js';

let started = false;
let registered = false;
let lastUser;
let checkSeq = 0;

async function check(force = false) {
  const my = ++checkSeq;
  let me;
  try {
    me = await api.invoke('admin:me', { force });
  } catch {
    me = null;
  }
  if (my !== checkSeq) return; // llegó otra revisión más nueva (cambió la sesión)
  if (me && me.isAdmin === true) {
    if (registered) return;
    await loadNs('admin');
    if (my !== checkSeq) return;
    registerPage('admin', () => import('../pages/admin.js'), { label: () => t('admin.navLabel'), icon: 'shieldCheck' });
    registered = true;
  } else if (registered && me && me.reason !== 'network' && me.reason !== 'error') {
    // Solo con una respuesta clara: un error de red no le saca el menú a un admin.
    unregisterPage('admin');
    registered = false;
  }
}

export async function startup() {
  if (started) return check(false);
  started = true;
  await cloud.ready();
  lastUser = cloud.user?.id || null;
  cloud.on('auth', (session) => {
    const id = session?.user?.id || null;
    if (id === lastUser) return;
    lastUser = id;
    check(true);
  });
  await check(false);
}
