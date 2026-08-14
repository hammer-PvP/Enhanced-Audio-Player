# Changelog

## 0.0.2

Playback-state and editor corrections from the first live Foundry test.

- Added distinct **Play**, **Pause**, and **Stop** controls.
- Play resumes a paused Enhanced session; Stop ends it and the next Play starts from the configured beginning.
- Fixed progress seeking fighting against the animation-frame progress updater while the GM drags the thumb.
- Progress/seek now always represents the entire source track from 0 to total duration.
- Added visual Start and End markers plus range highlighting over the full-track timeline.
- Decoupled persisted Start/End values from runtime duration normalization. A transient Sound duration can no longer rewrite valid saved values into a tiny range such as 14.999 → 15.000.
- Added per-track duration caching keyed by Playlist, PlaylistSound, and source path to prevent duration metadata leaking between selections or limited playback cycles.
- Full Track now always resolves to 0 → full source duration and ignores stored custom Start/End/Loop values without deleting them.
- Added **Reset Track** to remove only `flags.enhanced-audio-player.playback` from the selected PlaylistSound and return it to the unconfigured Full Track default.
- Invalid custom ranges are preserved for editing rather than destructively clamped; playback is blocked until the range is valid.

## 0.0.1

Initial release.

- Added GM-only Enhanced Audio Player panel below the native Playlist Directory.
- Added click-to-select behavior for PlaylistSound rows without changing native playback controls.
- Added per-sound Full Track, Start, End, Loop Range, Fade In, and Fade Out configuration.
- Added persistent namespaced PlaylistSound flags.
- Added Enhanced Play and Stop controls.
- Added native-Sound progress tracking and seek during Enhanced playback.
- Added connected-client playback commands without replacing Foundry's Playlist, PlaylistSound, or Sound classes.
- Added English and Brazilian Portuguese localization.
