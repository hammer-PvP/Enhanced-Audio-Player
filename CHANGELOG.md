# Changelog

## 0.0.3

Transport determinism and reactive range-editor patch.

- Reworked Enhanced transport around per-track command revisions and serialized command queues so stale asynchronous Play/Seek/Reconfigure operations cannot overwrite newer GM actions.
- Removed the old duplicate native-state reapply path. Native Playlist synchronization now reconciles only when the local Sound is demonstrably out of the current Enhanced state.
- Full Track, Custom Range, Start/End, Loop, fades, timeline bounds, and the active Enhanced session now reconcile from the same configuration state.
- Full Track changes apply immediately: Full Track enables seek across the complete source; Custom Range confines seek to Start → End while the timeline still represents the entire source duration.
- Disabling Full Track immediately moves the stopped playhead to Start. Start/End edits reposition an active or stopped Custom Range to the new Start after the edit is committed.
- Start/End/Fade inputs are now controlled text-decimal fields rather than native number inputs. They accept `100`, `100.5`, and `100,5` and isolate keyboard/wheel events from Foundry keybindings.
- Numpad digits and decimal input are handled by the module even when Num Lock is off, preventing Home/End/Page navigation from leaking into Foundry while editing values.
- Numeric edits update markers and range validity immediately and commit after a short typing debounce; Enter/change/blur flush the edit without requiring Play or Stop.
- Timeline drag no longer depends on an already-active Enhanced session. Releasing the thumb starts or continues Enhanced playback at the chosen position.
- The timeline remains visually 0 → total duration at all times. In Custom Range the thumb is clamped to Start → End; in Full Track it is free across the entire source.
- Pointer seek uses pointer capture and suppresses duplicate `change` commits after `pointerup` for more consistent drag behavior.
- Loop/Fade edits reconcile an active Enhanced session on the fly without requiring a manual restart. Structural range edits restart/reposition at Start.
- Stop deterministically ends the Enhanced session and returns the stopped playhead to 0 for Full Track or Start for Custom Range.
- Reset Track is now a transport barrier: it invalidates old transport work, stops the native Sound/session, removes only the module playback flag, then restores the implicit Full Track state and playhead 0.
- Preserved the v0.0.2 protection that saved Start/End values are never destructively clamped against transient Sound duration metadata.

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
