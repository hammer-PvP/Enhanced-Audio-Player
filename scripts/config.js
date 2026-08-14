import {DEFAULT_PLAYBACK_CONFIG, FLAG_KEY, MODULE_ID} from "./constants.js";

const EPSILON = 0.001;

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function normalizePlaybackConfig(raw = {}, duration = 0) {
  const safeDuration = Math.max(0, finiteNumber(duration, 0));
  const fullTrack = raw.fullTrack !== false;

  let start = clamp(finiteNumber(raw.start, DEFAULT_PLAYBACK_CONFIG.start), 0, safeDuration);
  let endFallback = safeDuration || null;
  let end = raw.end === null || raw.end === undefined || raw.end === ""
    ? endFallback
    : finiteNumber(raw.end, safeDuration);

  if (end !== null) {
    end = clamp(end, 0, safeDuration);
    if (safeDuration > 0 && end <= start) {
      end = Math.min(safeDuration, start + EPSILON);
      if (end <= start) start = Math.max(0, end - EPSILON);
    }
  }

  const effectiveStart = fullTrack ? 0 : start;
  const effectiveEnd = fullTrack ? safeDuration : (end ?? safeDuration);
  const segmentLength = Math.max(0, effectiveEnd - effectiveStart);

  let fadeIn = Math.max(0, finiteNumber(raw.fadeIn, DEFAULT_PLAYBACK_CONFIG.fadeIn));
  let fadeOut = Math.max(0, finiteNumber(raw.fadeOut, DEFAULT_PLAYBACK_CONFIG.fadeOut));

  fadeIn = Math.min(fadeIn, segmentLength);
  fadeOut = Math.min(fadeOut, Math.max(0, segmentLength - fadeIn));

  return {
    fullTrack,
    start,
    end,
    loop: Boolean(raw.loop),
    fadeIn,
    fadeOut
  };
}

export function effectiveRange(config, duration = 0) {
  const normalized = normalizePlaybackConfig(config, duration);
  const safeDuration = Math.max(0, finiteNumber(duration, 0));
  const start = normalized.fullTrack ? 0 : normalized.start;
  const end = normalized.fullTrack ? safeDuration : (normalized.end ?? safeDuration);

  return {
    start,
    end,
    length: Math.max(0, end - start),
    loop: !normalized.fullTrack && normalized.loop,
    fadeIn: normalized.fadeIn,
    fadeOut: normalized.fadeOut
  };
}

export function readPlaybackConfig(playlistSound, duration = 0) {
  const stored = playlistSound?.getFlag?.(MODULE_ID, FLAG_KEY) ?? DEFAULT_PLAYBACK_CONFIG;
  return normalizePlaybackConfig(stored, duration);
}

export async function writePlaybackConfig(playlistSound, config, duration = 0) {
  const normalized = normalizePlaybackConfig(config, duration);
  await playlistSound.setFlag(MODULE_ID, FLAG_KEY, normalized);
  return normalized;
}
