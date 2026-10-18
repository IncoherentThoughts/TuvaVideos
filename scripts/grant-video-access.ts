// The owner's grant script (docs/sharing-spec.md §8.1, ADR-0007): gives an archive account video access.
//
//   bun scripts/grant-video-access.ts <email> <member|editor> [--name "Full Name"] [--dry-run]
//   bun scripts/grant-video-access.ts <email> --revoke [--dry-run]
//
// Needs SUPABASE_URL (the archive project, https://<ref>.supabase.co) and SUPABASE_SERVICE_ROLE_KEY in the environment.
// The key is the owner's alone: never commit it, never put it in the app. When the email has no archive account yet the
// script calls the archive's `create-user` Edge Function (which emails a temporary password), then upserts the
// `video_access` row (profile_id, level, granted_at) through PostgREST, and prints the next step to tell the person.
// `--revoke` deletes the row. `--dry-run` only reads (the account lookup) and prints what it would do; with no key it
// prints the plan without reading anything. Grants are never made from either app's UI.

export type Level = "member" | "editor";

export interface GrantArgs {
  email: string;
  level: Level | null;
  revoke: boolean;
  dryRun: boolean;
  name: string | null;
}

export const USAGE =
  'usage: bun scripts/grant-video-access.ts <email> <member|editor> [--name "Full Name"] [--dry-run]\n' +
  "       bun scripts/grant-video-access.ts <email> --revoke [--dry-run]\n" +
  "env:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (the archive project's service-role key)";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Pure: argv (after the script path) to the request, or an error message. */
export function parseGrantArgs(argv: string[]): GrantArgs | { error: string } {
  const pos: string[] = [];
  let revoke = false;
  let dryRun = false;
  let name: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--revoke") revoke = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--name") {
      const v = argv[++i];
      if (!v) return { error: "--name needs a value" };
      name = v;
    } else if (a.startsWith("--name=")) name = a.slice(7);
    else if (a === "-h" || a === "--help") return { error: "help" };
    else if (a.startsWith("-")) return { error: `unknown option ${a}` };
    else pos.push(a);
  }
  const [rawEmail, rawLevel, ...extra] = pos;
  if (!rawEmail) return { error: "missing <email>" };
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: `not an email: ${rawEmail}` };
  if (extra.length) return { error: `unexpected argument ${extra[0]}` };
  if (revoke) {
    if (rawLevel) return { error: "--revoke takes no level" };
    if (name) return { error: "--revoke takes no --name" };
    return { email, level: null, revoke, dryRun, name };
  }
  if (!rawLevel) return { error: "missing <level> (member or editor)" };
  const level = rawLevel.toLowerCase();
  if (level !== "member" && level !== "editor") return { error: `level must be member or editor, not ${rawLevel}` };
  return { email, level, revoke, dryRun, name };
}

/** Pure: what to tell the person once the grant is in. */
export function nextStep(email: string, level: Level, created: boolean): string {
  const what = level === "editor" ? "a Video Editor (can change the Shared data)" : "a Member (reads the Shared data)";
  const lines = [`Granted: ${email} is now ${what}.`, "Next step, tell them:"];
  if (created) {
    lines.push(
      "  1. The archive just emailed you a temporary password. Sign in once on https://songsofthesteppe.org/login",
      "     and change it there (the app does not change passwords).",
      "  2. Then in TuvaVideos click Sign in and use the same email and your new password.",
    );
  } else {
    lines.push("  In TuvaVideos click Sign in and use your songsofthesteppe.org email and password.");
  }
  lines.push("Do not send a password yourself; the archive's own email carries it.");
  return lines.join("\n");
}

export interface ArchiveDeps {
  url: string;
  key: string;
  fetch: typeof fetch;
}

export interface Log {
  (line: string): void;
}

const headers = (key: string, extra: Record<string, string> = {}) => ({
  apikey: key,
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
  ...extra,
});

async function failText(r: Response): Promise<string> {
  const body = await r.text().catch(() => "");
  return `${r.status} ${r.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`;
}

/** The auth user (= profile) id for an email, paging the Auth admin list; null when there is no account. */
export async function findUserId(d: ArchiveDeps, email: string): Promise<string | null> {
  for (let page = 1; page < 100; page++) {
    const r = await d.fetch(`${d.url}/auth/v1/admin/users?page=${page}&per_page=1000`, { headers: headers(d.key) });
    if (!r.ok) throw new Error(`account lookup failed: ${await failText(r)}`);
    const { users = [] } = (await r.json()) as { users?: { id: string; email?: string }[] };
    const hit = users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (users.length < 1000) return null;
  }
  return null;
}

/** Runs the grant or revoke. Returns the exit code. */
export async function grant(a: GrantArgs, d: ArchiveDeps | null, log: Log): Promise<number> {
  const dry = a.dryRun ? "[dry run] " : "";
  if (!d) {
    if (!a.dryRun) {
      log("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
      return 2;
    }
    log(`${dry}No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: nothing read. The plan:`);
    log(`${dry}  look up ${a.email} in the archive's accounts (GET /auth/v1/admin/users)`);
    if (a.revoke) log(`${dry}  delete its video_access row (DELETE /rest/v1/video_access?profile_id=eq.<id>)`);
    else {
      log(`${dry}  if there is no account: create it with create-user (POST /functions/v1/create-user), which emails a temporary password`);
      log(`${dry}  upsert video_access (profile_id, level '${a.level}', granted_at now) on profile_id`);
    }
    return 0;
  }

  let id = await findUserId(d, a.email);
  log(`${dry}${a.email}: ${id ? `account ${id}` : "no archive account"}`);

  if (a.revoke) {
    if (!id) {
      log(`${dry}Nothing to revoke.`);
      return 0;
    }
    if (a.dryRun) {
      log(`${dry}Would delete the video_access row for ${id}.`);
      return 0;
    }
    const r = await d.fetch(`${d.url}/rest/v1/video_access?profile_id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: headers(d.key, { Prefer: "return=representation" }),
    });
    if (!r.ok) {
      log(`Revoke failed: ${await failText(r)}`);
      return 1;
    }
    const rows = (await r.json()) as unknown[];
    log(rows.length ? `Revoked: ${a.email} has no video access now (the app handles the lost grant, sharing-spec §2.5).` : `${a.email} had no grant.`);
    return 0;
  }

  const level = a.level!;
  let created = false;
  if (!id) {
    if (a.dryRun) {
      log(`${dry}Would call create-user for ${a.email}${a.name ? ` (${a.name})` : ""}; it emails a temporary password.`);
      log(`${dry}Would then upsert video_access (level '${level}').`);
      return 0;
    }
    const r = await d.fetch(`${d.url}/functions/v1/create-user`, {
      method: "POST",
      headers: headers(d.key),
      body: JSON.stringify({ email: a.email, ...(a.name ? { full_name: a.name } : {}) }),
    });
    if (!r.ok) {
      log(`create-user failed: ${await failText(r)}`);
      log("Create the account in the archive's Users section instead, then run this again.");
      return 1;
    }
    created = true;
    id = await findUserId(d, a.email);
    if (!id) {
      log("create-user answered but the account is not listed yet; run this again in a moment.");
      return 1;
    }
    log(`Created account ${id}; the archive emailed ${a.email} a temporary password.`);
  }

  if (a.dryRun) {
    log(`${dry}Would upsert video_access (profile_id ${id}, level '${level}').`);
    return 0;
  }
  const r = await d.fetch(`${d.url}/rest/v1/video_access?on_conflict=profile_id`, {
    method: "POST",
    headers: headers(d.key, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ profile_id: id, level, granted_at: new Date().toISOString() }),
  });
  if (!r.ok) {
    log(`Grant failed: ${await failText(r)}`);
    return 1;
  }
  log(nextStep(a.email, level, created));
  return 0;
}

if (import.meta.main) {
  const a = parseGrantArgs(process.argv.slice(2));
  if ("error" in a) {
    if (a.error !== "help") console.error(a.error);
    console.error(USAGE);
    process.exit(a.error === "help" ? 0 : 2);
  }
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const deps = url && key ? { url, key, fetch } : null;
  try {
    process.exit(await grant(a, deps, (l) => console.log(l)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
