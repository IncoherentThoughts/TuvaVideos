// §6.6's one question per machine (ticket #140): "Share n new Videos from <folder>?" with the count that has no
// YouTube id, Instagram shortcode or Rutube id. A minimal bar above the grid; when it shows is the session layer's
// rule (`shareStep` in src/shared/share.ts). After one "Share", later drains are automatic.
import { noProvenanceLine, shareQuestionLine } from "../shared/share";
import { useSession } from "./session";

export function ShareQuestion() {
  const s = useSession();
  const q = s.pendingShare;
  if (!s.shareQuestion || !q || !q.count) return null;
  const bare = noProvenanceLine(q);
  return (
    <div class="root-bar share-bar" role="dialog" aria-label="Share new Videos">
      <span>
        {shareQuestionLine(q)}
        {bare && <span class="muted"> {bare}</span>}
      </span>
      <button class="btn small" disabled={s.sharing} onClick={() => void s.shareNow()}>
        Share
      </button>
      <button class="btn small" onClick={() => s.declineShare()}>
        Not now
      </button>
    </div>
  );
}
