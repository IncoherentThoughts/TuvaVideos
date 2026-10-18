// Onboarding from source (sharing-spec §8.1–§8.3): platform shims, `bun run setup`'s checks, the grant script.
import { describe, expect, test } from "bun:test";
import { MAC_TRASH, NO_TRASH_NOTICE, openCommandFor, resolveTrash, trashCommandFor, type Which } from "../src/server/platform";
import { exitCodeFor, formatLine, planSetup, versionAtLeast } from "../scripts/setup";
import { grant, nextStep, parseGrantArgs, type ArchiveDeps } from "../scripts/grant-video-access";

const whichOf = (present: string[]): Which => (n) => (present.includes(n) ? (n.startsWith("/") ? n : `/bin/${n}`) : null);

describe("trash shim", () => {
  test("macOS uses /usr/bin/trash when present, else none", () => {
    expect(trashCommandFor("darwin", whichOf([MAC_TRASH]))!.argv("/a b.mp4")).toEqual({ cmd: MAC_TRASH, args: ["/a b.mp4"] });
    expect(trashCommandFor("darwin", whichOf([]))).toBeNull();
  });
  test("Linux prefers gio trash, then trash-put, else none", () => {
    expect(trashCommandFor("linux", whichOf(["gio", "trash-put"]))!.argv("/x")).toEqual({ cmd: "/bin/gio", args: ["trash", "/x"] });
    expect(trashCommandFor("linux", whichOf(["trash-put"]))!.argv("/x")).toEqual({ cmd: "/bin/trash-put", args: ["/x"] });
    expect(trashCommandFor("freebsd", whichOf(["trash-put"]))!.label).toBe("trash-put");
    expect(trashCommandFor("linux", whichOf([]))).toBeNull();
  });
  test("Windows calls PowerShell with the path as an argument, not inside the script", () => {
    const c = trashCommandFor("win32", whichOf(["powershell"]))!.argv("C:\\v\\a'b.mp4");
    expect(c.cmd).toBe("/bin/powershell");
    expect(c.args.at(-1)).toBe("C:\\v\\a'b.mp4");
    expect(c.args.join(" ")).toContain("SendToRecycleBin");
    expect(trashCommandFor("win32", whichOf(["pwsh"]))!.argv("x").cmd).toBe("/bin/pwsh");
    expect(trashCommandFor("win32", whichOf([]))).toBeNull();
  });
  test("the TUVA_TRASH override wins on every platform; the macOS default means resolve per platform", () => {
    for (const p of ["darwin", "linux", "win32"] as const) expect(trashCommandFor(p, whichOf([]), "/t/fake")!.argv("f")).toEqual({ cmd: "/t/fake", args: ["f"] });
    expect(resolveTrash("/t/fake", "linux", whichOf([]))!.label).toBe("/t/fake");
    expect(resolveTrash(MAC_TRASH, "linux", whichOf(["gio"]))!.label).toBe("gio trash");
    expect(resolveTrash(MAC_TRASH, "linux", whichOf([]))).toBeNull();
    expect(NO_TRASH_NOTICE).toContain("entry only");
  });
});

test("open shim: open / xdg-open / cmd /c start", () => {
  const u = "http://localhost:4400";
  expect(openCommandFor("darwin", u)).toEqual({ cmd: "open", args: [u] });
  expect(openCommandFor("linux", u)).toEqual({ cmd: "xdg-open", args: [u] });
  expect(openCommandFor("win32", u)).toEqual({ cmd: "cmd", args: ["/c", "start", "", u] });
});

describe("bun run setup", () => {
  const probe = (platform: NodeJS.Platform, have: string[], bunVersion = "1.4.3") => ({
    platform,
    bunVersion,
    findBin: (n: string) => (have.includes(n) ? `/bin/${n}` : null),
    which: whichOf(have),
  });

  test("versions compare numerically", () => {
    expect(versionAtLeast("1.4.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.10.0", "1.4.0")).toBe(true);
    expect(versionAtLeast("1.3.9", "1.4.0")).toBe(false);
    expect(versionAtLeast("2.0.0-canary.1", "1.4.0")).toBe(true);
  });

  test("all present: exit 0, optional tools reported", () => {
    const lines = planSetup(probe("darwin", ["ffmpeg", "ffprobe", "cwebp", MAC_TRASH, "yt-dlp", "magick"]));
    expect(lines.map((l) => l.name)).toEqual(["bun", "ffmpeg", "ffprobe", "cwebp", "trash", "yt-dlp", "imagemagick"]);
    expect(lines.every((l) => l.ok)).toBe(true);
    expect(exitCodeFor(lines)).toBe(0);
  });

  test("a missing required tool exits non-zero with the platform's install command", () => {
    const mac = planSetup(probe("darwin", ["ffmpeg", "ffprobe"]));
    expect(exitCodeFor(mac)).toBe(1);
    expect(mac.find((l) => l.name === "cwebp")!.install).toBe("brew install webp");
    expect(formatLine(mac.find((l) => l.name === "cwebp")!)).toBe("MISSING cwebp: not found -> brew install webp");
    const linux = planSetup(probe("linux", []));
    expect(linux.find((l) => l.name === "ffmpeg")!.install).toBe("sudo apt install ffmpeg");
    expect(linux.find((l) => l.name === "trash")!.install).toContain("trash-cli");
    expect(planSetup(probe("win32", [])).find((l) => l.name === "cwebp")!.install).toBe("scoop install libwebp");
  });

  test("trash, yt-dlp and ImageMagick are optional: missing them still exits 0", () => {
    const lines = planSetup(probe("linux", ["ffmpeg", "ffprobe", "cwebp"]));
    expect(exitCodeFor(lines)).toBe(0);
    expect(formatLine(lines.find((l) => l.name === "yt-dlp")!)).toBe("missing yt-dlp (optional): not found -> pipx install yt-dlp");
  });

  test("an old Bun is a required failure", () => {
    const lines = planSetup(probe("darwin", ["ffmpeg", "ffprobe", "cwebp"], "1.3.2"));
    expect(lines[0]).toMatchObject({ name: "bun", ok: false, required: true });
    expect(exitCodeFor(lines)).toBe(1);
  });
});

describe("grant-video-access", () => {
  test("argument parsing", () => {
    expect(parseGrantArgs(["A@Example.org", "Editor"])).toEqual({ email: "a@example.org", level: "editor", revoke: false, dryRun: false, name: null });
    expect(parseGrantArgs(["a@b.co", "member", "--dry-run", "--name", "Ada L"])).toMatchObject({ level: "member", dryRun: true, name: "Ada L" });
    expect(parseGrantArgs(["a@b.co", "--revoke"])).toMatchObject({ revoke: true, level: null });
    expect(parseGrantArgs(["a@b.co", "admin"])).toEqual({ error: "level must be member or editor, not admin" });
    expect(parseGrantArgs(["a@b.co"])).toEqual({ error: "missing <level> (member or editor)" });
    expect(parseGrantArgs(["nope", "member"])).toEqual({ error: "not an email: nope" });
    expect(parseGrantArgs(["a@b.co", "member", "--revoke"])).toEqual({ error: "--revoke takes no level" });
    expect(parseGrantArgs(["a@b.co", "member", "--force"])).toEqual({ error: "unknown option --force" });
    expect(parseGrantArgs([])).toEqual({ error: "missing <email>" });
  });

  test("next step: a new account is told to change the temporary password on the archive first", () => {
    expect(nextStep("a@b.co", "member", true)).toContain("songsofthesteppe.org/login");
    expect(nextStep("a@b.co", "editor", false)).toContain("Video Editor");
    expect(nextStep("a@b.co", "editor", false)).not.toContain("temporary");
  });

  /** A fake archive: records every request; `users` is the Auth admin list. */
  function fakeArchive(users: { id: string; email: string }[]) {
    const calls: { method: string; path: string; body?: unknown }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push({ method, path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (u.pathname === "/auth/v1/admin/users") return Response.json({ users });
      if (u.pathname === "/functions/v1/create-user") {
        users.push({ id: "new-id", email: "new@b.co" });
        return Response.json({ ok: true });
      }
      if (u.pathname === "/rest/v1/video_access" && method === "DELETE") return Response.json([{}]);
      return new Response(null, { status: 201 });
    }) as typeof fetch;
    const deps: ArchiveDeps = { url: "https://x.supabase.co", key: "k", fetch: f };
    return { calls, deps, writes: () => calls.filter((c) => c.method !== "GET") };
  }

  test("dry run reads only; with no key it prints the plan and reads nothing", async () => {
    const a = fakeArchive([{ id: "u1", email: "a@b.co" }]);
    const out: string[] = [];
    expect(await grant(parseGrantArgs(["new@b.co", "member", "--dry-run"]) as never, a.deps, (l) => out.push(l))).toBe(0);
    expect(a.writes()).toEqual([]);
    expect(out.join("\n")).toContain("Would call create-user");
    const plan: string[] = [];
    expect(await grant(parseGrantArgs(["new@b.co", "member", "--dry-run"]) as never, null, (l) => plan.push(l))).toBe(0);
    expect(plan[0]).toContain("nothing read");
    expect(await grant(parseGrantArgs(["new@b.co", "member"]) as never, null, () => {})).toBe(2);
  });

  test("an existing account gets the row upserted on profile_id, no create-user", async () => {
    const a = fakeArchive([{ id: "u1", email: "a@b.co" }]);
    expect(await grant(parseGrantArgs(["a@b.co", "editor"]) as never, a.deps, () => {})).toBe(0);
    expect(a.writes()).toMatchObject([{ method: "POST", path: "/rest/v1/video_access?on_conflict=profile_id", body: { profile_id: "u1", level: "editor" } }]);
  });

  test("a new account goes through create-user first, then the grant", async () => {
    const a = fakeArchive([]);
    const out: string[] = [];
    expect(await grant(parseGrantArgs(["new@b.co", "member", "--name", "N"]) as never, a.deps, (l) => out.push(l))).toBe(0);
    expect(a.writes().map((c) => c.path)).toEqual(["/functions/v1/create-user", "/rest/v1/video_access?on_conflict=profile_id"]);
    expect(a.writes()[0]!.body).toEqual({ email: "new@b.co", full_name: "N" });
    expect(out.join("\n")).toContain("temporary password");
  });

  test("revoke deletes the row; no account means nothing to revoke", async () => {
    const a = fakeArchive([{ id: "u1", email: "a@b.co" }]);
    expect(await grant(parseGrantArgs(["a@b.co", "--revoke"]) as never, a.deps, () => {})).toBe(0);
    expect(a.writes()).toMatchObject([{ method: "DELETE", path: "/rest/v1/video_access?profile_id=eq.u1" }]);
    const b = fakeArchive([]);
    expect(await grant(parseGrantArgs(["z@b.co", "--revoke"]) as never, b.deps, () => {})).toBe(0);
    expect(b.writes()).toEqual([]);
  });
});
