// The sign-in UI (docs/sharing-spec.md §2.2, §5.1, §5.3, §5.4; ticket #131): the account chip and its menu at the
// header's right, the sign-in dialog with the reconciliation confirmation, and the "Your session ended" banner.
// Everything reads and acts through useSession() (src/web/session.ts); what renders from which state is chipView.ts.
import type { Ref } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { SIGN_IN_ERRORS } from "../shared/session";
import { chipView, type ChipView, endedLine, FORGOT_URL, NO_ACCESS_HINT, NO_ACCESS_LINE, OFFLINE_LINE, REFRESH_ALL_CONFIRM, shelveLine, submitBlocked } from "./chipView";
import { useSession } from "./session";
import { clearShelvedEdits, fetchShelved, onShelvedChange, openShelved } from "./History";
import { navigate } from "./router";
import { THEMES, useTheme } from "./theme";
import { ShelvedExplainer, VideoDiffList } from "./ShelvedDiff";
import type { VideoDiff } from "../shared/shelvedDiff";

// One dialog for the whole app: the chip's "Sign in", the banner's and the first-launch panel's all open it.
let dialogOpen = false;
const dialogListeners = new Set<() => void>();
const setDialog = (on: boolean) => {
  dialogOpen = on;
  for (const l of dialogListeners) l();
};
export const openSignIn = () => setDialog(true);

function useDialogOpen() {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    dialogListeners.add(l);
    return () => void dialogListeners.delete(l);
  }, []);
  return dialogOpen;
}

function useOnline() {
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(navigator.onLine);
    window.addEventListener("online", on);
    window.addEventListener("offline", on);
    return () => (window.removeEventListener("online", on), window.removeEventListener("offline", on));
  }, []);
  return online;
}

/** Re-render once a minute so "Last Sync 5 min ago" moves while the menu is open. */
function useMinuteTick(on: boolean) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => bump((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, [on]);
}

/** The header's account chip, or a plain "Sign in" button (§2.2), plus the one sign-in dialog. */
export function AccountChip() {
  const s = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const showDialog = useDialogOpen();
  useMinuteTick(open);
  const view = chipView(s, Date.now());

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  useEffect(() => {
    if (view.kind !== "chip") setOpen(false);
  }, [view.kind]);

  // The dialog keeps one place in the tree, so a sign-in that turns the button into the chip keeps it open.
  const dialog = showDialog ? <SignInDialog onClose={() => setDialog(false)} /> : null;
  const body =
    view.kind === "none" ? null
    : view.kind === "sign-in" ? (
      <button class="btn" onClick={openSignIn}>
        Sign in
      </button>
    ) : (
      <Chip view={view} open={open} setOpen={setOpen} box={box} />
    );
  return (
    <>
      {body}
      {dialog}
    </>
  );
}

/** How many Shelved edits this machine keeps (§7.4), re-read when the menu opens and when they change. */
function useShelvedCount(open: boolean) {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => void fetchShelved().then((l) => setN(l.length)).catch(() => null);
    if (open) load();
    return onShelvedChange(load);
  }, [open]);
  return n;
}

function Chip({ view, open, setOpen, box }: { view: Extract<ChipView, { kind: "chip" }>; open: boolean; setOpen: (on: boolean) => void; box: Ref<HTMLDivElement> }) {
  const s = useSession();
  const shelved = useShelvedCount(open);
  const [theme, setTheme] = useTheme();
  const clearAll = async () => {
    if (!confirm(`Clear ${shelved} Shelved edit${shelved === 1 ? "" : "s"}? They are not in the Shared data and cannot be brought back.`)) return;
    setOpen(false);
    await clearShelvedEdits().catch((e: Error) => alert(e.message));
  };
  return (
    <div class="acct" ref={box} onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setOpen(false))}>
      <button
        class={`acct-chip${view.avatarUrl ? " pic" : ""}${view.offline ? " offline" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${view.displayName}${view.offline ? " (the archive can't be reached)" : ""}`}
        title={view.displayName}
        onClick={() => setOpen(!open)}
      >
        {view.avatarUrl ? <img src={view.avatarUrl} alt="" width="34" height="34" referrerpolicy="no-referrer" /> : <span class="ini">{view.initials}</span>}
        {view.offline && <i class="acct-off" aria-hidden="true" />}
      </button>
      {open && (
        <div class="menu acct-menu" role="menu" aria-label="Account">
          <div class="am-name" title={view.email ?? undefined}>
            {view.displayName}
          </div>
          {view.role ? (
            <div>
              <span class={`am-role${view.role === "Video Editor" ? " ed" : ""}`}>{view.role}</span>
            </div>
          ) : (
            <div class="am-nogrant">
              <div class="am-nogrant-line">{NO_ACCESS_LINE}</div>
              <div class="dim">{NO_ACCESS_HINT}</div>
            </div>
          )}
          <div class="am-sync" role="group" aria-label="Sync">
            <span class={view.offline ? "am-offline" : "dim"} role="status">
              {view.sync.line}
            </span>
            <button role="menuitem" class="btn small" disabled={!view.sync.canSync} onClick={() => void s.requestSync()}>
              Sync
            </button>
          </div>
          {view.sync.error && (
            <div class="am-err" title={view.sync.error}>
              {view.sync.error}
            </div>
          )}
          {view.refreshAll && (
            <button
              role="menuitem"
              disabled={!view.refreshAll.enabled}
              title={view.refreshAll.enabled ? "Wipe this machine's copy of the Shared data and pull it whole" : view.offline ? OFFLINE_LINE : "A Sync is running"}
              onClick={() => confirm(REFRESH_ALL_CONFIRM) && (setOpen(false), void s.refreshAll())}
            >
              Refresh all Shared data
            </button>
          )}
          <label class="am-theme">
            <span class="dim">Theme</span>
            <select class="btn theme small" title="Theme (docs/themes.md)" value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)}>
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <button role="menuitem" onClick={() => (setOpen(false), navigate("/edits"))}>
            Edits
          </button>
          {shelved > 0 && (
            <>
              <button role="menuitem" onClick={() => (setOpen(false), openShelved(null))}>
                Shelved edits ({shelved})
              </button>
              <button role="menuitem" onClick={() => void clearAll()}>
                Clear Shelved edits
              </button>
            </>
          )}
          <button role="menuitem" onClick={() => (setOpen(false), void s.signOut())}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

type Step =
  | { at: "form" }
  | { at: "confirm"; count: number; videos: number; diffs: VideoDiff[]; mustChangePassword: boolean; noGrant: boolean }
  // #157: after the sign-in Sync, once per reconciliation: what was shelved, the same rows.
  | { at: "done"; count: number; videos: number; diffs: VideoDiff[] };

/** §5.1: email and password, the three inline errors, then the reconciliation confirmation; Cancel signs out. */
function SignInDialog({ onClose }: { onClose: () => void }) {
  const s = useSession();
  const box = useRef<HTMLDialogElement>(null);
  const online = useOnline();
  const [email, setEmail] = useState(s.record?.email ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ at: "form" });
  // Closing the confirmation by any path but Continue (Esc, the backdrop) is a Cancel: no half-signed-in state.
  const confirmed = useRef(false);

  useEffect(() => {
    box.current?.showModal();
  }, []);

  const blocked = submitBlocked({ reachable: s.reachable, browserSignedIn: s.browserSignedIn, online });
  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy || blocked || !email.trim() || !password) return;
    setBusy(true);
    setErr(null);
    const r = await s.signIn(email.trim(), password);
    setPassword("");
    setBusy(false);
    if (!r.ok) return void setErr(r.error ?? SIGN_IN_ERRORS.unreachable);
    // §2.3: the count of what reconciliation will shelve. No count, no confirmation: sign out again (no half-signed-in state).
    const rec = r.reconcile;
    if (!rec?.ok) {
      await s.signOut();
      return void setErr(rec?.error ?? SIGN_IN_ERRORS.unreachable);
    }
    setStep({
      at: "confirm", count: rec.counts.shelved, videos: rec.counts.shelvedVideos, diffs: rec.diffs ?? [],
      mustChangePassword: r.mustChangePassword, noGrant: rec.record ? rec.record.grantLevel === null : false,
    });
  };

  const onDialogClose = () => {
    if (step.at === "confirm" && !confirmed.current) void s.signOut();
    onClose();
  };
  const cont = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    const r = await s.confirmSignIn();
    setBusy(false);
    // A failed reconciliation changed nothing: say why and stay on the confirmation (Cancel still signs out).
    if (!r.reconcile?.ok) return void setErr(r.reconcile?.error ?? SIGN_IN_ERRORS.unreachable);
    confirmed.current = true;
    // Nothing shelved: nothing to explain. Otherwise the popup says what happened (the Sync has finished by now).
    const c = r.reconcile.counts;
    if (c.shelved > 0) setStep({ at: "done", count: c.shelved, videos: c.shelvedVideos, diffs: r.reconcile.diffs ?? [] });
    else box.current?.close();
  };

  return (
    <dialog ref={box} class="delconfirm signin" aria-label="Sign in" onClose={onDialogClose} onClick={(e) => {
      const r = box.current!.getBoundingClientRect();
      const out = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      if (e.target === box.current && out && !busy) box.current!.close();
    }}>
      {step.at === "form" ? (
        <form onSubmit={submit}>
          <h3>Sign in to the Tuvan Lyrics Archive</h3>
          <label class="si-field">
            <span>Email</span>
            <input type="email" autoComplete="username" required value={email} autoFocus={!email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} disabled={busy} />
          </label>
          <label class="si-field">
            <span>Password</span>
            <input type="password" autoComplete="current-password" required value={password} autoFocus={!!email} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} disabled={busy} />
          </label>
          {(err || blocked) && (
            <p class="err" role="alert">
              {err ?? SIGN_IN_ERRORS.unreachable}
            </p>
          )}
          <p class="dim si-links">
            <a href={FORGOT_URL} target="_blank" rel="noopener noreferrer">
              Forgot password
            </a>
            <span class="si-noacct">
              No account? Create one on{" "}
              <a href={FORGOT_URL} target="_blank" rel="noopener noreferrer">
                songsofthesteppe.org
              </a>{" "}
              and ask the owner for video access.
            </span>
          </p>
          <div class="actions">
            <button type="button" class="btn" disabled={busy} onClick={() => box.current?.close()}>
              Cancel
            </button>
            <button type="submit" class="btn primary" disabled={busy || blocked || !email.trim() || !password}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </div>
        </form>
      ) : step.at === "done" ? (
        <div class="sd-popup">
          <h3>Signed in: your edits were shelved</h3>
          <ShelvedExplainer />
          <p>{shelveLine(step.count, step.videos, true)}</p>
          <VideoDiffList diffs={step.diffs} />
          <div class="actions">
            <button class="btn" onClick={() => (box.current?.close(), openShelved(null))}>
              Open Shelved edits
            </button>
            <button class="btn primary" autoFocus onClick={() => box.current?.close()}>
              OK
            </button>
          </div>
        </div>
      ) : (
        <>
          <h3>Bring in the shared library?</h3>
          {step.count > 0 && <ShelvedExplainer />}
          <p>{shelveLine(step.count, step.videos)}</p>
          <VideoDiffList diffs={step.diffs} />
          {err && (
            <p class="err" role="alert">
              {err}
            </p>
          )}
          <p class="dim">The archive's titles, Artists and Chapters replace this machine's for the Videos it knows.</p>
          {step.noGrant && (
            <div class="si-note">
              <div class="am-nogrant-line">{NO_ACCESS_LINE}</div>
              <div class="dim">{NO_ACCESS_HINT}</div>
            </div>
          )}
          {step.mustChangePassword && (
            <p class="si-note">
              The archive asks you to change your password. Do it on{" "}
              <a href={FORGOT_URL} target="_blank" rel="noopener noreferrer">
                songsofthesteppe.org
              </a>
              ; you stay signed in here.
            </p>
          )}
          <div class="actions">
            <button class="btn" onClick={() => box.current?.close()} title="Sign out again and keep this machine as it was">
              Cancel
            </button>
            <button class="btn primary" autoFocus disabled={busy} onClick={() => void cont()}>
              {busy ? "Bringing it in…" : "Continue"}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

/** §5.4: "Your session ended. Sign in again.", dismissable (in every tab, through the hook). */
export function EndedBanner() {
  const s = useSession();
  const line = endedLine(s.ended);
  if (!line) return null;
  return (
    <div class="root-bar ended-bar" role="alert">
      <span>{line}</span>
      <button class="btn small" onClick={openSignIn}>
        Sign in
      </button>
      <button class="root-bar-x" aria-label="Dismiss" title="Dismiss" onClick={() => s.dismissEnded()}>
        ×
      </button>
    </div>
  );
}
