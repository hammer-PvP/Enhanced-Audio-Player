# Enhanced Audio Player

Enhanced Audio Player is a system-agnostic Foundry VTT module that adds a compact GM-only playback-control layer below the native Playlist Directory. It does not replace Foundry playlists, PlaylistSound documents, Sound objects, or the audio engine.

## v0.0.1 scope

- Click a sound row inside an expanded native Playlist to select it without starting playback.
- Native playlist controls remain untouched.
- Every unconfigured sound defaults to **Full Track**.
- Disable Full Track to configure a custom Start and End range.
- Optional **Loop Range** repeats only the configured custom range.
- Fade In and Fade Out are stored per PlaylistSound.
- Enhanced Play and Stop use the selected native PlaylistSound.
- Progress follows the native Sound current time.
- Seek is available while the selected sound is playing through Enhanced playback.
- Configuration is stored in `flags.enhanced-audio-player.playback` on each PlaylistSound.
- Playback commands are mirrored to connected clients through the module socket, while the actual audio is still played by Foundry's native Sound instance.

## Design contract

Enhanced Audio Player intentionally does **not** provide its own playlists, soundboard, waveform editor, cue points, markers, multiple ranges, intro/loop/outro sequencing, or crossfade system.

It also does not replace `Playlist`, `PlaylistSound`, `Sound`, or global `Sound.prototype.play` behavior. Clicking Foundry's native Play control remains native playback and ignores Enhanced Audio Player's range configuration.

## Playback rules

| Full Track | Loop Range | Enhanced Play behavior |
| --- | --- | --- |
| On | Disabled | Plays the complete track. Fade settings are applied when configured. |
| Off | Off | Plays Start → End once. |
| Off | On | Repeats Start → End until stopped. |

For buffered audio with no boundary fades, Foundry's native `loopStart`/`loopEnd` is used when available. Streamed audio and ranges using boundary fades are restarted at the range boundary by the module controller while still using the same native Sound object.

## Compatibility

- Foundry VTT: minimum Version 14
- Verified against Foundry VTT 14.365
- Game system: Any

## Installation

Manifest URL:

`https://github.com/hammer-PvP/Enhanced-Audio-Player/releases/latest/download/module.json`

Repository:

`https://github.com/hammer-PvP/Enhanced-Audio-Player`

## v0.0.1 notes

This first release deliberately keeps the integration surface small. The Enhanced panel is shown only to GMs. Players still receive playback because the module is enabled world-wide and uses each client's native Foundry Sound instance.
