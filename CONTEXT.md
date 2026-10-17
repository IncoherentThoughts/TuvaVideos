# TuvaVideos

A single-user local player for a personal library of Tuvan music videos, browsed in the browser and enriched with artists, chapters, studio tracks and lyrics mirrored from the Tuvan Lyrics Archive. This glossary fixes the words the project uses for its own concepts; it is not a spec.

## Language

### The library

**Video**:
One piece of footage the library knows about, identified by its YouTube id when it has one and by a content hash otherwise. A Video downloaded from Instagram also records its post's shortcode: not its identity, but a new file with a shortcode the library already knows becomes another Copy of that Video. Carries a title, a Type, Artists, Chapters, Links and a Favorite flag. Never identified by its path.
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
The timestamp the user last left a Video at; playback reopens there without asking. A position within the last 30 seconds counts as finished and reopens at the start.
_Avoid_: progress, watch position, bookmark

**Preferred Copy**:
The Copy the selection rule picks when a Video is played: local Root first, then one that plays as-is under the Playback profile of the player in use, then larger resolution, then smaller size. The user may switch Copies for one play; the choice is never remembered.
_Avoid_: best copy, default copy, pinned copy, copy to play

**Fallback (of a Copy)**:
The one-time cached remux or audio transcode played instead of the Copy's own file when the player's Playback profile cannot play it as-is. Made for the browser only, at scan time when possible, otherwise on first play while the Player shows it preparing. At most one per Copy; the TV app plays it when its own Playback profile allows.
_Avoid_: remux (the act), transcode (the act), converted file, pipe

**Playback profile**:
The containers, codecs and limits one player (the browser, or the TV app) plays as-is. Each Copy is judged against each Playback profile once, at scan time, and judged again when the profile changes.
_Avoid_: device profile, client profile, capabilities, codec support

**Live remux**:
A stream made on the fly while the TV app plays a Copy that neither the Copy itself nor its Fallback suits: the video copied untouched, the audio copied or converted. Leaves nothing cached; one at a time.
_Avoid_: transcode, pipe, live Fallback, on-the-fly conversion

### Enrichment

**Chapter**:
A start time and a title inside a Video, optionally pointing at a Song and a Version (and through the Song, its Studio tracks). The unit the player jumps between in a concert.
_Avoid_: marker, segment, timestamp, cue

**Suggested (a chapter, song, type or Studio track)**:
Created by an automatic source (a YouTube comment or description, an archive Performance, the Song matcher, the Studio matcher) rather than the user, and not yet confirmed. Behaves like a confirmed one until rejected. Every Suggested thing remembers its source.
_Avoid_: auto, pending, unverified, draft

**YouTube info**:
The description, top comments and metadata fetched once for a Video's YouTube id by the offline-breaking script and kept as a file, so Chapters can be suggested and re-suggested without the network.
_Avoid_: info json, metadata dump, scrape

**Song matcher**:
The step that attaches a Song (Mirror or Local) to a Chapter or Video from its title, preferring the Songs the Video's id already links to through Performances, and tolerating spelling and script differences. Its result is always Suggested.
_Avoid_: title matcher, fuzzy match, auto-link

**Mirror**:
The read-only copy of the Tuvan Lyrics Archive's entities (Song, Artist, Album, Track, Version, Footnote, Performance) imported from a backup. Edited only on the archive and re-imported; never edited here.
_Avoid_: sync, cache, import (the act), upstream data

**Latin title**:
The Latin-script form of a Cyrillic title on a Video, Chapter or Local Artist, used so the library can be searched from a Latin keyboard. Generated once, editable afterwards, empty when the title is already Latin. Uses the archive's spelling where the archive has one, otherwise the project's transliteration table.
_Avoid_: transliteration (the act), romanized title, english title (the archive's English name is a translation, not a transliteration)

**Local Artist**:
An Artist created here because the Mirror has no row for them. Never exported to the archive.
_Avoid_: custom artist, unknown artist, extra artist

**Local Song**:
A Song created here because the Mirror has none, pointed at by Videos and Chapters exactly like a Mirror Song. Renamable and deletable here (while nothing points at it); never exported. Its Versions are all Local Versions. Marked "local" wherever it is shown.
_Avoid_: custom song, user song, unknown song (that is a dangling uuid)

**Local Version**:
A lyrics Version written here, attached to a Mirror Song or a Local Song, with the same three Scripts and Footnotes as a Mirror Version. Listed after the Song's Mirror Versions; editable and deletable; survives an import; never exported. The lyrics pane marks it "local" on its pill and above its lines.
_Avoid_: custom lyrics, user lyrics, local lyrics (as the noun), override

### Playback

**Player**:
The in-browser video surface and its mpv-style keyboard bindings. Captures keys only while focused.
_Avoid_: viewer, video element, mpv (which is the reference, not the thing)

**Keyframe seek**:
A seek that lands on the playing Copy's nearest keyframe (from its Keyframe index) so the browser decodes one frame; what the timeline bar and the plain arrow keys do. The opposite is an exact seek (Shift-arrows, frame step, Chapters, Resume).
_Avoid_: fast seek, coarse seek, snap (as the noun)

**Keyframe index**:
The list of a Copy's keyframe timestamps, read once from the file's packets and stored on the Copy; made when the Copy first plays or ahead of time by the index command.
_Avoid_: seek table, cue index, GOP map

**Playing from**:
The ordered list of Videos the Player steps through with previous/next: the list the Video was opened from (grid as filtered and sorted, Favorites, search results), or library order when opened by URL. A Video opened this way loops itself when it ends. Not a Playlist until a shuffle starts one.
_Avoid_: queue, playlist (for the plain list), context

**Playlist**:
The list of Entries the Player plays through on its own, started by a shuffle button on a list page (the grid as filtered, Favorites, search results) or by the shuffle control on a playing Video (then it is the whole library). Has a Play order and a Repeat mode, shown in the Playlist panel. Ends when a Video outside it is opened or another shuffle starts; hiding the panel does not end it. Survives a reload in the same tab. Playing inside a Playlist never writes a Resume position.
_Avoid_: queue, shuffle (as the noun), session, Playing from (which it is built from)

**Entry (of a Playlist)**:
One item in a Playlist: a Video, or a Chapter of a Video (from a Favorite Chapter), which plays from the Chapter's start to the next Chapter's start. Seeking past that end turns the Entry into a Video Entry for the rest of the Video. An Entry whose Video is unavailable stays in the Playlist, greyed, and is skipped.
_Avoid_: item, track, row

**Play order**:
Whether a Playlist's upcoming Entries run **shuffled** (a random permutation, reshuffled when turned on again or when Repeat wraps the list) or **sequential** (the source list's order from the current Entry on). Played Entries keep the order they were played in.
_Avoid_: shuffle mode, random mode, order (bare)

**Repeat**:
What a Playlist does when an Entry ends: **off** (advance; stop at the end of the list), **list** (advance; wrap at the end), or **one** (play the same Entry again). Starts off for a Playlist; a Video that is only Playing from behaves as repeat one.
_Avoid_: loop (that is the A-B loop), cycle, replay

**Played (an Entry)**:
An Entry the current Playlist has already finished or skipped past; hidden in the panel unless shown.
_Avoid_: history, watched, done

**Studio track**:
A Music.app track, held by its persistent id, that the Player can play for a Song. Either the match found for one of the Song's Mirror Tracks (at most one per Mirror Track; Suggested when found automatically after an import, confirmed when picked by hand) or a Local Studio track. Every Video and Chapter of the Song shows all of them.
_Avoid_: match, Music.app link, linked track, studio recording

**Local Studio track**:
A Studio track attached to a Song directly, without a Mirror Track behind it, because the archive lists no such Track. Never exported; absorbed into a match if a later import brings a Mirror Track with the same recording.
_Avoid_: custom track, manual track, extra track

**Audio settings**:
What the Player does to a Video's sound: channel routing, balance, per-channel volume, clean up (cutoffs, notches, denoise), equalizer, preamp and leveler. Per Video, persisted, applied whenever the Video plays. Edited in the Audio panel.
_Avoid_: audio fix, effects, filters, mix (the recording's own mix is what these correct)

**Clean up**:
The Audio settings that remove what the recording picked up rather than shape what it kept: the Rumble and Hiss cutoffs, up to three Notches, and the Denoise.
_Avoid_: filters, restoration, repair

**Notch**:
A narrow cut at one frequency, for a tone that sits over a recording (hum, a whine, a feedback ring). Placed on the spectrum, by Find tone, or by Auto. With harmonics, it also cuts twice and three times its frequency.
_Avoid_: band-stop, EQ cut, hum filter

**Auto (Audio)**:
The wand in the Audio panel: measures the Copy (decoded whole, or sampled at five places) and sets the Audio settings to suit it, with a report of what it heard and did.
_Avoid_: auto-EQ, normalize, magic, analysis mode

**Audio preset**:
A named set of the seven equalizer band gains, shared across Videos. Built-in ones ship with the app; custom ones are the user's and can be overwritten or deleted.
_Avoid_: EQ profile, curve, setting

**Studio playback**:
Playing a Studio track in Music.app, driven from the browser (play, pause, seek, loop), with the Video paused meanwhile.
_Avoid_: Apple Music mode, audio mode, track preview

### TV

**TV app**:
The app installed on the Samsung TV for browsing and watching the library with the remote. Read-only: no editing, Studio playback, Rescan or screenshots.
_Avoid_: TV client, Tizen app, TV version

**TV Server**:
The home-network listener that the TV app talks to, started from a button in the browser app and off at every launch. Runs alongside the localhost app over the same library; the localhost app is unchanged.
_Avoid_: LAN mode, remote server, second server, TV mode

**Approved TV**:
A TV whose IP address the user allowed, with one click in the browser, the first time it reached the TV Server. Remembered across launches until removed; only Approved TVs get anything beyond the health check.
_Avoid_: paired device, trusted client, whitelisted IP

### Sharing

Terms settled while charting the sharing map (2026-10-16). They describe the planned shared library; the Mirror terms above describe the app as it is until that map is built.

**Shared (data)**:
The link data every signed-in user sees and Video Editors maintain in the archive's database: a Video's identity, title, Type, Song and Version pointers, Artists and Chapters, plus the Songs, Versions and Artists promoted from here. Never the files, Copies, Roots, Thumbnails, Audio settings, Resume positions, Favorites or Studio tracks, which stay on each machine.
_Avoid_: synced, cloud, remote, mirror (which is the retired read-only copy)

**Standalone**:
Using the app with no session on this machine. Everything is local and nothing leaves the machine; the Shared data it holds is whatever the last Sync left, read-only, and nothing at all on a machine that never signed in.
_Avoid_: offline (which is a Member without a connection), signed out (as the noun), guest, anonymous mode, local mode

**Member**:
A person signed in with a Tuvan Lyrics Archive account. Reads the Shared data and browses it with their own Copies, Favorites and Resume positions; cannot change it.
_Avoid_: user, viewer, reader, standard account

**Video Editor**:
A Member who has been granted the right to change the Shared data, set only in the archive's database console and never from either app. A scan by a Video Editor adds unknown Videos to the Shared data for everyone.
_Avoid_: editor (ambiguous with the archive's roles), admin, moderator, maintainer

**Unshared (a Video)**:
A Video a Member who is not a Video Editor scanned in that the Shared data does not know. Playable and taggable on that machine only; invisible to everyone else.
_Avoid_: private, local video, pending, draft

**Unverified (a Song, Version or Artist)**:
A row promoted into the archive from a Video Editor's local additions and not yet checked against a source by an archive moderator. Visible and usable on both sites; cleared by a moderator.
_Avoid_: local (its old name here), draft, hidden, provisional

**Sync**:
Refreshing this machine's local copy of the Shared data from the archive. Runs when a sign-in completes, at launch while signed in, after a Video Editor's own write, and from a button; never on a timer. The local copy outlives sign-out, read-only.
_Avoid_: refresh, pull, download, cache (the copy, not the act)

**Shelved (edits)**:
The title, Type, Song and Version pointers, Artists and Chapters a Video carried on this machine before sign-in reconciliation replaced them with the Shared row. Kept locally, read-only, never synced; shown in a drawer on the Video, copyable back into the Shared data by a Video Editor as an ordinary edit, and clearable by hand. Made only by reconciliation.
_Avoid_: backup, history, old tags, overlay, local edits
