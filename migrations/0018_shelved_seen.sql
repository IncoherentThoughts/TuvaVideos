-- 0018: "seen" for Shelved edits (ticket #159, docs/sharing-spec.md §7.4). A Video with Shelved edits the user has not
-- looked at is highlighted (the State button and the History tab's marker; the grid card's dot later); opening the
-- drawer for that Video (or for every Video) stamps its rows. Clearing deletes the rows, so it clears the highlight too.
-- Rows shelved before this migration start unseen. Local only, never synced.
ALTER TABLE shelved_edit ADD COLUMN seen_at TEXT;
