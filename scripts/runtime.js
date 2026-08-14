import {MODULE_ID, SOCKET_CHANNEL, SOCKET_TYPES} from "./constants.js";
import {clamp, effectiveRange, readPlaybackConfig} from "./config.js";

function sessionKey(playlistId, soundId) {
  return `${playlistId}.${soundId}`;
}

function nowId() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now()}-${random}`;
}

function samePolicy(session, range, trackDuration) {
  return Boolean(session)
    && Number(session.trackDuration) === Number(trackDuration)
    && Number(session.rangeStart) === Number(range.start)
    && Number(session.rangeEnd) === Number(range.end)
    && Boolean(session.loop) === Boolean(range.loop)
    && Number(session.fadeIn) === Number(range.fadeIn)
    && Number(session.fadeOut) === Number(range.fadeOut);
}

function requiresEnhancedPolicy(config) {
  return config?.fullTrack === false
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
  #latestRevision = new Map();
  #queues = new Map();
  #revisionCounter = 0;
  #nativeReconcileTimers = new Map();

  constructor({onSessionChanged} = {}) {
    this.#onSessionChanged = onSessionChanged ?? (() => {});
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
        await this.#startPersistedPolicyFromNative(sound, null);
      }
    }
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
    const existing = this.getSession(playlist.id, playlistSound.id);
    const resumePaused = Boolean(existing?.paused && samePolicy(existing, range, duration));
    const offset = resumePaused
      ? clamp(Number(existing.offset), range.start, range.end)
      : range.start;

    await this.#ensurePlaylistActive(playlist, playlistSound);

    const command = this.#policyCommand({
      type: SOCKET_TYPES.PLAY,
      revision: this.#nextRevision(key),
      sessionId: resumePaused ? existing.sessionId : nowId(),
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
   * Seek is an absolute transport action inside the currently allowed policy.
   * If no Enhanced session exists, releasing the timeline starts one at offset.
   * Seeking from Pause resumes playback, matching the UI contract.
   */
  async seekFromGM(playlist, playlistSound, config, duration, requestedOffset) {
    const range = effectiveRange(config, duration);
    if (!range.valid) throw new Error("Invalid playback range");

    const key = sessionKey(playlist.id, playlistSound.id);
    const existing = this.getSession(playlist.id, playlistSound.id);
    const offset = clamp(Number(requestedOffset), range.start, range.end);

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
      : clamp(current, range.start, range.end);

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
    const session = this.getSession(playlistId, soundId);
    if (!session || session.paused) return null;

    const key = sessionKey(playlistId, soundId);
    const command = {
      type: SOCKET_TYPES.PAUSE,
      revision: this.#nextRevision(key),
      playlistId,
      soundId,
      sessionId: session.sessionId,
      controllerUserId: game.user.id,
      offset: clamp(this.getPosition(playlistId, soundId), session.rangeStart, session.rangeEnd)
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
      offset: range.start,
      loop: Boolean(range.loop),
      fadeIn: Number(range.fadeIn) || 0,
      fadeOut: Number(range.fadeOut) || 0,
      paused: false,
      nativePolicy: true
    };

    await this.#acceptCommand(command);
  }

  async onPlaylistSoundDeleted(playlistSound) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    const key = sessionKey(playlistId, playlistSound.id);
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
      offset: clamp(Number(offset), range.start, range.end),
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

    const rangeStart = Math.max(0, Number(command.rangeStart) || 0);
    const rangeEnd = Math.max(rangeStart, Number(command.rangeEnd) || 0);
    const trackDuration = Math.max(0, Number(command.trackDuration) || 0);
    if (trackDuration <= 0 || rangeEnd <= rangeStart || rangeEnd > trackDuration) return;

    const prior = this.#sessions.get(key);
    if (prior) {
      prior.active = false;
      prior.generation += 1;
      this.#clearSchedules(prior);
    }

    const session = {
      ...command,
      rangeStart,
      rangeEnd,
      trackDuration,
      offset: clamp(Number(command.offset), rangeStart, rangeEnd),
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
      await this.#stopOrPauseNative(session, {preferPause: true});
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
    session.offset = clamp(Number(command.offset), session.rangeStart, session.rangeEnd);
    session.paused = true;
    session.generation += 1;
    this.#clearSchedules(session);
    await this.#stopOrPauseNative(session, {preferPause: true});
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

    session.offset = clamp(Number(requestedOffset), rangeStart, rangeEnd);
    session.generation += 1;
    const generation = session.generation;
    this.#clearSchedules(session);

    if (restart && (nativeSound.playing || Number(nativeSound.pausedTime) > 0)) {
      // IMPORTANT: restarts/seeks are absolute transport operations. Pause is
      // intentionally NOT used here because it preserves pausedTime and can
      // contaminate a subsequent explicit offset (observed as 10 + seek 30 =>
      // ~40 on live playback). Only the user-facing Pause command preserves
      // pausedTime. Stop clears the native resume state before absolute play.
      try {
        await nativeSound.stop();
      } catch (error) {
        console.debug(`${MODULE_ID} | Native stop before absolute restart failed`, error);
      }
    }

    if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;
    await this.#playCycle(session, session.offset, generation, revision);
  }

  async #playCycle(session, offset, generation, revision) {
    const key = sessionKey(session.playlistId, session.soundId);
    if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;

    const resolved = resolveSound(session.playlistId, session.soundId);
    const playlistSound = resolved?.sound;
    const nativeSound = playlistSound?.sound;
    if (!playlistSound || !nativeSound) return;

    const start = clamp(Number(offset), session.rangeStart, session.rangeEnd);
    const remaining = Math.max(0, session.rangeEnd - start);
    if (remaining <= 0) {
      if (session.loop) return this.#playCycle(session, session.rangeStart, generation, revision);
      return this.#finishSession(session, revision);
    }

    const fadeInMs = Math.max(0, Math.min(Number(session.fadeIn) || 0, remaining) * 1000);
    const fadeOutSec = Math.max(0, Math.min(Number(session.fadeOut) || 0, Math.max(0, remaining - fadeInMs / 1000)));
    const targetVolume = Number.isFinite(Number(playlistSound.volume)) ? Number(playlistSound.volume) : 1;

    const canUseNativeLoop = Boolean(
      session.loop
      && nativeSound.isBuffer
      && fadeInMs === 0
      && fadeOutSec === 0
      && Math.abs(start - session.rangeStart) < 0.0005
    );

    const onended = () => {
      if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;
      if (canUseNativeLoop) return;
      if (session.loop) void this.#playCycle(session, session.rangeStart, generation, revision);
      else void this.#finishSession(session, revision);
    };

    const options = {
      offset: start,
      volume: targetVolume,
      fade: fadeInMs,
      onended
    };

    if (canUseNativeLoop) {
      options.loop = true;
      options.loopStart = session.rangeStart;
      options.loopEnd = session.rangeEnd;
    } else {
      options.duration = remaining;
      options.loop = false;
    }

    try {
      await nativeSound.play(options);
    } catch (error) {
      console.error(`${MODULE_ID} | Enhanced Sound.play failed`, error);
      return;
    }

    if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) {
      if (nativeSound.playing || Number(nativeSound.pausedTime) > 0) {
        try { await nativeSound.stop(); } catch (_error) { /* newest command will reconcile */ }
      }
      return;
    }

    session.lastAppliedAt = Date.now();

    if (fadeOutSec > 0 && !canUseNativeLoop) {
      const fadeAt = session.rangeEnd - fadeOutSec;
      try {
        const handle = nativeSound.schedule(() => {
          session.scheduleHandles.delete(handle);
          if (!session.active || session.paused || generation !== session.generation || !this.#isCurrent(key, revision)) return;
          void nativeSound.fade(0, {
            duration: fadeOutSec * 1000,
            from: targetVolume,
            type: "linear"
          });
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

  async #stopOrPauseNative(session, {preferPause = false} = {}) {
    const resolved = resolveSound(session.playlistId, session.soundId);
    const nativeSound = resolved?.sound?.sound;
    if (!nativeSound) return;
    try {
      if (preferPause && nativeSound.playing) nativeSound.pause();
      else if (!preferPause && (nativeSound.playing || Number(nativeSound.pausedTime) > 0)) await nativeSound.stop();
    } catch (error) {
      console.warn(`${MODULE_ID} | Native transport operation failed`, error);
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
    const start = Number(session.rangeStart) || 0;
    const end = Number(session.rangeEnd) || start;
    const base = clamp(Number(session.offset), start, end);
    if (!session.lastAppliedAt || session.paused) return base;

    const elapsed = Math.max(0, (Date.now() - Number(session.lastAppliedAt)) / 1000);
    if (!session.loop) return clamp(base + elapsed, start, end);

    const length = end - start;
    if (length <= 0) return start;
    const relative = (base - start + elapsed) % length;
    return start + relative;
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
