// Game care (features/playcare): new version notice, break reminder, session recap and scheduled downloads.
export default {
  // New version notice (features/playcare/mcnews.js)
  newVersionTitle: 'New Minecraft version: {id}',
  newVersionRelease: '{id} is out. Create an instance?',
  newVersionSnapshot: 'There is a new snapshot: {id}.',
  newVersionCreate: 'Create instance',
  newVersionSeen: 'Got it',

  // Breaks (features/playcare/breaks.js)
  breakTitle: 'Time for a break',
  breakBody_one: 'You have been playing for {count} minute straight. Stretch a bit and drink some water.',
  breakBody_other: 'You have been playing for {count} minutes straight. Stretch a bit and drink some water.',
  limitTitle: 'You reached your limit for today',
  limitBody: 'You played {minutes} minutes today and your limit is {limit}. Venus never closes the game: it is your call.',

  // Session recap (features/playcare/recap.js)
  recapTitle: 'Session recap',
  recapDuration: 'You played {time}',
  recapInstance: 'Instance',
  recapCaptures: 'Screenshots',
  recapClips: 'Clips',
  recapAchievements: 'Achievements unlocked',
  recapMissions: 'Missions completed',
  recapNone: 'None this session',
  recapStats: 'View statistics',
  recapClose: 'Close',

  // Scheduled downloads (features/playcare/schedule.js)
  schedTitle: 'Scheduled downloads',
  schedSub: 'Pick a time window: outside it downloads stay paused and inside it they resume on their own. Handy to keep the connection free while you play or to make the most of the night.',
  schedEnable: 'Enable the window',
  schedFrom: 'From',
  schedTo: 'To',
  schedCrosses: 'The window crosses midnight.',
  schedStatusOff: 'Off: downloads run at any time.',
  schedStatusIn: 'Inside the window: downloads run now, until {to}.',
  schedStatusOut: 'Outside the window: downloads wait until {from}.',
  schedStatusOverride: 'Downloading now because you asked, until {until}; then the window applies again.',
  schedStatusManualPause: 'Downloads are paused because you paused them yourself in Downloads.',
  schedNow: 'Download now',
  schedNowHint: 'Lifts the pause for 2 hours.',
  schedReset: 'Back to the window',
  schedNoticeTitle: 'Downloads waiting',
  schedNoticeText: 'Because of the scheduled downloads window, downloads wait until {from}.',
  schedSaveError: 'Could not save the window',
  schedUnavailable: 'Scheduled downloads are not available.',
};
