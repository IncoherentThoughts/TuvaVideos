import type { Config } from "./config";
import { IO_RE, run, sleep } from "./proc";
import { parseProbe, type FfprobeJson, type ProbeFacts } from "./playback";

export type ProbeResult = { ok: true; facts: ProbeFacts } | { ok: false; io: boolean; error: string };

const ATTEMPTS = 3;

/** One ffprobe per Copy. I/O errors are retried and reported as `io: true`, never as "no video". */
export async function probeFile(cfg: Pick<Config, "ffprobe">, file: string): Promise<ProbeResult> {
  let last = "";
  let io = false;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const r = await run(
      cfg.ffprobe,
      [
        "-v", "error",
        "-show_entries",
        "stream=codec_type,codec_name,width,height,r_frame_rate,duration:stream_disposition=attached_pic:format=duration",
        "-of", "json",
        file,
      ],
      { timeout: 120_000 },
    );
    if (r.code === 0) {
      try {
        return { ok: true, facts: parseProbe(JSON.parse(r.out) as FfprobeJson) };
      } catch (e) {
        return { ok: false, io: false, error: `bad ffprobe json: ${e}` };
      }
    }
    last = (r.err || `ffprobe exit ${r.code}`).trim().slice(0, 300);
    io = IO_RE.test(r.err) || r.err.startsWith("killed");
    if (!io) return { ok: false, io: false, error: last };
    if (attempt < ATTEMPTS) await sleep(2000 * attempt);
  }
  return { ok: false, io, error: last };
}
