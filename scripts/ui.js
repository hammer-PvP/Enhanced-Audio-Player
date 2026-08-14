import {MODULE_ID} from "./constants.js";
import {clamp, effectiveRange, readPlaybackConfig, resetPlaybackConfig, writePlaybackConfig} from "./config.js";

const PANEL_CLASS = "eap-panel";
const SELECTED_CLASS = "eap-selected-track";
const INTERACTIVE_SELECTOR = "button, input, select, textarea, [data-action], [role='button'], .control, .controls, .sound-control, .volume";

export class EnhancedAudioPlayerUI {
  #selection;
  #runtime;
  #root = null;
  #panel = null;
  #renderToken = 0;
  #progressFrame = null;
  #saving = false;
  #isSeeking = false;
  #boundRoots = new WeakSet();
  #durationCache = new Map();

  constructor({selection, runtime}) {
    this.#selection = selection;
    this.#runtime = runtime;
  }

  onPlaylistDirectoryRender(application, element) {
    if (!game.user?.isGM) return;
    const PlaylistDirectory = foundry?.applications?.sidebar?.tabs?.PlaylistDirectory;
    if (!PlaylistDirectory || !(application instanceof PlaylistDirectory)) return;

    this.#root = element;
    element.querySelector(`.${PANEL_CLASS}`)?.remove();

    const panel = document.createElement("section");
    panel.className = PANEL_CLASS;
    panel.dataset.moduleId = MODULE_ID;
    element.append(panel);
    this.#panel = panel;
    this.#isSeeking = false;

    if (!this.#boundRoots.has(element)) {
      element.addEventListener("click", event => this.#onDirectoryClick(event));
      this.#boundRoots.add(element);
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
      if (Number.isFinite(candidate) && candidate > 0) {
        duration = this.#rememberDuration(playlist, sound, candidate);
      }
    } catch (error) {
      loadError = true;
      console.warn(`${MODULE_ID} | Unable to load selected sound`, error);
    }

    if (token !== this.#renderToken || !this.#panel?.isConnected) return;
    const config = readPlaybackConfig(sound);
    this.#panel.innerHTML = this.#configuredPanelHtml({playlist, sound, config, duration, loadError});
    this.#attachPanelListeners({playlist, sound, duration});
    this.#updateProgress();
  }

  onSessionChanged() {
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

  #cachedDuration(playlist, sound) {
    return this.#durationCache.get(this.#durationKey(playlist, sound)) ?? 0;
  }

  #rememberDuration(playlist, sound, candidate) {
    const key = this.#durationKey(playlist, sound);
    const prior = Number(this.#durationCache.get(key)) || 0;
    // Total source duration should be stable. Keeping the greatest positive value
    // prevents a later limited playback cycle from contaminating track metadata.
    const duration = Math.max(prior, Number(candidate) || 0);
    if (duration > 0) this.#durationCache.set(key, duration);
    return duration;
  }

  #onDirectoryClick(event) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(`.${PANEL_CLASS}`)) return;
    if (event.target.closest(".currently-playing, [data-part='playing'], [data-application-part='playing']")) return;
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;

    const match = this.#resolveSoundFromElement(event.target);
    if (!match) return;

    this.#selection.select(match.playlist.id, match.sound.id);
    this.#highlightSelection(match.row);
    this.#isSeeking = false;
    void this.renderPanel();
  }

  #resolveSoundFromElement(target) {
    const soundIndex = new Map();
    for (const playlist of game.playlists ?? []) {
      for (const sound of playlist.sounds ?? []) {
        const list = soundIndex.get(sound.id) ?? [];
        list.push({playlist, sound});
        soundIndex.set(sound.id, list);
      }
    }

    let node = target;
    while (node instanceof HTMLElement && node !== this.#root) {
      const uuid = node.dataset?.uuid;
      if (uuid) {
        const parsed = this.#resolveByUuid(uuid);
        if (parsed && this.#findParentPlaylistId(node) === parsed.playlist.id) return {...parsed, row: node};
      }

      const ids = [node.dataset?.soundId, node.dataset?.documentId, node.dataset?.entryId].filter(Boolean);
      for (const id of ids) {
        const matches = soundIndex.get(id) ?? [];
        const playlistId = this.#findParentPlaylistId(node);
        if (!playlistId) continue;
        const exact = matches.find(match => match.playlist.id === playlistId);
        if (exact) return {...exact, row: node};
      }
      node = node.parentElement;
    }
    return null;
  }

  #resolveByUuid(uuid) {
    const parts = String(uuid).split(".");
    const playlistAt = parts.indexOf("Playlist");
    if (playlistAt < 0) return null;
    const playlistId = parts[playlistAt + 1];
    const soundTypeAt = parts.findIndex((part, index) => index > playlistAt + 1 && part === "PlaylistSound");
    if (!playlistId || soundTypeAt < 0) return null;
    const soundId = parts[soundTypeAt + 1];
    const playlist = game.playlists?.get(playlistId);
    const sound = playlist?.sounds?.get(soundId);
    return playlist && sound ? {playlist, sound} : null;
  }

  #findParentPlaylistId(node) {
    let current = node?.parentElement;
    while (current instanceof HTMLElement && current !== this.#root) {
      const id = current.dataset?.entryId ?? current.dataset?.documentId;
      if (id && game.playlists?.has(id)) return id;
      if (current.dataset?.playlistId && game.playlists?.has(current.dataset.playlistId)) return current.dataset.playlistId;
      current = current.parentElement;
    }
    return null;
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

    const soundId = CSS.escape(selected.sound.id);
    const selectors = [
      `[data-sound-id="${soundId}"]`,
      `[data-document-id="${soundId}"]`,
      `[data-entry-id="${soundId}"]`
    ];
    for (const selector of selectors) {
      for (const row of this.#root.querySelectorAll(selector)) {
        if (!(row instanceof HTMLElement) || row.closest(`.${PANEL_CLASS}`)) continue;
        if (this.#findParentPlaylistId(row) !== selected.playlist.id) continue;
        row.classList.add(SELECTED_CLASS);
        return;
      }
    }
  }

  #attachPanelListeners({playlist, sound, duration}) {
    const panel = this.#panel;
    if (!panel) return;

    panel.querySelector("[data-eap-action='play']")?.addEventListener("click", async () => {
      await this.#persistFromPanel(sound);
      const config = readPlaybackConfig(sound);
      const range = effectiveRange(config, duration);
      if (!range.valid) return ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));

      try {
        await this.#runtime.playFromGM(playlist, sound, config, duration);
      } catch (error) {
        console.error(`${MODULE_ID} | Play failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PlayFailed"));
      }
      this.#updatePlaybackStatus();
    });

    panel.querySelector("[data-eap-action='pause']")?.addEventListener("click", async () => {
      try {
        await this.#runtime.pauseFromGM(playlist.id, sound.id);
      } catch (error) {
        console.error(`${MODULE_ID} | Pause failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PauseFailed"));
      }
      this.#updatePlaybackStatus();
      this.#updateProgress();
    });

    panel.querySelector("[data-eap-action='stop']")?.addEventListener("click", async () => {
      try {
        await this.#runtime.stopFromGM(playlist, sound);
      } catch (error) {
        console.error(`${MODULE_ID} | Stop failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.StopFailed"));
      }
      this.#updatePlaybackStatus();
      this.#updateProgress();
    });

    panel.querySelector("[data-eap-action='reset']")?.addEventListener("click", async () => {
      try {
        if (this.#runtime.isEnhanced(playlist.id, sound.id)) await this.#runtime.stopFromGM(playlist, sound);
        await resetPlaybackConfig(sound);
        ui.notifications?.info(localize("EAP.Notifications.ResetComplete"));
        await this.renderPanel();
      } catch (error) {
        console.error(`${MODULE_ID} | Reset failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.ResetFailed"));
      }
    });

    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      if (["start", "end"].includes(input.dataset.eapConfig)) {
        input.addEventListener("input", () => this.#updateTimelineMarkers(duration));
      }

      input.addEventListener("change", async event => {
        if (event.currentTarget?.dataset?.eapConfig === "fullTrack") this.#syncDisabledState();
        await this.#persistFromPanel(sound);
        this.#updateTimelineMarkers(duration);
      });
    }

    const progress = panel.querySelector("[data-eap-progress]");
    progress?.addEventListener("pointerdown", () => {
      this.#isSeeking = true;
    });
    progress?.addEventListener("input", event => {
      this.#isSeeking = true;
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(Number(event.currentTarget.value));
    });
    progress?.addEventListener("change", async event => {
      try {
        if (!this.#runtime.isEnhanced(playlist.id, sound.id)) return;
        await this.#runtime.seekFromGM(playlist.id, sound.id, Number(event.currentTarget.value));
      } finally {
        this.#isSeeking = false;
        this.#updateProgress();
      }
    });
    progress?.addEventListener("blur", () => {
      this.#isSeeking = false;
      this.#updateProgress();
    });

    this.#syncDisabledState();
    this.#updateTimelineMarkers(duration);
  }

  async #persistFromPanel(sound) {
    if (this.#saving || !this.#panel) return;
    const current = readPlaybackConfig(sound);
    const values = {...current};

    for (const input of this.#panel.querySelectorAll("[data-eap-config]")) {
      const key = input.dataset.eapConfig;
      if (!key) continue;
      if (input.type === "checkbox") values[key] = input.checked;
      else values[key] = input.value === "" ? null : Number(input.value);
    }

    this.#saving = true;
    try {
      await writePlaybackConfig(sound, values);
    } finally {
      this.#saving = false;
    }
  }

  #syncDisabledState() {
    const panel = this.#panel;
    if (!panel) return;
    const fullTrack = panel.querySelector("[data-eap-config='fullTrack']")?.checked ?? true;
    for (const key of ["start", "end", "loop"]) {
      const input = panel.querySelector(`[data-eap-config='${key}']`);
      if (input) input.disabled = fullTrack;
    }
    panel.querySelector("[data-eap-timeline]")?.toggleAttribute("data-full-track", fullTrack);
  }

  #updateTimelineMarkers(duration) {
    const panel = this.#panel;
    const timeline = panel?.querySelector("[data-eap-timeline]");
    if (!panel || !timeline || duration <= 0) return;

    const fullTrack = panel.querySelector("[data-eap-config='fullTrack']")?.checked ?? true;
    const start = Number(panel.querySelector("[data-eap-config='start']")?.value) || 0;
    const endRaw = Number(panel.querySelector("[data-eap-config='end']")?.value);
    const end = Number.isFinite(endRaw) ? endRaw : duration;
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

    const slider = panel.querySelector("[data-eap-progress]");
    if (slider) {
      slider.min = "0";
      slider.max = String(duration);
      slider.disabled = !session;
    }

    if (!this.#isSeeking) {
      let current = session ? this.#runtime.getPosition(playlist.id, sound.id) : Number(sound.sound?.currentTime);
      if (!Number.isFinite(current)) current = 0;
      current = clamp(current, 0, duration);
      if (slider) slider.value = String(current);
      const currentLabel = panel.querySelector("[data-eap-current]");
      if (currentLabel) currentLabel.textContent = formatTime(current);
    }

    const totalLabel = panel.querySelector("[data-eap-progress-end]");
    if (totalLabel) totalLabel.textContent = formatTime(duration);
    this.#updateTimelineMarkers(duration);
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
    if (pauseButton) pauseButton.disabled = !session || Boolean(session.paused);
    const stopButton = panel.querySelector("[data-eap-action='stop']");
    if (stopButton) stopButton.disabled = !session && !resolved.sound.playing && !resolved.sound.sound?.playing;
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
    const canPlay = !loadError && duration > 0;
    const session = this.#runtime.getSession(playlist.id, sound.id);
    const status = session?.paused
      ? localize("EAP.Status.Paused")
      : (session
        ? localize("EAP.Status.Enhanced")
        : (sound.sound?.playing || sound.playing ? localize("EAP.Status.Native") : localize("EAP.Status.Idle")));

    const startPct = duration > 0 ? clamp(config.start, 0, duration) / duration * 100 : 0;
    const endPct = duration > 0 ? clamp(endValue, 0, duration) / duration * 100 : 100;
    const widthPct = Math.max(0, endPct - startPct);

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
      ${!config.fullTrack && !range.valid && duration > 0 ? `<div class="eap-warning">${escapeHtml(localize("EAP.InvalidRangeHint"))}</div>` : ""}

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
          <div class="eap-number"><input type="number" min="0" step="0.001" value="${numberValue(config.start)}" data-eap-config="start"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.End"))}</span>
          <div class="eap-number"><input type="number" min="0" step="0.001" value="${numberValue(endValue)}" data-eap-config="end"><span>s</span></div>
        </label>
      </div>

      <label class="eap-toggle">
        <input type="checkbox" data-eap-config="loop" ${config.loop ? "checked" : ""}>
        <span>${escapeHtml(localize("EAP.LoopRange"))}</span>
      </label>

      <div class="eap-grid">
        <label>
          <span>${escapeHtml(localize("EAP.FadeIn"))}</span>
          <div class="eap-number"><input type="number" min="0" step="0.050" value="${numberValue(config.fadeIn)}" data-eap-config="fadeIn"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.FadeOut"))}</span>
          <div class="eap-number"><input type="number" min="0" step="0.050" value="${numberValue(config.fadeOut)}" data-eap-config="fadeOut"><span>s</span></div>
        </label>
      </div>

      <div class="eap-progress-wrap">
        <div class="eap-progress-labels">
          <span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Current"))}</span> <strong data-eap-current>${formatTime(session ? this.#runtime.getPosition(playlist.id, sound.id) : 0)}</strong></span>
          <span><span class="eap-progress-caption">${escapeHtml(localize("EAP.Duration"))}</span> <strong data-eap-progress-end>${formatTime(duration)}</strong></span>
        </div>
        <div class="eap-timeline" data-eap-timeline ${config.fullTrack ? "data-full-track" : ""}
             style="--eap-start-pct:${startPct}%;--eap-end-pct:${endPct}%;--eap-range-width:${widthPct}%">
          <div class="eap-range-highlight" aria-hidden="true"></div>
          <span class="eap-range-marker eap-range-marker-start" aria-hidden="true"></span>
          <span class="eap-range-marker eap-range-marker-end" aria-hidden="true"></span>
          <input type="range" data-eap-progress min="0" max="${duration}" step="0.01" value="${session ? clamp(this.#runtime.getPosition(playlist.id, sound.id), 0, duration) : 0}" ${session ? "" : "disabled"}>
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

export function formatTime(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(safe / 60);
  const remainder = safe - minutes * 60;
  const whole = Math.floor(remainder);
  const millis = Math.floor((remainder - whole) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
