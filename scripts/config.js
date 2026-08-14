import {DEFAULT_PLAYBACK_CONFIG, FLAG_KEY, MODULE_ID} from "./constants.js";

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Sanitize values for persistence only.
 *
 * IMPORTANT: this function deliberately does not clamp Start/End against the
 * currently observed Sound duration. Sound duration is runtime metadata and can
 * be transient while Foundry replaces/restarts a native Sound. Persisted user
 * intent must never be rewritten because of transient playback state.
 */
export function sanitizePlaybackConfig(raw = {}) {
  const fullTrack = raw.fullTrack !== false;
  const start = Math.max(0, finiteNumber(raw.start, DEFAULT_PLAYBACK_CONFIG.start));

  let end = raw.end;
  if (end === "" || end === undefined || end === null) end = null;
  else end = Math.max(0, finiteNumber(end, 0));

  return {
    fullTrack,
    start,
    end,
    loop: Boolean(raw.loop),
    fadeIn: Math.max(0, finiteNumber(raw.fadeIn, DEFAULT_PLAYBACK_CONFIG.fadeIn)),
    fadeOut: Math.max(0, finiteNumber(raw.fadeOut, DEFAULT_PLAYBACK_CONFIG.fadeOut))
  };
}

/**
 * Resolve the effective runtime range without mutating the stored configuration.
 */
export function effectiveRange(config, duration = 0) {
  const stored = sanitizePlaybackConfig(config);
  const safeDuration = Math.max(0, finiteNumber(duration, 0));

  if (stored.fullTrack) {
    return {
      valid: safeDuration > 0,
      start: 0,
      end: safeDuration,
      length: safeDuration,
      loop: false,
      fadeIn: Math.min(stored.fadeIn, safeDuration),
      fadeOut: Math.min(stored.fadeOut, Math.max(0, safeDuration - Math.min(stored.fadeIn, safeDuration)))
    };
  }

  const requestedEnd = stored.end ?? safeDuration;
  const valid = safeDuration > 0
    && stored.start >= 0
    && requestedEnd > stored.start
    && stored.start < safeDuration
    && requestedEnd <= safeDuration;

  if (!valid) {
    return {
      valid: false,
      start: stored.start,
      end: requestedEnd,
      length: Math.max(0, requestedEnd - stored.start),
      loop: Boolean(stored.loop),
      fadeIn: stored.fadeIn,
      fadeOut: stored.fadeOut
    };
  }

  const length = requestedEnd - stored.start;
  const fadeIn = Math.min(stored.fadeIn, length);
  const fadeOut = Math.min(stored.fadeOut, Math.max(0, length - fadeIn));

  return {
    valid: true,
    start: stored.start,
    end: requestedEnd,
    length,
    loop: Boolean(stored.loop),
    fadeIn,
    fadeOut
  };
}

export function readPlaybackConfig(playlistSound) {
  const stored = playlistSound?.getFlag?.(MODULE_ID, FLAG_KEY) ?? DEFAULT_PLAYBACK_CONFIG;
  return sanitizePlaybackConfig(stored);
}

export async function writePlaybackConfig(playlistSound, config) {
  const sanitized = sanitizePlaybackConfig(config);
  await playlistSound.setFlag(MODULE_ID, FLAG_KEY, sanitized);
  return sanitized;
}

export async function resetPlaybackConfig(playlistSound) {
  await playlistSound.unsetFlag(MODULE_ID, FLAG_KEY);
  return {...DEFAULT_PLAYBACK_CONFIG};
}
