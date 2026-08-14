/**
 * Foundry V13/V14 compatibility helpers.
 *
 * Keep version-sensitive PlaylistDirectory/DOM knowledge in one place so the
 * playback runtime remains version-agnostic.
 */

export function foundryGeneration() {
  const releaseGeneration = Number(game?.release?.generation);
  if (Number.isFinite(releaseGeneration) && releaseGeneration > 0) return releaseGeneration;

  const raw = String(game?.version ?? game?.release?.version ?? "");
  const match = /^(\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

export function foundryBuild() {
  const releaseBuild = Number(game?.release?.build);
  if (Number.isFinite(releaseBuild) && releaseBuild > 0) return releaseBuild;

  const raw = String(game?.version ?? game?.release?.version ?? "");
  const match = /^\d+\.(\d+)/.exec(raw);
  return match ? Number(match[1]) : 0;
}

export function supportedFoundryCore() {
  const generation = foundryGeneration();
  const build = foundryBuild();
  if (generation === 13) return build === 0 || build >= 341;
  if (generation === 14) return true;
  return false;
}

export function isPlaylistDirectoryApplication(application) {
  const PlaylistDirectory = globalThis.foundry?.applications?.sidebar?.tabs?.PlaylistDirectory;
  if (PlaylistDirectory && application instanceof PlaylistDirectory) return true;

  // Defensive fallback for the same AppV2 class exposed through a different
  // realm/reference. Both V13 and V14 identify this sidebar tab as playlists.
  return application?.constructor?.name === "PlaylistDirectory"
    && (application?.tabName === "playlists" || application?.options?.collection === "playlists");
}

export function normalizeRenderElement(element) {
  if (element instanceof HTMLElement) return element;
  // AppV2 V13/V14 pass HTMLElement, but accepting an array/jQuery-like wrapper
  // costs nothing and protects the integration if another module wraps a hook.
  if (element?.[0] instanceof HTMLElement) return element[0];
  return null;
}

export function isCurrentlyPlayingElement(target) {
  return Boolean(target?.closest?.(
    ".currently-playing, [data-part='playing'], [data-application-part='playing'], [data-tab='playing']"
  ));
}

export function resolvePlaylistSoundFromElement(target, root) {
  if (!(target instanceof Element) || !(root instanceof HTMLElement)) return null;

  const soundIndex = new Map();
  const playlists = game.playlists?.values?.() ?? game.playlists ?? [];
  for (const playlist of playlists) {
    const sounds = playlist.sounds?.values?.() ?? playlist.sounds ?? [];
    for (const sound of sounds) {
      const list = soundIndex.get(sound.id) ?? [];
      list.push({playlist, sound});
      soundIndex.set(sound.id, list);
    }
  }

  let node = target;
  while (node instanceof HTMLElement && node !== root) {
    const uuid = node.dataset?.uuid;
    if (uuid) {
      const parsed = resolvePlaylistSoundUuid(uuid);
      if (parsed && findParentPlaylistId(node, root) === parsed.playlist.id) return {...parsed, row: node};
    }

    const ids = [
      node.dataset?.soundId,
      node.dataset?.playlistSoundId,
      node.dataset?.documentId,
      node.dataset?.entryId
    ].filter(Boolean);

    for (const id of ids) {
      const playlistId = findParentPlaylistId(node, root);
      if (!playlistId) continue;
      const exact = (soundIndex.get(id) ?? []).find(match => match.playlist.id === playlistId);
      if (exact) return {...exact, row: node};
    }
    node = node.parentElement;
  }
  return null;
}

export function findParentPlaylistId(node, root) {
  let current = node?.parentElement;
  while (current instanceof HTMLElement && current !== root) {
    const candidates = [
      current.dataset?.playlistId,
      current.dataset?.entryId,
      current.dataset?.documentId
    ].filter(Boolean);

    for (const id of candidates) {
      if (game.playlists?.has(id)) return id;
    }

    const uuid = current.dataset?.uuid;
    if (uuid) {
      const playlistId = playlistIdFromUuid(uuid);
      if (playlistId && game.playlists?.has(playlistId)) return playlistId;
    }
    current = current.parentElement;
  }
  return null;
}

export function findPlaylistSoundRow(root, playlistId, soundId) {
  if (!(root instanceof HTMLElement) || !playlistId || !soundId) return null;
  const escaped = cssEscape(soundId);
  const selectors = [
    `[data-sound-id="${escaped}"]`,
    `[data-playlist-sound-id="${escaped}"]`,
    `[data-document-id="${escaped}"]`,
    `[data-entry-id="${escaped}"]`
  ];

  for (const selector of selectors) {
    for (const row of root.querySelectorAll(selector)) {
      if (!(row instanceof HTMLElement)) continue;
      if (findParentPlaylistId(row, root) !== playlistId) continue;
      return row;
    }
  }

  // UUID fallback is useful when a core/template version omits a dedicated
  // sound-id dataset attribute.
  for (const row of root.querySelectorAll("[data-uuid]")) {
    if (!(row instanceof HTMLElement)) continue;
    const resolved = resolvePlaylistSoundUuid(row.dataset.uuid);
    if (resolved?.playlist.id === playlistId && resolved?.sound.id === soundId) return row;
  }
  return null;
}

function resolvePlaylistSoundUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  const playlistAt = parts.indexOf("Playlist");
  if (playlistAt < 0) return null;
  const playlistId = parts[playlistAt + 1];
  const soundAt = parts.findIndex((part, index) => index > playlistAt + 1 && part === "PlaylistSound");
  if (!playlistId || soundAt < 0) return null;
  const soundId = parts[soundAt + 1];
  const playlist = game.playlists?.get(playlistId);
  const sound = playlist?.sounds?.get(soundId);
  return playlist && sound ? {playlist, sound} : null;
}

function playlistIdFromUuid(uuid) {
  const parts = String(uuid ?? "").split(".");
  const playlistAt = parts.indexOf("Playlist");
  return playlistAt >= 0 ? parts[playlistAt + 1] ?? null : null;
}

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, "\\$&");
}
