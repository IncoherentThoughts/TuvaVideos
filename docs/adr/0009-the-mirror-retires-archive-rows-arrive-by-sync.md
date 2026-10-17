---
status: accepted
date: 2026-10-17
supersedes: 0001 (entirely; 0006's "ADR-0001 stays for the Mirror until it retires" clause closes here)
---

# The Mirror retires: the archive's rows reach each machine by Sync into the Local copy

Until now the app knew the Tuvan Lyrics Archive through the **Mirror**: a read-only copy of a backup, imported by `bun run import` into `mirror_*` tables keyed by plain uuid TEXT with no foreign keys (ADR-0001), refreshed only by importing a newer backup. The sharing map (#82) moves the library's link data into the archive's own Supabase project, where it sits beside the archive's Songs, Versions and Artists with real foreign keys (ADR-0006). A separate backup copy of the archive would then be a second, staler source of the same rows on every machine.

Decided (#95, 2026-10-17; the shape from #89 and #92): the `mirror_*` tables become `archive_song`, `archive_version`, `archive_artist`, `archive_performance`, `archive_track`, `archive_album` and the credit tables, filled by **Sync** (`shared_changes_since` over every Shared table, archive rows included, applied by one `applyShared` with an `updated_at` skip guard) instead of by a backup import, and together with the `video_*` tables they are the **Local copy**. Performances, tracks and albums are Shared for every Member, so one pull shape serves everyone. `mirror_import` and the import command go; the Local copy outlives sign-out read-only, and a machine that never signed in holds nothing of the archive. ADR-0001's reason, wipe-and-replace imports that could not keep foreign keys, no longer exists on either side: the server holds real keys (ADR-0006) and the Local copy is upserted row by row, never wiped.

Costs accepted: a Standalone user who never signs in loses the Mirror's Songs and lyrics (the owner's machine signs in; collaborators were never going to receive a backup); the companion's schema is rebuilt around uuid keys once, by the `local-copy` build ticket, with thumbnail files already named by identity so nothing on disk is renamed; and the archive's rare hard deletes of Songs, Versions and Artists need an ids-only reconcile at every Sync, since the archive emits no tombstones. The alternative, keeping the Mirror beside the Shared tables, was rejected as two sources of the same truth with two refresh paths. The `Mirror`, `Local Song`, `Local Version` and `Local Artist` glossary terms are retired at cutover (`docs/sharing-spec.md` §9.3); the `local_*` tables survive only as this machine's own rows for Unshared Videos.
