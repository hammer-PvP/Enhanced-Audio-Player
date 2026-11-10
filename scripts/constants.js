export const MODULE_ID = "enhanced-audio-player";
export const FLAG_KEY = "playback";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const DEFAULT_PLAYBACK_CONFIG = Object.freeze({
  schemaVersion: 2,
  start: 0,
  repeat: false,
  introEnabled: false,
  introStart: 0,
  introEnd: null,
  loopEnabled: false,
  loopStart: 0,
  loopEnd: null,
  fadeIn: 0,
  fadeOut: 0
});

export const SOCKET_TYPES = Object.freeze({
  PLAY: "play",
  PAUSE: "pause",
  SEEK: "seek",
  RECONFIGURE: "reconfigure",
  STOP_LOCAL: "stopLocal"
});
