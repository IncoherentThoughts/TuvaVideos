// The Player's quality pick (home-server-spec 7.1): Original (the Copy or its Fallback as it is, the default on every
// play) or a smaller Live stream, 1080p / 720p / 480p, below the playing Copy's own size. For this play only, never
// remembered. Sits beside the Copy switcher and looks like it.
import { useEffect, useRef, useState } from "preact/hooks";
import { qualityLabel, qualityOptions, type LiveQuality } from "../shared/liveQuality";
import { ChevronDownIcon } from "./ui";

interface Props {
  /** The playing Copy's size; null while none plays. */
  copy: { width: number | null; height: number | null } | null;
  quality: LiveQuality;
  onPick(q: LiveQuality): void;
  /** Return focus to the Player container (the keyboard lives there). */
  refocus(): void;
}

const note = (q: LiveQuality) => (q === "orig" ? "the Copy as it is" : "Live stream, made as it plays");

export function QualityPicker({ copy, quality, onPick, refocus }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const options = copy ? qualityOptions(copy.width, copy.height) : [];

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  // a Copy at 480p or less has nothing below it to offer
  if (options.length < 2) return null;

  return (
    <div
      class="cpick qpick"
      ref={root}
      data-keep-focus=""
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
          refocus();
        }
      }}
    >
      <button
        class={`cbtn${quality !== "orig" ? " on" : ""}`}
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Quality for this play: ${qualityLabel(quality)}. Click to choose; it is not remembered.`}
        onClick={() => {
          setOpen((o) => !o);
          if (open) refocus();
        }}
      >
        <span class="mono">{qualityLabel(quality)}</span>
        <span class="caret"><ChevronDownIcon /></span>
      </button>
      {open && (
        <div class="cmenu" role="menu">
          <div class="chead">Quality · this play only</div>
          {options.map((q) => (
            <button
              key={q}
              role="menuitemradio"
              aria-checked={q === quality}
              class={`copt${q === quality ? " on" : ""}`}
              onClick={() => {
                setOpen(false);
                refocus();
                if (q !== quality) onPick(q);
              }}
            >
              <span class="mono">{qualityLabel(q)}</span>
              <span class="cnote">
                {q === quality && <b>playing</b>}
                <em>{note(q)}</em>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
