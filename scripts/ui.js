import {MODULE_ID} from "./constants.js";
import {
  findPlaylistSoundRow,
  isCurrentlyPlayingElement,
  isPlaylistDirectoryApplication,
  normalizeRenderElement,
  resolvePlaylistSoundFromElement
} from "./compat.js";
import {clamp, effectiveRange, readPlaybackConfig, resetPlaybackConfig, sanitizePlaybackConfig, sourceDuration, writePlaybackConfig} from "./config.js";

const PANEL_CLASS = "eap-panel";
const SELECTED_CLASS = "eap-selected-track";
const INTERACTIVE_SELECTOR = "button, input, select, textarea, [data-action], [role='button'], .control, .controls, .sound-control, .volume";
const TIME_KEYS = new Set(["start", "introStart", "introEnd", "loopStart", "loopEnd"]);
const NUMERIC_KEYS = new Set([...TIME_KEYS, "fadeIn", "fadeOut"]);
const STRUCTURAL_KEYS = new Set(["start", "repeat", "introEnabled", "introStart", "introEnd", "loopEnabled", "loopStart", "loopEnd"]);
const CONFIG_KEYS = ["start", "repeat", "introEnabled", "introStart", "introEnd", "loopEnabled", "loopStart", "loopEnd", "fadeIn", "fadeOut"];

/**
 * Playlist-directory UI for the Enhanced Audio Player.
 *
 * v0.1.0 deliberately separates a local edit draft from persisted playback
 * policy. Typing never updates the PlaylistSound document. The whole editor is
 * committed atomically by the OK button, which prevents AppV2 rerenders from
 * destroying focus/caret state while a GM is entering numbers with a numpad.
 */
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
  #lastCommittedConfig = null;
  #dirty = false;
  #transportBusy = false;
  #suppressNextRangeChange = false;
  #anchorDrag = null;

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
    this.#anchorDrag = null;

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

    if (!resolved) {
      this.#lastCommittedConfig = null;
      this.#dirty = false;
      this.#panel.innerHTML = this.#emptyPanelHtml();
      return;
    }

    const {playlist, sound} = resolved;
    this.#panel.innerHTML = this.#loadingPanelHtml(sound.name);

    let duration = this.#cachedDuration(playlist, sound);
    let loadError = false;
    try {
      await sound.load();
      const candidate = sourceDuration(sound.sound);
      if (Number.isFinite(candidate) && candidate > 0) duration = this.#rememberDuration(playlist, sound, candidate);
    } catch (error) {
      loadError = true;
      console.warn(`${MODULE_ID} | Unable to load selected sound`, error);
    }

    if (token !== this.#renderToken || !this.#panel?.isConnected) return;
    const stored = readPlaybackConfig(sound);
    const config = {...stored};
    this.#lastCommittedConfig = {...config};
    this.#dirty = false;
    this.#ensureIdlePosition(playlist, sound, config, duration);

    this.#panel.innerHTML = this.#configuredPanelHtml({playlist, sound, config, duration, loadError});
    this.#attachPanelListeners({playlist, sound, duration});
    this.#updateActiveTrackInfo();
    this.#syncDraftVisuals(duration);
    this.#updateProgress();
  }

  onSessionChanged() {
    const resolved = this.#selection.resolve();
    if (resolved && !this.#runtime.getSession(resolved.playlist.id, resolved.sound.id)
      && !resolved.sound.playing && !resolved.sound.sound?.playing) {
      const duration = this.#cachedDuration(resolved.playlist, resolved.sound);
      const config = this.#lastCommittedConfig ?? readPlaybackConfig(resolved.sound);
      this.#setIdlePosition(resolved.playlist, resolved.sound, this.#defaultPosition(config, duration));
    }
    this.#updatePlaybackStatus();
    this.#updateProgress();
  }

  onTrackStarted(track) {
    if (!game.user?.isGM) return;

    // Startup reconciliation only informs the Playing line. Auto-follow is
    // reserved for a genuine NEW playing=true transition after the UI is live.
    if (!track?.autoFollow) {
      this.#updateActiveTrackInfo();
      this.#updatePlaybackStatus();
      return;
    }

    // A new track starting is an explicit selection boundary. Any uncommitted
    // draft on the previously selected occurrence is discarded; OK remains the
    // only way to persist edits. The GM can immediately click another track and
    // edit it while the active track continues playing without selection theft.
    this.#selection.select(track.playlistId, track.soundId);
    this.#dirty = false;
    this.#isSeeking = false;
    this.#seekPointerId = null;
    this.#anchorDrag = null;
    this.#highlightSelection();
    void this.renderPanel();
  }

  onSoundDeleted(playlistSound) {
    const playlistId = playlistSound.parent?.id;
    if (this.#selection.soundId !== playlistSound.id || this.#selection.playlistId !== playlistId) return;
    this.#selection.clear();
    this.#lastCommittedConfig = null;
    this.#dirty = false;
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
    const range = effectiveRange(config ?? {}, duration);
    return range.valid ? range.start : clamp(Number(config?.start) || 0, 0, Math.max(0, duration));
  }

  async #onDirectoryClick(event) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(`.${PANEL_CLASS}`)) return;
    if (isCurrentlyPlayingElement(event.target)) return;
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;

    const match = resolvePlaylistSoundFromElement(event.target, this.#root);
    if (!match) return;

    // Unsaved edits are intentionally local to the selected occurrence and are
    // discarded when another PlaylistSound is selected. Only OK persists them.
    this.#selection.select(match.playlist.id, match.sound.id);
    this.#highlightSelection(match.row);
    this.#isSeeking = false;
    this.#seekPointerId = null;
    this.#anchorDrag = null;
    this.#dirty = false;
    void this.renderPanel();
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
      if (this.#transportBusy || this.#dirty) return;
      this.#transportBusy = true;
      try {
        const config = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
        if (!effectiveRange(config, duration).valid) {
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
        if (this.#runtime.isPaused(playlist.id, sound.id)) {
          await this.#runtime.resumeFromGM(playlist.id, sound.id);
        } else {
          await this.#runtime.pauseFromGM(playlist.id, sound.id);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Pause/Resume failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PauseResumeFailed"));
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
        const config = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
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

    panel.querySelector("[data-eap-action='apply']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      const draft = this.#readPanelConfig();
      const range = draft ? effectiveRange(draft, duration) : null;
      if (!draft || !range?.valid) {
        ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));
        this.#syncDraftVisuals(duration);
        return;
      }

      this.#transportBusy = true;
      try {
        const previous = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
        const changedKeys = changedConfigKeys(previous, draft);
        const repositionToStart = [...changedKeys].some(key => STRUCTURAL_KEYS.has(key));

        // One atomic document write for the whole editor. The flag belongs to
        // this PlaylistSound occurrence, so identical file paths in other
        // playlists remain completely independent.
        const saved = await writePlaybackConfig(sound, draft);
        this.#lastCommittedConfig = {...saved};
        this.#dirty = false;
        this.#setIdlePosition(playlist, sound, this.#defaultPosition(this.#lastCommittedConfig, duration));

        if (this.#runtime.isEnhanced(playlist.id, sound.id)) {
          await this.#runtime.reconfigureFromGM(playlist, sound, this.#lastCommittedConfig, duration, {repositionToStart});
        } else if (sound.playing || sound.sound?.playing) {
          // A policy applied while the native track is already playing should
          // take effect immediately for all connected clients.
          await this.#runtime.playFromGM(playlist, sound, this.#lastCommittedConfig, duration);
        }

        ui.notifications?.info(localize("EAP.Notifications.SettingsSaved"));
        this.#syncDraftVisuals(duration);
        this.#updateProgress();
      } catch (error) {
        console.error(`${MODULE_ID} | Apply settings failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.SettingsSaveFailed"));
      } finally {
        this.#transportBusy = false;
        this.#updatePlaybackStatus();
      }
    });

    panel.querySelector("[data-eap-action='reset']")?.addEventListener("click", async () => {
      if (this.#transportBusy) return;
      this.#transportBusy = true;
      try {
        await this.#runtime.resetBarrierFromGM(playlist, sound);
        await resetPlaybackConfig(sound);
        this.#setIdlePosition(playlist, sound, 0);
        this.#lastCommittedConfig = sanitizePlaybackConfig({schemaVersion: 2});
        this.#dirty = false;
        ui.notifications?.info(localize("EAP.Notifications.ResetComplete"));
        await this.renderPanel();
      } catch (error) {
        console.error(`${MODULE_ID} | Reset failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.ResetFailed"));
      } finally {
        this.#transportBusy = false;
      }
    });

    // Checkbox edits are drafts until OK. Hidden groups do not contribute
    // invalid text or updates; no document write occurs during typing.
    for (const toggle of panel.querySelectorAll("[data-eap-toggle]")) {
      toggle.addEventListener("change", () => {
        if ((toggle.dataset.eapToggle === "introEnabled" || toggle.dataset.eapToggle === "loopEnabled") && toggle.checked) {
          const repeat = panel.querySelector("[data-eap-toggle='repeat']");
          if (repeat) repeat.checked = false;
        }
        this.#syncDraftVisuals(duration);
      });
    }

    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      if (!NUMERIC_KEYS.has(input.dataset.eapConfig)) continue;
      this.#isolateNumericInput(input, duration);
      const updateDraft = () => this.#syncDraftVisuals(duration);
      input.addEventListener("input", updateDraft);
      input.addEventListener("change", updateDraft);
    }

    this.#attachRangeAnchors(duration);

    const progress = panel.querySelector("[data-eap-progress]");
    progress?.addEventListener("pointerdown", event => {
      if (this.#dirty) return;
      this.#isSeeking = true;
      this.#seekPointerId = event.pointerId;
      try { progress.setPointerCapture(event.pointerId); } catch (_error) { /* optional */ }
    });

    progress?.addEventListener("input", event => {
      if (this.#dirty) return;
      this.#isSeeking = true;
      const config = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
      const bounds = this.#seekBounds(config, duration);
      const raw = Number(event.currentTarget.value);
      const value = bounds.valid ? allowedSeekOffset(config, duration, clamp(raw, bounds.min, bounds.max)) : raw;
      event.currentTarget.value = String(value);
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(value);
    });

    progress?.addEventListener("pointerup", async event => {
      if (this.#dirty) return;
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
      if (this.#dirty || this.#seekPointerId !== null || this.#suppressNextRangeChange) return;
      await this.#commitSeek({playlist, sound, duration, progress: event.currentTarget});
    });

    progress?.addEventListener("blur", () => {
      if (this.#seekPointerId !== null) return;
      this.#isSeeking = false;
      this.#updateProgress();
    });

    this.#syncDraftVisuals(duration);
  }

  /** Time fields use a fixed right-to-left millisecond mask. Changes remain
   *  local until OK, so neither the input node nor its focus is recreated. */
  #isolateNumericInput(input, duration) {
    const isTime = TIME_KEYS.has(input.dataset.eapConfig);
    const stop = event => {
      event.stopPropagation();
      event.stopImmediatePropagation();
    };
    const setTime = seconds => {
      input.value = formatTime(seconds);
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new Event("input", {bubbles: true}));
    };
    input.addEventListener("focus", () => { if (isTime) input.select(); });
    input.addEventListener("keydown", event => {
      stop(event);
      const keypad = /^Numpad([0-9])$/.exec(event.code);
      const digit = keypad?.[1] ?? (/^[0-9]$/.test(event.key) ? event.key : null);
      if (isTime) {
        if (digit !== null) {
          event.preventDefault();
          const selected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
          setTime(shiftMaskedTime(input.value, digit, {replace: selected}));
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          const selected = input.selectionStart === 0 && input.selectionEnd === input.value.length;
          setTime(event.key === "Delete" || selected ? 0 : shiftMaskedTime(input.value, "backspace"));
          return;
        }
        // Delimiters are automatic. Leave Ctrl+A/C/V/X and keyboard selection
        // intact; paste is parsed explicitly below.
        if (event.code === "NumpadDecimal" || event.key === "." || event.key === ",") {
          event.preventDefault();
          return;
        }
      } else if (keypad) {
        event.preventDefault();
        insertAtSelection(input, digit);
        input.dispatchEvent(new Event("input", {bubbles: true}));
        return;
      } else if (event.code === "NumpadDecimal") {
        event.preventDefault();
        insertAtSelection(input, ".");
        input.dispatchEvent(new Event("input", {bubbles: true}));
        return;
      }
      if (["NumpadAdd", "NumpadSubtract", "NumpadMultiply", "NumpadDivide"].includes(event.code)
          || event.key === "Enter" || event.code === "NumpadEnter") event.preventDefault();
    });
    if (isTime) {
      input.addEventListener("paste", event => {
        stop(event);
        event.preventDefault();
        const pasted = event.clipboardData?.getData("text")?.trim() ?? "";
        const parsed = parsePastedTime(pasted);
        if (Number.isFinite(parsed) && parsed >= 0) setTime(parsed);
      });
      input.addEventListener("drop", event => { stop(event); event.preventDefault(); });
      input.addEventListener("blur", () => {
        const parsed = parseTime(input.value);
        if (Number.isFinite(parsed) && parsed >= 0) input.value = formatTime(parsed);
      });
    }
    input.addEventListener("keyup", stop);
    input.addEventListener("keypress", stop);
    input.addEventListener("dblclick", stop);
    input.addEventListener("wheel", event => { stop(event); event.preventDefault(); }, {passive: false});
  }

  /** The two editing rails share the *whole file* time scale; their handles
   *  alter the draft only and never send a playback/seek command. */
  #attachRangeAnchors(duration) {
    const panel = this.#panel;
    if (!panel || !(duration > 0)) return;
    for (const anchor of panel.querySelectorAll("[data-eap-anchor]")) {
      const key = anchor.dataset.eapAnchor;
      const rail = anchor.closest("[data-eap-anchor-rail]");
      if (!TIME_KEYS.has(key) || !rail) continue;
      const input = panel.querySelector(`[data-eap-config='${key}']`);
      if (!input) continue;
      const applyValue = value => {
        input.value = formatTime(value);
        input.dispatchEvent(new Event("input", {bubbles: true}));
      };
      const clearDrag = event => {
        if (!this.#anchorDrag || this.#anchorDrag.key !== key) return;
        if (event?.pointerId !== undefined && event.pointerId !== this.#anchorDrag.pointerId) return;
        this.#anchorDrag = null;
        try { anchor.releasePointerCapture(event.pointerId); } catch (_error) { /* optional */ }
      };
      anchor.addEventListener("pointerdown", event => {
        if (event.button !== 0) return;
        const draft = this.#readPanelConfig();
        if (!draft) return;
        event.preventDefault();
        event.stopPropagation();
        anchor.focus({preventScroll: true});
        this.#anchorDrag = {
          key, pointerId: event.pointerId, x: event.clientX,
          start: Number(draft[key]) || 0,
          width: rail.getBoundingClientRect().width
        };
        try { anchor.setPointerCapture(event.pointerId); } catch (_error) { /* optional */ }
      });
      anchor.addEventListener("pointermove", event => {
        const drag = this.#anchorDrag;
        if (!drag || drag.key !== key || drag.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const draft = this.#readPanelConfig();
        if (!draft) return;
        const target = drag.start + (event.clientX - drag.x) / Math.max(1, drag.width)
          * duration * (event.shiftKey ? 0.05 : 1);
        applyValue(constrainAnchorTime(key, target, draft, duration));
      });
      anchor.addEventListener("pointerup", event => { event.stopPropagation(); clearDrag(event); });
      anchor.addEventListener("pointercancel", clearDrag);
      anchor.addEventListener("lostpointercapture", clearDrag);
      anchor.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const draft = this.#readPanelConfig();
        if (!draft) return;
        const delta = (event.shiftKey ? 0.01 : 0.001)
          * (["ArrowRight", "ArrowUp"].includes(event.key) ? 1 : -1);
        const target = event.key === "Home" ? 0 : event.key === "End" ? duration : Number(draft[key]) + delta;
        applyValue(constrainAnchorTime(key, target, draft, duration));
      });
      anchor.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
    }
  }

  async #commitSeek({playlist, sound, duration, progress}) {
    if (this.#transportBusy || this.#dirty) {
      this.#isSeeking = false;
      return;
    }

    this.#transportBusy = true;
    try {
      const config = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
      const range = effectiveRange(config, duration);
      if (!range.valid) {
        ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));
        return;
      }

      const bounds = this.#seekBounds(config, duration);
      const offset = allowedSeekOffset(config, duration, clamp(Number(progress.value), bounds.min, bounds.max));
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
    const stored = this.#lastCommittedConfig ?? sanitizePlaybackConfig({schemaVersion: 2});
    const config = {...stored};
    config.introEnabled = Boolean(panel.querySelector("[data-eap-toggle='introEnabled']")?.checked);
    config.loopEnabled = Boolean(panel.querySelector("[data-eap-toggle='loopEnabled']")?.checked);
    config.repeat = !config.introEnabled && !config.loopEnabled
      && Boolean(panel.querySelector("[data-eap-toggle='repeat']")?.checked);
    let validText = true;
    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      const key = input.dataset.eapConfig;
      if (!NUMERIC_KEYS.has(key)) continue;
      const group = input.closest("[data-eap-fields]");
      const visible = !group?.hidden;
      if (!visible) {
        input.classList.remove("eap-input-invalid");
        continue;
      }
      const parsed = TIME_KEYS.has(key) ? parseTime(input.value) : parseDecimal(input.value);
      const valid = Number.isFinite(parsed) && parsed >= 0;
      input.classList.toggle("eap-input-invalid", !valid);
      if (valid) config[key] = parsed;
      else if (!allowInvalidText) validText = false;
    }
    return validText ? config : null;
  }

  #syncDraftVisuals(duration) {
    const panel = this.#panel;
    if (!panel || !this.#lastCommittedConfig) return;

    const introOn = Boolean(panel.querySelector("[data-eap-toggle='introEnabled']")?.checked);
    const loopOn = Boolean(panel.querySelector("[data-eap-toggle='loopEnabled']")?.checked);
    const introGroup = panel.querySelector("[data-eap-fields='intro']");
    const loopGroup = panel.querySelector("[data-eap-fields='loop']");
    const baseGroup = panel.querySelector("[data-eap-fields='base']");
    if (introGroup) introGroup.hidden = !introOn;
    if (loopGroup) loopGroup.hidden = !loopOn;
    if (baseGroup) baseGroup.hidden = introOn || loopOn;

    const draft = this.#readPanelConfig({allowInvalidText: true});
    if (!draft) return;
    const invalidText = Boolean(panel.querySelector(".eap-input-invalid"));
    const range = effectiveRange(draft, duration);
    const draftValid = duration > 0 && range.valid && !invalidText;
    this.#dirty = invalidText || !configsEqual(draft, this.#lastCommittedConfig);
    panel.toggleAttribute("data-eap-dirty", this.#dirty);

    const warning = panel.querySelector("[data-eap-warning]");
    if (warning) warning.hidden = duration <= 0 || draftValid;
    const apply = panel.querySelector("[data-eap-action='apply']");
    if (apply) apply.disabled = !this.#dirty || !draftValid || this.#transportBusy;
    const dirtyHint = panel.querySelector("[data-eap-dirty-hint]");
    if (dirtyHint) dirtyHint.hidden = !this.#dirty;
    const committedValid = effectiveRange(this.#lastCommittedConfig, duration).valid;
    const play = panel.querySelector("[data-eap-action='play']");
    if (play) play.disabled = !committedValid || this.#dirty || this.#transportBusy;
    const progress = panel.querySelector("[data-eap-progress]");
    if (progress) progress.disabled = !committedValid || this.#dirty || this.#transportBusy;
    this.#updateTimelineMarkers(duration, draft);
    this.#updatePreview(draft, duration);
    if (!this.#isSeeking && !this.#dirty) this.#enforceDisplayedPosition(this.#lastCommittedConfig, duration);
  }

  #updatePreview(config, duration) {
    const output = this.#panel?.querySelector("[data-eap-preview]");
    if (!output) return;
    const range = effectiveRange(config, duration);
    const from = (a, b) => `${formatTime(a)} → ${formatTime(b)}`;
    const intro = range.introEnabled ? `${localize("EAP.IntroOnce")}: ${from(range.introStart, range.introEnd)}` : "";
    const loop = range.loopEnabled ? `${localize("EAP.LoopRepeat")}: ${from(range.loopStart, range.loopEnd)} ↺` : "";
    const base = range.repeat
      ? `${localize("EAP.RepeatTrack")}: ${from(range.start, range.end)} ↺`
      : `${localize("EAP.FullOnce")}: ${from(range.start, range.end)}`;
    output.textContent = [intro, loop].filter(Boolean).join(" · ") || base;
  }

  #seekBounds(config, duration) {
    const range = effectiveRange(config, duration);
    if (!range.valid) return {valid: false, min: 0, max: duration};
    return {valid: true, min: range.seekMin, max: range.seekMax};
  }

  #enforceDisplayedPosition(config, duration) {
    const resolved = this.#selection.resolve();
    if (!resolved || duration <= 0) return;
    const bounds = this.#seekBounds(config, duration);
    if (!bounds.valid) return;

    const session = this.#runtime.getSession(resolved.playlist.id, resolved.sound.id);
    if (session) return;

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
    const config = suppliedConfig ?? this.#lastCommittedConfig;
    if (!config) return;
    const range = effectiveRange(config, duration);
    const pct = value => `${clamp(Number(value) || 0, 0, duration) / duration * 100}%`;
    timeline.style.setProperty("--eap-intro-start", pct(range.introStart));
    timeline.style.setProperty("--eap-intro-end", pct(range.introEnd));
    timeline.style.setProperty("--eap-loop-start", pct(range.loopStart));
    timeline.style.setProperty("--eap-loop-end", pct(range.loopEnd));
    timeline.style.setProperty("--eap-base-start", pct(range.start));
    timeline.toggleAttribute("data-has-intro", range.introEnabled);
    timeline.toggleAttribute("data-has-loop", range.loopEnabled);
    timeline.toggleAttribute("data-has-base", !range.introEnabled && !range.loopEnabled && range.start > 0);

    const lanes = panel.querySelector("[data-eap-editor-lanes]");
    if (lanes) {
      for (const [name, active, a, b] of [
        ["intro", range.introEnabled, range.introStart, range.introEnd],
        ["loop", range.loopEnabled, range.loopStart, range.loopEnd]
      ]) {
        const lane = lanes.querySelector(`[data-eap-edit-lane='${name}']`);
        if (!lane) continue;
        lane.hidden = !active;
        const rail = lane.querySelector("[data-eap-anchor-rail]");
        if (rail) {
          const left = clamp(a, 0, duration) / duration * 100;
          const right = clamp(b, 0, duration) / duration * 100;
          rail.style.setProperty("--eap-edit-left", `${left}%`);
          rail.style.setProperty("--eap-edit-width", `${Math.max(0, right - left)}%`);
        }
        const startHandle = lane.querySelector(`[data-eap-anchor='${name}Start']`);
        const endHandle = lane.querySelector(`[data-eap-anchor='${name}End']`);
        if (startHandle) {
          startHandle.style.left = pct(a);
          startHandle.title = `${name === "intro" ? localize("EAP.IntroStart") : localize("EAP.LoopStart")}: ${formatTime(a)}`;
          startHandle.setAttribute("aria-valuenow", String(Math.round(a * 1000)));
          startHandle.setAttribute("aria-valuemax", String(Math.round(duration * 1000)));
        }
        if (endHandle) {
          endHandle.style.left = pct(b);
          endHandle.title = `${name === "intro" ? localize("EAP.IntroEnd") : localize("EAP.LoopEnd")}: ${formatTime(b)}`;
          endHandle.setAttribute("aria-valuenow", String(Math.round(b * 1000)));
          endHandle.setAttribute("aria-valuemax", String(Math.round(duration * 1000)));
        }
      }
    }

    const first = panel.querySelector("[data-eap-marker-start-label]");
    const second = panel.querySelector("[data-eap-marker-end-label]");
    if (first) first.textContent = range.introEnabled
      ? `${localize("EAP.IntroOnce")}: ${formatTime(range.introStart)}–${formatTime(range.introEnd)}`
      : `${localize("EAP.Start")}: ${formatTime(range.start)}`;
    if (second) second.textContent = range.loopEnabled
      ? `${localize("EAP.LoopRange")}: ${formatTime(range.loopStart)}–${formatTime(range.loopEnd)}`
      : `${localize("EAP.End")}: ${formatTime(range.end)}`;
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
    const candidate = sourceDuration(sound.sound);
    if (!session && Number.isFinite(candidate) && candidate > 0) duration = this.#rememberDuration(playlist, sound, candidate);
    if (duration <= 0) return;

    const committed = this.#lastCommittedConfig ?? readPlaybackConfig(sound);
    const bounds = this.#seekBounds(committed, duration);
    const slider = panel.querySelector("[data-eap-progress]");
    if (slider) {
      slider.min = "0";
      slider.max = String(duration);
      slider.disabled = !bounds.valid || this.#dirty || this.#transportBusy;
    }

    if (!this.#isSeeking) {
      let current = this.#getDisplayedPosition(playlist, sound, committed, duration);
      current = bounds.valid ? clamp(current, bounds.min, bounds.max) : clamp(current, 0, duration);
      if (!session && !sound.sound?.playing) this.#setIdlePosition(playlist, sound, current);
      if (slider) slider.value = String(current);
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(current);
    }

    const totalLabel = panel.querySelector("[data-eap-progress-end]");
    if (totalLabel) totalLabel.textContent = formatTime(duration);
    if (!this.#dirty) this.#updateTimelineMarkers(duration, committed);
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
    if (pauseButton) {
      pauseButton.disabled = (!session && !resolved.sound.playing && !resolved.sound.sound?.playing) || this.#transportBusy;
      pauseButton.innerHTML = session?.paused
        ? `<i class="fa-solid fa-play"></i> ${escapeHtml(localize("EAP.Resume"))}`
        : `<i class="fa-solid fa-pause"></i> ${escapeHtml(localize("EAP.Pause"))}`;
    }
    const stopButton = panel.querySelector("[data-eap-action='stop']");
    if (stopButton) stopButton.disabled = (!session && !resolved.sound.playing && !resolved.sound.sound?.playing) || this.#transportBusy;
    this.#updateActiveTrackInfo();
  }

  #updateActiveTrackInfo() {
    const panel = this.#panel;
    if (!panel) return;
    const active = this.#runtime.getActiveTrack();
    const name = panel.querySelector("[data-eap-playing-name]");
    const playlist = panel.querySelector("[data-eap-playing-playlist]");
    if (name) {
      name.textContent = active?.sound?.name ?? localize("EAP.NoTrackPlaying");
      name.title = active?.sound?.name ?? "";
      name.classList.toggle("eap-track-none", !active);
    }
    if (playlist) {
      playlist.textContent = active ? `· ${active.playlist.name}` : "";
      playlist.title = active?.playlist?.name ?? "";
    }
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
    const canPlay = !loadError && duration > 0 && range.valid;
    const session = this.#runtime.getSession(playlist.id, sound.id);
    const status = session?.paused ? localize("EAP.Status.Paused")
      : (session ? localize("EAP.Status.Enhanced")
        : (sound.sound?.playing || sound.playing ? localize("EAP.Status.Native") : localize("EAP.Status.Idle")));
    const current = this.#getDisplayedPosition(playlist, sound, config, duration);
    const timeInput = (key, value) => `<input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${formatTime(value)}" data-eap-config="${key}">`;
    const fields = (a, labelA, valueA, b, labelB, valueB) => `
      <div class="eap-grid">
        <label><span>${escapeHtml(localize(labelA))}</span><div class="eap-number">${timeInput(a, valueA)}</div></label>
        <label><span>${escapeHtml(localize(labelB))}</span><div class="eap-number">${timeInput(b, valueB)}</div></label>
      </div>`;

    return `
      <header class="eap-header">
        <span><i class="fa-solid fa-wave-square"></i> ${escapeHtml(localize("EAP.Title"))}</span>
        <span class="eap-status" data-eap-status data-state="${session?.paused ? "paused" : (session ? "enhanced" : "idle")}">${escapeHtml(status)}</span>
      </header>
      <div class="eap-track-summary">
        <div class="eap-track-row"><span class="eap-track-label">${escapeHtml(localize("EAP.SelectedTrack"))}</span><span class="eap-track-value"><strong class="eap-track-name" title="${escapeHtml(sound.name)}">${escapeHtml(sound.name)}</strong> <span class="eap-playlist-name">· ${escapeHtml(playlist.name)}</span></span></div>
        <div class="eap-track-row"><span class="eap-track-label">${escapeHtml(localize("EAP.PlayingTrack"))}</span><span class="eap-track-value"><strong class="eap-track-name" data-eap-playing-name></strong> <span class="eap-playlist-name" data-eap-playing-playlist></span></span></div>
      </div>
      ${loadError ? `<div class="eap-error">${escapeHtml(localize("EAP.LoadError"))}</div>` : ""}
      <div class="eap-warning" data-eap-warning ${range.valid || duration <= 0 ? "hidden" : ""}>${escapeHtml(localize("EAP.InvalidRangeHint"))}</div>
      <div class="eap-transport">
        <button type="button" data-eap-action="play" ${canPlay ? "" : "disabled"}><i class="fa-solid fa-play"></i> ${escapeHtml(localize("EAP.Play"))}</button>
        <button type="button" data-eap-action="pause" ${session || sound.playing || sound.sound?.playing ? "" : "disabled"}>${session?.paused ? `<i class="fa-solid fa-play"></i> ${escapeHtml(localize("EAP.Resume"))}` : `<i class="fa-solid fa-pause"></i> ${escapeHtml(localize("EAP.Pause"))}`}</button>
        <button type="button" data-eap-action="stop" ${session || sound.playing || sound.sound?.playing ? "" : "disabled"}><i class="fa-solid fa-stop"></i> ${escapeHtml(localize("EAP.Stop"))}</button>
      </div>
      <div class="eap-policy">
        <label class="eap-toggle"><input type="checkbox" data-eap-toggle="introEnabled" ${config.introEnabled ? "checked" : ""}> <strong>${escapeHtml(localize("EAP.IntroToggle"))}</strong></label>
        <div data-eap-fields="intro" ${config.introEnabled ? "" : "hidden"}>
          ${fields("introStart", "EAP.IntroStart", config.introStart, "introEnd", "EAP.IntroEnd", config.introEnd ?? duration)}
        </div>
        <label class="eap-toggle"><input type="checkbox" data-eap-toggle="loopEnabled" ${config.loopEnabled ? "checked" : ""}> <strong>${escapeHtml(localize("EAP.LoopToggle"))}</strong></label>
        <div data-eap-fields="loop" ${config.loopEnabled ? "" : "hidden"}>
          ${fields("loopStart", "EAP.LoopStart", config.loopStart, "loopEnd", "EAP.LoopEnd", config.loopEnd ?? duration)}
        </div>
        <div data-eap-fields="base" ${config.introEnabled || config.loopEnabled ? "hidden" : ""}>
          <label class="eap-single-time"><span>${escapeHtml(localize("EAP.StartPlaybackAt"))}</span>${timeInput("start", config.start)}</label>
          <label class="eap-toggle"><input type="checkbox" data-eap-toggle="repeat" ${config.repeat && !config.introEnabled && !config.loopEnabled ? "checked" : ""}> ${escapeHtml(localize("EAP.RepeatTrack"))}</label>
        </div>
      </div>
      <div class="eap-grid eap-fades" data-eap-fields="fades">
        <label><span>${escapeHtml(localize("EAP.FadeIn"))}</span><div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(config.fadeIn)}" data-eap-config="fadeIn"><span>s</span></div></label>
        <label><span>${escapeHtml(localize("EAP.FadeOut"))}</span><div class="eap-number"><input type="text" inputmode="decimal" autocomplete="off" value="${numberValue(config.fadeOut)}" data-eap-config="fadeOut"><span>s</span></div></label>
      </div>
      <div class="eap-playback-preview" data-eap-preview aria-live="polite"></div>
      <div class="eap-apply-row">
        <span class="eap-dirty-hint" data-eap-dirty-hint hidden>${escapeHtml(localize("EAP.UnsavedChanges"))}</span>
        <button type="button" class="eap-apply" data-eap-action="apply" disabled><i class="fa-solid fa-check"></i> ${escapeHtml(localize("EAP.OK"))}</button>
      </div>
      <div class="eap-progress-wrap">
        <div class="eap-progress-labels"><span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Current"))}</span> <strong data-eap-current>${formatTime(current)}</strong></span><span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Duration"))}</span> <strong data-eap-progress-end>${formatTime(duration)}</strong></span></div>
        <div class="eap-timeline" data-eap-timeline>
          <div class="eap-segment-highlight eap-intro-segment" aria-hidden="true"></div><div class="eap-segment-highlight eap-loop-segment" aria-hidden="true"></div>
          <span class="eap-range-marker eap-intro-marker-start" aria-hidden="true"></span><span class="eap-range-marker eap-intro-marker-end" aria-hidden="true"></span>
          <span class="eap-range-marker eap-loop-marker-start" aria-hidden="true"></span><span class="eap-range-marker eap-loop-marker-end" aria-hidden="true"></span>
          <span class="eap-range-marker eap-base-marker-start" aria-hidden="true"></span>
          <input type="range" data-eap-progress min="0" max="${duration}" step="0.01" value="${clamp(current, 0, duration)}" ${canPlay ? "" : "disabled"}>
        </div>
        <div class="eap-marker-labels"><span data-eap-marker-start-label></span><span data-eap-marker-end-label></span></div>
        <div class="eap-editor-lanes" data-eap-editor-lanes>
          ${editLane("intro", "EAP.IntroRail", "EAP.IntroStart", "EAP.IntroEnd", config.introEnabled)}
          ${editLane("loop", "EAP.LoopRail", "EAP.LoopStart", "EAP.LoopEnd", config.loopEnabled)}
        </div>
      </div>
      <div class="eap-footer-actions"><button type="button" class="eap-reset" data-eap-action="reset"><i class="fa-solid fa-rotate-left"></i> ${escapeHtml(localize("EAP.ResetTrack"))}</button></div>
    `;
  }

}

/** Compact independent editing tracks below the playback timeline. */
function editLane(name, labelKey, startKey, endKey, visible) {
  const handle = (edge, titleKey) => `<button type="button" class="eap-anchor eap-anchor-${edge}"
    data-eap-anchor="${name}${edge === "start" ? "Start" : "End"}"
    role="slider" aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="0"
    aria-valuenow="0" aria-label="${escapeHtml(localize(titleKey))}"
    title="${escapeHtml(localize(titleKey))}"></button>`;
  return `<div class="eap-edit-lane eap-edit-lane-${name}" data-eap-edit-lane="${name}" ${visible ? "" : "hidden"}>
    <span class="eap-edit-label">${escapeHtml(localize(labelKey))}</span>
    <div class="eap-anchor-rail" data-eap-anchor-rail="${name}">
      <span class="eap-anchor-fill" aria-hidden="true"></span>
      ${handle("start", startKey)}${handle("end", endKey)}
    </div>
  </div>`;
}

function changedConfigKeys(previous, next) {
  const keys = new Set();
  for (const key of CONFIG_KEYS) if (!sameValue(previous?.[key], next?.[key])) keys.add(key);
  return keys;
}

function configsEqual(a, b) {
  if (!a || !b) return false;
  return CONFIG_KEYS.every(key => sameValue(a[key], b[key]));
}

function sameValue(a, b) {
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  const an = Number(a), bn = Number(b);
  return Number.isFinite(an) && Number.isFinite(bn) ? Math.abs(an - bn) < 0.0005 : String(a) === String(b);
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

/** Accept seconds, MM:SS(.mmm), or HH:MM:SS(.mmm); decimals can use comma. */
export function parseTime(value) {
  const text = String(value ?? "").trim().replace(",", ".");
  const parts = text.split(":");
  if (parts.length === 1) return parseDecimal(text);
  if (parts.length !== 2 && parts.length !== 3) return NaN;
  if (parts.some(part => !part || !/^\d+(?:\.\d+)?$/.test(part))) return NaN;
  if (parts.slice(0, -1).some(part => !/^\d+$/.test(part))) return NaN;
  const numbers = parts.map(Number);
  const seconds = numbers.at(-1);
  if (seconds >= 60) return NaN;
  if (parts.length === 2) return numbers[0] * 60 + seconds;
  if (numbers[1] >= 60) return NaN;
  return numbers[0] * 3600 + numbers[1] * 60 + seconds;
}

/** Snap gap seeks to the nearest playable segment; no hidden gap playback. */
export function allowedSeekOffset(config, duration, requested) {
  const range = effectiveRange(config, duration);
  if (!range.valid) return Math.max(0, Number(requested) || 0);
  const at = clamp(Number(requested), range.seekMin, range.seekMax);
  if (!range.introEnabled || !range.loopEnabled) return at;
  const inIntro = at >= range.introStart && at <= range.introEnd;
  const inLoop = at >= range.loopStart && at <= range.loopEnd;
  if (inIntro || inLoop) return at;
  // Skip a silent gap between Intro End and a later Loop Start.
  if (range.introEnd < range.loopStart && at > range.introEnd && at < range.loopStart) return range.loopStart;
  const endpoints = [range.introStart, range.introEnd, range.loopStart, range.loopEnd];
  return endpoints.reduce((best, point) => Math.abs(point-at) < Math.abs(best-at) ? point : best, endpoints[0]);
}

function insertAtSelection(input, text) {
  const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
  input.setRangeText(text, start, end, "end");
}

/** Numeric rolling millisecond mask. Key 5000 => 00:05.000. */
export function shiftMaskedTime(current, key, {replace = false} = {}) {
  const parsed = replace ? 0 : parseTime(current);
  const currentMs = Math.max(0, Math.round((Number.isFinite(parsed) ? parsed : 0) * 1000));
  if (key === "backspace") return Math.floor(currentMs / 10) / 1000;
  if (!/^[0-9]$/.test(String(key))) return currentMs / 1000;
  const result = currentMs * 10 + Number(key);
  return Number.isSafeInteger(result) ? result / 1000 : currentMs / 1000;
}

/** Clipboard accepts formatted MM:SS.mmm and raw mask digits. */
export function parsePastedTime(text) {
  const value = String(text ?? "").trim();
  if (/^\d+$/.test(value)) return Number(value) / 1000;
  return parseTime(value);
}

/** Clamps an edited handle to the full-track scale and keeps its own pair
 *  ordered by at least one millisecond. Other segments may overlap freely. */
export function constrainAnchorTime(key, target, config, duration) {
  const maxMs = Math.max(0, Math.round(Number(duration) * 1000));
  const other = key.endsWith("Start") ? key.replace(/Start$/, "End") : key.replace(/End$/, "Start");
  const otherMs = Math.max(0, Math.round(Number(config[other]) * 1000));
  const requestedMs = Math.round(Number(target) * 1000);
  const isStart = key.endsWith("Start");
  const min = isStart ? 0 : otherMs + 1;
  const max = isStart ? otherMs - 1 : maxMs;
  if (!Number.isFinite(requestedMs) || max < min) return Math.max(0, Number(config[key]) || 0);
  return Math.min(Math.max(requestedMs, min), max) / 1000;
}

export function formatTime(seconds) {
  const totalMs = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const pad = n => String(n).padStart(2, "0");
  const prefix = hours ? `${pad(hours)}:${pad(minutes)}` : pad(Math.floor(totalMs / 60000));
  return `${prefix}:${pad(secs)}.${String(millis).padStart(3, "0")}`;
}
