import {MODULE_ID, SOCKET_CHANNEL, SOCKET_TYPES} from "./constants.js";
import {clamp, effectiveRange, readPlaybackConfig} from "./config.js";

function sessionKey(playlistId, soundId) {
  return `${playlistId}.${soundId}`;
}

function nowId() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now()}-${random}`;
}


function requiresEnhancedPolicy(config) {
  return config?.fullTrack === false
    || Boolean(config?.loop)
    || Number(config?.fadeIn) > 0
    || Number(config?.fadeOut) > 0;
}

function chooseControllerUserId(requestedUserId = null) {
  const requested = requestedUserId ? game.users?.get?.(requestedUserId) : null;
  if (requested?.isGM) return requested.id;

  const users = game.users?.contents ?? Array.from(game.users ?? []);
  const activeGMs = users.filter(user => user?.isGM && user?.active).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return activeGMs[0]?.id ?? null;
}

export class PlaybackRuntime {
  #sessions = new Map();
  #onSessionChanged;
  #onTrackStarted;
  #activeTrack = null;
  #latestRevision = new Map();
  #queues = new Map();
  #revisionCounter = 0;
  #nativeReconcileTimers = new Map();

  constructor({onSessionChanged, onTrackStarted} = {}) {
    this.#onSessionChanged = onSessionChanged ?? (() => {});
    this.#onTrackStarted = onTrackStarted ?? (() => {});
  }

  registerSocket() {
    game.socket.on(SOCKET_CHANNEL, payload => {
      void this.#handleSocket(payload);
    });
  }

  async reconcileCurrentlyPlaying() {
    const playlists = game.playlists?.values?.() ?? game.playlists ?? [];
    for (const playlist of playlists) {
      const sounds = playlist.sounds?.values?.() ?? playlist.sounds ?? [];
      for (const sound of sounds) {
        if (!sound.playing) continue;
        this.#markTrackStarted(sound, {autoFollow: false});
        await this.#startPersistedPolicyFromNative(sound, null);
      }
    }
  }

  getActiveTrack() {
    if (!this.#activeTrack) return null;
    const resolved = resolveSound(this.#activeTrack.playlistId, this.#activeTrack.soundId);
    if (!resolved) {
      this.#activeTrack = null;
      return null;
    }
    return resolved;
  }

  getSession(playlistId, soundId) {
    return this.#sessions.get(sessionKey(playlistId, soundId)) ?? null;
  }

  isEnhanced(playlistId, soundId) {
    return this.#sessions.has(sessionKey(playlistId, soundId));
  }

  isPaused(playlistId, soundId) {
    return Boolean(this.getSession(playlistId, soundId)?.paused);
  }

  getPosition(playlistId, soundId) {
    const session = this.getSession(playlistId, soundId);
    if (session?.paused) return Number(session.offset) || 0;

    const resolved = resolveSound(playlistId, soundId);
    const nativeTime = Number(resolved?.sound?.sound?.currentTime);
    if (Number.isFinite(nativeTime)) return nativeTime;
    return Number(session?.offset) || 0;
  }

  async playFromGM(playlist, playlistSound, config, duration) {
    const range = effectiveRange(config, duration);
    if (!range.valid) throw new Error("Invalid playback range");

    const key = sessionKey(playlist.id, playlistSound.id);

    // Play is deliberately a NEW playback action. It always starts from the
    // effective beginning (0 for Full Track, Start for Custom Range), even if
    // this track currently has a paused session. Resume is a separate command.
    await this.#ensurePlaylistActive(playlist, playlistSound);

    const command = this.#policyCommand({
      type: SOCKET_TYPES.PLAY,
      revision: this.#nextRevision(key),
      sessionId: nowId(),
      playlist,
      playlistSound,
      range,
      duration,
      offset: range.start,
      paused: false
    });

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    // The EAP Play button already targets the selected track, so no UI jump is
    // needed here; this only keeps the Playing indicator authoritative when a
    // document was already playing and therefore emitted no new playing=true.
    this.#markTrackStarted(playlistSound, {autoFollow: false});
    return command;
  }

  async resumeFromGM(playlistId, soundId) {
    const session = this.getSession(playlistId, soundId);
    if (!session?.active || !session.paused) return null;

    const key = sessionKey(playlistId, soundId);
    const command = {
      type: SOCKET_TYPES.PLAY,
      revision: this.#nextRevision(key),
      sessionId: session.sessionId,
      playlistId,
      soundId,
      controllerUserId: game.user.id,
      trackDuration: Number(session.trackDuration) || 0,
      rangeStart: Number(session.rangeStart) || 0,
      rangeEnd: Number(session.rangeEnd) || 0,
      loopStart: Number(session.loopStart) || 0,
      loopEnd: Number(session.loopEnd) || 0,
      playbackStart: Number(session.playbackStart) || 0,
      seekMin: Number(session.seekMin) || 0,
      seekMax: Number(session.seekMax) || 0,
      introLoop: Boolean(session.introLoop),
      offset: clamp(Number(session.offset), Number(session.seekMin) || 0, Number(session.seekMax) || 0),
      loop: Boolean(session.loop),
      fadeIn: Number(session.fadeIn) || 0,
      fadeOut: Number(session.fadeOut) || 0,
      paused: false,
      resume: true
    };

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    return command;
  }

  /**
   * Seek is an absolute transport action inside the currently allowed policy.
   * If no Enhanced session exists, releasing the timeline starts one at offset.
   * Seeking from Pause resumes playback, matching the UI contract.
   */
  async seekFromGM(playlist, playlistSound, config, duration, requestedOffset) {
    const range = effectiveRange(config, duration);
    if (!range.valid) throw new Error("Invalid playback range");

    const key = sessionKey(playlist.id, playlistSound.id);
    const existing = this.getSession(playlist.id, playlistSound.id);
    const offset = clamp(Number(requestedOffset), range.seekMin, range.seekMax);

    await this.#ensurePlaylistActive(playlist, playlistSound);

    const command = this.#policyCommand({
      type: SOCKET_TYPES.SEEK,
      revision: this.#nextRevision(key),
      sessionId: existing?.sessionId ?? nowId(),
      playlist,
      playlistSound,
      range,
      duration,
      offset,
      paused: false
    });

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    return command;
  }

  /**
   * Reconcile a live Enhanced session after an explicit OK configuration commit.
   * This does nothing when the selected track is not in an Enhanced session.
   */
  async reconfigureFromGM(playlist, playlistSound, config, duration, {repositionToStart = false} = {}) {
    const existing = this.getSession(playlist.id, playlistSound.id);
    if (!existing) return null;

    const range = effectiveRange(config, duration);
    if (!range.valid) {
      await this.stopFromGM(playlist, playlistSound);
      return null;
    }

    const key = sessionKey(playlist.id, playlistSound.id);
    const current = this.getPosition(playlist.id, playlistSound.id);
    const offset = repositionToStart
      ? range.start
      : clamp(current, range.seekMin, range.seekMax);

    const command = this.#policyCommand({
      type: SOCKET_TYPES.RECONFIGURE,
      revision: this.#nextRevision(key),
      sessionId: existing.sessionId,
      playlist,
      playlistSound,
      range,
      duration,
      offset,
      paused: Boolean(existing.paused)
    });

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    return command;
  }

  async pauseFromGM(playlistId, soundId) {
    let session = this.getSession(playlistId, soundId);
    if (session?.paused) return null;

    const key = sessionKey(playlistId, soundId);

    // A Full Track started purely by Foundry may not have an Enhanced session.
    // If the GM presses Pause after auto-follow, adopt that native playback into
    // a paused EAP session so Resume can continue from the exact same position.
    if (!session) {
      const resolved = resolveSound(playlistId, soundId);
      const playlistSound = resolved?.sound;
      const nativeSound = playlistSound?.sound;
      if (!playlistSound || (!playlistSound.playing && !nativeSound?.playing)) return null;

      try { await playlistSound.load(); } catch (_error) { /* use loaded metadata if available */ }
      const duration = Number(playlistSound.sound?.duration) || 0;
      const range = effectiveRange(readPlaybackConfig(playlistSound), duration);
      if (!range.valid) return null;

      const offset = clamp(Number(playlistSound.sound?.currentTime) || 0, range.start, range.end);
      const command = {
        type: SOCKET_TYPES.PLAY,
        revision: this.#nextRevision(key),
        sessionId: nowId(),
        playlistId,
        soundId,
        controllerUserId: game.user.id,
        trackDuration: duration,
        rangeStart: range.start,
        rangeEnd: range.end,
        playbackStart: range.playbackStart,
        loopStart: range.loopStart,
        loopEnd: range.loopEnd,
        seekMin: range.seekMin,
        seekMax: range.seekMax,
        introLoop: range.introLoop,
        offset,
        loop: Boolean(range.loop),
        fadeIn: Number(range.fadeIn) || 0,
        fadeOut: Number(range.fadeOut) || 0,
        paused: true,
        adoptedNativePause: true
      };
      await this.#acceptCommand(command);
      game.socket.emit(SOCKET_CHANNEL, command);
      return command;
    }

    const command = {
      type: SOCKET_TYPES.PAUSE,
      revision: this.#nextRevision(key),
      playlistId,
      soundId,
      sessionId: session.sessionId,
      controllerUserId: game.user.id,
      offset: clamp(this.getPosition(playlistId, soundId), session.seekMin, session.seekMax)
    };

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    return command;
  }

  async stopFromGM(playlist, playlistSound) {
    const key = sessionKey(playlist.id, playlistSound.id);
    const command = {
      type: SOCKET_TYPES.STOP_LOCAL,
      revision: this.#nextRevision(key),
      playlistId: playlist.id,
      soundId: playlistSound.id,
      controllerUserId: game.user.id,
      stopAudio: true
    };

    await this.#acceptCommand(command);
    game.socket.emit(SOCKET_CHANNEL, command);

    if (playlistSound.playing) await playlist.stopSound(playlistSound);
    return command;
  }

  /** Reset uses this as a real transport barrier before flags are removed. */
  async resetBarrierFromGM(playlist, playlistSound) {
    await this.stopFromGM(playlist, playlistSound);
    await Promise.resolve();
  }

  async onPlaylistSoundUpdated(playlistSound, changed, _options = {}, userId = null) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    const key = sessionKey(playlistId, playlistSound.id);

    if (changed.playing === false) {
      this.#clearActiveTrack(playlistId, playlistSound.id);
      // Defer one turn and inspect current document state. This avoids a stale
      // native stop update killing a newer Enhanced PLAY that already won.
      queueMicrotask(() => {
        if (playlistSound.playing !== false) return;
        const session = this.#sessions.get(key);
        if (!session) return;
        session.active = false;
        session.paused = false;
        session.generation += 1;
        this.#clearSchedules(session);
        this.#sessions.delete(key);
        this.#onSessionChanged();
      });
      return;
    }

    if (changed.playing !== true) return;

    // A genuine native transition to playing=true is the auto-follow boundary.
    // The GM remains free to select/edit another occurrence while this same
    // track keeps playing; we only take selection again when a NEW track starts.
    this.#markTrackStarted(playlistSound, {autoFollow: true});

    if (this.#sessions.has(key)) {
      this.#scheduleNativeReconcile(playlistId, playlistSound.id);
      return;
    }

    // v0.1.0: persisted policy belongs to this exact PlaylistSound occurrence.
    // When Foundry starts it natively (including automatic playlist advance),
    // apply that occurrence's saved range/fades without replacing Playlist or
    // Sound classes. A duplicate file in another Playlist is a different
    // PlaylistSound and therefore resolves independent flags.
    await this.#startPersistedPolicyFromNative(playlistSound, userId);
  }

  async #startPersistedPolicyFromNative(playlistSound, controllerUserId = null) {
    const playlist = playlistSound.parent;
    if (!playlist || !playlistSound.playing) return;

    const config = readPlaybackConfig(playlistSound);
    if (!requiresEnhancedPolicy(config)) return;

    // Capture the native revision before any asynchronous load. If an explicit
    // GM Play/Seek command is issued while loading, its later integer revision
    // wins and this native-start policy becomes stale instead of overriding it.
    const key = sessionKey(playlist.id, playlistSound.id);
    const prior = Number(this.#latestRevision.get(key)) || 0;
    const revision = prior + 0.5;

    try {
      await playlistSound.load();
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not load native-started PlaylistSound policy`, error);
      return;
    }

    if (!playlistSound.playing) return;
    const duration = Number(playlistSound.sound?.duration) || 0;
    const range = effectiveRange(config, duration);
    if (!range.valid) {
      console.warn(`${MODULE_ID} | Saved policy is invalid for ${playlistSound.name}; leaving native playback untouched.`);
      return;
    }

    // Native document updates are already synchronized by Foundry. Give their
    // local policy session a fractional revision just above the command state
    // that existed when the native start was first observed.
    const command = {
      type: SOCKET_TYPES.PLAY,
      revision,
      sessionId: nowId(),
      playlistId: playlist.id,
      soundId: playlistSound.id,
      controllerUserId: chooseControllerUserId(controllerUserId),
      trackDuration: duration,
      rangeStart: range.start,
      rangeEnd: range.end,
      playbackStart: range.playbackStart,
      loopStart: range.loopStart,
      loopEnd: range.loopEnd,
      seekMin: range.seekMin,
      seekMax: range.seekMax,
      introLoop: range.introLoop,
      offset: range.start,
      loop: Boolean(range.loop),
      fadeIn: Number(range.fadeIn) || 0,
      fadeOut: Number(range.fadeOut) || 0,
      paused: false,
      nativePolicy: true
    };

    await this.#acceptCommand(command);
  }

  #markTrackStarted(playlistSound, {autoFollow = true} = {}) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    const next = {playlistId, soundId: playlistSound.id};
    const same = this.#activeTrack?.playlistId === next.playlistId && this.#activeTrack?.soundId === next.soundId;
    this.#activeTrack = next;
    if (!same) this.#onTrackStarted({...next, autoFollow: Boolean(autoFollow)});
    else this.#onSessionChanged();
  }

  #clearActiveTrack(playlistId, soundId) {
    if (this.#activeTrack?.playlistId !== playlistId || this.#activeTrack?.soundId !== soundId) return;
    this.#activeTrack = null;
    this.#onTrackStarted(null);
  }

  async onPlaylistSoundDeleted(playlistSound) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    const key = sessionKey(playlistId, playlistSound.id);
    this.#clearActiveTrack(playlistId, playlistSound.id);
    const timer = this.#nativeReconcileTimers.get(key);
    if (timer) clearTimeout(timer);
    this.#nativeReconcileTimers.delete(key);
    this.#sessions.delete(key);
    this.#latestRevision.delete(key);
    this.#onSessionChanged();
  }

  #policyCommand({type, revision, sessionId, playlist, playlistSound, range, duration, offset, paused}) {
    return {
      type,
      revision,
      sessionId,
      playlistId: playlist.id,
      soundId: playlistSound.id,
      controllerUserId: game.user.id,
      trackDuration: Number(duration) || 0,
      rangeStart: range.start,
      rangeEnd: range.end,
      playbackStart: range.playbackStart,
      loopStart: range.loopStart,
      loopEnd: range.loopEnd,
      seekMin: range.seekMin,
      seekMax: range.seekMax,
      introLoop: range.introLoop,
      offset: clamp(Number(offset), range.seekMin, range.seekMax),
      loop: Boolean(range.loop),
      fadeIn: Number(range.fadeIn) || 0,
      fadeOut: Number(range.fadeOut) || 0,
      paused: Boolean(paused)
    };
  }

  async #ensurePlaylistActive(playlist, playlistSound) {
    if (playlistSound.playing) return;
    await playlist.playSound(playlistSound);
  }

  #nextRevision(key) {
    this.#revisionCounter = (this.#revisionCounter + 1) % 1000;
    const revision = Date.now() * 1000 + this.#revisionCounter;
    const prior = Number(this.#latestRevision.get(key)) || 0;
    return Math.max(revision, prior + 1);
  }

  #isCurrent(key, revision) {
    return Number(this.#latestRevision.get(key)) === Number(revision);
  }

  #acceptCommand(command) {
    if (!command?.playlistId || !command?.soundId || !Number.isFinite(Number(command.revision))) return Promise.resolve();
    const key = sessionKey(command.playlistId, command.soundId);
    const revision = Number(command.revision);
    const prior = Number(this.#latestRevision.get(key)) || 0;
    if (revision <= prior) return Promise.resolve();
    this.#latestRevision.set(key, revision);

    return this.#enqueue(key, async () => {
      if (!this.#isCurrent(key, revision)) return;
      switch (command.type) {
        case SOCKET_TYPES.PLAY:
        case SOCKET_TYPES.SEEK:
        case SOCKET_TYPES.RECONFIGURE:
          await this.#acceptPolicy(command);
          break;
        case SOCKET_TYPES.PAUSE:
          await this.#acceptPause(command);
          break;
        case SOCKET_TYPES.STOP_LOCAL:
          await this.#acceptStop(command);
          break;
      }
    });
  }

  #enqueue(key, task) {
    const prior = this.#queues.get(key) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(task);
    this.#queues.set(key, next);
    void next.finally(() => {
      if (this.#queues.get(key) === next) this.#queues.delete(key);
    });
    return next;
  }

  async #handleSocket(payload) {
    if (!payload || typeof payload !== "object") return;
    const controller = payload.controllerUserId ? game.users?.get(payload.controllerUserId) : null;
    if (!controller?.isGM) return;

    try {
      await this.#acceptCommand(payload);
    } catch (error) {
      console.error(`${MODULE_ID} | Socket playback command failed`, error);
    }
  }

  async #acceptPolicy(command) {
    const resolved = resolveSound(command.playlistId, command.soundId);
    if (!resolved) return;
    const key = sessionKey(command.playlistId, command.soundId);
    if (!this.#isCurrent(key, command.revision)) return;

    const playbackStart = Math.max(0, Number(command.playbackStart ?? command.rangeStart) || 0);
    const rangeEnd = Math.max(playbackStart, Number(command.rangeEnd) || 0);
    const loopStart = Math.max(0, Number(command.loopStart ?? command.rangeStart) || 0);
    const loopEnd = Math.max(loopStart, Number(command.loopEnd ?? rangeEnd) || 0);
    const seekMin = Math.max(0, Number(command.seekMin ?? playbackStart) || 0);
    const seekMax = Math.max(seekMin, Number(command.seekMax ?? rangeEnd) || 0);
    const trackDuration = Math.max(0, Number(command.trackDuration) || 0);
    if (trackDuration <= 0 || rangeEnd <= playbackStart || rangeEnd > trackDuration) return;
    if (command.loop && (loopStart >= loopEnd || loopEnd > trackDuration)) return;

    const prior = this.#sessions.get(key);
    if (prior) {
      prior.active = false;
      prior.generation += 1;
      this.#clearSchedules(prior);
    }

    const session = {
      ...command,
      rangeStart: playbackStart,
      rangeEnd,
      playbackStart,
      loopStart,
      loopEnd,
      seekMin,
      seekMax,
      introLoop: Boolean(command.introLoop),
      trackDuration,
      offset: clamp(Number(command.offset), seekMin, seekMax),
      fadeInApplied: command.type === SOCKET_TYPES.SEEK || Boolean(command.resume),
      loop: Boolean(command.loop),
      fadeIn: Math.max(0, Number(command.fadeIn) || 0),
      fadeOut: Math.max(0, Number(command.fadeOut) || 0),
      active: true,
      paused: Boolean(command.paused),
      scheduleHandles: new Set(),
      generation: 0,
      lastAppliedAt: 0
    };

    this.#sessions.set(key, session);

    if (session.paused) {
      await this.#stopNative(session);
    } else {
      await this.#applyPlayback(session, session.offset, {restart: true, revision: command.revision});
    }
    this.#onSessionChanged();
  }

  async #acceptPause(command) {
    const key = sessionKey(command.playlistId, command.soundId);
    if (!this.#isCurrent(key, command.revision)) return;
    const session = this.#sessions.get(key);
    if (!session || session.sessionId !== command.sessionId || !session.active) return;

    session.revision = command.revision;
    session.offset = clamp(Number(command.offset), session.seekMin, session.seekMax);
    session.paused = true;
    session.generation += 1;
    this.#clearSchedules(session);
    await this.#stopNative(session);
    this.#onSessionChanged();
  }

  async #acceptStop(command) {
    const key = sessionKey(command.playlistId, command.soundId);
    if (!this.#isCurrent(key, command.revision)) return;

    const timer = this.#nativeReconcileTimers.get(key);
    if (timer) clearTimeout(timer);
    this.#nativeReconcileTimers.delete(key);

    const session = this.#sessions.get(key);
    if (session) {
      session.active = false;
      session.paused = false;
      session.generation += 1;
      this.#clearSchedules(session);
      this.#sessions.delete(key);
    }

    if (command.stopAudio !== false) {
      const resolved = resolveSound(command.playlistId, command.soundId);
      const nativeSound = resolved?.sound?.sound;
      if (nativeSound?.playing || Number(nativeSound?.pausedTime) > 0) {
        try {
          await nativeSound.stop();
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to stop local Sound`, error);
        }
      }
    }

    this.#onSessionChanged();
  }

  async #applyPlayback(session, requestedOffset, {restart = false, revision = session.revision} = {}) {
    const key = sessionKey(session.playlistId, session.soundId);
    if (!session.active || session.paused || !this.#isCurrent(key, revision)) return;

    const resolved = resolveSound(session.playlistId, session.soundId);
    if (!resolved) return;

    const playlistSound = resolved.sound;
    try {
      await playlistSound.load();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not load ${playlistSound.name}`, error);
      return;
    }

    if (!session.active || session.paused || !this.#isCurrent(key, revision)) return;
    const nativeSound = playlistSound.sound;
    if (!nativeSound) return;

    const trackDuration = Number(session.trackDuration) || 0;
    const rangeStart = Number(session.rangeStart) || 0;
    const rangeEnd = Number(session.rangeEnd) || 0;
    if (trackDuration <= 0 || rangeStart < 0 || rangeEnd <= rangeStart || rangeEnd > trackDuration) return;

    session.offset = clamp(Number(requestedOffset), session.seekMin, session.seekMax);
    session.generation += 1;
    const generation = session.generation;
    this.#clearSchedules(session);

    // #playCycle is the single absolute-start path. It clears any native
    // playing/paused state before supplying the requested source offset.

    if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;
    await this.#playCycle(session, session.offset, generation, revision);
  }

  /**
   * Every cycle works in absolute source seconds. The first pass starts at
   * playbackStart (0 for Intro+Loop); subsequent passes start at loopStart.
   * Only a buffer source can use sample-accurate native region looping.
   */
  async #playCycle(session, offset, generation, revision) {
    const key = sessionKey(session.playlistId, session.soundId);
    if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;

    const resolved = resolveSound(session.playlistId, session.soundId);
    const playlistSound = resolved?.sound;
    const nativeSound = playlistSound?.sound;
    if (!playlistSound || !nativeSound) return;

    session.cycleSerial = (Number(session.cycleSerial) || 0) + 1;
    const cycleSerial = session.cycleSerial;
    const start = clamp(Number(offset), session.seekMin, session.seekMax);
    const remaining = Math.max(0, session.rangeEnd - start);
    if (remaining <= 0.001) {
      if (session.loop) {
        // Do not recursively replay an End-bound seek in the same tick.
        return this.#playCycle(session, session.loopStart, generation, revision);
      }
      return this.#finishSession(session, revision);
    }

    const initialFade = !session.fadeInApplied;
    session.fadeInApplied = true;
    const fadeInMs = initialFade ? Math.max(0, Math.min(Number(session.fadeIn) || 0, remaining) * 1000) : 0;
    // A loop must never fade out at its seam; Fade Out is for terminal ends.
    const fadeOutSec = session.loop ? 0 : Math.max(0, Math.min(Number(session.fadeOut) || 0, Math.max(0, remaining - fadeInMs / 1000)));
    const targetVolume = Number.isFinite(Number(playlistSound.volume)) ? Number(playlistSound.volume) : 1;
    const canUseNativeLoop = Boolean(session.loop && nativeSound.isBuffer);

    const onended = () => {
      if (!session.active || session.paused || generation !== session.generation || cycleSerial !== session.cycleSerial || !this.#isCurrent(key, revision)) return;
      if (canUseNativeLoop) return;
      if (session.loop) {
        // Streamed files use the same native Sound, but start subsequent
        // iterations at loopStart instead of repeating the introduction.
        void this.#playCycle(session, session.loopStart, generation, revision);
      } else {
        void this.#finishSession(session, revision);
      }
    };

    const options = {offset: start, volume: targetVolume, fade: fadeInMs, onended};
    if (canUseNativeLoop) {
      options.loop = true;
      options.loopStart = session.loopStart;
      options.loopEnd = session.loopEnd;
    } else {
      options.duration = remaining;
      options.loop = false;
    }

    // A streamed cycle can end with an internal paused position. Always clear
    // it before starting an absolute offset, including a loop fallback.
    if (nativeSound.playing || Number(nativeSound.pausedTime) > 0) {
      try { await nativeSound.stop(); }
      catch (error) { console.debug(`${MODULE_ID} | Stop before next absolute cycle failed`, error); }
    }
    if (!session.active || session.paused || generation !== session.generation || cycleSerial !== session.cycleSerial || !this.#isCurrent(key, revision)) return;

    // Begin the expected-time clock before play(), so a concurrent native
    // sync/reconcile cannot mistake an intro for the loop segment.
    session.offset = start;
    session.lastAppliedAt = Date.now();
    try { await nativeSound.play(options); }
    catch (error) {
      console.error(`${MODULE_ID} | Enhanced Sound.play failed`, error);
      return;
    }

    if (!session.active || session.paused || generation !== session.generation || cycleSerial !== session.cycleSerial || !this.#isCurrent(key, revision)) {
      if (nativeSound.playing || Number(nativeSound.pausedTime) > 0) {
        try { await nativeSound.stop(); } catch (_error) { /* newer command will reconcile */ }
      }
      return;
    }

    if (fadeOutSec > 0 && !canUseNativeLoop) {
      const fadeAt = session.rangeEnd - fadeOutSec;
      try {
        const handle = nativeSound.schedule(() => {
          session.scheduleHandles.delete(handle);
          if (!session.active || session.paused || generation !== session.generation || cycleSerial !== session.cycleSerial || !this.#isCurrent(key, revision)) return;
          void nativeSound.fade(0, {duration: fadeOutSec * 1000, from: targetVolume, type: "linear"});
        }, fadeAt);
        session.scheduleHandles.add(handle);
      } catch (error) {
        console.debug(`${MODULE_ID} | Could not schedule fade-out`, error);
      }
    }
  }

  async #finishSession(session, revision) {
    const key = sessionKey(session.playlistId, session.soundId);
    if (!session.active || !this.#isCurrent(key, revision)) return;

    this.#clearSchedules(session);
    session.active = false;
    session.paused = false;
    this.#sessions.delete(key);
    this.#onSessionChanged();

    if (game.user?.isGM && game.user.id === session.controllerUserId) {
      const resolved = resolveSound(session.playlistId, session.soundId);
      if (resolved?.sound?.playing) {
        let advanced = false;
        try {
          // Public Foundry API: sequential/shuffled playlists advance using
          // their own playback order. Other modes return null/undefined.
          advanced = Boolean(await resolved.playlist.playNext(resolved.sound.id));
        } catch (error) {
          console.debug(`${MODULE_ID} | Playlist playNext was not applicable`, error);
        }

        if (!advanced && resolved.sound.playing) {
          try {
            await resolved.playlist.stopSound(resolved.sound);
          } catch (error) {
            console.warn(`${MODULE_ID} | Failed to finalize native PlaylistSound state`, error);
          }
        }
      }
    }
  }

  /** Only the EAP session owns its paused absolute offset. */
  async #stopNative(session) {
    const resolved = resolveSound(session.playlistId, session.soundId);
    const nativeSound = resolved?.sound?.sound;
    if (!nativeSound) return;
    try {
      if (nativeSound.playing || Number(nativeSound.pausedTime) > 0) await nativeSound.stop();
    } catch (error) {
      console.warn(`${MODULE_ID} | Native transport stop failed`, error);
    }
  }

  #scheduleNativeReconcile(playlistId, soundId) {
    const key = sessionKey(playlistId, soundId);
    const prior = this.#nativeReconcileTimers.get(key);
    if (prior) clearTimeout(prior);

    const timer = setTimeout(() => {
      this.#nativeReconcileTimers.delete(key);
      const session = this.#sessions.get(key);
      if (!session?.active) return;
      const revision = Number(session.revision);
      if (!this.#isCurrent(key, revision)) return;

      void this.#enqueue(key, async () => {
        const current = this.#sessions.get(key);
        if (!current?.active || current.paused || !this.#isCurrent(key, revision)) return;
        const resolved = resolveSound(playlistId, soundId);
        const nativeSound = resolved?.sound?.sound;
        const currentTime = Number(nativeSound?.currentTime);
        const expected = this.#expectedCurrentTime(current);
        const looksCorrect = nativeSound?.playing
          && Number.isFinite(currentTime)
          && Math.abs(currentTime - expected) < 1.25;
        if (looksCorrect) return;
        await this.#applyPlayback(current, expected, {restart: true, revision});
      });
    }, 75);

    this.#nativeReconcileTimers.set(key, timer);
  }

  #expectedCurrentTime(session) {
    const firstStart = Number(session.playbackStart) || 0;
    const end = Number(session.rangeEnd) || firstStart;
    const base = clamp(Number(session.offset), session.seekMin, session.seekMax);
    if (!session.lastAppliedAt || session.paused) return base;
    const elapsed = Math.max(0, (Date.now() - Number(session.lastAppliedAt)) / 1000);
    if (!session.loop) return clamp(base + elapsed, firstStart, end);

    const untilFirstEnd = Math.max(0, end - base);
    if (elapsed < untilFirstEnd) return base + elapsed;
    const loopStart = Number(session.loopStart) || 0;
    const loopEnd = Number(session.loopEnd) || end;
    const length = loopEnd - loopStart;
    if (length <= 0) return loopStart;
    return loopStart + ((elapsed - untilFirstEnd) % length);
  }

  #clearSchedules(session) {
    const resolved = resolveSound(session.playlistId, session.soundId);
    const nativeSound = resolved?.sound?.sound;
    if (!nativeSound) {
      session.scheduleHandles?.clear?.();
      return;
    }

    for (const handle of session.scheduleHandles ?? []) {
      try {
        nativeSound.unschedule(handle);
      } catch (_error) {
        // Scheduling may already have resolved naturally; cleanup is best-effort.
      }
    }
    session.scheduleHandles?.clear?.();
  }
}

export function resolveSound(playlistId, soundId) {
  const playlist = game.playlists?.get(playlistId);
  const sound = playlist?.sounds?.get(soundId);
  return playlist && sound ? {playlist, sound} : null;
}
