# Enhanced Audio Player

Enhanced Audio Player is a lightweight, system-agnostic Foundry VTT module that places a compact GM-only playback controller below the native Playlists directory. All audio remains on Foundry's native `PlaylistSound` / `Sound` engine. No independent playlists or audio players are created.

## Playback configuration (v0.1.4)

Select a sound **inside an expanded native playlist**. The module shows two optional checkboxes. **Their time fields appear only when enabled**:

- **Intro — Play Once:** define `Intro Start` and `Intro End` to play that portion once. With no loop enabled, the sound ends there and the playlist advances when its native mode supports Next.
- **Continuous Loop:** define `Loop Start` and `Loop End` to repeat only that portion indefinitely.
- **Both enabled:** the intro plays once, then playback jumps directly to the independent loop range and repeats there. For example, Intro `00:05 → 00:20`, Loop `00:35 → 01:17`.
- **Neither enabled:** the ordinary `Start Playback At` field appears. The track plays from this point to its actual end. An optional `Repeat Track` checkbox repeats from that start point to the end; without it, the next track can play naturally.

`Continuous Loop` already means infinite repetition. `Repeat Track` is shown only when neither Intro nor Continuous Loop is selected.

**Time entry:** write `77`, `1:17`, `1:17.250`, `2:35,5`, or `01:02:03.005`. The display uses `MM:SS.mmm` (or `HH:MM:SS.mmm` for longer audio); internally the times are stored as seconds. Fade In / Fade Out remain seconds.

Click **OK** to validate and save the complete draft once. Typing does **not** write flags, rebuild the editor or disturb focus. **Reset Track** removes only this occurrence's Enhanced Audio Player flags, restoring the unconfigured default. Any edits without OK are discarded on track change or native auto-follow.

## Usage

1. Open Foundry's Playlists sidebar and expand a Playlist.
2. Click the **name of a sound** (not the native Play button) to select it. Selection does not play anything.
3. Choose Intro, Continuous Loop, both, or neither, and enter the relevant time ranges.
4. Optionally set Fade In / Fade Out; click **OK**.
5. Use the Enhanced Play/Pause/Resume/Stop controls or let Foundry reach this sound naturally in a sequential/shuffle Playlist.

### Transport

- **Play** starts a *new* execution from its configured beginning, ignoring any previous pause.
- **Pause** records the absolute position; **Resume** continues precisely there, without doubling the offset.
- **While paused**, dragging the timeline changes only the stored seek point and **does not resume audio**.
- **Stop** fully ends the current session and resets the playhead to the policy start.
- The timeline always spans the **entire original file duration**. Highlighted regions show the configured intro and loop. Seeking stays within the playable sections of the selected policy; gaps between Intro and Loop are skipped.
- **Selected** and **Playing** are separate: the GM may select another occurrence to edit while one is sounding. A newly started track is automatically selected once, unless the GM selects another before the next change.

## Playlist integration and persistence

Each configuration belongs to one native embedded `PlaylistSound` under its parent Playlist, stored in `flags.enhanced-audio-player.playback`, never keyed by file path. The same `.ogg` or `.mp3` in Playlist A and Playlist B can have completely independent intro/loop settings and Reset operations. No custom database or audio files are created.

Saved policies are respected when Foundry starts the sound natively, including natural transitions between playlist entries. A non-looping Enhanced segment ends locally and the GM-side controller delegates Next to Foundry's playlist order where supported. Looping policies remain on the same track until stopped or changed.

**Version migration:** v0.1.4 reads older v0.1.3 `fullTrack/start/end/loop` flags and translates them into the equivalent settings in memory. The next click of OK saves the newer independent Intro/Loop schema for that occurrence; existing flags are not silently rewritten. Legacy Intro + Loop becomes Intro `0 → old Start` and Loop `old Start → old End`.

### Technical note on native playback duration

Enhanced Audio Player no longer provides `Sound.play({duration})` or native loop-region options that could interfere with Foundry V13's own displayed track length. It plays the full underlying native sound and uses audio-time boundary scheduling to end or repeat the chosen segments. Loop transitions on some streamed/buffered sources may have a very brief seam depending on buffering; they are not advertised as sample-perfect.

## Compatibility

- Foundry VTT: V13 Stable build `13.341` and newer; V14.
- Game system: Any / system-agnostic (including non-D&D systems).
- V14 manifest verified target carried forward: `14.365`.

The module intentionally does not provide its own audio engine, soundboard, waveform editor, cue points, automation, multiple-range editor, crossfade or Intro→Loop→Outro sequencer.

## Links

Repository: https://github.com/hammer-PvP/Enhanced-Audio-Player

Manifest: https://github.com/hammer-PvP/Enhanced-Audio-Player/releases/latest/download/module.json
