# Changelog

## 0.1.1

Active-track follow, Pause/Resume semantics, and compact-layout patch.

- Added a distinct **Playing** track indicator alongside **Selected Track** so the GM can see which occurrence is sounding while editing another occurrence.
- Added one-shot auto-follow when a new PlaylistSound starts. Native Next/sequential progression now selects the newly started occurrence and loads its saved per-occurrence configuration.
- Auto-follow discards any uncommitted draft; only OK persists edits. After the automatic jump, the GM may freely select another track while the current track continues without repeated selection theft.
- Changed **Play** semantics to always start a new playback from the effective beginning (0 for Full Track, Start for Custom Range), even if the track was paused.
- Changed the middle transport control into a **Pause / Resume** toggle. Pause preserves the absolute position; Resume continues from that exact position.
- Stop remains a full termination and returns the stopped playhead to 0 or Custom Start, so Play, Pause/Resume, and Stop now have distinct responsibilities.
- Preserved v0.1.0 explicit-OK editing, per-PlaylistSound occurrence persistence, native playlist policy, absolute seek, range/loop behavior, and V13.341+/V14 compatibility.
- Compacted the panel vertically by reducing outer padding, inter-row gaps, button/input heights, timeline spacing, and footer margins while keeping the existing width and two-column field layout.

## 0.1.0

Explicit-commit editor and per-playlist playback-policy release.

- Replaced automatic/debounced configuration persistence with a local editor draft and explicit **OK** commit. Typing Start/End/Fades no longer calls `setFlag`, rerenders the PlaylistSound, or destroys input focus/caret state.
- Numpad Enter is now consumed without blur or commit. Numeric fields continue isolating numpad/key/wheel events from Foundry/browser shortcuts.
- Full Track, Start, End, Loop Range, Fade In, and Fade Out are committed together as one validated configuration.
- Unsaved drafts are never used as the live transport policy; Play and timeline seek are temporarily disabled until OK, preventing UI/runtime state disagreement.
- Reset Track remains an immediate transport barrier and removes only the selected occurrence's EAP flag.
- Formalized playback-policy scope as **Playlist ID + PlaylistSound ID**, never audio file path. The same physical file can have independent settings in Root and in every playlist occurrence.
- Added automatic policy application when Foundry starts a configured PlaylistSound natively, including normal sequential/shuffled playlist progression.
- Non-looping custom ranges now conclude at End and delegate next-track progression to Foundry's public `Playlist.playNext(soundId)` when applicable; other modes stop the occurrence.
- Loop Range remains Start → End until stopped or another track takes over.
- Preserved v0.0.4 absolute seek, Play/Pause/Stop behavior, full-duration timeline, command serialization, V13.341+ compatibility adapter, and native Sound architecture.

## 0.0.4

Absolute-seek correction and Foundry V13 compatibility patch.

- Fixed consecutive timeline seeks being applied as if they were relative offsets in some native Sound states (for example 10s + seek 30s becoming ~40s).
- Absolute transport restarts now clear the native paused/resume state with `Sound.stop()` before `Sound.play({offset})`. Only the explicit Pause command is allowed to preserve `pausedTime`.
- Resume after Pause remains deterministic because the Enhanced session stores the paused absolute position, clears native resume state, and restarts at that stored offset.
- Added regression coverage for multiple consecutive absolute seeks so offsets cannot accumulate.
- Added a Foundry V13/V14 compatibility adapter for PlaylistDirectory detection, AppV2 render roots, currently-playing exclusion, Playlist ancestry, PlaylistSound row resolution, and selected-row highlighting.
- Added defensive UUID and dataset fallbacks for Playlist/PlaylistSound rows while keeping selection limited to sounds nested inside native Playlists.
- Lowered manifest minimum compatibility to Foundry VTT `13.341`, the first V13 Full Stable build, while retaining V14.365 as the verified target.
- Playback architecture remains unchanged: native Playlist/PlaylistSound/Sound objects, native document flags, and the module socket are still used; no parallel audio player was introduced.

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
