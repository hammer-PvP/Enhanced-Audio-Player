# Enhanced Audio Player

Enhanced Audio Player is a system-agnostic Foundry VTT module that adds a compact GM-only playback-control layer below the native Playlist Directory. It does not replace Foundry playlists, PlaylistSound documents, Sound objects, or the audio engine.

## v0.0.3 scope

- Click a sound row inside an expanded native Playlist to select it without starting playback.
- Native playlist controls remain untouched.
- Every unconfigured sound defaults to **Full Track**.
- Disable Full Track to configure a custom Start and End range.
- Optional **Loop Range** repeats only the configured custom range.
- Fade In and Fade Out are stored per PlaylistSound.
- Enhanced **Play**, **Pause**, and **Stop** use the selected native PlaylistSound/Sound.
- Start/End/Fade fields are controlled decimal inputs that accept point or comma decimal notation and isolate numpad/key events from Foundry shortcuts.
- Configuration changes reconcile the Enhanced UI/session on the fly; no Play/Stop cycle is required just to make a changed range or mode take effect.
- The timeline always represents the complete source file from 0 to total duration.
- Start and End remain visible as markers on that full timeline.
- In **Full Track**, seek is available across the complete source.
- In **Custom Range**, the same full-width timeline remains visible but the seek thumb is confined to Start → End.
- Disabling Full Track or changing a structural range moves the Custom Range playhead to Start.
- Releasing a timeline drag starts or continues Enhanced playback at the chosen allowed position.
- Per-track command revisions and serialized transport prevent stale asynchronous Play/Seek/Reset work from restoring an older state.
- Configuration is stored in `flags.enhanced-audio-player.playback` on each PlaylistSound.
- Saved Start/End values are never rewritten from transient runtime duration metadata.
- **Reset Track** acts as a transport barrier, removes only the module playback flag, and restores the implicit Full Track default.
- Playback commands are mirrored to connected clients through the module socket, while the actual audio is still played by Foundry's native Sound instance.

## Playback rules

| Mode | Seek bounds | Enhanced Play behavior |
| --- | --- | --- |
| Full Track | 0 → source duration | Plays the complete source. Stored custom Start/End/Loop are ignored but preserved. |
| Custom Range + Loop Off | Start → End | Plays Start → End once. |
| Custom Range + Loop On | Start → End | Repeats Start → End until stopped. |

The timeline itself always spans 0 → source duration. Custom Range changes only the allowed seek area and playback policy, not the visual time scale.

## Reactive editing

- Switching from Full Track to Custom Range immediately enables Start/End/Loop and positions a stopped playhead at Start.
- Switching back to Full Track immediately unlocks seek across the complete track without deleting the saved custom range.
- Start/End changes update timeline markers immediately. Once the numeric edit is committed (typing debounce, Enter, change, or blur), an active Enhanced session is reconciled and structural range changes restart/reposition at Start.
- Loop and fade edits reconcile an active Enhanced session without requiring a manual Stop/Play cycle.
- Invalid custom ranges remain visible for correction and do not get silently rewritten.

## Pause, Stop, and Reset

- **Pause** stores the current Enhanced position and pauses the native Sound.
- **Play** after an unchanged Pause resumes from that position.
- **Stop** terminates the Enhanced session. A stopped Full Track returns to 0; a stopped Custom Range returns to Start.
- **Reset Track** invalidates old transport work, stops the current Enhanced/native playback for the selected track, removes `flags.enhanced-audio-player.playback`, and restores Full Track with playhead 0.

## Persistence

Playback configuration belongs to each PlaylistSound through Foundry document flags:

`flags.enhanced-audio-player.playback`

Persisted values are Full Track, Start, End, Loop Range, Fade In, and Fade Out. Selection, current progress, pause position, and UI state are runtime-only.

## Design contract

Enhanced Audio Player intentionally does **not** provide its own playlists, soundboard, waveform editor, cue points, editable markers/events, multiple ranges, intro/loop/outro sequencing, or crossfade system.

It also does not replace `Playlist`, `PlaylistSound`, `Sound`, or global `Sound.prototype.play` behavior. Clicking Foundry's native Play control remains native playback and ignores Enhanced Audio Player's custom playback policy.

## Compatibility

- Foundry VTT: minimum Version 14
- Verified API target: Foundry VTT 14.365
- Game system: Any

## Installation

Manifest URL:

`https://github.com/hammer-PvP/Enhanced-Audio-Player/releases/latest/download/module.json`

Repository:

`https://github.com/hammer-PvP/Enhanced-Audio-Player`
