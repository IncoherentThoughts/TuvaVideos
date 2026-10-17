// PROTOTYPE (#94, throwaway, branch prototype/member-grid): a Member's grid when none of the files are on this machine,
// the click-through for an unavailable Video, the sign-in entry point and the account chip (#88). Three variants on the
// existing Library and Now playing routes, switched with `?variant=` and the floating bar at the bottom. Fake data:
// the real library, with every Copy taken away; no Supabase. Nothing here is production code.
import { useEffect, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../../shared/types";
import { currentVideos, reloadAll, useStore } from "../data";
import { Link, navigate, playHref } from "../router";
import { Poster, Tags } from "../ui";

export type Variant = "A" | "B" | "C";
export const VARIANTS: { key: Variant; name: string }[] = [
  { key: "A", name: "Grid as today; Now playing explains" },
  { key: "B", name: "The card says it; popover, no navigation" },
  { key: "C", name: "Grid states it up front; sign-in page" },
];

type Mode = "out" | "member" | "editor";
interface Proto {
  variant: Variant;
  /** The machine holds none of the files (the collaborator's case). Off: the library as it really is here. */
  noFiles: boolean;
  mode: Mode;
  offline: boolean;
  avatar: boolean;
  lastSync: number | null;
  shelved: number;
}

const LS = "tuva.proto.member-grid";
const fromUrl = new URLSearchParams(location.search).get("variant");
let st: Proto = { variant: "A", noFiles: true, mode: "out", offline: false, avatar: true, lastSync: null, shelved: 3 };
try {
  const saved = localStorage.getItem(LS);
  if (saved) st = { ...st, ...(JSON.parse(saved) as Partial<Proto>) };
} catch {}
if (fromUrl === "A" || fromUrl === "B" || fromUrl === "C") st.variant = fromUrl;
const subs = new Set<() => void>();
export const proto = () => st;
export function setProto(patch: Partial<Proto>) {
  st = { ...st, ...patch };
  try {
    localStorage.setItem(LS, JSON.stringify({ variant: st.variant, noFiles: st.noFiles, avatar: st.avatar }));
  } catch {}
  subs.forEach((f) => f());
}
export function useProto(): Proto {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return st;
}

/** The fake: every Copy gone, posters kept (they are hosted; the companion has them). Applied to every Video the API answers. */
export function protoVideo<T extends VideoDto>(v: T): T {
  if (!st.noFiles) return v;
  return { ...v, available: false, availability: null, copies: [], preferredCopyId: null };
}
export const protoVideos = <T extends VideoDto>(vs: T[]): T[] => vs.map(protoVideo);

const FAKE = {
  member: { name: "Aidyn Mongush", role: "Member", email: "aidyn@example.com" },
  editor: { name: "Choduraa Tumat", role: "Video Editor", email: "choduraa@example.com" },
};
const avatarUrl = () => currentVideos()?.find((v) => v.thumbnail)?.thumbnail?.poster ?? null;
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const ago = (t: number | null) => {
  if (t == null) return "never";
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : m === 1 ? "1 minute ago" : m < 60 ? `${m} minutes ago` : `${Math.round(m / 60)} h ago`;
};

export const videoLink = (v: Pick<VideoDto, "youtubeId" | "instagramId">) =>
  v.youtubeId ? { label: `youtube.com/watch?v=${v.youtubeId}`, href: `https://www.youtube.com/watch?v=${v.youtubeId}`, site: "YouTube" }
  : v.instagramId ? { label: `instagram.com/p/${v.instagramId}`, href: `https://www.instagram.com/p/${v.instagramId}/`, site: "Instagram" }
  : null;

// ---- sign-in (fake) ----
export function signIn(role: Mode = "member") {
  setProto({ mode: role === "out" ? "member" : role, lastSync: Date.now() });
}
export const signOut = () => setProto({ mode: "out" });

function SignInForm({ onDone, autoFocus, compact }: { onDone: () => void; autoFocus?: boolean; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const submit = (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      signIn("member");
      onDone();
    }, 700);
  };
  return (
    <form class={`proto-signin${compact ? " compact" : ""}`} onSubmit={submit}>
      <label>
        <span>Email</span>
        <input type="email" required autoFocus={autoFocus} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} placeholder="you@example.com" autocomplete="username" />
      </label>
      <label>
        <span>Password</span>
        <input type="password" required value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} autocomplete="current-password" />
      </label>
      <button class="btn primary" type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <p class="dim">Your Tuvan Lyrics Archive account. No account yet? Ask an archive moderator; sign-up is closed.</p>
    </form>
  );
}

/** Variant A: a dialog over the page. */
function SignInDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog class="proto-dialog" ref={ref} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <h3>Sign in to the archive</h3>
      <p class="muted">Signing in shows the shared link data: every Video, its Song, Artists and Chapters, as the Video Editors keep it. Your files, Favorites and Resume positions stay on this machine.</p>
      <SignInForm onDone={onClose} autoFocus />
    </dialog>
  );
}

/** Variant B: a popover hanging off the Sign in button. */
function SignInPopover({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", on);
    document.addEventListener("keydown", key);
    return () => (document.removeEventListener("mousedown", on), document.removeEventListener("keydown", key));
  }, []);
  return (
    <div class="proto-pop signin" ref={box}>
      <SignInForm onDone={onClose} autoFocus compact />
    </div>
  );
}

/** Variant C: a page of its own at /signin. */
export function SignInPage() {
  const p = useProto();
  useEffect(() => {
    if (p.mode !== "out") navigate("/", { replace: true });
  }, [p.mode]);
  return (
    <div class="proto-signin-page">
      <img src="/olchey.svg?v=2" alt="" width="56" height="56" />
      <h2>Sign in to the archive</h2>
      <p class="muted">A Tuvan Lyrics Archive account makes this app a Member of the shared library: every Video's title, Song, Artists and Chapters, kept by the Video Editors, shown here next to the files you have. Nothing on this machine leaves it.</p>
      <SignInForm onDone={() => navigate("/")} autoFocus />
      <Link href="/" class="dim">Keep browsing without an account</Link>
    </div>
  );
}

// ---- the chip (#88: one chip at the header's right; "Sign in" button and nothing else when there is no session) ----
export function AccountChip() {
  const p = useProto();
  const [open, setOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", on);
    document.addEventListener("keydown", key);
    return () => (document.removeEventListener("mousedown", on), document.removeEventListener("keydown", key));
  }, [open]);

  if (p.mode === "out") {
    if (p.variant === "C") return <Link href="/signin" class="btn proto-signin-btn">Sign in</Link>;
    return (
      <div class="proto-chipwrap" ref={box}>
        <button class="btn proto-signin-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog">Sign in</button>
        {open && p.variant === "A" && <SignInDialog onClose={() => setOpen(false)} />}
        {open && p.variant === "B" && <SignInPopover onClose={() => setOpen(false)} />}
      </div>
    );
  }

  const who = FAKE[p.mode];
  const url = p.avatar ? avatarUrl() : null;
  const sync = () => {
    setSyncing(true);
    setTimeout(() => (setSyncing(false), setProto({ lastSync: Date.now() })), 900);
  };
  return (
    <div class="proto-chipwrap" ref={box}>
      <button class={`proto-chip${p.offline ? " offline" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" aria-label={`Account menu, ${who.name}${p.offline ? ", offline" : ""}`} title={p.offline ? `${who.name} · offline` : who.name}>
        {url ? <img src={url} alt="" /> : <span>{initials(who.name)}</span>}
        {p.offline && <i class="off" aria-hidden="true" />}
      </button>
      {open && (
        <div class="proto-pop acct" role="menu">
          <div class="who">
            <div class="nm">{who.name}</div>
            <span class="role">{who.role}</span>
          </div>
          <div class="sync">
            <span class="dim">{p.offline ? "Offline: the archive cannot be reached" : `Last Sync ${ago(p.lastSync)}`}</span>
            <button class="btn small" disabled={p.offline || syncing} title={p.offline ? "Sync needs the archive; you are offline" : "Refresh this machine's copy of the shared link data"} onClick={sync}>{syncing ? "Syncing…" : "Sync"}</button>
          </div>
          <button role="menuitem" onClick={() => (setOpen(false), signOut())}>Sign out</button>
          <button
            role="menuitem"
            disabled={p.shelved === 0}
            onClick={() => {
              if (confirm(`Clear ${p.shelved} Shelved edits on this machine? They are the local tags that lost to the shared data at sign-in. This cannot be undone.`)) setProto({ shelved: 0 });
              setOpen(false);
            }}
          >
            Clear Shelved edits{p.shelved > 0 ? ` (${p.shelved})` : ""}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- the grid card for a Video with no Copy here ----
const DOWN = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" />
  </svg>
);

const MESSAGE = "This Video's link data is here; its file is not. Download it into one of your Roots and it plays.";

/** A: the card as today, greyed; a small "not here" mark in the corner. The click goes to Now playing, which explains. */
function CardA({ v, onOpen }: { v: VideoDto; onOpen: () => void }) {
  return (
    <Link href={playHref(v.id)} class="card proto-a" data-item="" data-id={v.id} data-fav-kind="video" onClickCapture={onOpen}>
      <Poster video={v} dur />
      <span class="proto-mark" title="Not on this machine">{DOWN}</span>
      <div class="ttl">{v.title}</div>
      <Tags video={v} />
      {v.chapterCount > 0 && <div class="meta"><span>{v.chapterCount} ch</span></div>}
    </Link>
  );
}

/** B: the card carries the fact in a strip under the poster; clicking opens a popover on the spot, the grid stays. */
function CardB({ v }: { v: VideoDto }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const link = videoLink(v);
  useEffect(() => {
    if (!open) return;
    const on = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", on);
    document.addEventListener("keydown", key);
    return () => (document.removeEventListener("mousedown", on), document.removeEventListener("keydown", key));
  }, [open]);
  return (
    <div class={`card proto-b${open ? " open" : ""}`} data-item="" data-id={v.id} data-fav-kind="video" ref={box}>
      <button class="hit" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Poster video={v} dur />
        <div class="strip">{DOWN} not downloaded{link ? <span class="dim"> · {link.site}</span> : null}</div>
        <div class="ttl">{v.title}</div>
      </button>
      <Tags video={v} />
      {open && (
        <div class="proto-pop card-pop" role="dialog">
          <p>{MESSAGE}</p>
          {link ? <a href={link.href} target="_blank" rel="noopener noreferrer" class="lnk">{link.label}</a> : <p class="dim">No link is known for this Video.</p>}
          <div class="row">
            <Link href={playHref(v.id)} class="btn small">Chapters and lyrics</Link>
            <button class="btn small" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** C: dimmed, dashed, with the link shown on the card itself; the click goes to Now playing's poster hero. */
function CardC({ v, onOpen }: { v: VideoDto; onOpen: () => void }) {
  const link = videoLink(v);
  return (
    <Link href={playHref(v.id)} class="card proto-c" data-item="" data-id={v.id} data-fav-kind="video" onClickCapture={onOpen}>
      <div class="frame">
        <Poster video={v} dur />
        <span class="dl">{DOWN} Download to play</span>
      </div>
      <div class="ttl">{v.title}</div>
      <Tags video={v} />
      <div class="meta">{link ? <span class="mono">{link.site}</span> : <span class="dim">no link</span>}{v.chapterCount > 0 && <span>{v.chapterCount} ch</span>}</div>
    </Link>
  );
}

/** True when the prototype should take over this Video's card and Now playing. */
export const protoOwns = (v: Pick<VideoDto, "available">) => st.noFiles && !v.available;

export function ProtoCard({ v, onOpen }: { v: VideoDto; onOpen: () => void }) {
  const p = useProto();
  if (p.variant === "B") return <CardB v={v} />;
  if (p.variant === "C") return <CardC v={v} onOpen={onOpen} />;
  return <CardA v={v} onOpen={onOpen} />;
}

/** C only: a line above the grid saying what the grid is. */
export function ProtoGridNotice({ total }: { total: number }) {
  const p = useProto();
  if (p.variant !== "C" || !p.noFiles) return null;
  return (
    <div class="proto-notice">
      {DOWN}
      <span>
        <b>None of these {total.toLocaleString()} Videos is on this machine.</b> Each card is the shared link data: title, Song, Artists, Chapters. Open one for its link; download the file into a Root and it plays here.
      </span>
    </div>
  );
}

// ---- Now playing when the file is not here (A and C; B sends people here only for Chapters and lyrics) ----
export function ProtoUnavailable({ v }: { v: VideoDto }) {
  const p = useProto();
  const link = videoLink(v);
  if (p.variant === "C") {
    return (
      <div class="proto-hero">
        <Poster video={v} />
        <div class="veil">
          <span class="badge">{DOWN} Not on this machine</span>
          <p>{MESSAGE}</p>
          {link ? <a href={link.href} target="_blank" rel="noopener noreferrer" class="btn primary">Open on {link.site}</a> : <span class="dim">No link known</span>}
        </div>
      </div>
    );
  }
  // A (and B's click-through): the Player's place, a plain panel over the blurred poster
  return (
    <div class="proto-panel">
      {v.thumbnail && <img class="bg" src={v.thumbnail.poster} alt="" />}
      <div class="box">
        <h3>Not on this machine</h3>
        <p>{MESSAGE}</p>
        {link ? (
          <p>
            {link.site}: <a href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a>
          </p>
        ) : (
          <p class="dim">No link is known for this Video.</p>
        )}
      </div>
    </div>
  );
}

// ---- the floating switcher and knobs ----
export function PrototypeBar() {
  const p = useProto();
  useStore();
  const i = VARIANTS.findIndex((x) => x.key === p.variant);
  const go = (d: number) => {
    const next = VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!.key;
    setProto({ variant: next });
    const u = new URL(location.href);
    u.searchParams.set("variant", next);
    history.replaceState(null, "", u.toString());
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable], [data-player], .player, dialog") || t.isContentEditable)) return;
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key === "ArrowLeft") (e.preventDefault(), go(-1));
      if (e.key === "ArrowRight") (e.preventDefault(), go(1));
    };
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, [i]);
  const files = (on: boolean) => {
    setProto({ noFiles: on });
    void reloadAll();
  };
  return (
    <div class="proto-bar" role="toolbar" aria-label="Prototype">
      <button onClick={() => go(-1)} aria-label="Previous variant">←</button>
      <span class="lbl"><b>{p.variant}</b> — {VARIANTS[i]!.name}</span>
      <button onClick={() => go(1)} aria-label="Next variant">→</button>
      <span class="sep" />
      <label><input type="checkbox" checked={p.noFiles} onChange={(e) => files((e.target as HTMLInputElement).checked)} /> owns no files</label>
      <select value={p.mode} onChange={(e) => { const m = (e.target as HTMLSelectElement).value as Mode; m === "out" ? signOut() : signIn(m); }} aria-label="Session">
        <option value="out">signed out</option>
        <option value="member">Member</option>
        <option value="editor">Video Editor</option>
      </select>
      <label><input type="checkbox" checked={p.offline} onChange={(e) => setProto({ offline: (e.target as HTMLInputElement).checked })} /> offline</label>
      <label><input type="checkbox" checked={p.avatar} onChange={(e) => setProto({ avatar: (e.target as HTMLInputElement).checked })} /> avatar</label>
    </div>
  );
}
