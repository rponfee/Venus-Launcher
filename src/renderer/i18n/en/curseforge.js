// CurseForge texts in the interface (catalog and the Administration test). Use t('curseforge.<key>').
export default {
  offText: 'There is no CurseForge key loaded on the Venus server yet. An administrator sets it up in Administration → Integrations. In the meantime you can keep browsing and installing from Modrinth.',
  signInTitle: 'Sign in to use CurseForge',
  signInText: 'The CurseForge catalog is queried with your Venus account: the key lives on the server and never reaches your PC. Sign in and it loads by itself.',
  signIn: 'Sign in',
  errorTitle: 'CurseForge could not be set up',
  errorText: 'The launcher could not check the state of CurseForge. Check your connection and try again.',
  checkAgain: 'Check again',
  // Search test in Administration → Integrations: one message for each thing that can happen
  testBlocked: 'CurseForge cut off the server request before checking the key. The key may be fine: this is a block at the edge of CurseForge. Try again in a few minutes.',
  testNotConfigured: 'The Venus server has no key loaded. Save the key and test again.',
  testUnavailable: 'The Venus service is not available right now. Try again in a while.',
  testUpstream: 'CurseForge answered with an error of its own, unrelated to the key. Try again in a while.',
};
