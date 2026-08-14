# Enhanced Audio Player

Enhanced Audio Player is a system-agnostic Foundry VTT module that adds a compact GM-only playback-control layer below the native Playlist Directory. It does not replace Foundry playlists, PlaylistSound documents, Sound objects, or the audio engine.

## v0.0.2 scope

- Click a sound row inside an expanded native Playlist to select it without starting playback.
- Native playlist controls remain untouched.
- Every unconfigured sound defaults to **Full Track**.
- Disable Full Track to configure a custom Start and End range.
- Optional **Loop Range** repeats only the configured custom range.
- Fade In and Fade Out are stored per PlaylistSound.
- Enhanced **Play**, **Pause**, and **Stop** use the selected native PlaylistSound/Sound.
- Play resumes a paused Enhanced session; Stop resets the playback session.
- The progress bar always spans the entire source file from 0 to total duration.
- Start and End are shown as markers over the full-track timeline.
- Seek can be dragged while Enhanced playback is active without the progress updater stealing the slider thumb.
- Configuration is stored in `flags.enhanced-audio-player.playback` on each PlaylistSound.
- Saved Start/End values are never rewritten from transient runtime duration metadata.
- **Reset Track** removes only the module playback flag from that PlaylistSound and restores the implicit Full Track default.
- Playback commands are mirrored to connected clients through the module socket, while the actual audio is still played by Foundry's native Sound instance.

## Design contract

Enhanced Audio Player intentionally does **not** provide its own playlists, soundboard, waveform editor, cue points, markers as editable audio events, multiple ranges, intro/loop/outro sequencing, or crossfade system.

It also does not replace `Playlist`, `PlaylistSound`, `Sound`, or global `Sound.prototype.play` behavior. Clicking Foundry's native Play control remains native playback and ignores Enhanced Audio Player's range configuration.

## Playback rules

| Full Track | Loop Range | Enhanced Play behavior |
| --- | --- | --- |
| On | Disabled | Plays 0 → complete source duration. Stored Start/End/Loop values are ignored but preserved. |
| Off | Off | Plays Start → End once. |
| Off | On | Repeats Start → End until stopped. |

For buffered audio with no boundary fades, Foundry's native `loopStart`/`loopEnd` is used when available. Streamed audio and ranges using boundary fades are restarted at the range boundary by the module controller while still using the same native Sound object.

## Pause and Stop

- **Pause** records the current Enhanced session position and pauses the native Sound on each connected client.
- **Play** after Pause resumes from that position.
- **Stop** ends the Enhanced session and stops the native PlaylistSound; the next Play starts at 0 for Full Track or Start for a custom range.

## Persistence

Playback configuration belongs to each PlaylistSound through Foundry document flags:

`flags.enhanced-audio-player.playback`

Selection, current progress, and pause session state are UI/runtime state and are not used as the persistent track configuration.

## Compatibility

- Foundry VTT: minimum Version 14
- Verified API target: Foundry VTT 14.365
- Game system: Any

## Installation

Manifest URL:

`https://github.com/hammer-PvP/Enhanced-Audio-Player/releases/latest/download/module.json`

Repository:

`https://github.com/hammer-PvP/Enhanced-Audio-Player`
