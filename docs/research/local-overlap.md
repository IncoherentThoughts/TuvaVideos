# Research: how the Local Songs, Versions and Artists overlap the archive

Resolves #87 (part of map #82). Question: before the Local Songs, Local Versions and Local Artists are promoted into the Tuvan Lyrics Archive as **Unverified** rows, how many duplicate rows the archive already has? For each local row: is there a matching archive row, how many Videos and Chapters point at it, and which Local Versions attach to a Mirror Song rather than a Local Song?

Investigated 2026-10-16. Sources, all read-only:

- `~/Library/Application Support/TuvaVideos/library.db`, opened with `mode=ro` (tables `local_song`, `local_version`, `artist WHERE mirror_id IS NULL`, `video`, `chapter`, `video_artist`, and the Mirror tables `mirror_song` 145 / `mirror_version` 159 / `mirror_artist` 109 from the import of `supabase_backup_20261007_162813_no_media`, per `mirror_import`).
- The live archive, Supabase project `ejabfdkhdmcfpvpwcuau`, `SELECT` only on `songs` (146), `song_lyrics` (161), `artists` (111).
- The project's own fold and name splitter: `src/shared/fold.ts` (`foldQuery`: Cyrillic and Latin onto one ASCII form, ŋ/ң → ng, ö/ө → o, x/х → kh) and `src/shared/songNames.ts` (`allSongNames`: name, English name, comma-split alternate titles and alternate spellings), the same functions `src/server/search.ts` indexes Songs with.

Counts have grown since the ticket was written: there are now **63** Local Songs (ticket: 62), **73** Local Versions (ticket: 71) and **49** Local Artists.

## TL;DR

| Entity | Local rows | True duplicates | Near-duplicates (need a human look) | Junk (drop, don't promote) | Genuinely new |
|---|--:|--:|--:|--:|--:|
| Songs | 63 | 0 | 1 | 1 | 61 |
| Versions | 73 | 0 | 0 (1 follows its near-duplicate Song) | 0 | 73 |
| Artists | 49 | 1 | 4 | 1 | 43 |
| **Total** | **185** | **1** | **5** | **2** | **177** |

- **The overlap is tiny.** No Local Song shares any folded name with any archive Song, and no Local Version's lyrics resemble any archive Version (best token Jaccard 0.22; a re-transcription of the same song would score far above 0.5).
- **The one true duplicate appeared after the backup.** The live archive gained an Artist **Andrei Mongush** (`97b03858-c814-44c3-8422-1104ca48942b`) on 2026-10-11, four days after the backup the Mirror was imported from. Local Artist 111 "Andrei Mongush" has the most links of any Local Artist: **46** Video links (15 Suggested). Promotion must map it onto the existing archive row, not insert a second one. The same day the archive also added **Sholban Mongush**, which has no local counterpart.
- **No Local Version attaches to a Mirror Song.** All 73 hang off Local Songs (`local_version.song_id` is in `local_song` for every row; none dangle). No Video points at a Local Version under a different Song.
- **The Mirror is slightly stale.** Comparing ids, the live archive has 1 Song and 2 Versions the Mirror lacks (all a test row, `zz_Bai-Taiga_test2_…`, created 2026-04, apparently left out of the backup) plus the 2 Artists above. Since the backup, 9 archive Songs were edited (Sarala, Erge-shölee Biste Turda, Xereezhen, Yrlaazhyyly, Chaldyg-Xaja, Chavydak, Kozhai-bile Torgalyg, Dyŋgyldai, Oglum), some gaining alternates. None of the new alternates match a Local Song. Promotion should dedupe against the **live** tables at the time it runs, not against the Mirror.

## Method

1. **Songs.** For each Local Song, every name from `allSongNames` was compared with every name of every archive Song (145 Mirror rows, including hidden ones), at three strengths:
   - *strict*: `foldQuery`, with non-alphanumerics stripped, must match exactly (score 3);
   - *loose*: additionally kh→h, y→i, w→v and doubled letters collapsed must match (score 2);
   - otherwise a normalised Levenshtein similarity on the loose form, raised to 0.9 when one name of at least 5 letters contains the other.

   The best pair is reported. Each candidate at 0.8 or above was then checked by reading lyrics.
2. **Versions.** Each Local Version's Cyrillic + transliteration text was HTML-stripped, folded and split into tokens of more than 2 letters. Its token-set Jaccard was computed against every archive Version, and the best match reported. A Version that is the same lyric as an archive Version scores far above 0.5 even under a different spelling, because the fold normalises script.
3. **Artists.** `artist.name` and `name_latin` were compared, with the same scoring as Songs, against the 108 Mirror Artists' names and Latin names (from the `artist` rows with a `mirror_id`). Local Artists were also compared with each other.
4. **Usage.** Each row was counted in `video.song_id` / `chapter.song_id` (Songs), `video.version_id` / `chapter.version_id` (Versions) and `video_artist` (Artists, with how many of the links are `suggested = 1`).
5. **Live archive.** All live `songs`, `song_lyrics` and `artists` ids were diffed against the Mirror ids, and rows with `updated_at` after the backup were listed.

## Usage of the local rows

- **Songs:** 94 Videos point at 41 of the Local Songs (55 of those 94 links are Suggested), and 9 Chapters point at 4 of them. 21 Local Songs are referenced by nothing.
- **Versions:** 4 Videos point at 3 Local Versions; no Chapter points at a Local Version. The other 70 Versions are lyrics only.
- **Artists:** 369 `video_artist` links point at 46 of the 49 Local Artists, and 111 of those links are Suggested. "gend", "aiah" and "oducuh" have no links. No `artist_rejection` row names a Local Artist.

## Near-duplicates and odd rows, for a human look

**Songs**

- **Karan Duruyaa** (2 Videos, 1 Version). The archive Song *Ediski deg boostaamny* lists **"Kara durujaa"** among its alternate titles, which folds to nearly the same string. The lyrics differ, though. The local song opens «Кара дуруяа ужуп-ла келгеш», while the archive Version opens «Эткен хектиң үнүн баскан» and only mentions кара дуруяа in its second line. It is probably a distinct song, but promoting it under this name will collide in search with Ediski's alternate. A moderator should decide whether "Kara durujaa" belongs on Ediski at all.
- **eir**: no names besides that, no Version, no Video, no Chapter. Junk; delete it locally rather than promote it.
- **Name-adjacent but checked distinct by lyrics**:
  - *Xöömejimni* and *Xöömejimni Kagbas-la Men* vs archive *Xöömejim*;
  - *Ösküs Urug* vs hidden *Ösküs bodum*;
  - *Men Tyva Men* and *Tyvam Cheri* vs *Ava Tyvam*;
  - *Ala-shokar mangy dolgan* vs *Alash*.

  The names only partly contain each other, and the lyrics share nothing.
- **Possibly not Songs at all**: *Kargyraa* (4 Chapters), *Sygyt, kargyraa* and *Xöömei Ünü* are throat-singing technique names. *Aldyn Shagaa* has 2 Videos but no Version.
- **Local Songs carry no alternates.** Every Local Song has `english_name`, `alternate_titles` and `alternate_spellings` NULL, so the archive would get them bare. That also means name matching had only one name per local row to work with.
- **A local-internal tangle**: there is a Local Song *Uvang-Shu*, and the Local Song *Kara-Shui* has a Version labelled "Uvang-Shu". The Song lyrics differ («Теве мунуп чораан эвес Уваң-Шу» vs «Танышпасты таныштырган»), so this is not a duplicate, but the label reads like a performer note.

**Versions**

- None duplicates the archive, and none attaches to a Mirror Song.
- Several labels look like working notes rather than Version labels, and should be cleaned before they become archive `version_label`s: "Hidde" (Ezir-Kara, Chaza-dyr), "Evan" (Chaza-dyr), "Notes" (Ezir-Kara), "Liner notes" (Ösküs Urug), "Möngün-ool Mongush (attempt)" (Salgaldar), "Additional lyrics" (Bolur-daa Bol).
- *Bodan / Complete* has only an English translation and no Tuvan text.

**Artists**

- **Andrei Mongush (111)**: a true duplicate of the live archive row added 2026-10-11. The archive Version *Alash / "Andrei Mongush"* also names him.
- **shodek] (146)**, 2 links, both Suggested, on *Taraan Taraam* Videos. It looks like a truncated "Shodekeh", a hidden archive Artist. Check the Videos before mapping it.
- **oducuh (156)**, no links: a typo of archive **ODUCHU**. Delete it.
- **gend (122)**, no links: probably a fragment of archive **Gen Dos**. Delete it.
- **Nachyn Chodu (129)**, 1 link, vs Local **Nachyn Choodu (130)**, 15 links: they fold identically, so merge them locally before promotion. (*Nachyn Choreve*, 21 links, and *Shonchalai Choodu* are different names.)
- **aiah (147)**, no links: a fragment. Delete it.
- **Checked distinct**: Subudai Mongush vs hidden *Sundukai Mongush* (the Video titles say «Субудай Монгуш»), Mengi vs Mergen Mongush, Dalai vs Ayas Damdyn, Mergen vs German Kuular, Ensemble Daia vs Ensemble Sayany. These are different people or groups sharing a surname or a word.

## Implications for the promotion

- Dedupe against the **live** archive at promotion time. The one real collision (Andrei Mongush) is invisible in the Mirror.
- Before promoting, clean up on this machine: delete the 2 junk rows plus the 2 zero-link Artist typos, merge Nachyn Chodu into Nachyn Choodu, and tidy the 6 working-note Version labels. That leaves 1 Song and 1 Artist (shodek]) for a human decision.
- Since every Local Version hangs off a Local Song, Versions can be promoted strictly after their Songs, with no case of a Version landing under an existing archive Song.

## Tables

Scores: 3 = strict folded match, 2 = loose folded match, below 2 = normalised edit similarity (0.9 = one name contains the other). The nearest match is listed even when it is obviously unrelated, so that the absence of matches can be checked.

### Songs (63)

| Local Song | Videos | Chapters | Versions | Nearest archive Song (by any name) | Score | Verdict |
|---|--:|--:|--:|---|--:|---|
| Ala-shokar mangy dolgan | 0 | 0 | 1 | Alash via Ala-shokar mangy dolgan ~ Alash | 0.9 | new |
| Men Tyva Men | 4 | 0 | 1 | Ava Tyvam via Men Tyva Men ~ Tyvam | 0.9 | new |
| Sygyt, kargyraa | 0 | 0 | 1 | Xöŋnüm-bile salyp via Sygyt, kargyraa ~ Sygyt | 0.9 | new (technique name?) |
| Tyvam Cheri | 2 | 0 | 1 | Ava Tyvam via Tyvam Cheri ~ Tyvam | 0.9 | new |
| Xöömejimni | 0 | 0 | 1 | Xöömejim via Xöömejimni ~ Xöömejim | 0.9 | new |
| Xöömejimni Kagbas-la Men | 3 | 0 | 2 | Xöömejim via Xöömejimni Kagbas-la Men ~ Xöömejim | 0.9 | new |
| Karan Duruyaa | 2 | 0 | 1 | Ediski deg boostaamny via Karan Duruyaa ~ Kara durujaa | 0.82 | near: name is an archive alternate title |
| Salgaldar | 3 | 0 | 2 | Samagaldai (hidden) via Salgaldar ~ Samagaldai | 0.7 | new |
| Taarlaashkyn | 1 | 0 | 1 | Aazaashkyn (hidden) via Taarlaashkyn ~ Aazaashkyn | 0.7 | new |
| Surguul | 2 | 0 | 1 | Mörgül* (hidden) via Surguul ~ Mörgül* | 0.67 | new |
| Kozhamyktar | 4 | 1 | 1 | Mazhalykta via Kozhamyktar ~ Mazhalykta | 0.64 | new |
| Kara-Shui | 2 | 0 | 2 | Karachal via Kara-Shui ~ Karachal | 0.63 | new |
| Kara-Suum | 3 | 0 | 1 | Kara Kush via Kara-Suum ~ Kara Kush | 0.63 | new |
| Kozhumak | 1 | 0 | 1 | Kozhai-bile Torgalyg via Kozhumak ~ Kozhai | 0.63 | new |
| Xöömei Ünü | 0 | 0 | 1 | Xöömejim via Xöömei Ünü ~ хоомейим | 0.63 | new (technique name?) |
| Ydyk Yry | 3 | 0 | 1 | Sygyt yrym salyp berein via Ydyk Yry ~ Сыгыт ыры | 0.63 | new |
| Angyrlarym | 0 | 0 | 1 | Daglarym (hidden) via Angyrlarym ~ Daglarym | 0.6 | new |
| Bodan | 1 | 0 | 1 | Xereezhen (hidden) via Bodan ~ Woman | 0.6 | new |
| Ösküs Urug | 2 | 0 | 3 | Ösküs bodum (hidden) via Ösküs Urug ~ Ösküs bodum | 0.6 | new |
| Laŋchyy Boomnu | 2 | 0 | 2 | Ivizhilerniŋ yryzy via Laŋchyy Boomnu ~ Aŋchy men | 0.58 | new |
| Kargyraa | 0 | 4 | 1 | Daŋgyna (hidden) via Kargyraa ~ Daŋgyna | 0.57 | new (technique name?) |
| Tozhama | 1 | 0 | 1 | Kozhai-bile Torgalyg via Tozhama ~ Kozhai | 0.57 | new |
| Aldyn Shagaa | 2 | 0 | 0 | Chaldyg-Xaja (hidden) via Aldyn Shagaa ~ Chaldyg-Xaja | 0.55 | new (no Version) |
| Kadarchylar | 4 | 0 | 1 | Karachal via Kadarchylar ~ Karachal | 0.55 | new |
| Kögü-Shygy | 3 | 0 | 1 | Dönen-Shilgi via Kögü-Shygy ~ Dönen-Shilgi | 0.55 | new |
| Xöndergejim | 2 | 0 | 2 | Xöömejim via Xöndergejim ~ Xöömejim | 0.55 | new |
| Borbak Karam Bodu Bodaar | 0 | 0 | 1 | Borbak-Borbak (hidden) via Borbak Karam Bodu Bodaar ~ Borbak-Borbak | 0.53 | new |
| Bolur-daa Bol | 4 | 0 | 2 | Er-le Changys (hidden) via Bolur-daa Bol ~ Homudal | 0.5 | new |
| Chaza-dyr | 2 | 0 | 2 | Chavydak via Chaza-dyr ~ Chavydak | 0.5 | new |
| Ezir-Kara | 6 | 2 | 2 | Amyr-Sanaa (hidden) via Ezir-Kara ~ Amyr-Sanaa | 0.5 | new |
| Khandagaity | 4 | 0 | 1 | Samagaldai (hidden) via Khandagaity ~ Samagaltai | 0.5 | new |
| Kurai Yry | 2 | 0 | 1 | Dugaiymny (hidden) via Kurai Yry ~ Dugaiymny | 0.5 | new |
| Message | 1 | 0 | 1 | Mezhegei via Message ~ Mezhegei | 0.5 | new |
| Toora-la Khemim | 1 | 0 | 1 | Bai-la Xemchiim (hidden) via Toora-la Khemim ~ Bai-la Xemchiim | 0.5 | new |
| Oshkaan bolza | 0 | 0 | 1 | Orai-la boldu-la via Oshkaan bolza ~ Orai boldu | 0.45 | new |
| Adymnyng Kydaraly | 4 | 0 | 1 | Doŋup xonar boldum-na be? via Adymnyng Kydaraly ~ Aratyŋ yry | 0.44 | new |
| Chekpelig | 0 | 0 | 1 | Aa-shuu, dekei-oo via Chekpelig ~ Dekei-oo | 0.44 | new |
| Ezengileer | 0 | 0 | 1 | Artysh-shaanak via Ezengileer ~ Juniper | 0.44 | new |
| Chymchak Salgyn | 1 | 0 | 1 | Chagytai via Chymchak Salgyn ~ Chaghatai | 0.43 | new |
| eir | 0 | 0 | 0 | Eki Attar (hidden) via eir ~ Eki Attar | 0.43 | junk: empty, unused |
| Öpei Xöömei (Sevek) | 2 | 0 | 1 | Ene-Sai via Öpei Xöömei (Sevek) ~ Xöömei sygyt | 0.43 | new |
| Oran churtum saktyrymga | 0 | 0 | 1 | Avam Churtu Dugaiymny (hidden) via Oran churtum saktyrymga ~ Avam Churtu Dugaiymny | 0.43 | new |
| Salbaam chezhip bergen-ne men | 0 | 0 | 1 | Kelir-le Deesh, Kelgen-le Men (hidden) via Salbaam chezhip bergen-ne men ~ Kelir-le Deesh, Kelgen-le Men | 0.43 | new |
| Tooruktug Dolgaj Tangdym | 4 | 0 | 1 | Dorug-Dajym (hidden) via Tooruktug Dolgaj Tangdym ~ Dorug-Dajym | 0.43 | new |
| Ches Bulungum | 0 | 0 | 1 | Chylgychynyŋ yry via Ches Bulungum ~ Cheler ojum | 0.42 | new |
| Eshtig-dir be? | 0 | 0 | 1 | Eshten Charlyyry Berge (hidden) via Eshtig-dir be? ~ Eshten Charlyyry Berge | 0.42 | new |
| Kökei Noyan | 2 | 0 | 1 | Külteginniŋ kyjgyzy via Kökei Noyan ~ Kültegin's call | 0.42 | new |
| Show Me The Way | 0 | 0 | 1 | Mezhegei via Show Me The Way ~ Mezhegei | 0.42 | new |
| Uvang-Shu | 2 | 0 | 1 | Ailan Kuzhum (hidden) via Uvang-Shu ~ Ailang-Kuzhum | 0.42 | new |
| Xöömeige jöreel | 0 | 0 | 1 | Ene-Sai via Xöömeige jöreel ~ Xöömei sygyt | 0.42 | new |
| Orlan-Eres Chylgychyny | 2 | 0 | 1 | Dönen-Shilgi via Orlan-Eres Chylgychyny ~ Dönen-Shilgi | 0.4 | new |
| Övür Xadyp | 1 | 2 | 1 | Dorug-Dajym (hidden) via Övür Xadyp ~ Dorug-Dajym | 0.4 | new |
| Road to Home | 1 | 0 | 1 | Ene-Sai via Road to Home ~ Sygyt xöömei | 0.4 | new |
| Kezek-kezek badyrgalaar | 0 | 0 | 1 | Kozhai-bile Torgalyg via Kezek-kezek badyrgalaar ~ Rivers Kozhai and Torgalyg | 0.39 | new |
| Delegeini chaŋgylandyr | 0 | 0 | 1 | Chylgychynyŋ yry via Delegeini chaŋgylandyr ~ Chylgychynyŋ yry | 0.38 | new |
| Earth (?) | 0 | 0 | 1 | Karachal via Earth (?) ~ Karachal | 0.38 | new |
| Kyzyl-Dagga kel daan onnuk | 0 | 0 | 1 | Kaigaldyng Yry (hidden) via Kyzyl-Dagga kel daan onnuk ~ Kaigaldyng Yry | 0.37 | new |
| Kelir üje Büzüreldig | 0 | 0 | 1 | Kelir-le Deesh, Kelgen-le Men (hidden) via Kelir üje Büzüreldig ~ Kelir-le Deesh, Kelgen-le Men | 0.36 | new |
| Ködürgeni körgen sen be? | 1 | 0 | 1 | Kelir-le Deesh, Kelgen-le Men (hidden) via Ködürgeni körgen sen be? ~ Kelir-le Deesh, Kelgen-le Men | 0.36 | new |
| Churttai-daa Bol, Bergei-le Bis | 1 | 0 | 2 | Orai-la boldu-la via Churttai-daa Bol, Bergei-le Bis ~ Orai-la boldu-la | 0.35 | new |
| Uzheleen bis, dörteleen bis | 2 | 0 | 1 | Ösken ujam (hidden) via Uzheleen bis, dörteleen bis ~ The nest I grew up in | 0.33 | new |
| Xörlüg-Xörlüg Taiga Körgesh | 3 | 0 | 2 | Ödügen taiga via Xörlüg-Xörlüg Taiga Körgesh ~ Ödügen taiga | 0.33 | new |
| Sula Salyp Beereel Chonum | 1 | 0 | 1 | Xöŋnüm-bile salyp via Sula Salyp Beereel Chonum ~ Xöngnüm bile salyp berein | 0.32 | new |

### Versions (73)

All 73 attach to Local Songs. Scripts: C = Cyrillic, T = transliteration, E = translation.

| Local Version (Song / label) | Scripts | Videos | Chapters | Best lyric match in archive (Song / label) | Jaccard | Verdict |
|---|---|--:|--:|---|--:|---|
| Xöömejimni Kagbas-la Men / Version 1 | CTE | 1 | 0 | Xöŋnüm-bile salyp / Complete | 0.22 | new |
| Xöömejimni Kagbas-la Men / Version 2 | CTE | 0 | 0 | Xoor chonga / Complete | 0.2 | new |
| Xörlüg-Xörlüg Taiga Körgesh / Version 1 | CTE | 0 | 0 | Bömbüreng-Xöö / Complete | 0.19 | new |
| Khandagaity / Complete | C-- | 0 | 0 | Mezhegei / Huun-Huur-Tu | 0.18 | new |
| Sygyt, kargyraa / Complete | CTE | 0 | 0 | Bai-Taiga / Complete | 0.16 | new |
| Bolur-daa Bol / Additional lyrics | CT- | 2 | 0 | Xöŋnüm-bile salyp / Complete | 0.14 | new |
| Xöömei Ünü / Complete | CTE | 0 | 0 | Xöŋnüm-bile salyp / Complete | 0.12 | new |
| Kara-Suum / Complete | CT- | 0 | 0 | Xöŋnüm-bile salyp / Complete | 0.11 | new |
| Uzheleen bis, dörteleen bis / Complete | -TE | 0 | 0 | Alash-Xem / Complete | 0.11 | new |
| Churttai-daa Bol, Bergei-le Bis / Version 1 | -TE | 0 | 0 | Döngeliktig Dugaiymny / Complete | 0.1 | new |
| Churttai-daa Bol, Bergei-le Bis / Version 2 | -TE | 0 | 0 | Döngeliktig Dugaiymny / Complete | 0.1 | new |
| Kargyraa / Complete | CTE | 0 | 0 | Doralaŋny berem, akym / Complete | 0.1 | new |
| Kezek-kezek badyrgalaar / Complete | -T- | 0 | 0 | Imirtiŋde / Complete | 0.1 | new |
| Borbak Karam Bodu Bodaar / Complete | CT- | 0 | 0 | Borbak-Borbak / Complete | 0.09 | new |
| Karan Duruyaa / Complete | CTE | 0 | 0 | Imirtiŋde / Complete | 0.09 | new (follows its Song) |
| Kögü-Shygy / Complete | CT- | 0 | 0 | Xoor chonga / Complete | 0.09 | new |
| Orlan-Eres Chylgychyny / Complete | CT- | 0 | 0 | Salgal damchaan xöömejim / Complete | 0.09 | new |
| Ösküs Urug / Chalama | CTE | 0 | 0 | Dadyr-Dadyr / Extra lyrics | 0.09 | new |
| Ösküs Urug / Liner notes | CTE | 0 | 0 | Dadyr-Dadyr / Extra lyrics | 0.09 | new |
| Ösküs Urug / Tyva: Spirits of my Land | CTE | 0 | 0 | Dadyr-Dadyr / Extra lyrics | 0.09 | new |
| Ala-shokar mangy dolgan / Complete | CT- | 0 | 0 | Avam Churtu Dugaiymny / Complete | 0.08 | new |
| Earth (?) / Complete | CT- | 0 | 0 | Avam Churtu Dugaiymny / Complete | 0.08 | new |
| Tooruktug Dolgaj Tangdym / Complete | C-- | 0 | 0 | Arbyn össün / Chirgilchin "Kyngyrgai" | 0.08 | new |
| Xörlüg-Xörlüg Taiga Körgesh / Version 2 | C-- | 0 | 0 | Salgal damchaan xöömejim / Complete | 0.08 | new |
| Bolur-daa Bol / Complete | CTE | 0 | 0 | Kelir-le Deesh, Kelgen-le Men / Complete | 0.07 | new |
| Kara-Shui / Uvang-Shu | CT- | 0 | 0 | Ondar kyzy / Complete | 0.07 | new |
| Ködürgeni körgen sen be? / Complete | CTE | 0 | 0 | Ava Tyvam / Complete | 0.07 | new |
| Kökei Noyan / Complete | C-- | 0 | 0 | Alash / Andrei Mongush | 0.07 | new |
| Kozhamyktar / Saiyn-Xerel Öpei & Kezhik Uspun | C-- | 0 | 0 | Kara-Daglar / Complete | 0.07 | new |
| Kozhumak / Complete | -T- | 0 | 0 | Bömbüreng-Xöö / Complete | 0.07 | new |
| Surguul / Complete | CT- | 0 | 0 | Kyŋgyrgai-Kong / Complete | 0.07 | new |
| Toora-la Khemim / Complete | C-- | 0 | 0 | Döngeliktig Dugaiymny / Complete | 0.07 | new |
| Xöndergejim / Version 2 | CT- | 0 | 0 | Ösken töreen Bai-la Taigam / Complete | 0.07 | new |
| Xöömeige jöreel / Complete | CT- | 0 | 0 | Xüüle xemning eriin durgaar / Complete | 0.07 | new |
| Angyrlarym / Complete | CT- | 0 | 0 | Achai / Complete | 0.06 | new |
| Chaza-dyr / Evan | C-- | 0 | 0 | Ava Tyvam / Complete | 0.06 | new |
| Chekpelig / Complete | CT- | 0 | 0 | Döngeliktig Dugaiymny / Complete | 0.06 | new |
| Ches Bulungum / Complete | CT- | 0 | 0 | Buura / Complete | 0.06 | new |
| Eshtig-dir be? / Complete | CT- | 0 | 0 | Taraan-Taraam / Complete | 0.06 | new |
| Kara-Shui / Chirgilchin | CT- | 1 | 0 | Ondar kyzy / Complete | 0.06 | new |
| Kelir üje Büzüreldig / Complete | C-- | 0 | 0 | Ava Tyvam / Complete | 0.06 | new |
| Kurai Yry / Complete | CT- | 0 | 0 | Odarladyp semirtiili / Complete | 0.06 | new |
| Oran churtum saktyrymga / Complete | C-- | 0 | 0 | Doŋup xonar boldum-na be? / Complete | 0.06 | new |
| Övür Xadyp / Complete | CT- | 0 | 0 | Chaldyg-Xaja / Version by Huun-Huur-Tu | 0.06 | new |
| Salbaam chezhip bergen-ne men / Complete | CTE | 0 | 0 | Kelir-le Deesh, Kelgen-le Men / Complete | 0.06 | new |
| Salgaldar / Möngün-ool Mongush (attempt) | C-- | 0 | 0 | Aazaashkyn / Complete | 0.06 | new |
| Show Me The Way / Complete | CT- | 0 | 0 | Kadarar men / Complete | 0.06 | new |
| Tyvam Cheri / Complete | CT- | 0 | 0 | Oitulaash Xeveri / Complete | 0.06 | new |
| Xöndergejim / Version 1 | CT- | 0 | 0 | Chagytai / Complete | 0.06 | new |
| Adymnyng Kydaraly / Complete | C-- | 0 | 0 | Kelir-le Deesh, Kelgen-le Men / Complete | 0.05 | new |
| Chymchak Salgyn / Complete | C-E | 0 | 0 | Agitator / Complete | 0.05 | new |
| Ezir-Kara / Hidde | C-- | 0 | 0 | Xüüle xemning eriin durgaar / Complete | 0.05 | new |
| Ezir-Kara / Notes | C-- | 0 | 0 | Chyraa-Xoor mögejig / Complete | 0.05 | new |
| Kadarchylar / Complete | C-- | 0 | 0 | Ailan Kuzhum / Version by Shyŋgyraa | 0.05 | new |
| Kyzyl-Dagga kel daan onnuk / Complete | C-- | 0 | 0 | Chok / Complete | 0.05 | new |
| Öpei Xöömei (Sevek) / Complete | CTE | 0 | 0 | Öske cherde / Xaraacha (Alternate arrangement) | 0.05 | new |
| Road to Home / Complete | CT- | 0 | 0 | Chazyn Erte / Complete | 0.05 | new |
| Salgaldar / Complete | C-- | 0 | 0 | Aazaashkyn / Complete | 0.05 | new |
| Sula Salyp Beereel Chonum / Complete | CT- | 0 | 0 | Igilimni Xöömejimni / Complete | 0.05 | new |
| Uvang-Shu / Complete | CT- | 0 | 0 | Tyvam Churtu / Complete | 0.05 | new |
| Xöömejimni / Complete | CT- | 0 | 0 | Kara-Daglar / Complete | 0.05 | new |
| Ydyk Yry / Complete | C-- | 0 | 0 | Kyŋgyrgai-Kong / Complete | 0.05 | new |
| Chaza-dyr / Hidde | C-- | 0 | 0 | Ava Tyvam / Complete | 0.04 | new |
| Delegeini chaŋgylandyr / Complete | CT- | 0 | 0 | Ching Söörtukchülerining Yryzy / Complete | 0.04 | new |
| Ezengileer / Complete | CT- | 0 | 0 | Ak Taigam / Complete | 0.04 | new |
| Laŋchyy Boomnu / Gennadi Tumat Version | CT- | 0 | 0 | Ediskileer aŋchy-la men / Complete | 0.04 | new |
| Laŋchyy Boomnu / Yat-Kha Version | CT- | 0 | 0 | Ediskileer aŋchy-la men / Complete | 0.04 | new |
| Men Tyva Men / Complete | CT- | 0 | 0 | Tyva Cherim (A. Öpei) / Complete | 0.04 | new |
| Oshkaan bolza / Complete | CT- | 0 | 0 | Chagytai / Complete | 0.04 | new |
| Taarlaashkyn / Complete | C-- | 0 | 0 | Ediski deg boostaamny / Complete | 0.04 | new |
| Tozhama / Complete | CT- | 0 | 0 | Saryglarlar / Complete | 0.04 | new |
| Message / Complete | CT- | 0 | 0 | Er-le Changys / Complete | 0.03 | new |
| Bodan / Complete | --E | 0 | 0 | Aa-shuu, dekei-oo / Complete | 0 | new |

### Artists (49)

Nearest match is against the Mirror (2026-10-07). Andrei Mongush matches the live archive exactly (added 2026-10-11).

| Local Artist (id) | Video links (suggested) | Nearest archive Artist | Score | Verdict |
|---|--:|---|--:|---|
| shodek] (146) | 2 (2) | Shodekeh (hidden) | 0.9 | near: Shodekeh? |
| Subudai Mongush (142) | 2 (1) | Sundukai Mongush (hidden) | 0.8 | new |
| Mengi Mongush (125) | 11 (2) | Mergen Mongush | 0.77 | new |
| Dalai Damdyn (126) | 17 (3) | Ayas Damdyn | 0.73 | new |
| Mergen Kuular (114) | 4 (2) | German Kuular | 0.73 | new |
| Ensemble Daia (110) | 29 (13) | Ensemble Salgal | 0.71 | new |
| Ensemble Sayany (128) | 4 (2) | Ensemble Salgal | 0.71 | new |
| Orlang Mongush (121) | 1 (0) | Lazo Mongush (hidden) | 0.69 | new |
| Andrei Mongush (111) | 46 (15) | Sundukai Mongush (hidden) | 0.67 | TRUE DUPLICATE (live archive, added 2026-10-11) |
| Ensemble Orgaadai (139) | 3 (2) | Ensemble Ene-Sai | 0.67 | new |
| gend (122) | 0 (0) | Gen Dos | 0.67 | near: fragment of Gen Dos? |
| Möngün-ool Mongush (115) | 7 (3) | Mergen Mongush | 0.67 | new |
| oducuh (156) | 0 (0) | ODUCHU | 0.67 | near: typo of ODUCHU |
| Uriankhai Ensemble (134) | 1 (0) | Changy-Khaya Ensemble | 0.67 | new |
| Aidysmaa Köshkendei (127) | 3 (1) | Igor Köshkendei | 0.65 | new |
| Choldug Koshkendei (113) | 5 (2) | Igor Köshkendei | 0.65 | new |
| Aihan Oorzhak (131) | 9 (0) | Khuren Oorzhak (hidden) | 0.64 | new |
| Ayan Mongush (157) | 1 (0) | Lazo Mongush (hidden) | 0.64 | new |
| Ediski Ensemble (145) | 7 (6) | Alash Ensemble | 0.64 | new |
| Bailak Mongush (132) | 7 (1) | Lazo Mongush (hidden) | 0.62 | new |
| Ertine Ensemble (154) | 6 (4) | Alash Ensemble | 0.62 | new |
| Artur Damdyn-ool (123) | 12 (4) | Ayas Damdyn | 0.54 | new |
| Aleksey Saryglar (138) | 3 (0) | Aleksey Khovalyg | 0.53 | new |
| Aidyn Sedii (136) | 10 (3) | Mai-ool Sedip | 0.5 | new |
| Aidash Barynmaa (124) | 9 (2) | Ayas Damdyn | 0.46 | new |
| Arzhaan (140) | 2 (0) | Vadim Oorzhak | 0.45 | new |
| Aylangmaa Damyrang (120) | 1 (0) | Ayas Damdyn | 0.44 | new |
| Robert McLaughlin (119) | 19 (9) | Albert Küvezin | 0.44 | new |
| aiah (147) | 0 (0) | Xaraacha | 0.43 | junk: fragment, no links |
| Evgeny Saryglar (118) | 9 (3) | German Kuular | 0.43 | new |
| Lopsan Mundukai (151) | 8 (4) | Sat Mantsakay (hidden) | 0.43 | new |
| Anand Avirmed (149) | 4 (0) | Andrei Öpei | 0.42 | new |
| Kang-Khüler Saiaa (133) | 11 (1) | Kaigal-ool Xovalyg | 0.4 | new |
| Nachyn Choreve (109) | 21 (11) | Dashima Sogtoeva (hidden) | 0.4 | new |
| Shonchalai Choodu (141) | 8 (0) | Dhani Harrison (hidden) | 0.4 | new |
| Aidan Byrtan-ool (135) | 9 (3) | Александр Саржат-оол | 0.39 | new |
| Ayan Shirizhik (137) | 10 (0) | Vadim Oorzhak | 0.38 | new |
| Damon Postle (148) | 4 (0) | Idamchap Xomushku (hidden) | 0.38 | new |
| Soriah (150) | 5 (2) | Fedor Tau | 0.38 | new |
| Dinmit (116) | 1 (0) | Gennadi Tumat | 0.36 | new |
| Nachyn Chodu (129) | 1 (0) | Marzhimal Ondar (hidden) | 0.36 | near: same as local Nachyn Choodu |
| Nachyn Choodu (130) | 15 (0) | Marzhimal Ondar (hidden) | 0.36 | new |
| Wada Fumiko (153) | 1 (0) | Kara-sal Ak-ool (hidden) | 0.36 | new |
| Anton Uvangur (155) | 4 (1) | Anatolii Kuular | 0.33 | new |
| Hidde Meenhorst (143) | 4 (3) | Huun-Huur-Tu | 0.33 | new |
| Konstantin Kilin (117) | 3 (2) | Anatolii Kuular | 0.33 | new |
| TNO (112) | 22 (0) | Gen Dos | 0.33 | new |
| Kuzume Junichi (144) | 1 (0) | Khusugtun | 0.31 | new |
| Yuliyana Krivoshapkina (152) | 7 (4) | Khuren Oorzhak (hidden) | 0.3 | new |
