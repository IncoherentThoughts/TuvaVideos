// Audio settings per Video and the custom EQ presets (spec 4.7, migration 0007). Thin: validation is shared/audio.ts.
import type { Db } from "./db";
import { BUILT_IN_PRESETS, isDefaultAudio, normalizeAudio, normalizeEq, presetNameError, type AudioPreset, type AudioState } from "../shared/audio";

type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

/** The Video's settings, or null when it has none (the Player then uses the defaults). */
export function getVideoAudio(db: Db, videoId: number): AudioState | null | undefined {
  if (!db.query("SELECT 1 FROM video WHERE id = ?").get(videoId)) return undefined;
  const row = db.query("SELECT state FROM video_audio WHERE video_id = ?").get(videoId) as { state: string } | null;
  if (!row) return null;
  try {
    return normalizeAudio(JSON.parse(row.state));
  } catch {
    return null;
  }
}

/** Store the settings; the defaults (or null) clear the row so untouched Videos stay rowless. */
export function setVideoAudio(db: Db, videoId: number, state: unknown): Result<AudioState | null> {
  if (!db.query("SELECT 1 FROM video WHERE id = ?").get(videoId)) return { ok: false, error: "no such video", status: 404 };
  if (state === null) {
    db.prepare("DELETE FROM video_audio WHERE video_id = ?").run(videoId);
    return { ok: true, value: null };
  }
  const s = normalizeAudio(state);
  if (!s) return { ok: false, error: "state must be audio settings with a seven-band eq", status: 400 };
  if (isDefaultAudio(s)) {
    db.prepare("DELETE FROM video_audio WHERE video_id = ?").run(videoId);
    return { ok: true, value: null };
  }
  db.prepare("INSERT INTO video_audio (video_id, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at")
    .run(videoId, JSON.stringify(s), new Date().toISOString());
  return { ok: true, value: s };
}

/** Built-in presets first, then the custom ones by name. */
export function listPresets(db: Db): AudioPreset[] {
  const rows = db.query("SELECT name, eq FROM audio_preset ORDER BY name COLLATE NOCASE").all() as { name: string; eq: string }[];
  const custom: AudioPreset[] = [];
  for (const r of rows) {
    const eq = (() => { try { return normalizeEq(JSON.parse(r.eq)); } catch { return null; } })();
    if (eq) custom.push({ name: r.name, eq, builtIn: false });
  }
  return [...BUILT_IN_PRESETS, ...custom];
}

/** Create or overwrite a custom preset. Names are trimmed; a built-in's name is refused. */
export function savePreset(db: Db, rawName: string, eqIn: unknown): Result<AudioPreset> {
  const err = presetNameError(rawName);
  if (err) return { ok: false, error: err, status: 400 };
  const eq = normalizeEq(eqIn);
  if (!eq) return { ok: false, error: "eq must be seven numbers", status: 400 };
  const name = rawName.trim();
  db.prepare("INSERT INTO audio_preset (name, eq, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET eq = excluded.eq").run(name, JSON.stringify(eq), new Date().toISOString());
  return { ok: true, value: { name, eq, builtIn: false } };
}

export function deletePreset(db: Db, name: string): Result<{ deleted: true }> {
  const r = db.prepare("DELETE FROM audio_preset WHERE name = ?").run(name.trim());
  return r.changes ? { ok: true, value: { deleted: true } } : { ok: false, error: "no such preset", status: 404 };
}
