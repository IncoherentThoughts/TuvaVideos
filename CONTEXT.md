# TuvaVideos

A single-user local player for a personal library of Tuvan music videos, browsed in the browser and enriched with artists, chapters, tracks and lyrics mirrored from the Tuvan Lyrics Archive. This glossary fixes the words the project uses for its own concepts; it is not a spec.

## Language

### The library

**Video**:
One piece of footage the library knows about, identified by its YouTube id when it has one and by a content hash otherwise. Carries a title, a Type, Artists, Chapters, Links and a Favorite flag. Never identified by its path.
_Avoid_: file, clip, media, item

**Copy**:
One file on disk holding a Video, inside exactly one Root. A Video has one or more Copies; two Copies of the same Video may differ in quality.
_Avoid_: file, path, location, duplicate

**Root**:
A directory the library scans for Copies. A Root is either **local** (always present, on the laptop) or **external** (on a drive that may be unmounted).
_Avoid_: folder, source, library path, mount

**Available (a Video)**:
Having at least one Copy whose Root is currently mounted. An unavailable Video can be browsed, its Thumbnails viewed and its metadata edited, but not played.
_Avoid_: online, playable, present, offline (for the negative use "unavailable")

**Thumbnail**:
The locally cached poster frame and scrub strip for a Video, generated once and kept so the library can be browsed while every Copy is unavailable.
_Avoid_: preview, poster (when the pair is meant), sprite

**Type (of a Video)**:
One of a fixed set — song, concert, interview, other — describing what the footage is. A concert is footage that holds several songs worth of Chapters.
_Avoid_: category, kind, genre, tag

**Favorite**:
A Video or a Chapter the user has starred. Filterable and searchable; listed in the order they were starred.
_Avoid_: star (the gesture), like, bookmark, pin

**Missing (a Copy)**:
A Copy whose Root is mounted but whose file is no longer there. Kept, not deleted, so it revives if the file returns. A Copy on an unmounted Root is not missing, only unavailable.
_Avoid_: deleted, gone, orphaned, stale

**Resume position**:
The timestamp the user last left a Video at; playback reopens there.
_Avoid_: progress, watch position, bookmark

### Enrichment

**Chapter**:
A start time and a title inside a Video, optionally pointing at a Song and a Version. The unit the player jumps between in a concert.
_Avoid_: marker, segment, timestamp, cue

**Link (track)**:
The association from a Video or a Chapter to a studio Track, so the user can hear the studio recording of what is being performed.
_Avoid_: reference, attachment, match

**Suggested (a link, chapter, song or type)**:
Created by an automatic source (a YouTube comment or description, an archive Performance, the Track matcher) rather than the user, and not yet confirmed. Behaves like a confirmed one until rejected. Every Suggested thing remembers its source.
_Avoid_: auto, pending, unverified, draft

**Mirror**:
The read-only copy of the Tuvan Lyrics Archive's entities (Song, Artist, Album, Track, Version, Footnote, Performance) imported from a backup. Edited only on the archive and re-imported; never edited here.
_Avoid_: sync, cache, import (the act), upstream data

**Latin title**:
The Latin-script form of a Cyrillic title on a Video, Chapter or Local Artist, used so the library can be searched from a Latin keyboard. Generated once, editable afterwards, empty when the title is already Latin. Uses the archive's spelling where the archive has one, otherwise the project's transliteration table.
_Avoid_: transliteration (the act), romanized title, english title (the archive's English name is a translation, not a transliteration)

**Local Artist**:
An Artist created here because the Mirror has no row for them. Never exported to the archive.
_Avoid_: custom artist, unknown artist, extra artist

### Playback

**Player**:
The in-browser video surface and its mpv-style keyboard bindings. Captures keys only while focused.
_Avoid_: viewer, video element, mpv (which is the reference, not the thing)

**Studio playback**:
Playing a Linked Track in Music.app, driven from the browser, with the Video paused meanwhile.
_Avoid_: Apple Music mode, audio mode, track preview
