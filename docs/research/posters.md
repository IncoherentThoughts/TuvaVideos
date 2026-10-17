# Hosting posters in Supabase Storage

Resolves wayfinder research ticket #85 (map #82). The question: how should
poster thumbnails be hosted in the Tuvan Lyrics Archive's Supabase Storage so
that every Member's grid can be browsed, Video Editors can write them, and a
Standalone user never touches the bucket?

Terms (Shared, Standalone, Member, Video Editor, Unshared) are the ones in
`CONTEXT.md` under **Sharing**.

## Recommendation (TL;DR)

| Item | Recommendation |
|--|--|
| Bucket | One **private** bucket, `posters`, with `allowed_mime_types = {image/webp}` and `file_size_limit` around 256 KB. The largest poster today is 111 KB. |
| Object path | `<shared video id>/<first 16 hex chars of the poster's sha256>.webp`. Each object is **immutable**: a new poster gets a new path, and the old object is deleted. The Shared Video row has a `poster_path` column, written by the same `write_<concept>` RPC that changes the Video. |
| RLS on `storage.objects` | `SELECT` for `authenticated` on `bucket_id = 'posters'`. `INSERT`, `UPDATE` and `DELETE` only where `(select public.is_video_editor())` is true. That is a `SECURITY DEFINER` helper over the Video Editor grant table, in the same initplan form as the archive's `is_admin_or_moderator()`. |
| Who reads | **The Bun companion, not the browser.** It downloads each poster once with the Member's JWT (`GET /storage/v1/object/authenticated/posters/<path>`) into the local thumbs directory. It then serves the poster through the existing `/thumbs/<id>/poster.webp` route, so the grid's `<img>` tags still point at localhost. |
| Who writes | The Video Editor's Bun companion uploads with `supabase-js` (Bun is a supported runtime), using the anon key plus the editor's session token. It sends `contentType: 'image/webp'` and `cacheControl: '31536000'`. The service key is never used on a collaborator's machine. |
| Cache headers | Set a one-year `cache-control` on upload, which is safe because paths are immutable. In this design the CDN hardly matters, because each Member downloads a poster only once. |
| Egress | About **36 MB per Member, once** (2,166 posters × 16.7 KB), so about **0.18 GB for 5 Members**. After that, only new or changed posters are downloaded, at a few MB a month. That is under 4% of the Free plan's 5 GB of uncached egress in the first month, and close to 0% afterwards. **The Free plan is enough.** |
| Standalone | The app builds no Supabase client without a session, so **there are zero Storage requests**. Posters are generated and served locally, exactly as they are today. |
| Fallback | The local poster cache is the source of truth for the grid. If the bucket can't be reached (offline, project paused, 5xx), the grid uses whatever is cached. Next it uses a poster the machine generated itself from its own Copy. Failing both, it shows the card's existing no-image state. Downloads retry on the next sync. Nothing blocks or errors in the UI. |
| Image transformations | Not needed: posters are already 480 px WebP at q75. The feature is also Pro-only, and the archive is on the Free plan (its `/render/image/` route returns 403). |

## Local facts (measured 2026-10-16, read-only)

Directory: `~/Library/Application Support/TuvaVideos/thumbs/`. Only `*.poster.webp` files were counted, not `*.strip.webp`.

| Set | Files | Bytes |
|--|--|--|
| All `*.poster.webp` | 2,282 | 38,060,068 (38.1 MB). Mean 16.7 KB, median 14.3 KB, p95 35.8 KB, min 294 B, max 111 KB |
| `<videoId>.poster.webp` (the live naming) | 2,187 | 36,542,280 |
| Seed leftovers named `<sha256>` (72) or `<youtubeId>` (23) | 95 | 1,517,788 |
| **Posters of Videos with `thumbnail_generated_at` set in `library.db`** | **2,166** | **36,255,724 (36.3 MB), mean 16.7 KB** |

The upload set is the last row: about 36 MB. The 95 seed leftovers come from the
#21 adoption, and the 21 orphan `<videoId>` posters belong to deleted Videos.
Neither group should be uploaded.

How posters are made and served today:

- `src/server/thumbs.ts` grabs one frame at 10% of the duration with ffmpeg, 480 px wide (`scale=480:-2`). It pipes PNG into `cwebp -q 75 -m 4` (`POSTER_W = 480`, `POSTER_Q = 75`, `POSTER_AT = 0.1`). The output is `<thumbsDir>/<videoId>.poster.webp` (`posterPath()`), with up to 4 jobs at a time.
- `src/server/api.ts`: the route `/thumbs/<id>/poster.webp` (`thumbRoute`) serves the file with `cache-control: public, max-age=86400` and `Last-Modified`, and answers 304 to `If-Modified-Since`. Video JSON carries `thumbUrl(id, "poster", generatedAt)`, which appends `?v=<generatedAt>` because Video ids are reused after deletes and renumbering.
- `src/web/ui.tsx:176` renders `<img loading="lazy" decoding="async" onError={() => setFailed(true)}>`. `src/web/windowed.ts` keeps 96 cards in the DOM per step (`WINDOW_STEP`) and grows the window as you scroll. So one grid load fetches about 96 to 200 posters, not 2,166.

## Primary-source findings

### Public vs private buckets

- Private buckets: "all operations are subject to access control via RLS policies. This also applies when downloading assets." The only ways to download are an Authorization header carrying the user's JWT or a signed URL. [Storage Buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals)
- Public buckets bypass access control "for both retrieving and serving files"; "anyone who possesses the asset URL can readily access the file". Uploads, deletes, moves and copies are still checked against RLS. (same page)
- Private objects are fetched from `/storage/v1/object/authenticated/<bucket>/<name>` with the user's Authorization header, or through `createSignedUrl(path, expiresIn)`. Public objects are fetched from `/storage/v1/object/public/<bucket>/<name>`. [Serving assets](https://supabase.com/docs/guides/storage/serving/downloads)
- CDN: public objects "do not require any authorization", so they get a better hit rate. Private objects are authorized per user, so two users in the same region can both miss. Caches can evict objects that haven't been requested for a while. [CDN fundamentals](https://supabase.com/docs/guides/storage/cdn/fundamentals)
- Smart CDN (Pro and above only) invalidates on update or delete within about 60 s, treats "each unique token as a separate cache key" for signed URLs, and says the default browser TTL "is typically set to 1 hour". Its advice: if the asset has no per-user restriction, prefer a public bucket. [Smart CDN](https://supabase.com/docs/guides/storage/cdn/smart-cdn)

**Why private anyway.** The map's rule is that Shared data is read by Members.
A public bucket would put frames from third-party videos at guessable
`<id>.webp` URLs that anyone could fetch, which contradicts that rule. A public
bucket's advantages are CDN hit rate and plain `<img src>` URLs, and both stop
mattering once the companion mirrors posters locally. Each poster is fetched
once per Member, so the hit rate is irrelevant. The `<img>` points at
localhost, so it needs no auth header. Signed URLs were rejected: they would
force the browser to mint and refresh tokens for every card, and each token
gets its own cache key.

### RLS on `storage.objects`

- An upload needs only an `INSERT` policy. An **upsert also needs `SELECT` and `UPDATE`**. [Storage access control](https://supabase.com/docs/guides/storage/security/access-control)
- `storage.foldername(name)` and `storage.allow_only_operation()` / `storage.allow_any_operation()` are available for path-scoped or operation-scoped `SELECT` policies. (same page)
- "Service keys entirely bypass RLS policies." Only trusted servers should hold one. (same page)
- The archive has already hit this. Its migration `058` dropped the `images` bucket's `SELECT` policy to stop anonymous listing (lint 0025). As `092` records, Postgres needs `SELECT` visibility for any `UPDATE`/`DELETE` with a `WHERE`, and for storage-api's upsert (`INSERT ... ON CONFLICT DO UPDATE`). Without a `SELECT` policy, "nobody — not even admins — can overwrite or delete through the API". (`/Users/evanwilliams/Desktop/Lyrics Website/supabase/migrations/058_lock_down_images_bucket_writes.sql`, `092_images_bucket_owner_scope.sql`). The `posters` bucket avoids this because Members need `SELECT` anyway.

Policy shape. The names of the grant table and helper are placeholders until
the write-model ticket fixes them:

```sql
create policy posters_select_member on storage.objects
  for select to authenticated
  using (bucket_id = 'posters');

create policy posters_insert_editor on storage.objects
  for insert to authenticated
  with check (bucket_id = 'posters' and (select public.is_video_editor()));

create policy posters_update_editor on storage.objects
  for update to authenticated
  using (bucket_id = 'posters' and (select public.is_video_editor()))
  with check (bucket_id = 'posters' and (select public.is_video_editor()));

create policy posters_delete_editor on storage.objects
  for delete to authenticated
  using (bucket_id = 'posters' and (select public.is_video_editor()));
```

`is_video_editor()` is `SECURITY DEFINER` and `STABLE`, and returns
`exists (select 1 from video_editors where profile_id = auth.uid())`. It is
written in the `(select ...)` initplan form, which the archive's `076` and
`092` use so the helper runs once per statement. No anon policy exists, so a
signed-out request sees nothing.

### Uploading from Bun

- supabase-js lists Bun as a supported runtime, through Bun's native `fetch`. [supabase-js README](https://cdn.jsdelivr.net/gh/supabase/supabase-js@master/README.md), [JSR package](https://jsr.io/@supabase/supabase-js)
- `upload(path, body, { cacheControl, contentType, upsert })` sends a POST to `/storage/v1/object/<bucket>/<path>`. The defaults are `cacheControl: '3600'` (sent as `cache-control: max-age=3600`), `contentType: 'text/plain;charset=UTF-8'` for non-Blob bodies, and `upsert: false` (`x-upsert: false`). [storage-js `StorageFileApi.ts`](https://github.com/supabase/storage-js/blob/main/src/packages/StorageFileApi.ts), [upload reference](https://supabase.com/docs/reference/javascript/storage-from-upload)
  - So **always pass `contentType: 'image/webp'`**, or pass a `Bun.file()`, which is a Blob, so the bucket's MIME allow-list accepts it. Also pass `cacheControl: '31536000'`. With immutable paths, `upsert` stays `false`.
- The plain REST call would be the same POST with `Authorization: Bearer <user access token>`, `apikey: <anon key>`, `content-type: image/webp`, `cache-control: max-age=31536000` and `x-upsert: false`. supabase-js is preferred because it refreshes the session.
- How the companion gets the editor's session token belongs to the sign-in ticket. Pushing the token from the browser to localhost is one option. The other is for the browser to do the upload itself: fetch `/thumbs/<id>/poster.webp` and call `upload()`. This research doesn't depend on which is chosen.

Upload flow for a Video Editor's poster: generate locally as today, then
sha256 the file and upload it to `<sharedId>/<hash16>.webp`. Then call the
Video write RPC to set `poster_path` (recorded in edit history like any other
Shared write), and finally delete the previous object. If the RPC fails, the
new object is orphaned but harmless; a sweep can list and remove objects that
no row references. The one-time migration uploads the 2,166 posters this
way: about 36 MB, which takes a few minutes at 4 to 8 uploads at a time.

### Pricing and limits (supabase.com/pricing, read 2026-10-16)

| | Free | Pro ($25/mo) |
|--|--|--|
| Storage | 1 GB | 100 GB, then $0.0213/GB |
| Egress (uncached) | 5 GB | 250 GB, then $0.09/GB |
| Cached egress | 5 GB | 250 GB, then $0.03/GB |
| Max upload size | 50 MB | 500 GB |
| Image transformations | not included | 100 origin images, then $5 per 1,000 |
| Inactivity | "Free projects are paused after 1 week of inactivity" | never paused |

Source: [Pricing](https://supabase.com/pricing). Cached and uncached egress
have "independent quotas and independent pricing". Egress is a single quota
shared by DB, Auth, Storage and other services. On the Free plan, or with a
Spend Cap, going over the quota starts a grace period under the Fair Use
Policy and may bring a restriction that lifts at the next billing cycle.
[Egress](https://supabase.com/docs/guides/platform/manage-your-usage/egress).
The archive project is on the **Free plan**, according to its own audits
(`Lyrics Website/docs/audits/2026-08-test-coverage.md`,
`2026-08-performance.md`). I couldn't check this live, because the
project-read call was not permitted in this session.

## Egress estimate: 5 Members, a few grid loads a day

Assumptions: 5 Members, 3 grid loads a day each, 30 days, so 450 loads a
month. A poster averages 16.7 KB, and the library has 2,166 posters (36.3 MB).

| Design | Monthly Storage egress | vs Free (5 GB) |
|--|--|--|
| **Recommended: companion mirrors posters locally** | First month: 5 × 36.3 MB = **0.18 GB**. After that: new or changed posters only, for example 100 × 16.7 KB × 5 = **8 MB** | 3.6%, then about 0.2% |
| Browser loads from the bucket, browser cache works (one-year TTL, immutable paths) | About the same as the mirror: each browser fills its cache once. But browser caches get cleared, are per-profile, and the TV is a second browser | about 4% |
| Browser loads from the bucket with **no** effective browser cache, first window only (about 150 posters a load) | 450 × 150 × 16.7 KB = **1.1 GB** | 23% |
| Same, but scrolling the whole grid every load (2,166 posters) | 450 × 36.3 MB = **16.3 GB** | **3.3× over Free**. On Pro: inside 250 GB |

Even the worst case is only a few dollars on Pro. On Free, though, it would
use up the egress quota that the archive's own website shares. The mirror
design bounds the cost by library size, not by how often people browse.
Storage is 36 MB, against 1 GB on Free.

## Standalone never touches the bucket

Standalone means "no account; nothing leaves the machine" (`CONTEXT.md`).
The companion's Supabase client should be created lazily, and only once a
session exists. Poster sync is a job that runs only in Member mode. In
Standalone mode `thumbs.ts` generates posters from local Copies exactly as
it does today, and `/thumbs` serves them, so no Storage URL is ever built.
A test can check this: start in Standalone mode, scan, browse, and assert
that no request leaves for `*.supabase.co`.

## Fallback when the bucket is unreachable

The local thumbs directory is the cache. The order is:

1. A mirrored Shared poster (`poster_path` matches the hash cached on disk).
2. A poster this machine generated from its own Copy. Unshared Videos always use this, and so do Videos the editor hasn't uploaded yet.
3. The card's existing no-image state (`onError` in `ui.tsx`). The rule is the same for a Video with no available Copy, which is shown greyed out.

When a sync attempt fails (network down, 5xx, or a Free project paused
after a week of inactivity), the companion logs it and backs off. It
retries on the next sync or when connectivity returns. The grid never waits
on Storage. Offline Member browsing, which works from the cache, is
unaffected.

## Open items for other tickets

- The grant table name and `is_video_editor()` belong to the write-model ticket. Whether `poster_path` sits on the Shared Video row or in a side table belongs to the schema ticket.
- How the session token reaches the companion, so it can download and upload, belongs to the sign-in ticket.
- Whether a Member who has a Copy should prefer their own locally generated poster over the Shared one. Recommended: the Shared one wins, so every grid looks the same, and the local one is the fallback.
