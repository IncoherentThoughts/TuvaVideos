// The key guide shown in the State panel (spec 4.5, 4.8). Kept apart from the component so a test can diff it against keyAction.

export const BINDINGS: [string[], string][] = [
  [["space", "p"], "pause"], [["←", "→"], "±5 s"],
  [["↓", "↑"], "±60 s"], [["⇧←", "⇧→"], "±1 s exact"],
  [[",", "."], "frame step"], [["[", "]"], "speed ∓0.1"],
  [["{", "}"], "speed ½ / ×2"], [["⌫"], "speed 1.0"],
  [["9", "0"], "volume ±5"], [["m"], "mute"],
  [["f"], "fullscreen"], [["l"], "A-B loop (A, B, off)"],
  [["!", "@"], "chapter prev / next"], [["PgUp", "PgDn"], "chapter prev / next"],
  [["<", ">"], "prev / next Video (Entry in a Playlist)"], [["r"], "random Video (works anywhere)"], [["s"], "screenshot"],
  [["o"], "OSD flash"], [["O"], "OSD always"],
  [["c"], "add Chapter here"], [["t"], "Studio playback"],
  [["i"], "this panel"], [["y"], "lyrics drawer"],
  [["a"], "audio panel"],
  [["n", "N"], "Playlist next / prev Entry"], [["x"], "shuffle (starts a Playlist)"],
  [["e"], "Repeat off / list / one"], [["q"], "Playlist panel"], [["/"], "focus search"],
  [["Esc"], "back to the Player"], [["v"], "back to the Player (from anywhere)"],
];
