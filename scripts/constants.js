export const MODULE_ID = "enhanced-audio-player";
export const FLAG_KEY = "playback";
export const SOCKET_CHANNEL = `module.${MODULE_ID}`;

export const DEFAULT_PLAYBACK_CONFIG = Object.freeze({
  fullTrack: true,
  start: 0,
  end: null,
  loop: false,
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
