import {MODULE_ID} from "./constants.js";
import {PlaybackRuntime} from "./runtime.js";
import {SelectionState} from "./state.js";
import {EnhancedAudioPlayerUI} from "./ui.js";
import {foundryBuild, foundryGeneration, supportedFoundryCore} from "./compat.js";

const selection = new SelectionState();
let uiController;
let runtime;

Hooks.once("init", () => {
  console.log(`${MODULE_ID} | Initializing`);
});

Hooks.once("ready", () => {
  const generation = foundryGeneration();
  const build = foundryBuild();
  if (!supportedFoundryCore()) {
    console.warn(`${MODULE_ID} | Unsupported Foundry core ${generation || "?"}.${build || "?"}; supported targets are V13 build 341+ and V14.`);
  } else {
    console.log(`${MODULE_ID} | Foundry V${generation}${build ? ` build ${build}` : ""} compatibility layer active`);
  }

  runtime = new PlaybackRuntime({onSessionChanged: () => uiController?.onSessionChanged()});
  uiController = new EnhancedAudioPlayerUI({selection, runtime});
  runtime.registerSocket();
});

Hooks.on("renderApplicationV2", (application, element) => {
  uiController?.onPlaylistDirectoryRender(application, element);
});

Hooks.on("updatePlaylistSound", (playlistSound, changed) => {
  void runtime?.onPlaylistSoundUpdated(playlistSound, changed);
});

Hooks.on("deletePlaylistSound", playlistSound => {
  void runtime?.onPlaylistSoundDeleted(playlistSound);
  uiController?.onSoundDeleted(playlistSound);
});
