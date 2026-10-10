# Root inventory and duplicate detection

Resolves #8 (part of map #1). Generated 2026-10-10 by a throwaway script (not in the repo); no media file was modified. `.DS_Store` and `._*` skipped. Per-file data: [root-inventory.csv](root-inventory.csv). Fingerprint = sha1(size + first 1 MB + last 1 MB).

## Files per Root by extension

| ext | external | local | total |
|---|---|---|---|
| jpg | 0 | 1 | 1 |
| mkv | 133 | 16 | 149 |
| mp3 | 0 | 4 | 4 |
| mp4 | 406 | 38 | 444 |
| webm | 514 | 30 | 544 |
| **total** | **1053** | **89** | **1142** |

Sizes: external 150.2 GB, local 15.8 GB

## Non-video files and unreadable files

Files with an extension other than mkv/mp4/webm: 5

- local: `Alash Ensemble Live in Chicago for 10th Anniversary Concert at Old Town School of Folk Music.mp3` (193540316 B; ffprobe: mp3; v= a=mp3)
- local: `Alash UChicago.mp3` (77490285 B; ffprobe: mp3; v= a=mp3)
- local: `Oitulaash Xeveri (condensed).mp3` (1598443 B; ffprobe: mp3; v= a=mp3)
- local: `Tuvan Throat Singing Group, Alash Ensemble Live at the University of Chicago International House.jpg` (64944 B; ffprobe: image2; v=mjpeg a=)
- local: `karg 7.53.08 PM [vocals].mp3` (1151123 B; ffprobe: mp3; v= a=mp3)

ffprobe cannot read: 0 files


mkv/mp4/webm readable but with no video stream: 2

- external: `Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].f251.webm` a=opus partial=f251
- external: `Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].f251.webm` a=opus partial=f251

## yt-dlp `.fNNN` partials

Count: 9

- external: `Khöömei Batch 2/02 Тувинская фольклорная группа 'Алаш' в Абакане.  Горловое пение. Throat singing. [0qMztplyev4].f303.webm` (29510219 B; v=vp9 a=-); merged sibling by path prefix: none; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/04 Тувинская фольклорная группа 'Алаш' в Абакане. Горловое пение. Throat singing. Песня 'Арачол'. [BiGK2ZXaJNs].f303.webm` (134788061 B; v=vp9 a=-); merged sibling by path prefix: none; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/05 Тувинская фольклорная группа 'Алаш' в Абакане. Песня табунщика. Горловое пение. Throat singing. [j42YMI1MXUQ].f303.webm` (51319011 B; v=vp9 a=-); merged sibling by path prefix: none; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/06 Тувинская фольклорная группа 'Алаш' в Абакане. Песня Бежелей. Горловое пение. Throat singing. [aCWLuXQF0ao].f303.webm` (116648081 B; v=vp9 a=-); merged sibling by path prefix: none; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/09 Тувинская фольклорная группа 'Алаш' в Абакане. Горловое пение. Олгума Песня сыну. Throat singing. [7fdLf7yy1mQ].f303.webm` (100075150 B; v=vp9 a=-); merged sibling by path prefix: `Khöömei Batch 2/09 Тувинская фольклорная группа 'Алаш' в Абакане. Горловое пение. Олгума Песня сыну. Throat singing. [7fdLf7yy1mQ].temp.mkv`; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].f251.webm` (2316818 B; v=- a=opus); merged sibling by path prefix: `Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].temp.webm`; same-id non-partial anywhere: none
- external: `Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].f303.webm` (37858190 B; v=vp9 a=-); merged sibling by path prefix: `Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].temp.webm`; same-id non-partial anywhere: none
- external: `Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].f251.webm` (63804849 B; v=- a=opus); merged sibling by path prefix: `Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].temp.webm`; same-id non-partial anywhere: none
- external: `Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].f303.webm` (455202460 B; v=vp9 a=-); merged sibling by path prefix: `Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].temp.webm`; same-id non-partial anywhere: none

## Copies in both Roots

Files with a YouTube id in the name: 1061 of 1142 (1049 external, 12 local). Distinct ids (non-partial): 829.

By YouTube id: 9 ids present in both Roots.

- `4uGjHjpl_Y4`:
  - external `Khöömei Batch 3/Alash Promo [4uGjHjpl_Y4].webm` 15117364 B 640x480 vp9/opus matroska 239s
  - external `Khöömei Batch 4/Alash Promo [4uGjHjpl_Y4].mp4` 20693934 B 640x480 h264/aac mov 239s
  - local `Alash Promo [4uGjHjpl_Y4].webm` 15117317 B 640x480 vp9/opus matroska 239s
- `LHnEgA_v6BY`:
  - external `Khöömei Batch 3/Тожу Кызы [LHnEgA_v6BY].webm` 59860220 B 1920x1080 vp9/opus matroska 247s
  - external `Khöömei Batch 4/Тожу Кызы [LHnEgA_v6BY].mp4` 70221036 B 1920x1080 h264/aac mov 247s
  - local `Тожу Кызы [LHnEgA_v6BY].mkv` 69235140 B 1920x1080 h264/opus matroska 247s
- `LSisNUwL_h0`:
  - external `Khöömei/Yuliyana Krivoshapkina and Nachyn Choreve  'Ene sai' [LSisNUwL_h0].webm` 76984068 B 1920x1080 vp9/opus matroska 395s
  - local `Yuliyana Krivoshapkina and Nachyn Choreve  'Ene sai' [LSisNUwL_h0].webm` 76984068 B 1920x1080 vp9/opus matroska 395s
- `QIYARuSgw5M`:
  - external `Khöömei Batch 2/ТUVAN PARTY - Kongar-oll Ondar, a star of world and folk music,  and his friends. [QIYARuSgw5M].webm` 42973489 B 1280x720 vp9/opus matroska 275s
  - local `ТUVAN PARTY - Kongar-oll Ondar, a star of world and folk music,  and his friends. [QIYARuSgw5M].webm` 42973489 B 1280x720 vp9/opus matroska 275s
- `TW3o5LbAduQ`:
  - external `Khöömei Batch 3/песня 'Чавыдак' [TW3o5LbAduQ].webm` 13985786 B 1920x1080 vp9/opus matroska 60s
  - local `песня 'Чавыдак' [TW3o5LbAduQ].webm` 13985786 B 1920x1080 vp9/opus matroska 60s
- `Xoqt_xATxvA`:
  - external `Khöömei Batch 3/Radik Tulush - Tyva - Spirits Of My Land - 2007 - Full Album [Xoqt_xATxvA].webm` 66376813 B 854x480 vp9/opus matroska 2671s
  - external `Khöömei Batch 4/Radik Tulush - Tyva： Spirits Of My Land - 2007 - Full Album [Xoqt_xATxvA].mp4` 71477990 B 854x480 h264/aac mov 2671s
  - local `Radik Tulush - Tyva： Spirits Of My Land - 2007 - Full Album [Xoqt_xATxvA].mp4` 71976678 B 854x480 h264/aac mov 2671s
- `bEZVMOB0a9E`:
  - external `Khöömei Batch 3/Кожамыктар - Ученики Конгар-оола Борисовича Ондар [bEZVMOB0a9E].webm` 49296571 B 1920x1080 vp9/opus matroska 196s
  - external `Khöömei Batch 4/Кожамыктар - Ученики Конгар-оола Борисовича Ондар [bEZVMOB0a9E].mp4` 63833977 B 1920x1080 h264/aac mov 196s
  - local `Кожамыктар - Ученики Конгар-оола Борисовича Ондар [bEZVMOB0a9E].webm` 49296571 B 1920x1080 vp9/opus matroska 196s
- `i92kR10QZ4c`:
  - external `Khöömei Batch 3/Bayan solo, ALASH, Poughkeepsie, NY Tuvan Throat Singing [i92kR10QZ4c].webm` 43158687 B 1280x720 vp9/opus matroska 300s
  - external `Khöömei Batch 4/Bayan solo, ALASH, Poughkeepsie, NY Tuvan Throat Singing [i92kR10QZ4c].mp4` 41620030 B 1280x720 h264/aac mov 300s
  - local `Bayan Solos/Bayan solo, ALASH, Poughkeepsie, NY Tuvan Throat Singing [i92kR10QZ4c].webm` 43158687 B 1280x720 vp9/opus matroska 300s
- `oGJOxzLXh1I`:
  - external `Khöömei Batch 3/Eki attar [oGJOxzLXh1I].webm` 15298534 B 636x480 vp9/opus matroska 173s
  - local `Eki attar [oGJOxzLXh1I].webm` 15298534 B 636x480 vp9/opus matroska 173s

By fingerprint: 2 fingerprint groups with more than one file; 2 span both Roots.

- `f220783b5df5`:
  - external `Khöömei Batch 4/Тувинская народная песня ＂Ырлап чоруур уруг＂- фольклорная группа ансамбля ＂Саяны＂ [n1rkpxWAvok].mp4` 75417371 B 1920x1080 h264/aac mov 211s id=n1rkpxWAvok
  - local `Ырлап чоруур уруг.mp4` 75417371 B 1920x1080 h264/aac mov 211s id=
- `957d853ba2ea`:
  - external `Khöömei Batch 4/Устуу-Хурээ 2009 [YKWr0Jz_Ig8].mp4` 21028916 B 960x720 h264/aac mov 108s id=YKWr0Jz_Ig8
  - local `Устуу-Хурээ.mp4` 21028916 B 960x720 h264/aac mov 108s id=

Ids in both Roots whose files are NOT byte-identical (differing fingerprint): 9

## All same-id groups (2+ Copies), classified

216 ids have 2+ Copies (9 span both Roots, 207 are within one Root, nearly all external Batch 3/4/5 overlap).

| class | span both Roots | within one Root |
|---|---|---|
| same size (header bytes differ only) | 4 | 21 |
| same resolution, size differs | 0 | 17 |
| same resolution, different container/codec | 5 | 168 |
| resolution differs | 0 | 1 |

Spot check: cmp of 3 same-size pairs showed only 5 and 32 differing bytes in two pairs (a third first differed at byte 286, near the container header; likely UIDs/dates), so the first-1 MB fingerprint under-matches re-downloads of the same stream. Treat same id + same size + same duration as the same Video.

Full list (one line per id; `ext res size` per Copy):

- `-HWiyZvRNwk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 150593957; ext:Khöömei Batch 5/mkv 1920x1080 150614259
- `-Nt7w9qSJfI` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x480 5584040; ext:Khöömei Batch 5/mkv 640x480 5559022
- `-xia8OERlNU` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 19365680; ext:Khöömei Batch 5/mkv 1280x720 26400323
- `00_hhy6gRyo` [same resolution, size differs; external]: ext:Khöömei Batch 3/mp4 640x480 13262114; ext:Khöömei Batch 4/mp4 640x480 13262113
- `0216ZVQa_Mg` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 53581163; ext:Khöömei Batch 5/mkv 1920x1080 53642610
- `16ZTkWjma3g` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 14548625; ext:Khöömei Batch 4/mp4 1920x1080 17915215
- `18gnn5wWgUQ` [same resolution, size differs; external]: ext:Khöömei Batch 3/mp4 1080x720 12747704; ext:Khöömei Batch 4/mp4 1080x720 12809713
- `1PAKHpnWMRE` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 181905433; ext:Khöömei Batch 4/mp4 1920x1080 223853723
- `1aD6DQjYroI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 35780541; ext:Khöömei Batch 4/mp4 1280x720 41994836
- `1kVogh3HRbQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 32957515; ext:Khöömei Batch 5/mkv 1280x720 32596883
- `1owRWWM5iSE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 116229216; ext:Khöömei Batch 5/mkv 1920x1080 116701369
- `2G4e089zjOQ` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 11830390; ext:Khöömei Batch 5/mp4 320x240 12722411
- `2WUtSIxJRak` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 115842477; ext:Khöömei Batch 5/mkv 1920x1080 115843974
- `2d8GcAylHHQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 88575662; ext:Khöömei Batch 5/mkv 1920x1080 88956999
- `2nFP5Z0wenQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 2/webm 1280x720 37419582; ext:Khöömei Batch 4/mp4 1280x720 48812509
- `2usiMmNYfv0` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 2400x1080 96772244; ext:Khöömei Batch 4/mp4 2400x1080 96453467
- `3muFdEu8dQM` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 462257176; ext:Khöömei Batch 4/mp4 1280x720 294085799
- `4sCWUUgnKsI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 56470453; ext:Khöömei Batch 4/mp4 1920x1080 46561583
- `4uGjHjpl_Y4` [same resolution, different container/codec; external+local]: ext:Khöömei Batch 3/webm 640x480 15117364; ext:Khöömei Batch 4/mp4 640x480 20693934; loc:./webm 640x480 15117317
- `50ZG87Ah_gc` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 360x240 17870153; ext:Khöömei Batch 4/mp4 360x240 20234414
- `5L4s0Scr5Kc` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 27486125; ext:Khöömei Batch 5/mkv 1280x720 26748609
- `6FHsFCs8i3E` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 4727235; ext:Khöömei Batch 5/mp4 320x240 4972218
- `6jnBxynHkjg` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 98924595; ext:Khöömei Batch 4/mp4 1920x1080 180328230
- `6owFeRhqeq0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 23814494; ext:Khöömei Batch 5/mkv 1280x720 23347015
- `7-BSl8aQLIM` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 61625932; ext:Khöömei Batch 4/mp4 1920x1080 93817623
- `78NaFeELwh0` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 226739348; ext:Khöömei Batch 4/mp4 1920x1080 291477125
- `7kwAHXhU9Hs` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 16482862; ext:Khöömei Batch 4/mp4 1920x1080 19939437
- `7yHpkp0QtmY` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 435880431; ext:Khöömei Batch 5/mkv 1280x720 434860389
- `8wNnMMgqu64` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 65156399; ext:Khöömei Batch 5/webm 1920x1080 65506455
- `9ZLrawciLfI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 720x1280 28219982; ext:Khöömei Batch 4/mp4 720x1280 28450163
- `Af9UuEPjY0U` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 32303521; ext:Khöömei Batch 4/mp4 1920x1080 32537812
- `BF6ALIdztOE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 94728878; ext:Khöömei Batch 5/mkv 1920x1080 94777389
- `Bqr8itUfa3Y` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 848x480 7107550; ext:Khöömei Batch 5/mkv 848x480 6881183
- `C-E-5sP3Ahc` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 3840x2160 430405552; ext:Khöömei Batch 5/webm 3840x2160 430512127
- `CjabcqZzIGM` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 84117998; ext:Khöömei Batch 4/mp4 1920x1080 178424814
- `DG7qYSl4EiQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 506758625; ext:Khöömei Batch 5/mkv 1280x720 499031034
- `DJSiHUCQGe8` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 1280x720 18143015; ext:Khöömei Batch 5/mp4 1280x720 18143015
- `DUzv7w99icY` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 5865420; ext:Khöömei Batch 5/mp4 640x480 5865420
- `EpVhfeJl3T0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x360 15619362; ext:Khöömei Batch 5/webm 640x360 15951650
- `FN4nEbLaXxk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 25002173; ext:Khöömei Batch 5/mkv 1920x1080 24990232
- `GGJ_xGIzUbc` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 49176494; ext:Khöömei Batch 5/mp4 640x480 49176494
- `H1poWuu8MpI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 18340847; ext:Khöömei Batch 4/mp4 1280x720 26700889
- `HbUYanyq9Bc` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x592 47655026; ext:Khöömei Batch 5/webm 1280x592 46035538
- `Hf3XLze2i_4` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 50529688; ext:Khöömei Batch 4/mp4 1280x720 59096057
- `IfSPzcjx-_s` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1080x1080 11483715; ext:Khöömei Batch 4/mp4 1080x1080 11493644
- `JC7MmoJexcU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 7557871; ext:Khöömei Batch 4/mp4 640x480 6741621
- `JO6WpBbeN6s` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 1458792720; ext:Khöömei Batch 5/mkv 1920x1080 1377273059
- `JXIJ3hA8d5w` [same resolution, size differs; external]: ext:Khöömei Batch 3/mp4 640x480 44219949; ext:Khöömei Batch 4/mp4 640x480 44219948
- `JZ-rYITppLU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 54035840; ext:Khöömei Batch 4/mp4 1280x720 87683815
- `Je2z6TJNHhU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 76569142; ext:Khöömei Batch 4/mp4 1920x1080 114056005
- `Jt_GIdT1Moo` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 1920x1080 32270015; ext:Khöömei Batch 5/mp4 1920x1080 32270015
- `Jx_5knAk8uE` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 15887572; ext:Khöömei Batch 5/mp4 640x480 15887572
- `JywOq_Q7iwc` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 2288x1080 61021748; ext:Khöömei Batch 5/webm 2288x1080 61035877
- `KUy9DG8xfhE` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1280x720 33006707; ext:Khöömei Batch 4/mp4 1280x720 33789429
- `KtlNJQZXV4s` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 31289665; ext:Khöömei Batch 5/mkv 1280x720 31427429
- `Ku52Wrjb4LE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 95486730; ext:Khöömei Batch 5/mkv 1920x1080 95384861
- `LHnEgA_v6BY` [same resolution, different container/codec; external+local]: ext:Khöömei Batch 3/webm 1920x1080 59860220; ext:Khöömei Batch 4/mp4 1920x1080 70221036; loc:./mkv 1920x1080 69235140
- `LP1CpDZpjQI` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 161967624; ext:Khöömei Batch 5/mkv 1920x1080 162078619
- `LSisNUwL_h0` [same size (header bytes differ only); external+local]: ext:Khöömei/webm 1920x1080 76984068; loc:./webm 1920x1080 76984068
- `LZU_i5Z9q0Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 47219557; ext:Khöömei Batch 4/mp4 1280x720 64428077
- `M-qOhtWongk` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 1920x1080 177207287; ext:Khöömei Batch 5/mp4 1920x1080 177207287
- `M_SKfzJkfg8` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x480 35631851; ext:Khöömei Batch 5/mkv 640x480 34999813
- `MhL3hLLh-vk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 3840x2160 1140432188; ext:Khöömei Batch 4/mp4 3840x2160 1139955883
- `Ml8DscySDL0` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 6870153; ext:Khöömei Batch 4/mp4 640x480 7036431
- `MnzHMIx9skk` [same resolution, size differs; external]: ext:Khöömei Batch 3/mp4 1920x1080 384960180; ext:Khöömei Batch 4/mp4 1920x1080 384960179
- `MyraEgmNLjk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 400x224 13045454; ext:Khöömei Batch 4/mp4 400x224 17277075
- `N8MZKPAnM28` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 3840x2160 382507969; ext:Khöömei Batch 4/mp4 3840x2160 383526626
- `NDBipWHaUY4` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 640x360 6080879; ext:Khöömei Batch 5/mp4 640x360 6528996
- `NI2nEvrgUBk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 45154465; ext:Khöömei Batch 4/mp4 1920x1080 48948487
- `NgFndO4ML2g` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 31559179; ext:Khöömei Batch 4/mp4 640x480 38113256
- `NqTJgZFNDTg` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 48259687; ext:Khöömei Batch 4/mp4 1920x1080 75521920
- `O8la8he5PqM` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 63283985; ext:Khöömei Batch 4/mp4 1920x1080 91965660
- `OCKrI22VUGA` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 144180245; ext:Khöömei Batch 4/mp4 1920x1080 143450687
- `OD3TYVVL3gU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 45690007; ext:Khöömei Batch 4/mp4 1920x1080 60483826
- `Ohslv4C5JpY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 76093671; ext:Khöömei Batch 4/mp4 1920x1080 77710351
- `OxwbXHksK98` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 3840x2160 3885124532; ext:Khöömei Batch 5/webm 3840x2160 3881834586
- `P33LQR-HGaI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 19272356; ext:Khöömei Batch 4/mp4 640x480 31314037
- `P6AUSX98OrY` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 47217665; ext:Khöömei Batch 5/mkv 1920x1080 47248140
- `PK44icnZhEI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 848x480 22225563; ext:Khöömei Batch 4/mp4 848x480 21998718
- `PLBrIauvDEk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 71859514; ext:Khöömei Batch 5/mkv 1920x1080 71944411
- `PV3MZlBuTXo` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 10825099; ext:Khöömei Batch 5/mp4 640x480 10825099
- `PW-WHwUDhlE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 164852584; ext:Khöömei Batch 5/mkv 1920x1080 165114845
- `Q0pbX9Gier8` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 7040981; ext:Khöömei Batch 5/mp4 640x480 7040981
- `Q4AcrfKuKOw` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 47285313; ext:Khöömei Batch 4/mp4 1920x1080 63413332
- `QB7aIqkexQg` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 46946070; ext:Khöömei Batch 5/mp4 640x480 46946070
- `QCy13FVu_Yw` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 854x480 17416473; ext:Khöömei Batch 4/mp4 854x480 20008009
- `QIYARuSgw5M` [same size (header bytes differ only); external+local]: ext:Khöömei Batch 2/webm 1280x720 42973489; loc:./webm 1280x720 42973489
- `RBqE6zZnpUw` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 3184145; ext:Khöömei Batch 5/mp4 640x480 3184145
- `RD2fOaAgJ-k` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x960 27333347; ext:Khöömei Batch 4/mp4 1920x960 27152822
- `RaPwl1biT-U` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 16337005; ext:Khöömei Batch 5/mkv 1280x720 16006541
- `RovTF7Np2cY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 31370915; ext:Khöömei Batch 4/mp4 1280x720 36747918
- `S6dl8GAxKXE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 88762941; ext:Khöömei Batch 5/mkv 1920x1080 89292831
- `SA9e6sBi8r0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 103152984; ext:Khöömei Batch 5/mkv 1920x1080 103110086
- `SE_rg3vu0KQ` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 4269386; ext:Khöömei Batch 5/mp4 320x240 6036293
- `SJYTqPlj2PQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 31826051; ext:Khöömei Batch 4/mp4 1920x1080 50233471
- `SmFGR8Qvemk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 69590107; ext:Khöömei Batch 5/mkv 1920x1080 69540350
- `TW3o5LbAduQ` [same size (header bytes differ only); external+local]: ext:Khöömei Batch 3/webm 1920x1080 13985786; loc:./webm 1920x1080 13985786
- `TX0AlXd_O9Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 114182179; ext:Khöömei Batch 5/mkv 1920x1080 114442357
- `TXh5_G9NjJI` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 640x480 17083864; ext:Khöömei Batch 5/mp4 640x480 25094117
- `Td6c-76UjNU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 85741901; ext:Khöömei Batch 4/mp4 1920x1080 84049743
- `UbjT8HVpxdk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 720x1280 66007228; ext:Khöömei Batch 4/mp4 720x1280 65891775
- `V7Z8j58dsh4` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 69644838; ext:Khöömei Batch 4/mp4 1920x1080 70386889
- `VQJiUGwKnkA` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 41088607; ext:Khöömei Batch 5/mkv 1920x1080 40693931
- `VlvMhepbcrs` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 162356956; ext:Khöömei Batch 4/mp4 1920x1080 328925312
- `VrYr25xHUYM` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 4194604; ext:Khöömei Batch 5/mp4 320x240 5882831
- `W8PVvQugOF4` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x360 10993305; ext:Khöömei Batch 5/mp4 640x360 10993305; ext:Khöömei/webm 640x360 11090271
- `X3ltVk1DW_U` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 40896776; ext:Khöömei Batch 4/mp4 1280x720 60854456
- `X6-x-zzcjqk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 508254149; ext:Khöömei Batch 5/webm 1920x1080 510892555
- `XX1hcf13PqQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 65783641; ext:Khöömei Batch 4/mp4 1920x1080 96489139
- `Xoqt_xATxvA` [same resolution, different container/codec; external+local]: ext:Khöömei Batch 3/webm 854x480 66376813; ext:Khöömei Batch 4/mp4 854x480 71477990; loc:./mp4 854x480 71976678
- `YDXgQ5zX46w` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1080x1080 32998050; ext:Khöömei Batch 5/webm 1080x1080 33456050
- `YHVlXMSCCIM` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 49815600; ext:Khöömei Batch 5/webm 1280x720 48586360
- `YKWr0Jz_Ig8` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 960x720 21028916; ext:Khöömei Batch 5/mkv 960x720 21239766
- `YZ563e2Ippw` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 640x480 146935885; ext:Khöömei Batch 4/mp4 640x480 152217481
- `Z46p1anmCQQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 320x240 4411513; ext:Khöömei Batch 4/mp4 320x240 5095733
- `ZMWvWptau1o` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 854x480 26620771; ext:Khöömei Batch 5/mp4 854x480 26620771
- `ZQ8kR5CWIQQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 61218073; ext:Khöömei Batch 4/mp4 1920x1080 71713292
- `_SKAIbCNayw` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 73023834; ext:Khöömei Batch 5/mkv 1920x1080 72592650
- `_sph_KlCjGM` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 8543878; ext:Khöömei Batch 4/mp4 640x480 4876691
- `_zyDncMBqfY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 25138893; ext:Khöömei Batch 4/mp4 1920x1080 39480711
- `a1HQeFMJUh0` [resolution differs; external]: ext:Khöömei Batch 3/webm 198x360 5028639; ext:Khöömei Batch 4/mp4 352x640 6708266
- `a9VVAmaoSwk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x960 59113619; ext:Khöömei Batch 4/mp4 1920x960 59349626
- `aI1zE4_QgOQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x480 45821158; ext:Khöömei Batch 5/mkv 640x480 44116158
- `aMNG0-DQdJA` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 90094722; ext:Khöömei Batch 5/mkv 1920x1080 90016348
- `aiT48TUNmtU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 640x480 6244726; ext:Khöömei Batch 4/mp4 640x480 6352389
- `b6ks7gwv1ec` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 103138168; ext:Khöömei Batch 4/mp4 1920x1080 102370092
- `b8zmOgQwo2A` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 13075724; ext:Khöömei Batch 4/mp4 640x480 15645315
- `bEZVMOB0a9E` [same resolution, different container/codec; external+local]: ext:Khöömei Batch 3/webm 1920x1080 49296571; ext:Khöömei Batch 4/mp4 1920x1080 63833977; loc:./webm 1920x1080 49296571
- `bIIsRrx0cBU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1280x720 39607083; ext:Khöömei Batch 4/mp4 1280x720 40469946
- `bKvYypHraRI` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 131680023; ext:Khöömei Batch 5/mkv 1920x1080 131623231
- `c49QGMtnHTI` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 104757256; ext:Khöömei Batch 5/mkv 1920x1080 104326300
- `c5w9ALG0cqU` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 36038778; ext:Khöömei Batch 4/mp4 1920x1080 36551635
- `cRCOGzHIPW0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 854x480 1879899; ext:Khöömei Batch 5/mkv 854x480 1824074
- `d1UL_M_GWsc` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 14254714; ext:Khöömei Batch 4/mp4 640x480 20633819
- `dAfWQzA6-sE` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 12093856; ext:Khöömei Batch 4/mp4 1280x720 22851131
- `dBCniQOP7uk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 11403512; ext:Khöömei Batch 4/mp4 640x480 18039234
- `dBZFbQWjNtU` [same resolution, size differs; external]: ext:Khöömei Batch 3/mp4 1280x720 53744446; ext:Khöömei Batch 4/mp4 1280x720 53852780
- `dRLBbW9hkj4` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 64314704; ext:Khöömei Batch 4/mp4 1920x1080 76132131
- `dinR8LTJhDo` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 862810510; ext:Khöömei Batch 4/mp4 1920x1080 857666971
- `djXcCvEW388` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 18319892; ext:Khöömei Batch 4/mp4 1280x720 16265474
- `dmz1pcP5S2Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 20066236; ext:Khöömei Batch 4/mp4 640x480 21072705
- `dnaWcyoPOsY` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 11117746; ext:Khöömei Batch 5/mp4 640x480 11117746
- `dqbdnMVvyV0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 942878679; ext:Khöömei Batch 5/mkv 1920x1080 943840521; ext:Khöömei/webm 1920x1080 321398731
- `eAT0nyKRQ-U` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 720x1280 78548896; ext:Khöömei Batch 4/mp4 720x1280 80544766
- `eBQcxteuuu0` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 46221387; ext:Khöömei Batch 4/mp4 1920x1080 35470372
- `eGDufz3CuCI` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 250840106; ext:Khöömei Batch 5/mkv 1920x1080 251414213
- `eR9JxcQZlyE` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 67462947; ext:Khöömei Batch 4/mp4 1920x1080 75299346
- `e_8LpC9qIck` [same size (header bytes differ only); external]: ext:Khöömei Batch 2/webm 1920x1080 74803767; ext:Khöömei/webm 1920x1080 74803767
- `ehiZVpC6zlw` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 73139724; ext:Khöömei Batch 4/mp4 1920x1080 123073766
- `ekfnEJ4rixk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 113599328; ext:Khöömei Batch 4/mp4 1920x1080 112804248
- `emlBRViT9hE` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 125101891; ext:Khöömei Batch 5/mkv 1920x1080 124740254
- `evmZ2ZWy-Zg` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 48659751; ext:Khöömei Batch 4/mp4 1920x1080 63215372
- `f1qupjo0jC0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 17657191; ext:Khöömei Batch 5/mkv 1280x720 17537643
- `fF-t9_K6vEM` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 63752705; ext:Khöömei Batch 5/mkv 1920x1080 64067322
- `fHHgy5RdZXE` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 50221790; ext:Khöömei Batch 4/mp4 1920x1080 86807250
- `fIr5Fris2AI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 112781667; ext:Khöömei Batch 4/mp4 1920x1080 178807883
- `fl-P98P2Gu4` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 79508121; ext:Khöömei Batch 5/mkv 1920x1080 79621796
- `go20L0JbBJQ` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x480 6627173; ext:Khöömei Batch 5/mkv 640x480 10949494
- `hA7cfWUS6kM` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 9966437; ext:Khöömei Batch 5/mp4 640x480 9966437
- `i92kR10QZ4c` [same resolution, different container/codec; external+local]: ext:Khöömei Batch 3/webm 1280x720 43158687; ext:Khöömei Batch 4/mp4 1280x720 41620030; loc:Bayan Solos/webm 1280x720 43158687
- `ijJ5LACXvIY` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 450x360 82987064; ext:Khöömei Batch 5/webm 450x360 84514649
- `iv6r3U8VWp8` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 31360837; ext:Khöömei Batch 5/mkv 1920x1080 31142150
- `jCWUBbOQM9Y` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 5130994; ext:Khöömei Batch 5/mp4 320x240 5423979
- `jMuMZOtLAYk` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1440x1080 66788567; ext:Khöömei Batch 4/mp4 1440x1080 82372508
- `jaqFLzGJchU` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 72725042; ext:Khöömei Batch 5/mkv 1920x1080 71746384
- `jcpVmTg3E6Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 55175478; ext:Khöömei Batch 4/mp4 1280x720 60071676
- `jkiwy4ZBMF4` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 4832613; ext:Khöömei Batch 5/mp4 320x240 4562090
- `jpk0T7b_I8o` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 13290201; ext:Khöömei Batch 5/mkv 1920x1080 13227727
- `jzxGldmx85o` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 1920x1080 1059023708; ext:Khöömei Batch 5/mp4 1920x1080 1059023708
- `k9seaVJJzO4` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 6766598; ext:Khöömei Batch 5/mp4 640x480 6766598
- `ku1Hj6R4x-Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 197554194; ext:Khöömei Batch 4/mp4 1920x1080 341401616
- `lD2SkeNjuJI` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 192393858; ext:Khöömei Batch 4/mp4 1920x1080 252833802
- `lIhGSQP5IFY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 15000760; ext:Khöömei Batch 4/mp4 1280x720 11246484
- `lOLIik0FZG8` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 15486722; ext:Khöömei Batch 4/mkv 640x480 16585821
- `mKqcrBQmvKs` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 166051755; ext:Khöömei Batch 4/mp4 1920x1080 225718142
- `m_3LWytODB0` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 656x480 269493591; ext:Khöömei Batch 5/mkv 656x480 261733642
- `m_VOh5Xj9V4` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 6464238; ext:Khöömei Batch 5/mp4 320x240 6586808
- `mhlkFozL44w` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 480x360 93536069; ext:Khöömei Batch 4/mp4 480x360 75598603
- `my2bnSSbfR8` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 106306497; ext:Khöömei Batch 4/mp4 1920x1080 83656743
- `n1rkpxWAvok` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 75417371; ext:Khöömei Batch 5/mkv 1920x1080 75502858
- `nT5QKJX2hWA` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 73741758; ext:Khöömei Batch 4/mp4 1920x1080 93681351
- `nWeGIIE-hhU` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 640x480 21364721; ext:Khöömei Batch 5/webm 640x480 21541492
- `nYsIfG-U15s` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 50941206; ext:Khöömei Batch 4/mp4 1920x1080 100292441
- `o7tWSwaHo94` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 87011867; ext:Khöömei Batch 5/mkv 1920x1080 86066951
- `oGJOxzLXh1I` [same size (header bytes differ only); external+local]: ext:Khöömei Batch 3/webm 636x480 15298534; loc:./webm 636x480 15298534
- `oIGZs3a6p-s` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x360 6025952; ext:Khöömei Batch 5/mp4 640x360 6025952
- `odzCDvi6e-I` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 192400661; ext:Khöömei Batch 4/mp4 1920x1080 309837742
- `ora4rj-4BaY` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 10666776; ext:Khöömei Batch 5/mp4 640x480 10666776
- `pYcaWzRRtuY` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 626x360 2729355; ext:Khöömei Batch 5/webm 626x360 2640023
- `pwPbSpIe2Xc` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 4339682; ext:Khöömei Batch 5/mp4 320x240 4861315
- `qNJFxVw58kM` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 77747272; ext:Khöömei Batch 5/mkv 1920x1080 78040361
- `rGZeIAnbU84` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 373664892; ext:Khöömei Batch 5/mkv 1920x1080 368297737
- `rm4HOrmzoSo` [same resolution, size differs; external]: ext:Khöömei Batch 4/mp4 320x240 1490417; ext:Khöömei Batch 5/mp4 320x240 1597024
- `rxXAd7Sul5Q` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 182516714; ext:Khöömei Batch 5/mkv 1280x720 182266529
- `sZcDtkiYNzY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 87502960; ext:Khöömei Batch 4/mp4 1920x1080 183173663
- `sc_JWWaSf1s` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 56870990; ext:Khöömei Batch 4/mp4 1920x1080 77681061
- `t0TYIO026XA` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 76656243; ext:Khöömei Batch 4/mp4 1280x720 113010829
- `twxnkGJN6g8` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 63169754; ext:Khöömei Batch 5/mkv 1920x1080 62989963
- `uUTQ6d7fL2U` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 640x480 10880639; ext:Khöömei Batch 4/mp4 640x480 10723576
- `ukdQC1fyoPA` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 23283758; ext:Khöömei Batch 4/mp4 1280x720 41056604
- `umHyAbEeS_I` [same resolution, size differs; external]: ext:Khöömei Batch 4/mkv 1920x1080 87468785; ext:Khöömei Batch 5/mkv 1920x1080 164827690
- `urZOB8p_BPs` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1280x720 28420856; ext:Khöömei Batch 5/mkv 1280x720 27800244
- `uwCtVxHko7c` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 74909369; ext:Khöömei Batch 5/mkv 1920x1080 74663701
- `v-HHP_fUWVY` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 69809273; ext:Khöömei Batch 4/mp4 1920x1080 109640592
- `vEKSAQjmK04` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 640x480 17669926; ext:Khöömei Batch 4/mp4 640x480 15494987
- `vfh-ik521_I` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/mkv 1920x1080 467117643; ext:Khöömei Batch 4/mp4 1920x1080 466698452
- `vsh106TPX8Y` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 51907279; ext:Khöömei Batch 4/mp4 1920x1080 87550301
- `wu2pFGsmKqU` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 640x480 9927141; ext:Khöömei Batch 5/mp4 640x480 9927141
- `xFNyYe1UxDw` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 720x1280 22608407; ext:Khöömei Batch 5/webm 720x1280 22710661
- `xGOgUiE6nQo` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1280x720 14647797; ext:Khöömei Batch 4/mp4 1280x720 17320260
- `xaZk_-rakz8` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 85687662; ext:Khöömei Batch 5/mkv 1920x1080 85781042
- `xfMCVW0MjYM` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 480x360 3123887; ext:Khöömei Batch 5/mp4 480x360 3123887
- `xjr9KdUVrHk` [same resolution, different container/codec; external]: ext:Khöömei Batch 4/mp4 1920x1080 115468169; ext:Khöömei Batch 5/mkv 1920x1080 116137152
- `ycQt5YH2VWQ` [same size (header bytes differ only); external]: ext:Khöömei Batch 4/mp4 1920x1080 25256257; ext:Khöömei Batch 5/mp4 1920x1080 25256257
- `ymdDyh9Lw7U` [same resolution, different container/codec; external]: ext:Khöömei Batch 3/webm 1920x1080 48603103; ext:Khöömei Batch 4/mp4 1920x1080 95933671
- `z5xwPSWqUw0` [same resolution, different container/codec; external]: ext:Khöömei Batch 2/webm 640x480 45666009; ext:Khöömei Batch 4/mp4 640x480 53712185

### Within one Root, different resolution (quality differences)

- `a1HQeFMJUh0`: ext:Khöömei Batch 3/webm 198x360 5028639; ext:Khöömei Batch 4/mp4 352x640 6708266

## Filename oddities

Files with U+2028 / trailing space / control chars: 1 (U+2028: 0, trailing_space: 0, other: 1)

- external: `'Khöömei Batch 3/2 июня 2022\xa0г. [XjyU0MIvnmk].mkv'` [control_or_special_ws]

Paths containing non-ASCII characters: 1075

Duplicate basenames: 45 names appear more than once (8 across both Roots, 37 with 2+ in one Root).

- `ТUVAN PARTY - Kongar-oll Ondar, a star of world and folk music,  and his friends. [QIYARuSgw5M].webm`: external:`Khöömei Batch 2` 42973489 B fp=9bb34a56; local:`.` 42973489 B fp=447a7427
- `ALASH ENSEMBLE [00_hhy6gRyo].mp4`: external:`Khöömei Batch 3` 13262114 B fp=8f848848; external:`Khöömei Batch 4` 13262113 B fp=f71ba566
- `Alash Promo [4uGjHjpl_Y4].webm`: external:`Khöömei Batch 3` 15117364 B fp=acfc4a79; local:`.` 15117317 B fp=cb3bf033
- `Bayan solo, ALASH, Poughkeepsie, NY Tuvan Throat Singing [i92kR10QZ4c].webm`: external:`Khöömei Batch 3` 43158687 B fp=0bfb5113; local:`Bayan Solos` 43158687 B fp=e6c98d60
- `Eki attar [oGJOxzLXh1I].webm`: external:`Khöömei Batch 3` 15298534 B fp=871ccd81; local:`.` 15298534 B fp=1ef03c06
- `Sygyt and Igil Practice [18gnn5wWgUQ].mp4`: external:`Khöömei Batch 3` 12747704 B fp=2871652f; external:`Khöömei Batch 4` 12809713 B fp=e0f5701a
- `The Alash Ensemble - Ene Sie - Princeton NJ, Алаш Тува TUVAN THROAT SINGING [JXIJ3hA8d5w].mp4`: external:`Khöömei Batch 3` 44219949 B fp=8a8b8127; external:`Khöömei Batch 4` 44219948 B fp=6522c37f
- `Tuva Ensemble live at 13 Shamans Festival - Khoomei - Tuvan Throat Singing [dBZFbQWjNtU].mp4`: external:`Khöömei Batch 3` 53744446 B fp=c1c3b048; external:`Khöömei Batch 4` 53852780 B fp=23a3237a
- `Кожамыктар - Ученики Конгар-оола Борисовича Ондар [bEZVMOB0a9E].webm`: external:`Khöömei Batch 3` 49296571 B fp=9d40cca7; local:`.` 49296571 B fp=8523167e
- `песня 'Чавыдак' [TW3o5LbAduQ].webm`: external:`Khöömei Batch 3` 13985786 B fp=7bc19bd2; local:`.` 13985786 B fp=dd723c45
- `20190302 201558 Alash -5HE - 08 [umHyAbEeS_I].mkv`: external:`Khöömei Batch 4` 87468785 B fp=8e4dcdea; external:`Khöömei Batch 5` 164827690 B fp=3c891cfa
- `ALASH at New City Galerie [DJSiHUCQGe8].mp4`: external:`Khöömei Batch 4` 18143015 B fp=0d9ee16f; external:`Khöömei Batch 5` 18143015 B fp=d38edd0a
- `Alash - closeup of instrument [ZMWvWptau1o].mp4`: external:`Khöömei Batch 4` 26620771 B fp=b8ddb3d0; external:`Khöömei Batch 5` 26620771 B fp=68bd96b1
- `Alash Ensemble with Shodekeh at The 2018 Philadelphia Folk Festival [ycQt5YH2VWQ].mp4`: external:`Khöömei Batch 4` 25256257 B fp=072f904e; external:`Khöömei Batch 5` 25256257 B fp=623d2d4d
- `Alash live at The Rotunda in Philadelphia 3 [DUzv7w99icY].mp4`: external:`Khöömei Batch 4` 5865420 B fp=131a678f; external:`Khöömei Batch 5` 5865420 B fp=98a86654
- `Alash live at The Rotunda in Philadelphia 4 [hA7cfWUS6kM].mp4`: external:`Khöömei Batch 4` 9966437 B fp=588560f6; external:`Khöömei Batch 5` 9966437 B fp=8a793b67
- `Alash live at The Rotunda in Philadelphia 5 [Q0pbX9Gier8].mp4`: external:`Khöömei Batch 4` 7040981 B fp=e6d4bcea; external:`Khöömei Batch 5` 7040981 B fp=5f0533ab
- `Alash live at The Rotunda in Philadelphia [RBqE6zZnpUw].mp4`: external:`Khöömei Batch 4` 3184145 B fp=957c8019; external:`Khöömei Batch 5` 3184145 B fp=6aac6b59
- `Alash on Chic-A-Go-Go [GGJ_xGIzUbc].mp4`: external:`Khöömei Batch 4` 49176494 B fp=33b8201a; external:`Khöömei Batch 5` 49176494 B fp=4cbe02c2
- `Alash, Grassroots Festival 2009, Dylnglydy TUVAN THROAT SINGING [dnaWcyoPOsY].mp4`: external:`Khöömei Batch 4` 11117746 B fp=6f3d9b99; external:`Khöömei Batch 5` 11117746 B fp=c0d1e6dc
- `Alash_OM_Center.mov [xfMCVW0MjYM].mp4`: external:`Khöömei Batch 4` 3123887 B fp=a75e86e7; external:`Khöömei Batch 5` 3123887 B fp=7a8a4c97
- `Bady Dorzhu Ondar, Alash Ensemble, Chanzy jam - Tuva [Jt_GIdT1Moo].mp4`: external:`Khöömei Batch 4` 32270015 B fp=601e9ebc; external:`Khöömei Batch 5` 32270015 B fp=a6d1ae77
- `Bady-Dorzhu Ondar - Khoomei Festival in Tuva 2008 part 1⧸2 [SE_rg3vu0KQ].mp4`: external:`Khöömei Batch 4` 4269386 B fp=47267123; external:`Khöömei Batch 5` 6036293 B fp=42c57a57
- `Bady-Dorzhu Ondar - Khoomei Festival in Tuva 2008 part 2⧸2 [VrYr25xHUYM].mp4`: external:`Khöömei Batch 4` 4194604 B fp=5cc9a78c; external:`Khöömei Batch 5` 5882831 B fp=ad159edf
- `Bela Fleck and the Flecktones - Live at the Quickcenter - part 3 [QB7aIqkexQg].mp4`: external:`Khöömei Batch 4` 46946070 B fp=36f779f3; external:`Khöömei Batch 5` 46946070 B fp=9a1374e5
- `Bela Fleck and the Flecktones - Live at the Quickcenter - part 5 [Jx_5knAk8uE].mp4`: external:`Khöömei Batch 4` 15887572 B fp=a832be04; external:`Khöömei Batch 5` 15887572 B fp=16c041f9
- `Chirgilchin - Daglarym [TXh5_G9NjJI].mp4`: external:`Khöömei Batch 4` 17083864 B fp=f35ffd98; external:`Khöömei Batch 5` 25094117 B fp=a9ba4fff
- `HARTYGA - Agitator (official old-school video) [M-qOhtWongk].mp4`: external:`Khöömei Batch 4` 177207287 B fp=9df40c25; external:`Khöömei Batch 5` 177207287 B fp=d9e43a6b
- `Khogzhumchu at the Richmond Folk Festival [PV3MZlBuTXo].mp4`: external:`Khöömei Batch 4` 10825099 B fp=b551daf9; external:`Khöömei Batch 5` 10825099 B fp=60ea1bfa
- `Khoomei Festival in Tuva 2008 [m_VOh5Xj9V4].mp4`: external:`Khöömei Batch 4` 6464238 B fp=283d8929; external:`Khöömei Batch 5` 6586808 B fp=f6d1d682
- `Kyzyl-Moscow_2005 part2 [6FHsFCs8i3E].mp4`: external:`Khöömei Batch 4` 4727235 B fp=9749c96b; external:`Khöömei Batch 5` 4972218 B fp=4d7bb628
- `Kyzyl-Moscow_2005 part3 [rm4HOrmzoSo].mp4`: external:`Khöömei Batch 4` 1490417 B fp=4b2b428c; external:`Khöömei Batch 5` 1597024 B fp=56ccc2b1
- `Kyzyl-Moscow_2005 part6 [jCWUBbOQM9Y].mp4`: external:`Khöömei Batch 4` 5130994 B fp=f575f871; external:`Khöömei Batch 5` 5423979 B fp=124d2cfb
- `Kyzyl-Moscow_2005 part8 [pwPbSpIe2Xc].mp4`: external:`Khöömei Batch 4` 4339682 B fp=d9ff4620; external:`Khöömei Batch 5` 4861315 B fp=c8a6bd16
- `Nachyn Choodu and Shonchalai Oorjak-Choodu Kojamyktar [oIGZs3a6p-s].mp4`: external:`Khöömei Batch 4` 6025952 B fp=c3c2eafd; external:`Khöömei Batch 5` 6025952 B fp=82e2bea0
- `Radik Tulush - Tyva： Spirits Of My Land - 2007 - Full Album [Xoqt_xATxvA].mp4`: external:`Khöömei Batch 4` 71477990 B fp=dacd7e46; local:`.` 71976678 B fp=734ae19d
- `Shonchalai Oorjak-Choodu, a famous throat-singer from Republic of Tyva [NDBipWHaUY4].mp4`: external:`Khöömei Batch 4` 6080879 B fp=c790b3cf; external:`Khöömei Batch 5` 6528996 B fp=d300b763
- `THE ALASH ENSEMBLE - Khoomei solo, BALTIMORE 2013 - TUVAN THROAT SINGING [wu2pFGsmKqU].mp4`: external:`Khöömei Batch 4` 9927141 B fp=5c1d0943; external:`Khöömei Batch 5` 9927141 B fp=2c81103c
- `Throat Singers of Tuva [jkiwy4ZBMF4].mp4`: external:`Khöömei Batch 4` 4832613 B fp=a99feba8; external:`Khöömei Batch 5` 4562090 B fp=7e72130e
- `Tuvan Throat Singers Khogzhumchu  at the Richmond Folk Festival [ora4rj-4BaY].mp4`: external:`Khöömei Batch 4` 10666776 B fp=6f6129a1; external:`Khöömei Batch 5` 10666776 B fp=8d960986
- `yeni ufuklar kirgiz manas destani, tuva girtlak sarkicilari [2G4e089zjOQ].mp4`: external:`Khöömei Batch 4` 11830390 B fp=40d2b3b7; external:`Khöömei Batch 5` 12722411 B fp=75a5de40
- `Добрыня. Кайчи - 1 [W8PVvQugOF4].mp4`: external:`Khöömei Batch 4` 10993305 B fp=2ecc15df; external:`Khöömei Batch 5` 10993305 B fp=756b1bf6
- `Хартыга в Красноярске. [jzxGldmx85o].mp4`: external:`Khöömei Batch 4` 1059023708 B fp=f4035f67; external:`Khöömei Batch 5` 1059023708 B fp=dca4e7b1
- `＂Kara druja＂ (musta kurki) performed by Rodion Munzuk (chanzy höömei⧸sygyt⧸borbangnadyr) [k9seaVJJzO4].mp4`: external:`Khöömei Batch 4` 6766598 B fp=6c6a10b5; external:`Khöömei Batch 5` 6766598 B fp=c956eab6
- `Yuliyana Krivoshapkina and Nachyn Choreve  'Ene sai' [LSisNUwL_h0].webm`: external:`Khöömei` 76984068 B fp=ebe1a39a; local:`.` 76984068 B fp=57a43a00

## Video codecs (readable video files)

- webm vp9+opus: 535
- mp4 h264+aac: 384
- mkv h264+opus: 107
- mp4 vp9+aac: 60
- mkv vp9+aac: 32
- webm vp9+none: 7
- mkv h264+aac: 6
- mkv vp9+opus: 3
- mkv vp9+eac3: 1
- jpg mjpeg+none: 1

---

## Batch 6 addendum (2026-10-10)

Resolves #20 (part of map #1). `Khöömei Batch 6` was added to the external Root after #8. Probed by a second throwaway script (not in the repo) with the same method and columns; its 205 rows are appended to [root-inventory.csv](root-inventory.csv) (now 1,347 rows). `.DS_Store` and `._*` skipped, no media file modified, 0 ffprobe failures. Same-Video rule is id + size + duration, not fingerprint.

### Batch 6 files by extension and size

38.0 GB in 205 files, all directly in `Khöömei Batch 6/` (no subfolders).

| ext | files | size |
|---|---|---|
| mkv | 151 | 28.46 GB |
| webm | 36 | 8.92 GB |
| mp4 | 16 | 0.56 GB |
| part | 1 | 0.07 GB |
| m4a | 1 | 0.00 GB |
| **total** | **205** | **38.01 GB** |

New extensions versus #8: `.m4a` and `.part` (both are yt-dlp leftovers, see Partials).

### Codecs seen

- mkv h264+opus: 151
- webm vp9+opus: 18
- webm av1+opus: 16 (AV1 is new: #8 had none)
- mp4 h264+aac: 16
- partials without a video stream: 3 (opus, opus, aac); the `.part` file is h264 video only
- Resolutions: 1920x1080 x101, 1280x720 x26, 640x480 x21, 854x480 x6, 3840x2160 x4, 2560x1440 x3, plus 7 portrait 1080x1920 and 2 square 1080x1080/1440x1440; the rest are small or odd sizes (e.g. 320x240, 1920x800, 3840x1608).

### Partials

4 yt-dlp leftovers (`.fNNN`), all in Batch 6:

- `Lowell Festival Tuvan throat singers [fNbyuMPu9Fc].f140.m4a` (2449383 B, aac only); no other Copy of the id.
- `Medley of Tuvan major songs – Echoes of the Steppe 2025 [nVn6fnM6Ypo].f251.webm` (20306484 B, opus only); no other Copy of the id.
- `Домашний концерт тувинских горловиков. Часть 1 [5yAphfd7X14].f251.webm` (10692675 B, opus only) and `... [5yAphfd7X14].f136.mp4.part` (65005008 B, h264 only, an unfinished download): the video and audio halves of one download that never merged. No merged file with the final name exists.

So none of the 4 is a playable Video on its own. The `.part` suffix is new; a scanner that only matches `.fNNN.<ext>` will miss it.

### Files with no id

0 of 205. All 201 non-partial files carry a trailing `[id]`, and the 4 partials carry one too (the id is parsed through `.fNNN` and `.part`). No fingerprint (first+last 1 MB) match between any Batch 6 file and any other file in either Root.

### Batch 6 ids already present elsewhere

6 of the 201 Batch 6 ids exist in another folder or in the local Root; the other 195 are new. No id repeats inside Batch 6.

- `7NIVTqUI5OE` [same resolution, different container/codec]:
  - local `Igor Köshkendei & Ensemble Daia (Full concert) – Echoes of the steppe 2025 [7NIVTqUI5OE].mp4` 775649201 B 1920x1080 h264/aac mov 3104s
  - external `Khöömei Batch 6/Igor Köshkendei & Ensemble Daia (Full concert) – Echoes of the steppe 2025 [7NIVTqUI5OE].mkv` 776273459 B 1920x1080 h264/opus matroska 3104s
- `KVtwuJTl5NE` [resolution differs; the names also differ, local has `2 часть 2`, Batch 6 has `2 часть`]:
  - local `2006 Улустун ырызы 2 часть 2 [KVtwuJTl5NE].mp4` 192859871 B 480x360 h264/aac mov 3396s
  - external `Khöömei Batch 6/2006 Улустун ырызы 2 часть [KVtwuJTl5NE].mkv` 359899983 B 640x480 h264/opus matroska 3395s
- `PWdJ4vVnqkI` [same size, byte-identical size and duration; fingerprints differ]:
  - local `Samagaldai by Igor & friends – Echoes of the Steppe 2025 [PWdJ4vVnqkI].mkv` 50205011 B 1920x1080 h264/opus matroska 186s
  - external `Khöömei Batch 6/Samagaldai by Igor & friends – Echoes of the Steppe 2025 [PWdJ4vVnqkI].mkv` 50205011 B 1920x1080 h264/opus matroska 186s
- `dwL_kms2eYE` [same resolution, different container/codec; external only]:
  - external `Khöömei Batch 4/Эзир-кара. Тувинское горловое пение. Монгун-оол Монгуш.  #tuva#хоомей#горловоепение#монгун-оол [dwL_kms2eYE].mp4` 63802861 B 1920x1080 vp9/aac mov 207s
  - external `Khöömei Batch 6/Эзир-кара. Тувинское горловое пение. Монгун-оол Монгуш.  #tuva#хоомей#горловоепение#монгун-оол [dwL_kms2eYE].webm` 46907454 B 1920x1080 av1/opus matroska 207s
- `vEKSAQjmK04` [same resolution, different container/codec; external only]:
  - external `Khöömei Batch 3/The Alash Ensemble, Ayan-ool Sam khoomei solo Алаш Тува - Throat Singing [vEKSAQjmK04].webm` 17669926 B 640x480 vp9/opus matroska 147s
  - external `Khöömei Batch 4/The Alash Ensemble, Ayan-ool Sam khoomei solo Алаш Тува - Throat Singing [vEKSAQjmK04].mp4` 15494987 B 640x480 h264/aac mov 147s
  - external `Khöömei Batch 6/The Alash Ensemble, Ayan-ool Sam khoomei solo Алаш Тува - Throat Singing [vEKSAQjmK04].mp4` 18019920 B 640x480 h264/aac mov 147s
- `z5xwPSWqUw0` [same resolution, different container/codec; external only]:
  - external `Khöömei Batch 2/Amazing Grace by Tuvan Throat Singers [z5xwPSWqUw0].webm` 45666009 B 640x480 vp9/opus matroska 583s
  - external `Khöömei Batch 4/Amazing Grace by Tuvan Throat Singers [z5xwPSWqUw0].mp4` 53712185 B 640x480 h264/aac mov 583s
  - external `Khöömei Batch 6/Amazing Grace by Tuvan Throat Singers [z5xwPSWqUw0].mkv` 67287682 B 640x480 h264/opus matroska 583s

Three of the six span both Roots (`7NIVTqUI5OE`, `KVtwuJTl5NE`, `PWdJ4vVnqkI`), so ids present in both Roots go from 9 to 12.

### Same-id pairs that differ in resolution

One new: `KVtwuJTl5NE`, local 480x360 (192859871 B) versus Batch 6 640x480 (359899983 B); durations 3396s vs 3395s. It is the first resolution difference that spans both Roots. Together with `a1HQeFMJUh0` (Batch 3 vs 4) there are now 2 ids that differ in resolution.

### Filename oddities

- U+2028, trailing spaces, U+00A0 or control characters: 0 in Batch 6.
- All 205 paths contain non-ASCII characters (Cyrillic, `ö`, en dashes), so non-ASCII paths total 1,280.
- Duplicate basenames: 47 names now appear more than once (was 45). The 2 new are `The Alash Ensemble, Ayan-ool Sam khoomei solo ... [vEKSAQjmK04].mp4` (Batch 4 and 6, different sizes) and the `Samagaldai ... [PWdJ4vVnqkI].mkv` (local and Batch 6, same size).

### Updated totals

| | before (#8) | after Batch 6 |
|---|---|---|
| files, external Root | 1,053 | 1,258 |
| files, local Root | 89 | 89 |
| files, total | 1,142 | 1,347 |
| size, external | 150.2 GB | 188.2 GB |
| distinct ids (non-partial) | 829 | 1,024 |
| ids with 2+ Copies | 216 | 220 |
| ids present in both Roots | 9 | 12 |
| redundant GB (every Copy except the largest of each id) | 24.5 GB | 25.7 GB |

"Redundant GB" counts, for each id with 2+ Copies, the sizes of all Copies except the largest one. It is an upper bound on what a dedupe could reclaim, since it ignores that Copies of one Video can differ in quality or container. Batch 6 adds 4 ids with 2+ Copies (the other 2 of the 6 overlaps already had 2 Copies) and 1.1 GB.

## Batch 7 addendum (2026-10-10)

`Khöömei Batch 7` is the output of `scripts/download-missing-youtube.sh`: the 665 Performance YouTube ids the archive links that no Root had a Copy of, downloaded as `bv*+ba` merged to mkv with an `.info.json` sidecar each. 636 downloaded; 29 failed (unavailable, private or removed — listed in `download.log`). The 636 ids are all new to the library (none in Batches 1–6 or the local Root), so Batch 7 adds no duplicates. Figures come from the app's own scan (ffprobe at scan time), not a throwaway probe; 636 rows appended to [root-inventory.csv](root-inventory.csv) (now 1,983 rows) with the fingerprint column empty.

Same day, the whole external Root moved off the drive: it is now `/Users/evanwilliams/Desktop/Хөөмей/` with the seven batch folders inside, same relative paths. The drive's exFAT listing was decomposed Unicode (NFD) and APFS lists precomposed (NFC); the scanner now stores one NFC spelling per Copy.

### Batch 7 files

54.3 GB in 636 Videos, 73.5 hours; all playable natively (every Copy `playback = native`).

| container / codecs | files |
|---|---|
| mkv h264+opus | 304 |
| mkv av1+opus | 172 |
| mkv vp9+opus | 137 |
| mkv h264+aac | 21 |
| mkv vp9+aac | 1 |
| mp4 h264+aac | 1 |

AV1 is now a sixth of the library's newest batch (16 files in Batch 6, 172 here). Resolutions: 1080x1080 x238 (YouTube Shorts-style squares), 1920x1080 x177, 1280x720 x69, 640x480 x38, portrait 1080x1920 x13 and 720x1280 x5, 3840x2160 x7, the rest small. Longest: 137 min (Отчетный концерт ККИ 2023), 134 min (Тыва Кызы), 127 min (День хоомея 2025).

Scan defaults from the Mirror: 395 Videos typed `song` with a Suggested Song, 9 `concert`, 232 left `other`.

### Leftovers in the folder

- `Uskash keliyyin (#1) [afXpcD5OU80].f251.webm` — audio-only partial of a failed download (skipped by the scanner).
- 637 `.info.json` sidecars (10 carry YouTube chapters). The app's `youtube-info/` cache is separate and fetched by `bun run fetch-youtube-info` (which also pulls comments), so these were not copied in.
- `download.log`, `.downloaded.txt` (yt-dlp archive, 636 ids).
