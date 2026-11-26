// Allow from any approved Mac (docs/home-server-spec.md §3.2): the Home Server's pending TV approvals, raised in this
// Mac's top bar as "Allow TV at ‹IP› on ‹name›? Allow / Deny". Polled every 5 s while the Home Server answers; nothing
// shows, and nothing more is asked, when no Home Server is set on this Mac.
import { useEffect, useState } from "preact/hooks";
import type { HomeApprovalsDto } from "../shared/types";
import { api, apiError } from "./data";

const CONNECTED_MS = 5_000;
/** While the Home Server does not answer (away, asleep, off Tailscale): asked again this often. */
const UNREACHABLE_MS = 30_000;

/** The prompt's text for the first pending TV, or null when nothing waits. */
export function homePromptText(s: HomeApprovalsDto | null): string | null {
  const first = s?.connected ? s.pending[0] : undefined;
  if (!first) return null;
  return `Allow TV at ${first.ip} on ${s!.server ?? "the Home Server"}?${s!.pending.length > 1 ? ` (+${s!.pending.length - 1})` : ""}`;
}

export function HomeApprovals() {
  const [s, setS] = useState<HomeApprovalsDto | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let next: HomeApprovalsDto | null = null;
      try {
        next = await api.homeApprovals();
        if (alive) setS(next);
      } catch {}
      if (alive && next?.configured !== false) timer = setTimeout(tick, next?.connected ? CONNECTED_MS : UNREACHABLE_MS);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const text = homePromptText(s);
  const first = s?.pending[0];
  if (!text || !first) return null;
  const answer = async (allow: boolean) => {
    setBusy(true);
    try {
      setS(await api.homeApprove(first.ip, allow));
    } catch (e) {
      alert(`Home Server: ${apiError(e)}`);
    }
    setBusy(false);
  };
  return (
    <span class="tvprompt" role="alert" title={first.model ?? undefined}>
      {text}
      <button class="btn small primary" disabled={busy} onClick={() => answer(true)}>
        Allow
      </button>
      <button class="btn small" disabled={busy} onClick={() => answer(false)}>
        Deny
      </button>
    </span>
  );
}
