export class SelectionState {
  #playlistId = null;
  #soundId = null;

  get playlistId() {
    return this.#playlistId;
  }

  get soundId() {
    return this.#soundId;
  }

  get key() {
    return this.#playlistId && this.#soundId ? `${this.#playlistId}.${this.#soundId}` : null;
  }

  get hasSelection() {
    return Boolean(this.#playlistId && this.#soundId);
  }

  select(playlistId, soundId) {
    this.#playlistId = playlistId ?? null;
    this.#soundId = soundId ?? null;
  }

  clear() {
    this.#playlistId = null;
    this.#soundId = null;
  }

  resolve() {
    if (!this.hasSelection) return null;
    const playlist = game.playlists?.get(this.#playlistId);
    const sound = playlist?.sounds?.get(this.#soundId);
    if (!playlist || !sound) {
      this.clear();
      return null;
    }
    return {playlist, sound};
  }
}
