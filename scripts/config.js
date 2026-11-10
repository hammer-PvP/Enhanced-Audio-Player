import {DEFAULT_PLAYBACK_CONFIG, FLAG_KEY, MODULE_ID} from "./constants.js";

export function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function safeTime(value, fallback = 0) {
  if (value === "" || value === undefined || value === null) return fallback;
  return Math.max(0, finiteNumber(value, fallback ?? 0));
}

/**
 * v2 stores independent Intro and Loop segments. Convert v0.1.3 flags *in
 * memory* to their exact equivalent; no destructive background migration.
 * The next explicit OK persists v2 on that PlaylistSound occurrence only.
 */
export function sanitizePlaybackConfig(raw = {}) {
  if (!raw || typeof raw !== "object") raw = {};
  if (raw.schemaVersion !== 2 && !Object.hasOwn(raw, "introEnabled") && !Object.hasOwn(raw, "loopEnabled")) {
    const fullTrack = raw.fullTrack !== false;
    const loop = Boolean(raw.loop);
    const start = safeTime(raw.start, 0);
    const end = raw.end === "" || raw.end == null ? null : safeTime(raw.end);
    // Legacy intro+loop always played 0→End, then Start→End.
    // Legacy range once is represented by an Intro-only segment.
    return {
      schemaVersion: 2,
      start: 0,
      repeat: false,
      introEnabled: (!fullTrack && !loop) || (fullTrack && loop && start > 0),
      introStart: fullTrack && loop ? 0 : start,
      introEnd: fullTrack && loop ? start : end,
      loopEnabled: loop,
      loopStart: start,
      loopEnd: end,
      fadeIn: safeTime(raw.fadeIn, 0),
      fadeOut: safeTime(raw.fadeOut, 0)
    };
  }

  return {
    schemaVersion: 2,
    start: safeTime(raw.start, 0),
    repeat: Boolean(raw.repeat),
    introEnabled: Boolean(raw.introEnabled),
    introStart: safeTime(raw.introStart, 0),
    introEnd: raw.introEnd === "" || raw.introEnd == null ? null : safeTime(raw.introEnd),
    loopEnabled: Boolean(raw.loopEnabled),
    loopStart: safeTime(raw.loopStart, 0),
    loopEnd: raw.loopEnd === "" || raw.loopEnd == null ? null : safeTime(raw.loopEnd),
    fadeIn: safeTime(raw.fadeIn, 0),
    fadeOut: safeTime(raw.fadeOut, 0)
  };
}

/** Resolve playback segments WITHOUT ever mutating stored timings or media metadata. */
export function effectiveRange(config, duration = 0) {
  const c = sanitizePlaybackConfig(config);
  const d = Math.max(0, finiteNumber(duration, 0));
  const introEnabled = c.introEnabled;
  const loopEnabled = c.loopEnabled;
  const repeat = !introEnabled && !loopEnabled && c.repeat;
  const introStart = c.introStart;
  // Foundry's source duration can have sub-millisecond precision while the
  // editor displays MM:SS.mmm. Accept an End matching the DISPLAYED final
  // millisecond and use the exact source duration only for playback.
  // The user's saved flag remains unchanged (e.g. 28.078, not 28.0779).
  const sourceEnd = value => {
    if (value == null) return d;
    return Math.round(value * 1000) === Math.round(d * 1000) ? d : value;
  };
  const introEnd = sourceEnd(c.introEnd);
  const loopStart = loopEnabled ? c.loopStart : (repeat ? c.start : 0);
  const loopEnd = loopEnabled ? sourceEnd(c.loopEnd) : d;
  const start = introEnabled ? introStart : (loopEnabled ? loopStart : c.start);
  const end = introEnabled ? introEnd : (loopEnabled ? loopEnd : d);
  const validSegment = (a, b) => a >= 0 && a < d && b > a && b <= d;
  const valid = d > 0
    && (introEnabled ? validSegment(introStart, introEnd) : true)
    && (loopEnabled ? validSegment(loopStart, loopEnd) : true)
    && ((!introEnabled && !loopEnabled) ? validSegment(c.start, d) : true);
  const seekMin = introEnabled && loopEnabled ? Math.min(introStart, loopStart) : start;
  const seekMax = introEnabled && loopEnabled ? Math.max(introEnd, loopEnd) : end;
  const firstLength = Math.max(0, end - start);
  const fadeIn = Math.min(c.fadeIn, firstLength);
  const looping = loopEnabled || repeat;
  return {
    valid, start, end, playbackStart: start,
    rangeStart: start, rangeEnd: end, length: firstLength,
    introEnabled, introStart, introEnd,
    // Contiguous intro→loop should run continuously until Loop End before
    // the first jump, avoiding an unnecessary seam at the Intro boundary.
    firstPassEnd: introEnabled && loopEnabled && Math.abs(introEnd - loopStart) < 0.001 ? loopEnd : end,
    loopEnabled, loopStart, loopEnd,
    repeat, loop: looping, introLoop: introEnabled && loopEnabled,
    firstPhase: introEnabled ? "intro" : (looping ? "loop" : "single"),
    seekMin, seekMax,
    fadeIn,
    fadeOut: looping ? 0 : Math.min(c.fadeOut, Math.max(0, firstLength - fadeIn))
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

/** Prefer immutable source metadata over transient playback-duration getters. */
export function sourceDuration(nativeSound) {
  const source = Number(nativeSound?.buffer?.duration ?? nativeSound?.element?.duration);
  if (Number.isFinite(source) && source > 0) return source;
  const reported = Number(nativeSound?.duration);
  return Number.isFinite(reported) && reported > 0 ? reported : 0;
}
