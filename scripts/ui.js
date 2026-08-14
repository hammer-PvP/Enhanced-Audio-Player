import {MODULE_ID} from "./constants.js";
import {effectiveRange, normalizePlaybackConfig, readPlaybackConfig, writePlaybackConfig} from "./config.js";

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
  #boundRoots = new WeakSet();

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

    let duration = 0;
    let loadError = false;
    try {
      await sound.load();
      duration = Number(sound.sound?.duration) || 0;
    } catch (error) {
      loadError = true;
      console.warn(`${MODULE_ID} | Unable to load selected sound`, error);
    }

    if (token !== this.#renderToken || !this.#panel?.isConnected) return;
    const config = readPlaybackConfig(sound, duration);
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

  #onDirectoryClick(event) {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest(`.${PANEL_CLASS}`)) return;
    if (event.target.closest(".currently-playing, [data-part='playing'], [data-application-part='playing']")) return;
    if (event.target.closest(INTERACTIVE_SELECTOR)) return;

    const match = this.#resolveSoundFromElement(event.target);
    if (!match) return;

    this.#selection.select(match.playlist.id, match.sound.id);
    this.#highlightSelection(match.row);
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
        if (parsed && this.#findParentPlaylistId(node) === parsed.playlist.id) {
          return {...parsed, row: node};
        }
      }

      const ids = [
        node.dataset?.soundId,
        node.dataset?.documentId,
        node.dataset?.entryId
      ].filter(Boolean);

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
      await this.#persistFromPanel(sound, duration);
      const config = readPlaybackConfig(sound, duration);
      const range = effectiveRange(config, duration);
      if (range.length <= 0) return ui.notifications?.warn(localize("EAP.Notifications.InvalidRange"));

      try {
        const requiresEnhancedRuntime = !config.fullTrack || config.fadeIn > 0 || config.fadeOut > 0;
        if (requiresEnhancedRuntime) {
          await this.#runtime.playFromGM(playlist, sound, config, duration);
        } else {
          await this.#runtime.playNativeFromGM(playlist, sound);
        }
      } catch (error) {
        console.error(`${MODULE_ID} | Play failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.PlayFailed"));
      }
      this.#updatePlaybackStatus();
    });

    panel.querySelector("[data-eap-action='stop']")?.addEventListener("click", async () => {
      try {
        await this.#runtime.stopFromGM(playlist, sound);
      } catch (error) {
        console.error(`${MODULE_ID} | Stop failed`, error);
        ui.notifications?.error(localize("EAP.Notifications.StopFailed"));
      }
      this.#updatePlaybackStatus();
    });

    for (const input of panel.querySelectorAll("[data-eap-config]")) {
      input.addEventListener("change", async event => {
        if (event.currentTarget?.dataset?.eapConfig === "fullTrack") this.#syncDisabledState();
        await this.#persistFromPanel(sound, duration);
        await this.renderPanel();
      });
    }

    const progress = panel.querySelector("[data-eap-progress]");
    progress?.addEventListener("change", async event => {
      if (!this.#runtime.isEnhanced(playlist.id, sound.id)) return;
      await this.#runtime.seekFromGM(playlist.id, sound.id, Number(event.currentTarget.value));
    });

    this.#syncDisabledState();
  }

  async #persistFromPanel(sound, duration) {
    if (this.#saving || !this.#panel) return;
    const current = readPlaybackConfig(sound, duration);
    const values = {...current};

    for (const input of this.#panel.querySelectorAll("[data-eap-config]")) {
      const key = input.dataset.eapConfig;
      if (!key) continue;
      if (input.type === "checkbox") values[key] = input.checked;
      else values[key] = Number(input.value);
    }

    const normalized = normalizePlaybackConfig(values, duration);
    this.#saving = true;
    try {
      await writePlaybackConfig(sound, normalized, duration);
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
    const nativeSound = sound.sound;
    const duration = Number(nativeSound?.duration) || Number(panel.dataset.duration) || 0;
    const config = readPlaybackConfig(sound, duration);
    const range = effectiveRange(config, duration);
    const activeEnhanced = this.#runtime.getSession(playlist.id, sound.id);

    const min = activeEnhanced?.rangeStart ?? range.start;
    const max = activeEnhanced?.rangeEnd ?? range.end;
    let current = Number(nativeSound?.currentTime);
    if (!Number.isFinite(current)) current = min;
    current = Math.min(Math.max(current, min), max || min);

    const slider = panel.querySelector("[data-eap-progress]");
    if (slider) {
      slider.min = String(min);
      slider.max = String(max || min);
      slider.value = String(current);
      slider.disabled = !nativeSound?.playing;
    }

    const currentLabel = panel.querySelector("[data-eap-current]");
    if (currentLabel) currentLabel.textContent = formatTime(current);
    const endLabel = panel.querySelector("[data-eap-progress-end]");
    if (endLabel) endLabel.textContent = formatTime(max);
    this.#updatePlaybackStatus();
  }

  #updatePlaybackStatus() {
    const panel = this.#panel;
    const resolved = this.#selection.resolve();
    if (!panel || !resolved) return;
    const status = panel.querySelector("[data-eap-status]");
    if (!status) return;

    if (this.#runtime.isEnhanced(resolved.playlist.id, resolved.sound.id)) {
      status.textContent = localize("EAP.Status.Enhanced");
      status.dataset.state = "enhanced";
    } else if (resolved.sound.sound?.playing || resolved.sound.playing) {
      status.textContent = localize("EAP.Status.Native");
      status.dataset.state = "native";
    } else {
      status.textContent = localize("EAP.Status.Idle");
      status.dataset.state = "idle";
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
    const endValue = config.end ?? duration;
    const canPlay = !loadError && duration > 0;
    const status = this.#runtime.isEnhanced(playlist.id, sound.id)
      ? localize("EAP.Status.Enhanced")
      : (sound.sound?.playing || sound.playing ? localize("EAP.Status.Native") : localize("EAP.Status.Idle"));

    this.#panel.dataset.duration = String(duration);

    return `
      <header class="eap-header">
        <span><i class="fa-solid fa-wave-square"></i> ${escapeHtml(localize("EAP.Title"))}</span>
        <span class="eap-status" data-eap-status>${escapeHtml(status)}</span>
      </header>

      <div class="eap-track-block">
        <div class="eap-track-label">${escapeHtml(localize("EAP.SelectedTrack"))}</div>
        <div class="eap-track-name" title="${escapeHtml(sound.name)}">${escapeHtml(sound.name)}</div>
        <div class="eap-playlist-name">${escapeHtml(playlist.name)}</div>
      </div>

      ${loadError ? `<div class="eap-error">${escapeHtml(localize("EAP.LoadError"))}</div>` : ""}

      <div class="eap-transport">
        <button type="button" data-eap-action="play" ${canPlay ? "" : "disabled"}>
          <i class="fa-solid fa-play"></i> ${escapeHtml(localize("EAP.Play"))}
        </button>
        <button type="button" data-eap-action="stop">
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
          <div class="eap-number"><input type="number" min="0" max="${duration}" step="0.001" value="${numberValue(config.start)}" data-eap-config="start"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.End"))}</span>
          <div class="eap-number"><input type="number" min="0" max="${duration}" step="0.001" value="${numberValue(endValue)}" data-eap-config="end"><span>s</span></div>
        </label>
      </div>

      <label class="eap-toggle">
        <input type="checkbox" data-eap-config="loop" ${config.loop ? "checked" : ""}>
        <span>${escapeHtml(localize("EAP.LoopRange"))}</span>
      </label>

      <div class="eap-grid">
        <label>
          <span>${escapeHtml(localize("EAP.FadeIn"))}</span>
          <div class="eap-number"><input type="number" min="0" max="${range.length}" step="0.050" value="${numberValue(config.fadeIn)}" data-eap-config="fadeIn"><span>s</span></div>
        </label>
        <label>
          <span>${escapeHtml(localize("EAP.FadeOut"))}</span>
          <div class="eap-number"><input type="number" min="0" max="${range.length}" step="0.050" value="${numberValue(config.fadeOut)}" data-eap-config="fadeOut"><span>s</span></div>
        </label>
      </div>

      <div class="eap-progress-wrap">
        <div class="eap-progress-labels"><span data-eap-current>${formatTime(range.start)}</span><span data-eap-progress-end>${formatTime(range.end)}</span></div>
        <input type="range" data-eap-progress min="${range.start}" max="${range.end}" step="0.01" value="${range.start}" ${canPlay ? "" : "disabled"}>
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
