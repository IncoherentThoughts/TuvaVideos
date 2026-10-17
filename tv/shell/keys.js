// GENERATED from src/tv/keys.ts by `bun run tv-install` (or `bun scripts/tv-install.ts --keys`). Do not edit.
(function (root) {
  "use strict"
  const table = [
  { name: "ArrowLeft", code: 37, registered: false },
  { name: "ArrowUp", code: 38, registered: false },
  { name: "ArrowRight", code: 39, registered: false },
  { name: "ArrowDown", code: 40, registered: false },
  { name: "Enter", code: 13, registered: false },
  { name: "Back", code: 10009, registered: false },
  { name: "Exit", code: 10182, registered: false },
  { name: "ChannelUp", code: 427, registered: true },
  { name: "ChannelDown", code: 428, registered: true },
  { name: "MediaPlayPause", code: 10252, registered: true },
  { name: "MediaPlay", code: 415, registered: true },
  { name: "MediaPause", code: 19, registered: true },
  { name: "MediaRewind", code: 412, registered: true },
  { name: "MediaFastForward", code: 417, registered: true },
  { name: "MediaTrackPrevious", code: 10232, registered: true },
  { name: "MediaTrackNext", code: 10233, registered: true },
  { name: "ColorF0Red", code: 403, registered: true },
  { name: "ColorF1Green", code: 404, registered: true },
  { name: "ColorF2Yellow", code: 405, registered: true },
  { name: "ColorF3Blue", code: 406, registered: true },
  { name: "Info", code: 457, registered: true },
  { name: "0", code: 48, registered: true },
  { name: "1", code: 49, registered: true },
  { name: "2", code: 50, registered: true },
  { name: "3", code: 51, registered: true },
  { name: "4", code: 52, registered: true },
  { name: "5", code: 53, registered: true },
  { name: "6", code: 54, registered: true },
  { name: "7", code: 55, registered: true },
  { name: "8", code: 56, registered: true },
  { name: "9", code: 57, registered: true },
  ]
  function keyName(keyCode) {
    const k = table.find((t) => t.code === keyCode)
    return k ? k.name : undefined
  }
  root.TuvaKeys = { table, keyName }
})(typeof globalThis !== "undefined" ? globalThis : window)
