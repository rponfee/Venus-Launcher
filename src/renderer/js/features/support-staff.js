// Support has its own permission. It never registers or unlocks the administration panel.
import { cloud } from '../cloud.js';
import { loadNs } from '../i18n.js';
import { registerPage, setNavHidden } from '../app.js';
import { S, supportCall } from './support.js';

const ROUTE = 'support-staff';
let started = false;
let registered = false;
let sequence = 0;
const accessListeners = new Set();
export function onStaffAccess(fn) { accessListeners.add(fn); return () => accessListeners.delete(fn); }

export async function refreshStaffAccess() {
  const request = ++sequence;
  const owner = cloud.user?.id || null;
  // Hide immediately while the server checks the current identity.
  setNavHidden(ROUTE, true);
  if (!owner) return false;
  try {
    const state = await supportCall('staffState');
    if (request !== sequence || cloud.user?.id !== owner) return false;
    if (state?.isStaff !== true) {
      for (const fn of [...accessListeners]) fn({ owner, isStaff: false });
      return false;
    }
    await loadNs('support');
    if (request !== sequence || cloud.user?.id !== owner) return false;
    if (!registered) {
      registerPage(ROUTE, () => import('../pages/support-staff.js'), { label: () => S('staffNav'), icon: 'message' });
      registered = true;
    }
    setNavHidden(ROUTE, false);
    return true;
  } catch {
    return false;
  }
}

export async function startup() {
  if (started) return refreshStaffAccess();
  started = true;
  await cloud.ready();
  cloud.on('auth', refreshStaffAccess);
  window.addEventListener('focus', refreshStaffAccess);
  return refreshStaffAccess();
}
