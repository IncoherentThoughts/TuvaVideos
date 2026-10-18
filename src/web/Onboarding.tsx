// First launch (docs/sharing-spec.md §8.4): the empty Standalone grid's two calls to action, Choose a videos folder
// and Sign in, and a Member's one-line "No videos folder yet" bar. The folder is typed as an absolute path (`~`
// expanded); the companion checks it (server/rootSetup.ts) and saving starts the first scan at once.
import { useEffect, useRef, useState } from "preact/hooks";
import type { OnboardingDto } from "../shared/types";
import { api, apiError, reloadAll } from "./data";

let current: OnboardingDto | null = null;
const subs = new Set<(o: OnboardingDto) => void>();
const publish = (o: OnboardingDto) => {
  current = o;
  subs.forEach((f) => f(o));
};

/** The onboarding state, fetched once per page and replaced by the answers of the writes below. */
export function useOnboarding(): OnboardingDto | null {
  const [o, setO] = useState(current);
  useEffect(() => {
    subs.add(setO);
    if (!current) api.onboarding().then(publish, () => {});
    return () => void subs.delete(setO);
  }, []);
  return o;
}

/** After the first scan starts: poll it, then reload the library (the top bar's slower poll can miss a short scan). */
async function followFirstScan() {
  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 700));
    try {
      if (!(await api.scan()).running) break;
    } catch {}
  }
  await reloadAll();
}

function RootField({ autoFocus }: { autoFocus?: boolean }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The autofocus attribute only works at page load; a field opened from the bar mounts later.
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, []);
  const save = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.addRoot(path);
      publish(r.onboarding);
      void followFirstScan();
    } catch (err) {
      setError(apiError(err));
    }
    setBusy(false);
  };
  return (
    <form class="root-field" onSubmit={save}>
      <input
        type="text"
        class="root-input mono"
        aria-label="Videos folder"
        placeholder="~/Videos/Tuvan"
        value={path}
        ref={input}
        spellcheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? "root-error" : undefined}
        onInput={(e) => {
          setPath((e.target as HTMLInputElement).value);
          setError(null);
        }}
      />
      <button class="btn" type="submit" disabled={busy || !path.trim()}>
        {busy ? "Checking…" : "Use this folder"}
      </button>
      {error && (
        <div id="root-error" class="root-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}

/** The empty Standalone grid: two independent calls to action, in either order. */
export function FirstLaunchPanel({ signIn }: { /** The header's sign-in, once it exists (#114). */ signIn?: () => void }) {
  return (
    <div class="first-launch">
      <section class="fl-card">
        <h2>Choose a videos folder</h2>
        <p class="dim">The folder that holds your video files, as a full path. Everything under it is scanned in; this machine keeps one folder.</p>
        <RootField autoFocus />
      </section>
      <section class="fl-card">
        <h2>Sign in</h2>
        <p class="dim">
          With video access from the Tuvan Lyrics Archive, signing in brings the shared library&rsquo;s titles, Artists and Chapters. Create an account on
          songsofthesteppe.org and ask the owner for video access.
        </p>
        <button class="btn" disabled={!signIn} onClick={signIn} title={signIn ? undefined : "Sign-in is not in this build yet"}>
          Sign in
        </button>
      </section>
    </div>
  );
}

/** A Member with no Root: one dismissable line above the grid that opens the folder field. */
export function NoRootBar() {
  const [open, setOpen] = useState(false);
  const dismiss = () => api.dismissRootBar().then(publish, () => {});
  return (
    <div class="root-bar" role="region" aria-label="No videos folder yet">
      <span>No videos folder yet</span>
      {open ? (
        <RootField autoFocus />
      ) : (
        <button class="btn small" onClick={() => setOpen(true)}>
          Choose a videos folder
        </button>
      )}
      <button class="root-bar-x" aria-label="Dismiss" title="Dismiss on this machine" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
