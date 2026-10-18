// The migration script's archive client: PostgREST, Storage and Auth over plain fetch (the companion has no
// supabase-js). Three credentials:
//   - the publishable key (anon), for the one read the spec makes by name: the live Artist Andrei Mongush;
//   - the service-role key (`TUVA_ARCHIVE_SERVICE_KEY`, env only), for the emptiness checks, the poster uploads, the
//     rejection rows and the `created_at` restore, and to mint a session for the owner;
//   - that session, for every write function: migration 130's gates read `auth.uid()` (`is_video_editor()`,
//     `get_my_role() = 'admin'`), which a service-role call does not have, and the history's `editor_id` is the owner.
import { readArchiveError, type ArchiveError, type EditInput, type WriteFunction } from "../../shared/archiveWire";

export class ArchiveCallError extends Error {
  constructor(readonly what: string, readonly status: number, readonly error: ArchiveError) {
    super(`${what}: ${status} ${error.word}${error.code ? ` (${error.code})` : ""}: ${error.message}`);
  }
}

export interface ArchiveEnv {
  url: string;
  publishableKey: string;
  serviceKey: string | null;
}

export class Archive {
  private token: { access: string; refresh: string; at: number } | null = null;

  constructor(readonly env: ArchiveEnv) {}

  private service(): string {
    if (!this.env.serviceKey) throw new Error("TUVA_ARCHIVE_SERVICE_KEY is not set");
    return this.env.serviceKey;
  }

  private async call(what: string, path: string, init: RequestInit & { key: string; bearer?: string }): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("apikey", init.key);
    headers.set("Authorization", `Bearer ${init.bearer ?? init.key}`);
    const res = await fetch(`${this.env.url}${path}`, { ...init, headers });
    if (!res.ok) {
      const text = await res.text();
      let body: Record<string, string | null> = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
      throw new ArchiveCallError(what, res.status, readArchiveError({ code: body.code ?? body.statusCode ?? null, message: body.message ?? body.msg ?? body.error ?? text, details: body.details ?? null, hint: body.hint ?? null }));
    }
    return res;
  }

  /** Archive Artists named exactly `name` that anon can read (the publishable key). */
  async artistsNamed(name: string): Promise<{ id: string; name: string }[]> {
    const q = `/rest/v1/artists?select=id,name&name=eq.${encodeURIComponent(name)}`;
    return (await this.call("artists by name", q, { key: this.env.publishableKey })).json() as Promise<{ id: string; name: string }[]>;
  }

  /** Exact row count of a table, read with the service-role key (RLS bypassed). */
  async count(table: string): Promise<number> {
    const res = await this.call(`count ${table}`, `/rest/v1/${table}?select=id&limit=1`, { key: this.service(), method: "HEAD", headers: { Prefer: "count=exact" } });
    const range = res.headers.get("content-range") ?? "";
    const n = Number(range.split("/")[1]);
    if (!Number.isFinite(n)) throw new Error(`count ${table}: no count in Content-Range "${range}"`);
    return n;
  }

  /** Every row of `table` (selected columns), paged, with the service-role key. */
  async all<T>(table: string, select: string): Promise<T[]> {
    const out: T[] = [];
    for (let from = 0; ; from += 1000) {
      const res = await this.call(`read ${table}`, `/rest/v1/${table}?select=${select}&order=id`, { key: this.service(), headers: { Range: `${from}-${from + 999}` } });
      const page = (await res.json()) as T[];
      out.push(...page);
      if (page.length < 1000) return out;
    }
  }

  /** One row's `updated_at` (the stamp a write needs), with the service-role key. */
  async updatedAt(table: string, id: string): Promise<string | null> {
    const res = await this.call(`read ${table} ${id}`, `/rest/v1/${table}?select=updated_at&id=eq.${encodeURIComponent(id)}`, { key: this.service() });
    return ((await res.json()) as { updated_at: string }[])[0]?.updated_at ?? null;
  }

  /** Objects at the top of the `posters` bucket (folders count), up to `limit`. */
  async posterObjects(limit = 1): Promise<number> {
    const res = await this.call("list posters", "/storage/v1/object/list/posters", {
      key: this.service(), method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix: "", limit, offset: 0 }),
    });
    return ((await res.json()) as unknown[]).length;
  }

  /** Uploads one poster (`upsert: false`). An object already at the path (a resumed run) counts as uploaded. */
  async uploadPoster(path: string, bytes: Uint8Array): Promise<"uploaded" | "exists"> {
    try {
      await this.call(`upload ${path}`, `/storage/v1/object/posters/${path}`, {
        key: this.service(), method: "POST",
        headers: { "Content-Type": "image/webp", "Cache-Control": "max-age=31536000", "x-upsert": "false" },
        body: new Blob([new Uint8Array(bytes)], { type: "image/webp" }),
      });
      return "uploaded";
    } catch (e) {
      if (e instanceof ArchiveCallError && (e.status === 409 || /exists|duplicate/i.test(e.error.message))) return "exists";
      throw e;
    }
  }

  /** Inserts rows with the service-role key; rows whose primary key is already there are left alone (a resumed run). */
  async insertIgnoringDuplicates(table: string, rows: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await this.call(`insert ${table}`, `/rest/v1/${table}?on_conflict=id`, {
        key: this.service(), method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(i, i + 500)),
      });
    }
  }

  /**
   * Sets `created_at` on existing rows with the service-role key: an upsert merging only the given columns. The row's
   * NOT NULL and identity columns ride along (the insert half of the upsert must be a valid row) with their current values.
   */
  async mergeColumns(table: string, rows: Record<string, unknown>[]): Promise<void> {
    for (let i = 0; i < rows.length; i += 500) {
      await this.call(`update ${table}`, `/rest/v1/${table}?on_conflict=id`, {
        key: this.service(), method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(rows.slice(i, i + 500)),
      });
    }
  }

  /**
   * A session for `email` minted with the service-role key (Auth admin `generate_link` magiclink, then `verify`), so
   * the writes run as that account. No email is sent. Re-minted when older than 30 minutes (tokens last an hour).
   */
  async signInAs(email: string): Promise<void> {
    const link = (await (await this.call("generate_link", "/auth/v1/admin/generate_link", {
      key: this.service(), method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", email }),
    })).json()) as { hashed_token?: string; properties?: { hashed_token?: string } };
    const token_hash = link.hashed_token ?? link.properties?.hashed_token;
    if (!token_hash) throw new Error("generate_link returned no hashed_token");
    const session = (await (await this.call("verify", "/auth/v1/verify", {
      key: this.env.publishableKey, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "magiclink", token_hash }),
    })).json()) as { access_token?: string; refresh_token?: string };
    if (!session.access_token) throw new Error("verify returned no access_token");
    this.token = { access: session.access_token, refresh: session.refresh_token ?? "", at: Date.now() };
    this.email = email;
  }

  private email: string | null = null;

  private async bearer(): Promise<string> {
    if (!this.token || !this.email) throw new Error("not signed in: call signInAs first");
    if (Date.now() - this.token.at > 30 * 60 * 1000) await this.signInAs(this.email);
    return this.token.access;
  }

  /** `video_whoami()` as the minted session. */
  async whoami(): Promise<{ user_id: string; grant_level: string | null; archive_role: string | null; email: string | null }> {
    const res = await this.call("video_whoami", "/rest/v1/rpc/video_whoami", {
      key: this.env.publishableKey, bearer: await this.bearer(), method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return res.json() as never;
  }

  /** One write function call as the minted session; returns the `{tables, tombstones}` bundle. */
  async write(fn: WriteFunction, op: string, target: string | null, payload: unknown, edits: EditInput[], stamp: string | null = null): Promise<{ tables: Record<string, Record<string, unknown>[]> }> {
    const res = await this.call(`${fn} ${op} ${target ?? ""}`.trim(), `/rest/v1/rpc/${fn}`, {
      key: this.env.publishableKey, bearer: await this.bearer(), method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p_op: op, p_target: target, p_payload: payload, p_expected_updated_at: stamp, p_edits: edits }),
    });
    return res.json() as never;
  }
}
