// The resume bar (docs/downloader-spec.md §4.7): after a quit or crash left a job with items to do, the first tab shows
// "Download job: N Videos left (≈ X GB) — Resume / Discard". Resume is disabled while the job's Root is unmounted.
import { useEffect } from "preact/hooks";
import { resumeLine } from "./model";
import { discardJob, refresh, resumeQueue, useDownloads } from "./store";

export function ResumeBar() {
  const s = useDownloads();
  const p = s.snap?.resumePrompt ?? null;
  useEffect(() => {
    void refresh();
  }, []);
  // While waiting for the Root (and the dialog is not polling anyway), look again every 5 s so Resume enables itself.
  useEffect(() => {
    if (!p?.waitingForRoot || s.open) return;
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [p?.waitingForRoot, s.open]);
  if (!p) return null;
  return (
    <div class="root-bar dl-resume" role="status">
      <span>{resumeLine(p)}</span>
      <button class="btn small primary" disabled={!!p.waitingForRoot} onClick={() => void resumeQueue()}>
        Resume
      </button>
      <button class="btn small" onClick={() => confirm("Discard this download job? Its partial files are deleted.") && void discardJob(p.jobId)}>
        Discard
      </button>
    </div>
  );
}
