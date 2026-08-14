import {MODULE_ID} from "./constants.js";
import {findPlaylistSoundRow, isCurrentlyPlayingElement, isPlaylistDirectoryApplication, normalizeRenderElement, resolvePlaylistSoundFromElement} from "./compat.js";
import {clamp, effectiveRange, readPlaybackConfig, resetPlaybackConfig, writePlaybackConfig} from "./config.js";

const PANEL_CLASS = "eap-panel";
const SELECTED_CLASS = "eap-selected-track";
const INTERACTIVE_SELECTOR = "button, input, select, textarea, [data-action], [role='button'], .control, .controls, .sound-control, .volume";
const NUMERIC_KEYS = new Set(["start", "end", "fadeIn", "fadeOut"]);
const STRUCTURAL_KEYS = new Set(["start", "end"]);
const CONFIG_DEBOUNCE_MS = 300;

export class EnhancedAudioPlayerUI {
  #selection;
  #runtime;
  #root = null;
  #panel = null;
  #renderToken = 0;
  #progressFrame = null;
  #isSeeking = false;
  #seekPointerId = null;
  #boundRoots = new WeakSet();
  #durationCache = new Map();
  #idlePositions = new Map();
  #configTimer = null;
  #pendingConfigContext = null;
  #configChain = Promise.resolve();
  #lastCommittedConfig = null;
  #transportBusy = false;
  #suppressNextRangeChange = false;

  constructor({selection, runtime}) {
    this.#selection = selection;
    this.#runtime = runtime;
  }

  onPlaylistDirectoryRender(application, element) {
    if (!game.user?.isGM) return;
    if (!isPlaylistDirectoryApplication(application)) return;
    const root = normalizeRenderElement(element);
    if (!root) return;

    this.#root = root;
    root.querySelector(`.${PANEL_CLASS}`)?.remove();

    const panel = document.createElement("section");
    panel.className = PANEL_CLASS;
    panel.dataset.moduleId = MODULE_ID;
    root.append(panel);
    this.#panel = panel;
    this.#isSeeking = false;
    this.#seekPointerId = null;

    if (!this.#boundRoots.has(root)) {
      root.addEventListener("click", event => { void this.#onDirectoryClick(event); });
      this.#boundRoots.add(root);
    }

    this.#highlightSelection();
    void this.renderPanel();
    this.#startProgressLoop();
  }

  async renderPanel() {
    const token = ++this.#renderToken;
    const resolved = this.#selection.resolve();
    if (!this.#panel?.isConnected) return;

    this.#cancelConfigTimer();

    if (!resolved) {
      this.#lastCommittedConfig = null;
      this.#panel.innerHTML = this.#emptyPanelHtml();
      return;
    }

    const {playlist, sound} = resolved;
    this.#panel.innerHTML = this.#loadingPanelHtml(sound.name);

    let duration = this.#cachedDuration(playlist, sound);
    let loadError = false;
    try {
      await sound.load();
      const candidate = Number(sound.sound?.duration);
      if (Number.isFinite(candidate) && candidate > 0) duration = this.#rememberDuration(playlist, sound, candidate);
    } catch (error) {
      loadError = true;
      console.warn(`${MODULE_ID} | Unable to load selected sound`, error);
    }

    if (token !== this.#renderToken || !this.#panel?.isConnected) return;
    const stored = readPlaybackConfig(sound);
    const config = {...stored, end: stored.end ?? duration};
    this.#lastCommittedConfig = {...config};
    this.#ensureIdlePosition(playlist, sound, config, duration);

    this.#panel.innerHTML = this.#configuredPanelHtml({playlist, sound, config, duration, loadError});
    this.#attachPanelListeners({playlist, sound, duration});
    this.#syncConfigVisuals(duration);
    this.#updateProgress();
  }

  onSessionChanged() {
    const resolved = this.#selection.resolve();
    if (resolved && !this.#runtime.getSession(resolved.playlist.id, resolved.sound.id)
      && !resolved.sound.playing && !resolved.sound.sound?.playing) {
      const duration = this.#cachedDuration(resolved.playlist, resolved.sound);
      const config = this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig ?? readPlaybackConfig(resolved.sound);
      this.#setIdlePosition(resolved.playlist, resolved.sound, this.#defaultPosition(config, duration));
    }
    this.#updatePlaybackStatus();
    this.#updateProgress();
  }

  onSoundDeleted(playlistSound) {
    const playlistId = playlistSound.parent?.id;
    if (this.#selection.soundId !== playlistSound.id || this.#selection.playlistId !== playlistId) return;
    this.#selection.clear();
    this.#highlightSelection();
    void this.renderPanel();
  }

  #durationKey(playlist, sound) {
    return `${playlist.id}.${sound.id}.${String(sound.path ?? "")}`;
  }

  #trackKey(playlist, sound) {
    return `${playlist.id}.${sound.id}`;
  }

  #cachedDuration(playlist, sound) {
    return this.#durationCache.get(this.#durationKey(playlist, sound)) ?? 0;
  }

  #rememberDuration(playlist, sound, candidate) {
    const key = this.#durationKey(playlist, sound);
    const prior = Number(this.#durationCache.get(key)) || 0;
    const duration = Math.max(prior, Number(candidate) || 0);
    if (duration > 0) this.#durationCache.set(key, duration);
    return duration;
  }

  #ensureIdlePosition(playlist, sound, config, duration) {
    const key = this.#trackKey(playlist, sound);
    if (this.#idlePositions.has(key)) return;
    this.#idlePositions.set(key, this.#defaultPosition(config, duration));
  }

  #setIdlePosition(playlist, sound, position) {
    this.#idlePositions.set(this.#trackKey(playlist, sound), Math.max(0, Number(position) || 0));
  }

  #getIdlePosition(playlist, sound, config, duration) {
    this.#ensureIdlePosition(playlist, sound, config, duration);
    return Number(this.#idlePositions.get(this.#trackKey(playlist, sound))) || 0;
  }

  #defaultPosition(config, duration) {
    if (config?.fullTrack !== false) return 0;
    const range = effectiveRange(config ?? {}, duration);
    return range.valid ? range.start : clamp(Number(config?.start) || 0, 0, Math.max(0, duration));
  }

  async #onDirectoryClick(event) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(`.${PANEL_CLASS}`)) return;
    if (isCurrentlyPlayingElement(event.target)) return;
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;

    const match = this.#resolveSoundFromElement(event.target);
    if (!match) return;

    if (this.#pendingConfigContext || this.#configTimer) {
      await this.#flushConfigCommit(this.#pendingConfigContext);
    }
    this.#selection.select(match.playlist.id, match.sound.id);
    this.#highlightSelection(match.row);
    this.#isSeeking = false;
    this.#seekPointerId = null;
    void this.renderPanel();
  }

  #resolveSoundFromElement(target) {
    return resolvePlaylistSoundFromElement(target, this.#root);
  }

  #highlightSelection(preferredRow = null) {
    if (!this.#root) return;
    this.#root.querySelectorAll(`.${SELECTED_CLASS}`).forEach(element => element.classList.remove(SELECTED_CLASS));
    const selected = this.#selection.resolve();
    if (!selected) return;

    if (preferredRow instanceof HTMLElement) {
      preferredRow.classList.add(SELECTED_CLASS);
      return;
    }

    const row = findPlaylistSoundRow(this.#root, selected.playlist.id, selected.sound.id);
    if (row && !row.closest(`.${PANEL_CLASS}`)) row.classList.add(SELECTED_CLASS);
  }

  #attachPanelListeners({playlist, sound, duration}) {
    const panel = this.#panel;
    if (!panel) return;

    panel.querySelector("[data-eap-action='play']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      this.#transportBusy = true;
      try {
        await this.#flushConfigCommit({playlist, sound, duration});
        const config = this.#readPanelConfig();
        if (!config || !effectiveRange(config, duration).valid) {
          ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));
          return;
        }
        await this.#runtime.playFromGM(playlist, sound, config, duration);
      } catch (error) {
        console.error(`${MODULE_ID} | Play failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PlayFailed"));
      } finally {
        this.#transportBusy = false;
        this.#updatePlaybackStatus();
        this.#updateProgress();
      }
    });

    panel.querySelector("[data-eap-action='pause']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      this.#transportBusy = true;
      try {
        await this.#runtime.pauseFromGM(playlist.id, sound.id);
      } catch (error) {
        console.error(`${MODULE_ID} | Pause failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PauseFailed"));
      } finally {
        this.#transportBusy = false;
        this.#updatePlaybackStatus();
        this.#updateProgress();
      }
    });

    panel.querySelector("[data-eap-action='stop']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      this.#transportBusy = true;
      try {
        await this.#runtime.stopFromGM(playlist, sound);
        const config = this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig ?? readPlaybackConfig(sound);
        this.#setIdlePosition(playlist, sound, this.#defaultPosition(config, duration));
      } catch (error) {
        console.error(`${MODULE_ID} | Stop failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.StopFailed"));
      } finally {
        this.#transportBusy = false;
        this.#updatePlaybackStatus();
        this.#updateProgress();
      }
    });

    panel.querySelector("[data-eap-action='reset']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      this.#transportBusy = true;
      this.#cancelConfigTimer();
      try {
        await this.#runtime.resetBarrierFromGM(playlist, sound);
        await resetPlaybackConfig(sound);
        this.#setIdlePosition(playlist, sound, 0);
        this.#lastCommittedConfig = {fullTrack: true, start: 0, end: duration, loop: false, fadeIn: 0, fadeOut: 0};
        ui.notifications?.info(localize("EAP.Notifications.ResetComplete"));
        await this.renderPanel();
      } catch (error) {
        console.error(`${MODULE_ID} | Reset failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.ResetFailed"));
      } finally {
        this.#transportBusy = false;
      }
    });

    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      const key = input.dataset.eapConfig;
      if (!key) continue;

      if (NUMERIC_KEYS.has(key)) this.#isolateNumericInput(input);

      if (input.type === "checkbox") {
        input.addEventListener("change", () => {
          void this.#commitConfig({playlist, sound, duration, changedKeys: new Set([key])});
        });
        continue;
      }

      input.addEventListener("input", () => {
        this.#markInputValidity(input);
        this.#syncConfigVisuals(duration);
        this.#scheduleConfigCommit({playlist, sound, duration, changedKeys: new Set([key])});
      });

      input.addEventListener("change", () => {
        void this.#commitConfig({playlist, sound, duration, changedKeys: new Set([key])});
      });

      input.addEventListener("blur", () => {
        void this.#flushConfigCommit({playlist, sound, duration});
      });
    }

    const progress = panel.querySelector("[data-eap-progress]");
    progress?.addEventListener("pointerdown", event => {
      this.#isSeeking = true;
      this.#seekPointerId = event.pointerId;
      try { progress.setPointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    });

    progress?.addEventListener("input", event => {
      this.#isSeeking = true;
      const config = this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig;
      const bounds = this.#seekBounds(config, duration);
      const raw = Number(event.currentTarget.value);
      const value = bounds.valid ? clamp(raw, bounds.min, bounds.max) : raw;
      event.currentTarget.value = String(value);
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(value);
    });

    progress?.addEventListener("pointerup", async event => {
      if (this.#seekPointerId !== null && event.pointerId !== this.#seekPointerId) return;
      try { progress.releasePointerCapture(event.pointerId); } catch (_error) { /* optional */ }
      this.#seekPointerId = null;
      this.#suppressNextRangeChange = true;
      setTimeout(() => { this.#suppressNextRangeChange = false; }, 0);
      await this.#commitSeek({playlist, sound, duration, progress});
    });

    progress?.addEventListener("pointercancel", () => {
      this.#seekPointerId = null;
      this.#isSeeking = false;
      this.#updateProgress();
    });

    progress?.addEventListener("change", async event => {
      // Pointer changes are committed by pointerup. This path handles keyboard
      // interaction with the range input.
      if (this.#seekPointerId !== null || this.#suppressNextRangeChange) return;
      await this.#commitSeek({playlist, sound, duration, progress: event.currentTarget});
    });

    progress?.addEventListener("blur", () => {
      if (this.#seekPointerId !== null) return;
      this.#isSeeking = false;
      this.#updateProgress();
    });

    this.#syncConfigVisuals(duration);
  }

  #isolateNumericInput(input) {
    const stop = event => {
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    input.addEventListener("keydown", event => {
      stop(event);

      const numpadMatch = /^Numpad([0-9])$/.exec(event.code);
      if (numpadMatch) {
        event.preventDefault();
        insertAtSelection(input, numpadMatch[1]);
        input.dispatchEvent(new Event("input", {bubbles: true}));
        return;
      }

      if (event.code === "NumpadDecimal") {
        event.preventDefault();
        insertAtSelection(input, ".");
        input.dispatchEvent(new Event("input", {bubbles: true}));
        return;
      }

      if (["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide"].includes(event.code)) {
        event.preventDefault();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        input.blur();
      }
    });
    input.addEventListener("keyup", stop);
    input.addEventListener("keypress", stop);
    input.addEventListener("dblclick", stop);
    input.addEventListener("wheel", event => {
      stop(event);
      event.preventDefault();
    }, {passive: false});
  }

  #scheduleConfigCommit(context) {
    this.#cancelConfigTimer({keepContext: true});
    this.#pendingConfigContext = context;
    this.#configTimer = setTimeout(() => {
      const pending = this.#pendingConfigContext;
      this.#configTimer = null;
      this.#pendingConfigContext = null;
      if (pending) void this.#commitConfig(pending);
    }, CONFIG_DEBOUNCE_MS);
  }

  #cancelConfigTimer({keepContext = false} = {}) {
    if (this.#configTimer) clearTimeout(this.#configTimer);
    this.#configTimer = null;
    if (!keepContext) this.#pendingConfigContext = null;
  }

  async #flushConfigCommit(context) {
    if (this.#configTimer) {
      const pending = this.#pendingConfigContext ?? context;
      this.#cancelConfigTimer();
      if (pending) await this.#commitConfig(pending);
    }
    await this.#configChain.catch(() => {});
  }

  #commitConfig({playlist, sound, duration, changedKeys}) {
    this.#cancelConfigTimer();
    const config = this.#readPanelConfig();
    if (!config) {
      this.#syncConfigVisuals(duration);
      return Promise.resolve(false);
    }

    const previous = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
    const snapshot = {...config};
    const keys = new Set(changedKeys ?? []);
    this.#lastCommittedConfig = snapshot;
    this.#syncConfigVisuals(duration);

    const operation = async () => {
      const stillSelected = this.#selection.playlistId === playlist.id && this.#selection.soundId === sound.id;
      if (!stillSelected) return false;

      const structural = [...keys].some(key => STRUCTURAL_KEYS.has(key));
      const fullTrackTurnedOff = keys.has("fullTrack") && previous.fullTrack !== false && snapshot.fullTrack === false;
      const repositionToStart = structural || fullTrackTurnedOff;
      const range = effectiveRange(snapshot, duration);

      if (repositionToStart) {
        this.#setIdlePosition(playlist, sound, range.valid ? range.start : clamp(Number(snapshot.start) || 0, 0, duration));
      } else if (keys.has("fullTrack") && snapshot.fullTrack) {
        const current = this.#getDisplayedPosition(playlist, sound, snapshot, duration);
        this.#setIdlePosition(playlist, sound, clamp(current, 0, duration));
      }

      if (this.#runtime.isEnhanced(playlist.id, sound.id)) {
        await this.#runtime.reconfigureFromGM(playlist, sound, snapshot, duration, {repositionToStart});
      }

      await writePlaybackConfig(sound, snapshot);
      if (this.#selection.playlistId === playlist.id && this.#selection.soundId === sound.id) {
        this.#syncConfigVisuals(duration);
        this.#updateProgress();
      }
      return true;
    };

    this.#configChain = this.#configChain.catch(() => {}).then(operation);
    return this.#configChain;
  }

  async #commitSeek({playlist, sound, duration, progress}) {
    if (this.#transportBusy) {
      this.#isSeeking = false;
      return;
    }

    this.#transportBusy = true;
    try {
      await this.#flushConfigCommit({playlist, sound, duration, changedKeys: new Set()});
      const config = this.#readPanelConfig();
      const range = config ? effectiveRange(config, duration) : null;
      if (!config || !range?.valid) {
        ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));
        return;
      }

      const bounds = this.#seekBounds(config, duration);
      const offset = clamp(Number(progress.value), bounds.min, bounds.max);
      progress.value = String(offset);
      this.#setIdlePosition(playlist, sound, offset);
      await this.#runtime.seekFromGM(playlist, sound, config, duration, offset);
    } catch (error) {
      console.error(`${MODULE_ID} | Seek failed`, error);
      ui.notifications?.error(localize("EAP.Notifications.SeekFailed"));
    } finally {
      this.#transportBusy = false;
      this.#isSeeking = false;
      this.#updatePlaybackStatus();
      this.#updateProgress();
    }
  }

  #readPanelConfig({allowInvalidText = false} = {}) {
    const panel = this.#panel;
    if (!panel) return null;

    const config = {};
    let validText = true;
    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      const key = input.dataset.eapConfig;
      if (!key) continue;
      if (input.type === "checkbox") {
        config[key] = input.checked;
        continue;
      }

      const parsed = parseDecimal(input.value);
      const valid = Number.isFinite(parsed) && parsed >= 0;
      input.classList.toggle("eap-input-invalid", !valid);
      if (!valid) {
        validText = false;
        if (allowInvalidText) config[key] = Number(this.#lastCommittedConfig?.[key]) || 0;
      } else config[key] = parsed;
    }

    if (!validText && !allowInvalidText) return null;
    return config;
  }

  #markInputValidity(input) {
    const parsed = parseDecimal(input.value);
    input.classList.toggle("eap-input-invalid", !Number.isFinite(parsed) || parsed < 0);
  }

  #syncConfigVisuals(duration) {
    const panel = this.#panel;
    if (!panel) return;

    const config = this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig;
    if (!config) return;
    const fullTrack = config.fullTrack !== false;

    for (const key of ["start", "end", "loop"]) {
      const input = panel.querySelector(`[data-eap-config='${key}']`);
      if (input) input.disabled = fullTrack;
    }

    const timeline = panel.querySelector("[data-eap-timeline]");
    timeline?.toggleAttribute("data-full-track", fullTrack);
    this.#updateTimelineMarkers(duration, config);

    const range = effectiveRange(config, duration);
    const hasInvalidText = Boolean(panel.querySelector(".eap-input-invalid"));
    const controlsValid = duration > 0 && range.valid && !hasInvalidText;
    const warning = panel.querySelector("[data-eap-warning]");
    if (warning) warning.hidden = fullTrack || duration <= 0 || (range.valid && !hasInvalidText);

    const play = panel.querySelector("[data-eap-action='play']");
    if (play) play.disabled = !controlsValid;

    const progress = panel.querySelector("[data-eap-progress]");
    if (progress) progress.disabled = !controlsValid;

    if (!this.#isSeeking) this.#enforceDisplayedPosition(config, duration);
  }

  #seekBounds(config, duration) {
    const safeDuration = Math.max(0, Number(duration) || 0);
    if (!config || config.fullTrack !== false) return {valid: safeDuration > 0, min: 0, max: safeDuration};
    const range = effectiveRange(config, safeDuration);
    if (!range.valid) return {valid: false, min: 0, max: safeDuration};
    return {valid: true, min: range.start, max: range.end};
  }

  #enforceDisplayedPosition(config, duration) {
    const resolved = this.#selection.resolve();
    if (!resolved || duration <= 0) return;
    const bounds = this.#seekBounds(config, duration);
    if (!bounds.valid) return;

    const session = this.#runtime.getSession(resolved.playlist.id, resolved.sound.id);
    if (session) return; // runtime is authoritative while active/paused

    const current = this.#getIdlePosition(resolved.playlist, resolved.sound, config, duration);
    const clamped = clamp(current, bounds.min, bounds.max);
    this.#setIdlePosition(resolved.playlist, resolved.sound, clamped);

    const slider = this.#panel?.querySelector("[data-eap-progress]");
    if (slider) slider.value = String(clamped);
    const currentLabel = this.#panel?.querySelector("[data-eap-current]");
    if (currentLabel) currentLabel.textContent = formatTime(clamped);
  }

  #updateTimelineMarkers(duration, suppliedConfig = null) {
    const panel = this.#panel;
    const timeline = panel?.querySelector("[data-eap-timeline]");
    if (!panel || !timeline || duration <= 0) return;

    const config = suppliedConfig ?? this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig;
    if (!config) return;
    const fullTrack = config.fullTrack !== false;
    const start = Math.max(0, Number(config.start) || 0);
    const end = Number.isFinite(Number(config.end)) ? Number(config.end) : duration;
    const startVisual = clamp(start, 0, duration);
    const endVisual = clamp(end, 0, duration);
    const left = (startVisual / duration) * 100;
    const right = (endVisual / duration) * 100;

    timeline.style.setProperty("--eap-start-pct", `${left}%`);
    timeline.style.setProperty("--eap-end-pct", `${right}%`);
    timeline.style.setProperty("--eap-range-width", `${Math.max(0, right - left)}%`);
    timeline.toggleAttribute("data-full-track", fullTrack);

    const startLabel = panel.querySelector("[data-eap-marker-start-label]");
    const endLabel = panel.querySelector("[data-eap-marker-end-label]");
    if (startLabel) startLabel.textContent = `${localize("EAP.Start")} ${formatTime(start)}`;
    if (endLabel) endLabel.textContent = `${localize("EAP.End")} ${formatTime(end)}`;
  }

  #getDisplayedPosition(playlist, sound, config, duration) {
    const session = this.#runtime.getSession(playlist.id, sound.id);
    if (session) return this.#runtime.getPosition(playlist.id, sound.id);
    if (sound.sound?.playing) {
      const native = Number(sound.sound.currentTime);
      if (Number.isFinite(native)) return native;
    }
    return this.#getIdlePosition(playlist, sound, config, duration);
  }

  #startProgressLoop() {
    if (this.#progressFrame) cancelAnimationFrame(this.#progressFrame);
    const tick = () => {
      if (!this.#panel?.isConnected) {
        this.#progressFrame = null;
        return;
      }
      this.#updateProgress();
      this.#progressFrame = requestAnimationFrame(tick);
    };
    this.#progressFrame = requestAnimationFrame(tick);
  }

  #updateProgress() {
    const panel = this.#panel;
    const resolved = this.#selection.resolve();
    if (!panel || !resolved) return;

    const {playlist, sound} = resolved;
    const session = this.#runtime.getSession(playlist.id, sound.id);
    let duration = this.#cachedDuration(playlist, sound);
    const candidate = Number(sound.sound?.duration);
    if (!session && Number.isFinite(candidate) && candidate > 0) duration = this.#rememberDuration(playlist, sound, candidate);
    if (duration <= 0) return;

    const config = this.#readPanelConfig({allowInvalidText: true}) ?? this.#lastCommittedConfig ?? readPlaybackConfig(sound);
    const bounds = this.#seekBounds(config, duration);
    const slider = panel.querySelector("[data-eap-progress]");
    if (slider) {
      slider.min = "0";
      slider.max = String(duration);
      slider.disabled = !bounds.valid;
    }

    if (!this.#isSeeking) {
      let current = this.#getDisplayedPosition(playlist, sound, config, duration);
      current = bounds.valid ? clamp(current, bounds.min, bounds.max) : clamp(current, 0, duration);
      if (!session && !sound.sound?.playing) this.#setIdlePosition(playlist, sound, current);
      if (slider) slider.value = String(current);
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(current);
    }

    const totalLabel = panel.querySelector("[data-eap-progress-end]");
    if (totalLabel) totalLabel.textContent = formatTime(duration);
    this.#updateTimelineMarkers(duration, config);
    this.#updatePlaybackStatus();
  }

  #updatePlaybackStatus() {
    const panel = this.#panel;
    const resolved = this.#selection.resolve();
    if (!panel || !resolved) return;
    const status = panel.querySelector("[data-eap-status]");
    if (!status) return;

    const session = this.#runtime.getSession(resolved.playlist.id, resolved.sound.id);
    if (session?.paused) {
      status.textContent = localize("EAP.Status.Paused");
      status.dataset.state = "paused";
    } else if (session) {
      status.textContent = localize("EAP.Status.Enhanced");
      status.dataset.state = "enhanced";
    } else if (resolved.sound.sound?.playing || resolved.sound.playing) {
      status.textContent = localize("EAP.Status.Native");
      status.dataset.state = "native";
    } else {
      status.textContent = localize("EAP.Status.Idle");
      status.dataset.state = "idle";
    }

    const pauseButton = panel.querySelector("[data-eap-action='pause']");
    if (pauseButton) pauseButton.disabled = !session || Boolean(session.paused) || this.#transportBusy;
    const stopButton = panel.querySelector("[data-eap-action='stop']");
    if (stopButton) stopButton.disabled = (!session && !resolved.sound.playing && !resolved.sound.sound?.playing) || this.#transportBusy;
  }

  #emptyPanelHtml() {
    return `
      <header class="eap-header"><i class="fa-solid fa-wave-square"></i><span>${escapeHtml(localize("EAP.Title"))}</span></header>
      <div class="eap-empty">${escapeHtml(localize("EAP.SelectTrack"))}</div>
    `;
  }

  #loadingPanelHtml(name) {
    return `
      <header class="eap-header"><i class="fa-solid fa-wave-square"></i><span>${escapeHtml(localize("EAP.Title"))}</span></header>
      <div class="eap-track-name">${escapeHtml(name)}</div>
      <div class="eap-empty"><i class="fa-solid fa-spinner fa-spin"></i> ${escapeHtml(localize("EAP.Loading"))}</div>
    `;
  }

  #configuredPanelHtml({playlist, sound, config, duration, loadError}) {
    const range = effectiveRange(config, duration);
    const endValue = config.end ?? duration;
    const canPlay = !loadError && duration > 0 && range.valid;
    const session = this.#runtime.getSession(playlist.id, sound.id);
    const status = session?.paused
      ? localize("EAP.Status.Paused")
      : (session
        ? localize("EAP.Status.Enhanced")
        : (sound.sound?.playing || sound.playing ? localize("EAP.Status.Native") : localize("EAP.Status.Idle")));

    const startPct = duration > 0 ? clamp(config.start, 0, duration) / duration * 100 : 0;
    const endPct = duration > 0 ? clamp(endValue, 0, duration) / duration * 100 : 100;
    const widthPct = Math.max(0, endPct - startPct);
    const current = this.#getDisplayedPosition(playlist, sound, config, duration);

    return `
      <header class="eap-header">
        <span><i class="fa-solid fa-wave-square"></i> ${escapeHtml(localize("EAP.Title"))}</span>
        <span class="eap-status" data-eap-status data-state="${session?.paused ? "paused" : (session ? "enhanced" : "idle")}">${escapeHtml(status)}</span>
      </header>

      <div class="eap-track-block">
        <div class="eap-track-label">${escapeHtml(localize("EAP.SelectedTrack"))}</div>
        <div class="eap-track-name" title="${escapeHtml(sound.name)}">${escapeHtml(sound.name)}</div>
        <div class="eap-playlist-name">${escapeHtml(playlist.name)}</div>
      </div>

      ${loadError ? `<div class="eap-error">${escapeHtml(localize("EAP.LoadError"))}</div>` : ""}
      <div class="eap-warning" data-eap-warning ${!config.fullTrack && !range.valid && duration > 0 ? "" : "hidden"}>${escapeHtml(localize("EAP.InvalidRangeHint"))}</div>

      <div class="eap-transport">
        <button type="button" data-eap-action="play" ${canPlay ? "" : "disabled"}>
          <i class="fa-solid fa-play"></i> ${escapeHtml(localize("EAP.Play"))}
        </button>
        <button type="button" data-eap-action="pause" ${session && !session.paused ? "" : "disabled"}>
          <i class="fa-solid fa-pause"></i> ${escapeHtml(localize("EAP.Pause"))}
        </button>
        <button type="button" data-eap-action="stop" ${session || sound.playing || sound.sound?.playing ? "" : "disabled"}>
          <i class="fa-solid fa-stop"></i> ${escapeHtml(localize("EAP.Stop"))}
        </button>
      </div>

      <label class="eap-toggle eap-full-track">
        <input type="checkbox" data-eap-config="fullTrack" ${config.fullTrack ? "checked" : ""}>
        <span>${escapeHtml(localize("EAP.FullTrack"))}</span>
      </label>

      <div class="eap-grid">
        <label>
          <span>${escapeHtml(localize("EAP.Start"))}</span>
          <div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(config.start)}" data-eap-config="start"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.End"))}</span>
          <div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(endValue)}" data-eap-config="end"><span>s</span></div>
        </label>
      </div>

      <label class="eap-toggle">
        <input type="checkbox" data-eap-config="loop" ${config.loop ? "checked" : ""}>
        <span>${escapeHtml(localize("EAP.LoopRange"))}</span>
      </label>

      <div class="eap-grid">
        <label>
          <span>${escapeHtml(localize("EAP.FadeIn"))}</span>
          <div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(config.fadeIn)}" data-eap-config="fadeIn"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.FadeOut"))}</span>
          <div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(config.fadeOut)}" data-eap-config="fadeOut"><span>s</span></div>
        </label>
      </div>

      <div class="eap-progress-wrap">
        <div class="eap-progress-labels">
          <span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Current"))}</span> <strong data-eap-current>${formatTime(current)}</strong></span>
          <span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Duration"))}</span> <strong data-eap-progress-end>${formatTime(duration)}</strong></span>
        </div>
        <div class="eap-timeline" data-eap-timeline ${config.fullTrack ? "data-full-track" : ""}
             style="--eap-start-pct:${startPct}%;--eap-end-pct:${endPct}%;--eap-range-width:${widthPct}%">
          <div class="eap-range-highlight" aria-hidden="true"></div>
          <span class="eap-range-marker eap-range-marker-start" aria-hidden="true"></span>
          <span class="eap-range-marker eap-range-marker-end" aria-hidden="true"></span>
          <input type="range" data-eap-progress min="0" max="${duration}" step="0.01" value="${clamp(current, 0, duration)}" ${canPlay ? "" : "disabled"}>
        </div>
        <div class="eap-marker-labels">
          <span data-eap-marker-start-label>${escapeHtml(localize("EAP.Start"))} ${formatTime(config.start)}</span>
          <span data-eap-marker-end-label>${escapeHtml(localize("EAP.End"))} ${formatTime(endValue)}</span>
        </div>
      </div>

      <div class="eap-footer-actions">
        <button type="button" class="eap-reset" data-eap-action="reset">
          <i class="fa-solid fa-rotate-left"></i> ${escapeHtml(localize("EAP.ResetTrack"))}
        </button>
      </div>
    `;
  }
}

function localize(key) {
  return game.i18n?.localize(key) ?? key;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(3) : "0.000";
}

function parseDecimal(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  if (!text || !/^\d+(?:\.\d*)?$/.test(text)) return NaN;
  const number = Number(text);
  return Number.isFinite(number) ? number : NaN;
}

function insertAtSelection(input, text) {
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  input.setRangeText(text, start, end, "end");
}

export function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const whole = Math.floor(remainder);
  const millis = Math.floor((remainder - whole) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
