'use strict';
// Main process texts for the Music module (nowplaying): errors and overlay alerts.
module.exports = {
  err_platform: 'Music controls are only available on Windows.',
  err_unsupported: "This version of Windows doesn't have the media controls needed (Windows 10 version 1809 or later).",
  err_unavailable: "Windows media controls aren't responding. Try again in a few seconds.",
  err_noSession: 'No media player is open.',
  err_rejected: "The player didn't accept that action.",
  err_noSeek: "This player doesn't allow skipping forward or back.",
  err_noAudio: "Couldn't find this app's volume in the Windows mixer. It shows up once it starts playing.",
  err_noSpotify: "Spotify isn't installed on this PC.",
  err_badAction: "That action isn't valid.",
  err_timeout: 'The player took too long to respond.',
  err_failed: "Couldn't control the music.",
  alertVolume: 'Music volume: {value}%',
  alertMuted: 'Music muted',
};
