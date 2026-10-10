// Shows which Copy is playing (Root kind icon, container, resolution) and lets the user switch Copy for this play only
// (spec 4.2). Nothing is persisted.
import { useEffect, useRef, useState } from "preact/hooks";
import { bestCopy } from "../shared/copies";
import type { CopyDto } from "../shared/types";
import { DriveIcon, LaptopIcon, resolutionLabel } from "./ui";

export const copyLabel = (c: Pick<CopyDto, "container" | "height">) => [c.container, resolutionLabel(c.height)].filter(Boolean).join(" · ") || "Copy";

const fmtSize = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);

function RootIcon({ c }: { c: Pick<CopyDto, "rootKind" | "available"> }) {
  return <span class={`avail ${c.available ? c.rootKind : "none"}`}>{c.rootKind === "local" ? LaptopIcon : DriveIcon}</span>;
}

function note(c: CopyDto): string {
  if (c.missing) return "file missing";
  if (!c.available) return "unavailable";
  if (c.playback === "native") return "";
  return c.fallback.state === "ready" ? "converted" : "needs conversion";
}

interface Props {
  copies: CopyDto[];
  playingId: number | null;
  onPick(id: number): void;
  /** Return focus to the Player container (the keyboard lives there). */
  refocus(): void;
}

export function CopyPicker({ copies, playingId, onPick, refocus }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const playing = copies.find((c) => c.id === playingId) ?? null;
  const preferred = bestCopy(copies);

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);

  return (
    <div
      class="cpick"
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
        class="cbtn"
        tabIndex={-1}
        aria-haspopup="menu"
        aria-expanded={open}
        title={playing ? `Playing this Copy (${playing.rootKind} Root). Click to switch Copy for this play.` : "Choose a Copy"}
        onClick={() => {
          setOpen((o) => !o);
          if (open) refocus();
        }}
      >
        {playing ? (
          <>
            <RootIcon c={playing} />
            <span class="mono">{copyLabel(playing)}</span>
          </>
        ) : (
          <span class="mono">no Copy</span>
        )}
        {copies.length > 1 && <span class="dim mono">{copies.length}</span>}
        <span class="caret">▾</span>
      </button>
      {open && (
        <div class="cmenu" role="menu">
          <div class="chead">Copies, best first · switching affects this play only</div>
          {copies.map((c) => {
            const isPlaying = c.id === playingId;
            const usable = c.available && !c.missing;
            return (
              <button
                key={c.id}
                role="menuitem"
                class={`copt${isPlaying ? " on" : ""}${usable ? "" : " off"}`}
                disabled={!usable}
                onClick={() => {
                  setOpen(false);
                  refocus();
                  if (!isPlaying) onPick(c.id);
                }}
              >
                <RootIcon c={c} />
                <span class="mono">{copyLabel(c)}</span>
                <span class="dim mono">{c.width && c.height ? `${c.width}×${c.height}` : ""}</span>
                <span class="dim mono">{fmtSize(c.size)}</span>
                <span class="cnote">
                  {isPlaying && <b>playing</b>}
                  {!isPlaying && preferred?.id === c.id && <b class="pref">preferred</b>}
                  {note(c) && <em>{note(c)}</em>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
