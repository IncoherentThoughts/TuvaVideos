// The on-screen keyboard of Search (docs/tv-spec.md 7): three layers (Latin, Cyrillic with ө ү ң, digits), space,
// backspace, clear and the layer switch, laid out in seven columns. Pure; the component only draws it.

export type Layer = "latin" | "cyr" | "digits"
export const LAYERS: readonly Layer[] = ["latin", "cyr", "digits"]
export const KEY_COLUMNS = 7

const LATIN = "abcdefghijklmnopqrstuvwxyz"
/** The Russian alphabet in its usual order, then the three Tuvan letters the Mirror uses. */
const CYRILLIC = "абвгдеёжзийклмнопрстуфхцчшщъыьэюяөүң"
const DIGITS = "1234567890"

export const LAYER_LABEL: Record<Layer, string> = { latin: "abc", cyr: "АБВ", digits: "123" }

export type KbKey =
  | { kind: "char"; value: string; label: string }
  | { kind: "space"; value: " "; label: string }
  | { kind: "backspace"; label: string }
  | { kind: "clear"; label: string }
  | { kind: "layer"; layer: Layer; label: string }

export function layerChars(layer: Layer): string[] {
  return [...(layer === "latin" ? LATIN : layer === "cyr" ? CYRILLIC : DIGITS)]
}

/** Every key of a layer in reading order: the characters, then space, backspace, the three layer switches and clear. */
export function layerKeys(layer: Layer): KbKey[] {
  return [
    ...layerChars(layer).map((c): KbKey => ({ kind: "char", value: c, label: c })),
    { kind: "space", value: " ", label: "␣" },
    { kind: "backspace", label: "⌫" },
    ...LAYERS.map((l): KbKey => ({ kind: "layer", layer: l, label: LAYER_LABEL[l] })),
    { kind: "clear", label: "clear" },
  ]
}

export interface KbState {
  text: string
  layer: Layer
}

const MAX_LEN = 80

/** A key pressed (on the screen or on a physical keyboard): the next text and layer. */
export function pressKey(st: KbState, key: KbKey): KbState {
  switch (key.kind) {
    case "char":
      return { ...st, text: (st.text + key.value).slice(0, MAX_LEN) }
    case "space":
      // no leading space and no double space: the search folds them away anyway
      return st.text === "" || st.text.endsWith(" ") ? st : { ...st, text: st.text + " " }
    case "backspace":
      return { ...st, text: [...st.text].slice(0, -1).join("") }
    case "clear":
      return { ...st, text: "" }
    case "layer":
      return { ...st, layer: key.layer }
  }
}

/** A character typed on a physical keyboard: any single printable character goes in as typed. */
export function typeChar(st: KbState, ch: string): KbState {
  if (ch === " ") return pressKey(st, { kind: "space", value: " ", label: "␣" })
  if ([...ch].length !== 1 || ch < " ") return st
  return pressKey(st, { kind: "char", value: ch, label: ch })
}
