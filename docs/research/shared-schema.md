# Where the Shared tables live in the archive's Supabase project

Research for issue #83 (map #82). Question: where should the **Shared** tables (Videos, Chapters, Video-Artist links, rejection tombstones; Favorites and every other per-machine field stay local) live in the Tuvan Lyrics Archive's Supabase project, and how should they be keyed and secured?

## Sources

Archive paths are relative to `/Users/evanwilliams/Desktop/Lyrics Website/` (read only, nothing modified).

- `CLAUDE.md`, section **Database Migrations** and the data-layer notes on `write_<concept>` functions.
- `supabase/config.toml`: `[api] schemas = ["public", "graphql_public"]`, `extra_search_path = ["public", "extensions"]`, `major_version = 17`.
- `supabase/migrations/001_profiles_and_rls.sql` (lines 98-117): where `is_admin_or_moderator()` and `can_manage_tags()` are defined.
- `supabase/migrations/094_revoke_anon_writes.sql`, `110_base_grants_for_api_roles.sql`, `122_revoke_authenticated_truncate.sql`: the grant and default-privilege history.
- `supabase/migrations/118_track_version.sql`, `120_write_songs_and_song_lyrics.sql`, `123_mentions_sync_rpc.sql`, `126_album_track_artists.sql`, `127_write_track_artists.sql`: the newest table and RPC templates.
- `supabase/tests/01_*`, `09_*`, `21_*`, `dump_security_surface.sql`, `README.md`.
- `prisma/schema.prisma`, `docs/adr/0005-songs-never-deleted-automatically.md`, `docs/adr/0011-transactional-write-functions.md`.
- This repo: `docs/adr/0001-mirror-referenced-by-uuid-without-foreign-keys.md`, `migrations/0001_schema.sql`, `0004`, `0006`, `0008_local_songs.sql`, `0011_deleted_videos.sql`, `src/server/localSongs.ts`.
- Supabase docs: [Using Custom Schemas](https://supabase.com/docs/guides/api/using-custom-schemas), [Securing your API](https://supabase.com/docs/guides/api/securing-your-api), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) (performance section).

## Recommendation in one paragraph

Put the Shared tables in **`public`, with a `video_` prefix**. Key Videos and Chapters with **uuid** primary keys (default `gen_random_uuid()`, client may supply one), and keep `youtube_id` and `content_hash` as unique natural identities. Use **real foreign keys** to `songs`, `song_lyrics` and `artists`, with `ON DELETE SET NULL` for song and version pointers and `ON DELETE CASCADE` for Video-Artist links. This replaces ADR-0001 for Shared data, so it needs a new ADR here. Give every table `ENABLE ROW LEVEL SECURITY`, then `REVOKE ALL ... FROM PUBLIC, anon, authenticated`, then grant back only what `authenticated` needs (no anon grant at all, no TRUNCATE). Gate writes with a new `public.is_video_editor()` helper shaped like `is_admin_or_moderator()`. Every RPC gets `revoke all ... from public; revoke execute ... from anon; grant execute ... to authenticated`.

## 1. Schema: `public` with a prefix, not a dedicated `videos` schema

**Every security net the archive has is scoped to `public`.** A new schema would sit outside all of them.

- **Default privileges are per schema.** Migration 094 revoked anon's write verbs on future tables, and 122 revoked authenticated's TRUNCATE on future tables. Both are `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public` (094 line 72, 122 line 87). A `videos` schema starts with none of that. The Supabase "Using Custom Schemas" guide goes further: its setup recipe is `GRANT ALL ON ALL TABLES ... TO anon, authenticated, service_role` plus matching default privileges. Followed as written, that hands anon full write privileges and authenticated TRUNCATE, which is exactly what 094 and 122 exist to forbid.
- **The pgTAP harness only checks `public`.** `01_anon_write_privileges_test.sql` (line 33) and `09_self_contained_grants_test.sql` (lines 31, 57, 91) filter on `nspname = 'public'` and `defaclnamespace = 'public'::regnamespace`. So does `21_authenticated_truncate_test.sql`, which is set-based "so the next table is covered the moment it exists". The live-drift dump `dump_security_surface.sql` (line 43) also reads `WHERE n.nspname = 'public'`. A table in `public` is policed by CI the moment it is created. A table in `videos` would need every one of those files widened first, or it ships unwatched.
- **The helpers live in `public`.** `is_admin_or_moderator()` and `can_manage_tags()` are `public.*`, `SECURITY DEFINER`, `SET search_path = public` (001 lines 98-117). A policy in another schema can call them by their qualified name, so the schema choice does not block this. But the new `is_video_editor()` belongs next to them under the same conventions.
- **Exposure is a dashboard step plus client changes.** The custom-schema guide's step 1 is adding the schema under API settings, "Exposed schemas". That is a hosted setting that `config.toml` (`schemas = ["public", "graphql_public"]`) only mirrors for local runs, so it is one more HITL step and one more place for live and repo to drift. Each client call also needs `supabase.schema('videos')`, or `Accept-Profile` / `Content-Profile` headers.
- **Prisma.** `schema.prisma` declares no `schemas` and no `@@schema`. As far as I know, Prisma's multi-schema support requires `@@schema` on every model once `schemas` is set, including all existing archive models. That would be a sweeping edit to a file the archive keeps as documentation, not just a few lines. With `public` the new models drop in beside the others. (The Prisma requirement is from memory, not checked against Prisma docs in this pass.)
- **What a dedicated schema would buy.** You could tell at a glance which objects belong to the video app, and drop them all with one `DROP SCHEMA ... CASCADE`. Supabase's "Securing your API" page also recommends a dedicated API schema "if you want an extra boundary". But that advice is about hiding internals behind a curated API schema. It is not about adding a second exposed schema next to a hardened `public`. The `video_` prefix gives the at-a-glance grouping; a teardown migration that lists its tables gives the clean removal.

**Naming.** Archive tables are plural snake_case (`song_lyrics`, `album_track_artists`). Suggested names: `video_videos` is awkward, so use `videos`, `video_chapters`, `video_artists`, `video_chapter_rejections`, `video_artist_rejections`, `video_deletions`, `video_editors`, `video_edit_history`. If the map wants a strict prefix on every table, `video_items` could stand in for `videos`. `videos` itself does not collide with anything in `prisma/schema.prisma` or migrations 001-129.

## 2. Ids: uuid, not integer

- **House convention.** Every archive model with a surrogate key is `String @id @default(uuid()) @db.Uuid`: Artist, Song, SongLyrics, Album, Tag, AlbumTrack, Mention, SongEditHistory and the rest in `prisma/schema.prisma`. The join tables (`album_track_artists`, contributor pairs) use composite primary keys. An integer identity column would be the only one in the database.
- **Ids minted on the client.** In the planned write model, browsers write directly over PostgREST, and a Video Editor's scan creates Videos. A Member who is not an editor creates **Unshared** Videos locally. With uuids, the creating machine can mint the id, use it in the local cache straight away, and send it in the insert (the column's default covers callers that don't). An Unshared Video that is later shared can keep its id. This repo already does the same for Local Songs and Local Versions (`crypto.randomUUID()`, `src/server/localSongs.ts` lines 50 and 154; `local_song.id TEXT PRIMARY KEY`). An integer identity would force a server round trip before any child row (Chapter, Video-Artist link) can name its Video, and a separate local id space for Unshared Videos.
- **Migration cost.** The one-time migration maps the 2,210 local integer `video.id` and 939 `chapter.id` values to new uuids, a lookup table inside one script. The local SQLite cache can then key on the uuid as TEXT, the same way `local_song` does.
- **Natural identity stays as it is.** `youtube_id text unique` and `content_hash text unique`, with `CHECK (youtube_id IS NOT NULL OR content_hash IS NOT NULL)`, carried over from `migrations/0001_schema.sql`. The scanner matches on these, never on the uuid. Add `instagram_id` too if ADR-0005 (here) makes it an identity.
- Chapters can keep `UNIQUE (video_id, start_s)`. Video-Artist links keep the composite `PRIMARY KEY (video_id, artist_id)` plus `position`, the same shape as `album_track_artists` (126), including its `UNIQUE (…, position)`.

## 3. Foreign keys to `songs`, `song_lyrics` and `artists`

ADR-0001 chose plain TEXT uuids with no FKs **because the Mirror is wiped and replaced on every import**. FKs would have blocked the wipe or cascaded through local rows. That reason does not apply once the Shared tables live in the same database as the songs: nothing is ever wiped and re-imported. The ADR still holds for the Standalone app's own Mirror. For Shared data it should be superseded by a new ADR.

**What real FKs buy:**
- No dangling pointers. ADR-0001's consequence ("may point at a uuid that no longer exists … renders as unknown song") goes away.
- PostgREST resource embedding, e.g. `videos?select=id,title,song:songs(id,name)`. PostgREST builds embeds from FK relationships.
- The archive's own discipline: `album_tracks` → `song_lyrics` is a composite FK (118), and `album_track_artists` → `artists` cascades (126).

**What they cost:**
- **Write order.** A promoted Local Song, Version or Artist must exist in the archive before any Video or Chapter that points at it. The one-time migration and every promote-then-link edit must insert in that order, ideally in one transaction (one RPC).
- **Archive deletes reach into video data.** Deleting a Song (admin-only, migration 108; never automatic, archive ADR-0005) or an Artist would null or cascade video rows. Postgres runs referential actions as the table owner, so they apply even though the deleting admin has no video-editor grant. They leave no `video_edit_history` row unless a trigger writes one. With `SET NULL` that is acceptable: the Video loses its Song pointer, which is the same visible outcome as ADR-0001's "unknown song", minus the dangling id. Use `RESTRICT` instead only if the map wants Song deletion blocked while Videos reference it.
- **Archive reshapes.** Migration 125 collapsed bands into artists. With FKs, a future reshape that re-keys `artists` has to carry `videos`/`video_artists` along or fail loudly. Failing loudly is a feature, but it couples the archive's future migrations to this app's tables. Their authors need to know the tables exist (a line in the archive's CLAUDE.md).
- **Indexes.** Postgres does not index referencing columns. Add an index on `video_artists(artist_id)`, `videos(song_id)` and `video_chapters(song_id)`, as 126 does (`idx_album_track_artists_artist_id`), or every archive Song or Artist delete scans these tables.

**Recommended shape:**

```sql
-- videos
song_id    uuid references public.songs(id) on delete set null,
version_id uuid,
constraint videos_version_fkey foreign key (song_id, version_id)
  references public.song_lyrics (song_id, id) on delete set null (version_id),
constraint videos_version_needs_song check (version_id is null or song_id is not null)
-- the same pair on video_chapters
-- video_artists
artist_id uuid not null references public.artists(id) on delete cascade
```

The composite FK reuses the unique index `song_lyrics_song_id_id_key` that 118 created. **Use the column-list form `ON DELETE SET NULL (version_id)`** (Postgres 15+; `config.toml` says 17, confirm live with `select version()`). Plain `SET NULL` on a composite FK nulls *both* columns. Deleting a Version would then also unlink the Video from its Song.

> Side observation for the archive (not acted on): `album_tracks_track_version_fkey` (118) uses plain `ON DELETE SET NULL` on `(song_id, track_version_id)`. Its comment says deleting a Version "returns its Tracks to the default". As written, it also nulls `album_tracks.song_id`, which unlinks the Track from its Song. Worth a check on the archive side.

## 4. Grants, revokes and policies every new object needs

What a new `public` table inherits today, from the post-122 default ACL quoted in 122's header: `anon=rm` (SELECT, MAINTAIN) and `authenticated=arwdxtm` (everything except TRUNCATE). **So a new table is anon-readable by default.** Shared data is for Members only; a Standalone user, or a signed-out visitor to the lyrics site, must not read it. Every Shared table therefore has to strip anon explicitly. 126 is the template, minus its anon SELECT:

```sql
alter table public.<t> enable row level security;
revoke all on table public.<t> from public, anon, authenticated;
grant select, insert, update, delete on table public.<t> to authenticated;   -- never TRUNCATE (122)

create policy "Members read <t>"  on public.<t> for select to authenticated using (true);
create policy "Video Editors insert <t>" on public.<t> for insert to authenticated
  with check ((select public.is_video_editor()));
create policy "Video Editors update <t>" on public.<t> for update to authenticated
  using ((select public.is_video_editor())) with check ((select public.is_video_editor()));
create policy "Video Editors delete <t>" on public.<t> for delete to authenticated
  using ((select public.is_video_editor()));
```

- **Wrap the helper in `(select …)` and name `to authenticated`.** The Supabase RLS performance guide measures 11,000 ms → 7 ms for `(select is_admin())` over a bare `is_admin()`, and recommends `TO` to skip the policy for anon. The archive already uses the wrapped form in 094's policies; 126 does not. It matters little at 2,210 rows, but the grid reads whole tables.
- **If writes go only through `write_video_*` RPCs** (ADR-0011's shape, `SECURITY INVOKER`), the table still needs the direct INSERT/UPDATE/DELETE grant and the policies above, because an invoker function runs with the caller's privileges and RLS. That is the point of ADR-0011: the RPC adds atomicity, not privilege.
- **The editor grant table.** For example `public.video_editors (profile_id uuid primary key references public.profiles(id) on delete cascade, granted_at timestamptz not null default now())`. Enable RLS, `revoke all … from public, anon, authenticated`, and write no policies. Only the console (postgres or service_role) writes it, which matches the map's "set only in the Supabase console". The helper reads it:

  ```sql
  create function public.is_video_editor() returns boolean
  language plpgsql stable security definer set search_path = public as $$
  begin
    return exists (select 1 from public.video_editors where profile_id = auth.uid());
  end; $$;
  revoke all on function public.is_video_editor() from public;
  revoke execute on function public.is_video_editor() from anon;
  grant execute on function public.is_video_editor() to authenticated;
  ```

  This copies `is_admin_or_moderator()` (001), including its home in exposed `public`. Supabase's RLS page warns that security-definer functions "should never be created in a schema in the 'Exposed schemas'". The archive already accepts that for its helpers, and this one only reveals the caller's own status. It also gives the app its "am I a Video Editor?" check as `rpc('is_video_editor')`.
- **Every RPC.** Follow 120 lines 156-162 exactly:

  ```sql
  revoke all on function public.write_video_x(...) from public;
  revoke execute on function public.write_video_x(...) from anon;   -- Supabase grants anon EXECUTE by default
  grant execute on function public.write_video_x(...) to authenticated;
  ```

  Also: gate first with `errcode '42501'`, `P0002` on zero rows, `SET search_path = public` (123 adds `pg_temp` last for definer functions), and one pgTAP file per function (CLAUDE.md, "Adding an eighth function").
- **Tests that must move with the migration.** Add a pgTAP file asserting that anon holds *no* SELECT on any `video_*` table. Test 01 only asserts anon has no write privileges, so it would not catch an anon read. Test 21 covers TRUNCATE for free. Refusal tests must follow the harness rule: a row count paired with a survival check, never an expected error. Refresh `live-rls-snapshot.json` on the live apply, because new functions and policies make `rlsSnapshot.test.ts` fail by design.
- **Sequences.** None with uuid keys, which avoids the `usage, select on sequences` grants the custom-schema recipe needs.

## 5. Related points the later tickets will hit

- **Promoting Unverified rows touches the archive's column allowlists.** `songs`, `artists`, `albums` and `composers` grant anon SELECT by column list (091). A new `is_unverified` column on `songs` or `artists` needs `GRANT SELECT (is_unverified) … TO anon` in the same migration, or signed-out readers break (CLAUDE.md, Database Migrations). Separately, inserts on `songs`, `song_lyrics` and `artists` are gated by `is_admin_or_moderator()` today. A Video Editor who is not a moderator cannot promote without a widened policy or a definer RPC. That is a write-model decision.
- **Local-only fields leave the Shared row.** `video.favorited_at`, `resume_s`, `last_played_at`, `view_count`, `loop_a_s`/`loop_b_s`, the thumbnail and strip columns, `chapter.favorited_at`, and the whole `copy`, `root`, `video_audio` and `studio_*` tables stay in the local SQLite, keyed by the Video or Chapter uuid.
- **Tombstones that become Shared.** `chapter_rejection (video, source, start_s)` → `video_chapter_rejections`. `artist_rejection (video, artist)` → `video_artist_rejections`. `deleted_video (youtube_id | content_hash)` → `video_deletions`, so a Video Editor's scan does not re-add a Video another editor deleted. `studio_rejection` stays local, because Studio tracks are local.
- **Edit history.** One `video_edit_history` table with an event-type CHECK, written inside each `write_video_*` RPC (archive ADR-0011, CLAUDE.md on `buildEntityWrite` specs naming "the history table + FK").

## Trade-offs at a glance

| Choice | Recommended | Gives up |
|---|---|---|
| `public` + prefix | Inherits 094/122 default ACLs, CI tests and the drift dump; no dashboard step; no Prisma multi-schema | One-statement teardown; an obvious namespace boundary |
| uuid ids | House convention; client-minted ids for offline-created and Unshared Videos; one id across cache and server | Compact integers; needs a one-time id map |
| Real FKs | No dangling pointers; PostgREST embeds; the archive's own pattern | Promotion must insert in order; archive deletes and reshapes now reach video tables; supersedes ADR-0001 for Shared data |
| No anon grant | Standalone or signed-out readers see nothing, as decided | Differs from archive content tables, which anon reads, so it needs an explicit revoke and its own test |
