# Enhanced Audio Player

Enhanced Audio Player is a system-agnostic Foundry VTT module that adds a compact GM-only playback-control layer below the native Playlist Directory. It does not replace Foundry playlists, PlaylistSound documents, Sound objects, or the audio engine.

## v0.1.0 scope

- Click a sound row inside an expanded native Playlist to select that exact PlaylistSound occurrence without starting playback.
- Native playlist management remains Foundry-owned.
- Every unconfigured PlaylistSound defaults to **Full Track**.
- Disable Full Track to configure a custom Start and End range.
- Optional **Loop Range** repeats only the configured custom range.
- Fade In and Fade Out remain available per PlaylistSound occurrence.
- Enhanced **Play**, **Pause**, **Stop**, full-duration timeline, bounded seek, and absolute seeking retain the stable v0.0.4 transport behavior.
- Configuration editing now uses a local draft and a single explicit **OK** button. Typing never writes flags, never rerenders the PlaylistSound, and never commits because of Enter, blur, debounce, or numpad behavior.
- Numpad keys remain isolated from Foundry/browser shortcuts while a numeric EAP field has focus. Numpad Enter is consumed but does not blur or commit the field.
- **OK** validates and atomically saves Full Track, Start, End, Loop Range, Fade In, and Fade Out as one playback policy.
- **Reset Track** stops the selected occurrence, removes only its EAP playback flag, and returns only that occurrence to implicit Full Track defaults.
- Playback policy is scoped to the exact `Playlist + PlaylistSound` occurrence, never to the audio file path. The same source file can therefore have completely different ranges/loop/fades in Root, Playlist A, Playlist B, and so on.
- A saved policy is now honored whenever that PlaylistSound starts through Foundry's native playlist flow, not only when the Enhanced Play button is used.
- For a saved custom range with Loop Range off, reaching End concludes that occurrence and Foundry's public `Playlist.playNext` is used when the parent playlist supports sequential/shuffled progression; other playlist modes simply stop the occurrence.
- With Loop Range on, the saved Start → End region continues looping until the track is stopped or changed.
- Configuration remains stored in `flags.enhanced-audio-player.playback` on each PlaylistSound.
- Foundry V13 Stable 13.341+ and V14 share one runtime with the compatibility adapter introduced in v0.0.4.

## Playback rules

| Saved mode | Seek bounds | Playback behavior |
| --- | --- | --- |
| Full Track | 0 → source duration | Plays the complete source. Stored custom Start/End/Loop are ignored but preserved. |
| Custom Range + Loop Off | Start → End | Plays Start → End once, then allows the parent sequential/shuffled playlist to advance normally. |
| Custom Range + Loop On | Start → End | Repeats Start → End until stopped or another track takes over. |

The timeline itself always spans 0 → source duration. Custom Range changes only the allowed seek area and playback policy, not the visual time scale.

## Explicit OK editing

Editing is intentionally transactional in v0.1.0:

1. Select the exact PlaylistSound occurrence you want to configure.
2. Edit Full Track, Start, End, Loop Range, Fade In, or Fade Out locally.
3. The timeline markers may preview the draft, but the persisted playback policy remains unchanged while the editor is dirty.
4. Click **OK** to validate and save the entire configuration in one document update.
5. If that occurrence is already playing, the committed policy is reconciled immediately.

While unsaved changes exist, Play and timeline seek are disabled so the transport can never disagree with the saved policy. Pause and Stop remain available for a currently active session.

## Per-playlist / per-occurrence persistence

Playback policy belongs to the PlaylistSound embedded inside its parent Playlist:

`Playlist ID + PlaylistSound ID -> flags.enhanced-audio-player.playback`

It is **not** keyed by `sound.path` or file name.

Example using the same physical audio source:

- Root occurrence: Full Track
- Playlist A occurrence: 100s → 120s, Loop On
- Playlist B occurrence: 15s → 28s, Loop Off
- Playlist C occurrence: 182s → 195s, Loop Off

Resetting the occurrence in Playlist A does not change Root, Playlist B, or Playlist C.

## Native playlist playback policy

A configured occurrence keeps its policy when Foundry itself starts the sound, including when a sequential/shuffled playlist advances to it. The module listens to the native PlaylistSound playing state, loads that exact occurrence's flags, and applies the range/fade policy through its native `PlaylistSound.sound` object.

Enhanced Audio Player does not create its own playlist order. For non-looping custom ranges it delegates next-track progression to Foundry's public `Playlist.playNext(soundId)` API when that operation is applicable.

## Pause, Stop, and Reset

- **Pause** stores the current Enhanced position and pauses the native Sound.
- **Play** after an unchanged Pause resumes from that position.
- **Stop** terminates the Enhanced session. A stopped Full Track returns to 0; a stopped Custom Range returns to Start.
- **Reset Track** is a transport barrier: it invalidates old transport work, stops the selected occurrence, removes only `flags.enhanced-audio-player.playback` from that PlaylistSound, and restores implicit Full Track behavior.

## Persistence

Persisted values are Full Track, Start, End, Loop Range, Fade In, and Fade Out. Selection, current progress, pause position, editor draft, dirty state, and UI state are runtime-only.

## Design contract

Enhanced Audio Player intentionally does **not** provide its own playlists, soundboard, waveform editor, cue points, editable markers/events, multiple ranges, intro/loop/outro sequencing, or crossfade system.

It also does not replace `Playlist`, `PlaylistSound`, `Sound`, or global `Sound.prototype.play` behavior. Foundry remains the owner of playlist structure, playback state, synchronization, and the actual audio engine; EAP adds per-occurrence playback policy on top of those native objects.

## Compatibility

- Foundry VTT: minimum Version 13 Stable build 341 (`13.341`)
- Supported core generations: V13 Stable (341+) and V14
- Verified manifest target: Foundry VTT 14.365
- Game system: Any

## Installation

Manifest URL:

`https://github.com/hammer-PvP/Enhanced-Audio-Player/releases/latest/download/module.json`

Repository:

`https://github.com/hammer-PvP/Enhanced-Audio-Player`
