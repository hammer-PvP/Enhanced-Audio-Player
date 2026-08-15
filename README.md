# Enhanced Audio Player

Enhanced Audio Player is a system-agnostic Foundry VTT module that adds a compact GM-only playback-control layer below the native Playlist Directory. It does not replace Foundry playlists, PlaylistSound documents, Sound objects, or the audio engine.

## v0.1.1 scope

- Click a sound row inside an expanded native Playlist to select that exact PlaylistSound occurrence without starting playback.
- The panel distinguishes **Selected Track** (the occurrence being viewed/edited) from **Playing** (the most recently started active occurrence).
- When a new PlaylistSound actually starts — including native Next/sequential progression — the player automatically follows and selects that new occurrence, discarding any uncommitted draft on the previously selected occurrence.
- After that automatic jump, the GM remains free to click another sound and edit it while the active track continues. Selection is not stolen again until another track genuinely starts.
- Native playlist management and ordering remain Foundry-owned.
- Every unconfigured PlaylistSound defaults to **Full Track**.
- Disable Full Track to configure a custom Start and End range. Optional **Loop Range** repeats only that configured range.
- Fade In and Fade Out remain available per PlaylistSound occurrence.
- Configuration editing uses a local draft and a single explicit **OK** button. Typing does not write flags or rerender the PlaylistSound.
- **Play** always starts a new playback from the effective beginning: 0 for Full Track, Start for Custom Range.
- The middle transport button is **Pause / Resume**: Pause preserves the exact current position; Resume continues from that position.
- **Stop** terminates playback and returns the stopped position to 0 (Full Track) or Start (Custom Range).
- Full-duration timeline, bounded seek, absolute seeking, Reset Track, command serialization, and per-occurrence persistence retain the stable v0.1.0 behavior.
- Playback policy remains scoped to the exact `Playlist ID + PlaylistSound ID`, never to the audio file path. Duplicate uses of the same file can behave differently in Root, Playlist A, Playlist B, and so on.
- A saved policy is honored whenever that PlaylistSound starts through Foundry's native playlist flow, not only through Enhanced Play.
- The UI is vertically compacted by reducing padding, gaps, row heights, and control heights while preserving the existing width and two-column Start/End and Fade layouts.
- Foundry V13 Stable 13.341+ and V14 continue sharing one runtime and compatibility adapter.

## Playback rules

| Saved mode | Seek bounds | Playback behavior |
| --- | --- | --- |
| Full Track | 0 → source duration | Play starts at 0 and plays the complete source. |
| Custom Range + Loop Off | Start → End | Play starts at Start, ends at End once, then allows the parent sequential/shuffled playlist to advance normally. |
| Custom Range + Loop On | Start → End | Play starts at Start and repeats Start → End until stopped or another track takes over. |

The timeline itself always spans 0 → source duration. Custom Range changes only the allowed seek area and playback policy, not the visual time scale.

## Selected vs Playing

The player intentionally separates editor focus from playback focus:

- **Selected Track** is the occurrence whose saved configuration/draft is shown in the editor.
- **Playing** is the occurrence most recently started by Foundry/EAP.
- A new playback start automatically selects that occurrence once.
- The GM may then select a different occurrence for configuration while the active one keeps playing.
- If another track starts later (for example via `Playlist.playNext`), the player auto-follows again.
- Auto-follow never saves an uncommitted draft. Only **OK** persists configuration.

## Explicit OK editing

Editing is transactional:

1. Select the exact PlaylistSound occurrence you want to configure.
2. Edit Full Track, Start, End, Loop Range, Fade In, or Fade Out locally.
3. The timeline markers may preview the draft, but the persisted playback policy remains unchanged while the editor is dirty.
4. Click **OK** to validate and save the entire configuration in one document update.
5. If that occurrence is already playing, the committed policy is reconciled immediately.

While unsaved changes exist, Play and timeline seek are disabled so the transport cannot disagree with the saved policy. Pause/Resume and Stop remain available for a currently selected active session.

## Per-playlist / per-occurrence persistence

Playback policy belongs to the PlaylistSound embedded inside its parent Playlist:

`Playlist ID + PlaylistSound ID -> flags.enhanced-audio-player.playback`

It is **not** keyed by `sound.path` or file name. Resetting one occurrence does not change any other occurrence that happens to use the same physical audio source.

## Native playlist playback policy

A configured occurrence keeps its policy when Foundry itself starts the sound, including sequential/shuffled playlist progression. The module listens to the native PlaylistSound playing state, loads that exact occurrence's flags, and applies the policy through its native `PlaylistSound.sound` object.

Enhanced Audio Player does not create its own playlist order. For non-looping custom ranges it delegates next-track progression to Foundry's public Playlist progression behavior.

## Transport semantics

- **Play** = new playback from the effective beginning. It does not resume a paused position.
- **Pause** = freeze the current Enhanced position while keeping the session resumable.
- **Resume** = continue that paused session from its stored absolute position.
- **Stop** = end the session. The next Play starts from the beginning again.
- **Reset Track** = transport barrier + removal of only that PlaylistSound occurrence's EAP playback flag.

## Persistence

Persisted values are Full Track, Start, End, Loop Range, Fade In, and Fade Out. Selection, active/playing indicator, current progress, pause position, editor draft, dirty state, and UI state are runtime-only.

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
