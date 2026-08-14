import {MODULE_ID, SOCKET_CHANNEL, SOCKET_TYPES} from "./constants.js";
import {clamp, effectiveRange} from "./config.js";

function sessionKey(playlistId, soundId) {
  return `${playlistId}.${soundId}`;
}

function nowId() {
  const random = globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${Date.now()}-${random}`;
}

export class PlaybackRuntime {
  #sessions = new Map();
  #onSessionChanged;

  constructor({onSessionChanged} = {}) {
    this.#onSessionChanged = onSessionChanged ?? (() => {});
  }

  registerSocket() {
    game.socket.on(SOCKET_CHANNEL, payload => {
      void this.#handleSocket(payload);
    });
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
    const resolved = resolveSound(playlistId, soundId);
    const nativeTime = Number(resolved?.sound?.sound?.currentTime);
    if (session?.paused) return Number(session.offset) || 0;
    if (Number.isFinite(nativeTime)) return nativeTime;
    return Number(session?.offset) || 0;
  }

  async playFromGM(playlist, playlistSound, config, duration) {
    const range = effectiveRange(config, duration);
    if (!range.valid) throw new Error("Invalid playback range");

    const existing = this.getSession(playlist.id, playlistSound.id);
    if (existing?.paused) {
      const unchanged = existing.rangeStart === range.start
        && existing.rangeEnd === range.end
        && existing.loop === range.loop
        && Number(existing.fadeIn) === Number(range.fadeIn)
        && Number(existing.fadeOut) === Number(range.fadeOut);
      if (unchanged) return this.resumeFromGM(playlist.id, playlistSound.id);
    }

    const command = {
      type: SOCKET_TYPES.PLAY,
      sessionId: nowId(),
      playlistId: playlist.id,
      soundId: playlistSound.id,
      controllerUserId: game.user.id,
      trackDuration: Number(duration) || 0,
      rangeStart: range.start,
      rangeEnd: range.end,
      offset: range.start,
      loop: range.loop,
      fadeIn: range.fadeIn,
      fadeOut: range.fadeOut
    };

    // Keep the shared Foundry PlaylistSound state authoritative for whether the
    // track is active. Enhanced playback only controls the native Sound instance.
    await playlist.playSound(playlistSound);

    await this.#acceptPlay(command);
    game.socket.emit(SOCKET_CHANNEL, command);
    return command;
  }

  async pauseFromGM(playlistId, soundId) {
    const session = this.getSession(playlistId, soundId);
    if (!session || session.paused) return;

    const command = {
      type: SOCKET_TYPES.PAUSE,
      playlistId,
      soundId,
      sessionId: session.sessionId,
      controllerUserId: game.user.id,
      offset: clamp(this.getPosition(playlistId, soundId), session.rangeStart, session.rangeEnd)
    };

    await this.#acceptPause(command);
    game.socket.emit(SOCKET_CHANNEL, command);
  }

  async resumeFromGM(playlistId, soundId) {
    const session = this.getSession(playlistId, soundId);
    if (!session?.paused) return;

    const command = {
      type: SOCKET_TYPES.RESUME,
      playlistId,
      soundId,
      sessionId: session.sessionId,
      controllerUserId: game.user.id,
      offset: clamp(Number(session.offset), session.rangeStart, session.rangeEnd)
    };

    await this.#acceptResume(command);
    game.socket.emit(SOCKET_CHANNEL, command);
  }

  async stopFromGM(playlist, playlistSound) {
    await this.stopLocalSession(playlist.id, playlistSound.id, {stopAudio: false, broadcast: true});
    return playlist.stopSound(playlistSound);
  }

  async seekFromGM(playlistId, soundId, offset) {
    const session = this.getSession(playlistId, soundId);
    if (!session) return;

    const command = {
      type: SOCKET_TYPES.SEEK,
      playlistId,
      soundId,
      sessionId: session.sessionId,
      controllerUserId: game.user.id,
      offset: clamp(Number(offset), session.rangeStart, session.rangeEnd)
    };

    await this.#acceptSeek(command);
    game.socket.emit(SOCKET_CHANNEL, command);
  }

  async stopLocalSession(playlistId, soundId, {stopAudio = false, broadcast = false} = {}) {
    const key = sessionKey(playlistId, soundId);
    const session = this.#sessions.get(key);

    if (session) {
      session.active = false;
      session.paused = false;
      session.generation += 1;
      this.#clearSchedules(session);
      this.#sessions.delete(key);
    }

    if (stopAudio) {
      const resolved = resolveSound(playlistId, soundId);
      const nativeSound = resolved?.sound?.sound;
      if (nativeSound?.playing || Number(nativeSound?.pausedTime) > 0) {
        try {
          await nativeSound.stop();
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to stop local Sound`, error);
        }
      }
    }

    if (broadcast) {
      game.socket.emit(SOCKET_CHANNEL, {
        type: SOCKET_TYPES.STOP_LOCAL,
        playlistId,
        soundId,
        controllerUserId: game.user.id
      });
    }

    if (session) this.#onSessionChanged();
  }

  async onPlaylistSoundUpdated(playlistSound, changed) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    const session = this.getSession(playlistId, playlistSound.id);

    if (changed.playing === false) {
      await this.stopLocalSession(playlistId, playlistSound.id, {stopAudio: false, broadcast: false});
      return;
    }

    // Core document synchronization may occur after our socket command. Re-apply
    // the local enhanced state once the native PlaylistSound confirms it is active.
    if (changed.playing === true && session && !session.nativeStateConfirmed) {
      session.nativeStateConfirmed = true;
      queueMicrotask(() => {
        if (!session.active) return;
        if (session.paused) this.#pauseNative(session);
        else void this.#applyPlayback(session, session.offset, {restart: true});
      });
      return;
    }

    // Keep a module-paused Sound paused if another PlaylistSound update causes
    // Foundry to synchronize its local native Sound instance.
    if (session?.paused) queueMicrotask(() => this.#pauseNative(session));
  }

  async onPlaylistSoundDeleted(playlistSound) {
    const playlistId = playlistSound.parent?.id;
    if (!playlistId) return;
    await this.stopLocalSession(playlistId, playlistSound.id, {stopAudio: false, broadcast: false});
  }

  async #handleSocket(payload) {
    if (!payload || typeof payload !== "object") return;
    const controller = payload.controllerUserId ? game.users?.get(payload.controllerUserId) : null;
    if (!controller?.isGM) return;

    try {
      switch (payload.type) {
        case SOCKET_TYPES.PLAY:
          await this.#acceptPlay(payload);
          break;
        case SOCKET_TYPES.PAUSE:
          await this.#acceptPause(payload);
          break;
        case SOCKET_TYPES.RESUME:
          await this.#acceptResume(payload);
          break;
        case SOCKET_TYPES.SEEK:
          await this.#acceptSeek(payload);
          break;
        case SOCKET_TYPES.STOP_LOCAL:
          await this.stopLocalSession(payload.playlistId, payload.soundId, {stopAudio: false, broadcast: false});
          break;
      }
    } catch (error) {
      console.error(`${MODULE_ID} | Socket playback command failed`, error);
    }
  }

  async #acceptPlay(command) {
    const resolved = resolveSound(command.playlistId, command.soundId);
    if (!resolved) return;

    const key = sessionKey(command.playlistId, command.soundId);
    const prior = this.#sessions.get(key);
    if (prior && prior.sessionId === command.sessionId) return;
    if (prior) {
      prior.active = false;
      prior.generation += 1;
      this.#clearSchedules(prior);
    }

    const rangeStart = Math.max(0, Number(command.rangeStart) || 0);
    const rangeEnd = Math.max(rangeStart, Number(command.rangeEnd) || 0);
    const session = {
      ...command,
      rangeStart,
      rangeEnd,
      trackDuration: Math.max(rangeEnd, Number(command.trackDuration) || 0),
      active: true,
      paused: false,
      offset: clamp(Number(command.offset), rangeStart, rangeEnd),
      scheduleHandles: new Set(),
      generation: 0,
      nativeStateConfirmed: Boolean(resolved.sound.playing)
    };

    this.#sessions.set(key, session);
    await this.#applyPlayback(session, session.offset, {restart: true});
    this.#onSessionChanged();
  }

  async #acceptPause(command) {
    const session = this.getSession(command.playlistId, command.soundId);
    if (!session || session.sessionId !== command.sessionId || !session.active) return;

    session.offset = clamp(Number(command.offset), session.rangeStart, session.rangeEnd);
    session.paused = true;
    session.generation += 1;
    this.#clearSchedules(session);
    this.#pauseNative(session);
    this.#onSessionChanged();
  }

  async #acceptResume(command) {
    const session = this.getSession(command.playlistId, command.soundId);
    if (!session || session.sessionId !== command.sessionId || !session.active) return;

    session.offset = clamp(Number(command.offset), session.rangeStart, session.rangeEnd);
    session.paused = false;
    await this.#applyPlayback(session, session.offset, {restart: false});
    this.#onSessionChanged();
  }

  async #acceptSeek(command) {
    const session = this.getSession(command.playlistId, command.soundId);
    if (!session || session.sessionId !== command.sessionId || !session.active) return;

    session.offset = clamp(Number(command.offset), session.rangeStart, session.rangeEnd);
    if (!session.paused) await this.#applyPlayback(session, session.offset, {restart: true});
    this.#onSessionChanged();
  }

  #pauseNative(session) {
    const resolved = resolveSound(session.playlistId, session.soundId);
    const nativeSound = resolved?.sound?.sound;
    if (!nativeSound?.playing) return;
    try {
      nativeSound.pause();
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to pause native Sound`, error);
    }
  }

  async #applyPlayback(session, requestedOffset, {restart = false} = {}) {
    if (!session.active || session.paused) return;
    const resolved = resolveSound(session.playlistId, session.soundId);
    if (!resolved) {
      await this.stopLocalSession(session.playlistId, session.soundId);
      return;
    }

    const playlistSound = resolved.sound;
    try {
      await playlistSound.load();
    } catch (error) {
      console.error(`${MODULE_ID} | Could not load ${playlistSound.name}`, error);
      return;
    }

    const nativeSound = playlistSound.sound;
    if (!nativeSound) return;

    // The GM-provided trackDuration was captured from the full source before
    // enhanced playback began. Do not rewrite it from a transient limited cycle.
    const trackDuration = Math.max(0, Number(session.trackDuration) || Number(nativeSound.duration) || 0);
    const rangeStart = Math.max(0, Number(session.rangeStart) || 0);
    const rangeEnd = Math.max(rangeStart, Number(session.rangeEnd) || 0);
    if (trackDuration <= 0 || rangeStart >= trackDuration || rangeEnd > trackDuration || rangeEnd <= rangeStart) return;

    session.offset = clamp(Number(requestedOffset), rangeStart, rangeEnd);
    session.generation += 1;
    const generation = session.generation;
    this.#clearSchedules(session);

    if (restart && nativeSound.playing) {
      try {
        nativeSound.pause();
      } catch (error) {
        console.debug(`${MODULE_ID} | Native pause before enhanced restart failed`, error);
      }
    }

    await this.#playCycle(session, session.offset, generation);
  }

  async #playCycle(session, offset, generation) {
    if (!session.active || session.paused || generation !== session.generation) return;
    const resolved = resolveSound(session.playlistId, session.soundId);
    const playlistSound = resolved?.sound;
    const nativeSound = playlistSound?.sound;
    if (!playlistSound || !nativeSound) return;

    const start = clamp(Number(offset), session.rangeStart, session.rangeEnd);
    const remaining = Math.max(0, session.rangeEnd - start);
    if (remaining <= 0) {
      if (session.loop) return this.#playCycle(session, session.rangeStart, generation);
      return this.#finishSession(session);
    }

    const fadeInMs = Math.max(0, Math.min(Number(session.fadeIn) || 0, remaining) * 1000);
    const fadeOutSec = Math.max(0, Math.min(Number(session.fadeOut) || 0, Math.max(0, remaining - fadeInMs / 1000)));
    const targetVolume = Number.isFinite(Number(playlistSound.volume)) ? Number(playlistSound.volume) : 1;

    const canUseNativeLoop = Boolean(
      session.loop
      && nativeSound.isBuffer
      && fadeInMs === 0
      && fadeOutSec === 0
      && start === session.rangeStart
    );

    const onended = () => {
      if (!session.active || session.paused || generation !== session.generation) return;
      if (canUseNativeLoop) return;
      if (session.loop) void this.#playCycle(session, session.rangeStart, generation);
      else void this.#finishSession(session);
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

    // A pause/seek can race the asynchronous start. Respect the newest generation.
    if (!session.active || session.paused || generation !== session.generation) {
      if (nativeSound.playing) nativeSound.pause();
      return;
    }

    if (fadeOutSec > 0 && !canUseNativeLoop) {
      const fadeAt = session.rangeEnd - fadeOutSec;
      try {
        const handle = nativeSound.schedule(() => {
          session.scheduleHandles.delete(handle);
          if (!session.active || session.paused || generation !== session.generation) return;
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

  async #finishSession(session) {
    if (!session.active) return;
    const key = sessionKey(session.playlistId, session.soundId);
    this.#clearSchedules(session);
    session.active = false;
    session.paused = false;
    this.#sessions.delete(key);
    this.#onSessionChanged();

    // Only the initiating GM changes the shared Playlist document at natural end.
    if (game.user?.isGM && game.user.id === session.controllerUserId) {
      const resolved = resolveSound(session.playlistId, session.soundId);
      if (resolved?.sound?.playing) {
        try {
          await resolved.playlist.stopSound(resolved.sound);
        } catch (error) {
          console.warn(`${MODULE_ID} | Failed to finalize native PlaylistSound state`, error);
        }
      }
    }
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
