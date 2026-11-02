// Venus Points (modules/rewards.js): errors when verifying the Minecraft account for invites
module.exports = {
  err_noAccount: 'Add a Microsoft account in Minecraft accounts to verify it.',
  err_offlineAccount: 'The selected account ({name}) is an offline account. Pick a Microsoft account in Minecraft accounts to verify it.',
  err_accountSession: 'Your Microsoft account session expired. Sign in again in Minecraft accounts and try again.',
  err_noCloud: 'Invites are not available in this version of the launcher.',
  err_noSession: 'Sign in with your Venus account to verify your Minecraft account.',
  err_network: 'Could not connect. Check your connection and try again.',
  err_unavailable: 'Verification is not available right now. Try again later.',
  err_multiplayerDisabled: 'Your Microsoft account is not allowed to play multiplayer (Xbox privacy settings or a child account), so it cannot be verified.',
  err_mojangSession: 'Mojang rejected the session of {name}. Sign in again in Minecraft accounts and try again.',
  err_mojang: 'Mojang servers did not respond. Try again in a while.',
  err_notVerified: 'Mojang did not confirm that the account is yours. Try again in a while.',
  err_tooManyAccounts: 'This Venus account has already verified too many Minecraft accounts.',
  err_banned: 'Your Venus account is suspended and cannot use invites.',
  err_rateLimited: 'Too many attempts in a row. Wait a minute and try again.',
  err_server: 'Could not verify your Minecraft account. Try again in a while.',
};
