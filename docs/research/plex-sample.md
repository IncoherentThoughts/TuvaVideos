# Plex sample

A Plex Media Server library of 42 hard links into the Library, built so the Plex research tickets (#43) can probe how Plex treats the awkward Copies.

- Server URL: `http://127.0.0.1:32400` (Plex Media Server 1.41.5, claimed and signed in)
- Sample library: "Tuva Sample", **section id 3** (existing: 1 Movies, 2 TV Shows, untouched)
- Section settings: type movie, agent `com.plexapp.agents.none`, scanner "Plex Video Files Scanner", language `xn`. The `tv.plex.agents.none` agent named in the ticket is rejected by 1.41.5 ("new scanner needs to be paired with new agent"), so the legacy none agent is used.
- Sample folder: `~/PlexSample/TuvaSample`. Every entry is a **hard link** (link count 2) named `<tag>__<original name>`; nothing was copied, moved or modified.
- Token: in the macOS defaults, `defaults read com.plexapp.plexmediaserver PlexOnlineToken`. Read it into a shell variable; never print or commit it. Pass as `X-Plex-Token` (add `Accept: application/json`).

## Stop Plex

Quit the menu-bar app, or `osascript -e 'quit app "Plex Media Server"'`.

## Remove the sample

```sh
T=$(defaults read com.plexapp.plexmediaserver PlexOnlineToken)
curl -X DELETE "http://127.0.0.1:32400/library/sections/3?X-Plex-Token=$T"
rm -r ~/PlexSample   # only removes the hard links; the Library files are untouched
```

## Findings

- 42 files linked, 40 indexed by Plex (section 3 `/all` size 40). The two not indexed are unmerged yt-dlp partials Plex does not treat as video: a `.f136.mp4.part` and a `.f140.m4a`.
- Plex reports a `.webm` file's container as `mkv` (Matroska), so webm and mkv are indistinguishable by Plex's `container` field; use the file extension.
- The audio-only `.f251.webm` partial was indexed but with no video codec or resolution. Video-only `.f303.webm` partials were indexed with video codec and resolution but no audio codec.
- Plex's analysis agreed with the db on video codec, audio codec and resolution for every Copy; Plex's `container` for webm differs as above.
- The `.fNNN` partials are not Copies in library.db (no Copy id). The only Copy with a Fallback file is 365 (the VP9 + E-AC3 mkv, `365.mkv`, playback `transcode`); the linked file is the original, not the Fallback.
- Extra tags beyond the ticket: `hdr10bit-*` (10-bit HLG, `yuv420p10le` + `arib-std-b67`), `fullrange-h264-mkv` (`yuvj420p`), `vfr-vp9-mkv` (19001/317 fps), `60fps-h264-mkv`, `oddres-h264-mp4`. `long-concert` and several `4k` files are also over 60 minutes or 4K-60fps.

## Files

Paths are relative to the library Root (`/Users/evanwilliams/Desktop/Khoomei/Videos`). Library columns come from library.db; Plex columns are Plex's own analysis (`/library/metadata/<ratingKey>`), with the video profile and frame rate label.

| tag | original library path | Copy id | container | video | audio | resolution | duration | size | Plex ratingKey | Plex container | Plex video | Plex audio | Plex resolution | Plex bitrate | Plex profile / fps |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 4k | `archive/Khöömei Batch 4/Four Mongolian throat singing techniques with Tovshuur - Song： ＂Mongol＂ [tiAgc12uqxs].mp4` | 1025 | mp4 | vp9 | aac | 3840x2026 | 3m26s | 185.8 MB | 694 | mp4 | vp9 | aac | 3840x2026 | 7193 kbps | profile 0/NTSC |
| 4k | `archive/Khöömei Batch 5/Тувинская народная песня «Дунда карам». Алексей Ховалыг ⧸ Tuvan folk song «Dunda karam» [c8G4WQj9CpA].webm` | 1322 | webm | vp9 | opus | 3840x2160 | 7m59s | 1298.5 MB | 697 | mkv | vp9 | opus | 3840x2160 | 21668 kbps | profile 0/60p |
| 4k | `archive/Khöömei Batch 7/Tuvan song Radik Tyulyush ⧸ SAMHEY [gBJbrRGxqr0].mkv` | 1363 | mkv | av1 | opus | 3840x2160 | 7m18s | 382.9 MB | 696 | mkv | av1 | opus | 3840x2160 | 6992 kbps | main/24p |
| 4k | `Batch 8/песня бээжин, фольклорный ансамбль Эзир Уя, Республика Тыва Эрзинский кожуун [vvDh7M2yJa0].mkv` | 2205 | mkv | vp9 | opus | 3840x2160 | 4m46s | 433.8 MB | 698 | mkv | vp9 | opus | 3840x2160 | 12132 kbps | profile 0/NTSC |
| 4k | `Batch 9/Huun-Huur-Tu ⧸ Хүн Хүртү ⧸ Хуун-хуур-ту @ СоТворение [Казань, Центр семьи ＂Казан＂, 09.09.2023] [3b-Gui1AUx4].mkv` | 2332 | mkv | vp9 | opus | 3840x2160 | 30m36s | 5286.7 MB | 695 | mkv | vp9 | opus | 3840x2160 | 23025 kbps | profile 0/60p |
| 60fps-h264-mkv | `1292023 Alash Caffe Lena TV.mkv` | 17 | mkv | h264 | aac | 960x540 | 123m53s | 1381.4 MB | 699 | mkv | h264 | aac | 960x540 | 1487 kbps | high/60p |
| av1-webm | `archive/Khöömei Batch 6/Ынак мен (Алдын-Херел) - cover by Дая Хертек [YNKUT5OvYO8].webm` | 654 | webm | av1 | opus | 1080x1920 | 1m13s | 10.5 MB | 703 | mkv | av1 | opus | 1080x1920 | 1140 kbps | main/NTSC |
| av1-webm | `archive/Khöömei Batch 6/Om Mani Padme Hum ｜ Denis Kucherov ｜ Radik Tyulyush ｜ Pravin ｜ Phill [urY6jXi7HDg].webm` | 679 | webm | av1 | opus | 3840x2160 | 6m34s | 404.5 MB | 701 | mkv | av1 | opus | 3840x2160 | 8193 kbps | main/PAL |
| av1-webm | `archive/Khöömei Batch 6/Mongolian Winter ｜ Өвөл [IlwZZZMdY84].webm` | 684 | webm | av1 | opus | 1920x1080 | 4m01s | 73.2 MB | 700 | mkv | av1 | opus | 1920x1080 | 2429 kbps | main/NTSC |
| av1-webm | `archive/Khöömei Batch 6/Чаңгыс чуртаар назынында [CpMFsAqh27M].webm` | 711 | webm | av1 | opus | 1080x1920 | 3m02s | 24.3 MB | 702 | mkv | av1 | opus | 1080x1920 | 1065 kbps | main/NTSC |
| fullrange-h264-mkv | `Batch 8/Video by rowan_hartsuiker [instagram-DOvcouZDbQ_].mkv` | 2038 | mkv | h264 | aac | 720x1280 | 7m16s | 49.1 MB | 704 | mkv | h264 | aac | 720x1280 | 900 kbps | high/24p |
| h264-aac-mp4 | `archive/Khöömei Batch 4/Radik Tyulyush - Mazhalykhta (Chalama live performance, 2013) [RovTF7Np2cY].mp4` | 1069 | mp4 | h264 | aac | 1280x720 | 7m16s | 36.7 MB | 706 | mp4 | h264 | aac | 1280x720 | 674 kbps | main/PAL |
| h264-aac-mp4 | `archive/Khöömei Batch 4/The Tuvan Horsemen 3 [LrbRxS52xFk].mp4` | 1095 | mp4 | h264 | aac | 1920x1080 | 4m39s | 79.3 MB | 707 | mp4 | h264 | aac | 1920x1080 | 2268 kbps | high/NTSC |
| h264-aac-mp4 | `archive/Khöömei Batch 4/The Tuvan Internationale - ＂Тыва Интернационал＂ (Alternate Version) [twxnkGJN6g8].mp4` | 1097 | mp4 | h264 | aac | 1920x1080 | 2m14s | 63.2 MB | 708 | mp4 | h264 | aac | 1920x1080 | 3769 kbps | high/60p |
| h264-aac-mp4 | `archive/Khöömei Batch 4/Aazashkyn. Alexandr SARJAT-OOL. [SA9e6sBi8r0].mp4` | 862 | mp4 | h264 | aac | 1920x1080 | 4m05s | 103.2 MB | 705 | mp4 | h264 | aac | 1920x1080 | 3360 kbps | high/PAL |
| h264-opus-mkv | `archive/Khöömei Batch 3/Хакасия. Тувинское горловое пение. Группа Алаш. Каргыраа, сыгыт, хоомей, гитара Tuvan throat singing [6JdFIZrIg3U].mkv` | 132 | mkv | h264 | opus | 1920x1080 | 5m49s | 132.8 MB | 710 | mkv | h264 | opus | 1920x1080 | 3043 kbps | high/ |
| h264-opus-mkv | `archive/Khöömei Batch 6/Радик Тюлюш - концерт тувинского горлового пения в Таллинне, 30.03.2016 [ZxsqJYxVLF4].mkv` | 649 | mkv | h264 | opus | 1920x1080 | 125m21s | 2373.7 MB | 709 | mkv | h264 | opus | 1920x1080 | 2525 kbps | high/NTSC |
| hdr10bit-mkv | `archive/Khöömei Batch 7/Ирик чудук - Фольклорный ансамбль ＂Улар＂ [gqBUbDnvlx4].mkv` | 1418 | mkv | vp9 | opus | 1920x1080 | 6m04s | 193.0 MB | 711 | mkv | vp9 | opus | 1920x1080 | 4238 kbps | profile 2/NTSC |
| hdr10bit-mp4 | `archive/Khöömei Batch 4/Tes gol ｜ Тэс гол [h7e7HrHwFsA].mp4` | 1083 | mp4 | vp9 | aac | 1920x1080 | 4m00s | 124.1 MB | 712 | mp4 | vp9 | aac | 1920x1080 | 4125 kbps | profile 2/NTSC |
| hdr10bit-webm | `archive/Khöömei Batch 2/Mongolian folk song Gooch Nanaa , in Lyon , France [vqem4ORd9ck].webm` | 361 | webm | vp9 | opus | 1920x1080 | 4m57s | 156.5 MB | 713 | mkv | vp9 | opus | 1920x1080 | 4213 kbps | profile 2/NTSC |
| long-concert | `archive/Khöömei Batch 7/Отчетный концерт ККИ 2023 год [rpElJp3yxIs].mkv` | 1544 | mkv | h264 | opus | 1920x1080 | 136m39s | 3127.1 MB | 716 | mkv | h264 | opus | 1920x1080 | 3051 kbps | high/24p |
| long-concert | `archive/Khöömei Batch 7/Ансамбль женского горлового пения ＂ТЫВА КЫЗЫ＂ ｜ Ensemble of Female Throat Singing ＂TYVA KYZY＂ [Tt0FZNsPCR8].mkv` | 1850 | mkv | h264 | opus | 1920x1080 | 133m58s | 2911.5 MB | 714 | mkv | h264 | opus | 1920x1080 | 2898 kbps | high/60p |
| long-concert | `archive/Khöömei Batch 7/День хоомея 2025 [1NdD3WQY7T8].mkv` | 1897 | mkv | h264 | opus | 1280x720 | 126m49s | 1057.0 MB | 715 | mkv | h264 | opus | 1280x720 | 1111 kbps | high/NTSC |
| oddres-h264-mp4 | `Alash Chedi-Tei.mp4` | 43 | mp4 | h264 | aac | 1166x720 | 3m32s | 18.1 MB | 717 | mp4 | h264 | aac | 1166x720 | 682 kbps | high/NTSC |
| partial | `archive/Khöömei Batch 7/Uskash keliyyin (#1) [afXpcD5OU80].f251.webm` | - | (not a Copy) | | | | | 1.0 MB | 721 | mkv | ? | opus | ?x? | ? kbps | / |
| partial | `archive/Khöömei Batch 6/Домашний концерт тувинских горловиков. Часть 1 [5yAphfd7X14].f136.mp4.part` | - | (not a Copy) | | | | | 65.0 MB | - | NOT INDEXED | | | | | |
| partial | `archive/Khöömei Batch 6/Lowell Festival Tuvan throat singers [fNbyuMPu9Fc].f140.m4a` | - | (not a Copy) | | | | | 2.4 MB | - | NOT INDEXED | | | | | |
| partial | `archive/Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].f303.webm` | - | (not a Copy) | | | | | 37.9 MB | 719 | mkv | vp9 | ? | 1920x1080 | ? kbps | profile 0/60p |
| partial | `archive/Khöömei/Nachyn Choreve @ Cryptatropa [GO2k9xpeWa0].f303.webm` | - | (not a Copy) | | | | | 455.2 MB | 720 | mkv | vp9 | ? | 1920x1080 | ? kbps | profile 0/60p |
| partial | `archive/Khöömei Batch 2/04 Тувинская фольклорная группа 'Алаш' в Абакане. Горловое пение. Throat singing. Песня 'Арачол'. [BiGK2ZXaJNs].f303.webm` | - | (not a Copy) | | | | | 134.8 MB | 718 | mkv | vp9 | ? | 1920x1080 | ? kbps | profile 0/ |
| vfr-vp9-mkv | `Nachyn Choreve Full.mkv` | 40 | mkv | vp9 | opus | 1920x1080 | 55m44s | 542.0 MB | 722 | mkv | vp9 | opus | 1920x1080 | 1297 kbps | profile 0/60p |
| vp9-eac3-mkv | `archive/Khöömei Batch 2/18 Тувинское горловое пение. Группа Алаш. Тувинский релакс. Relax. Tuvan throat singing. Alash. [5Om2KFo18EU].mkv` | 365 | mkv | vp9 | eac3 | 1920x1080 | 11m14s | 215.8 MB | 723 | mkv | vp9 | eac3 | 1920x1080 | 2560 kbps | profile 0/PAL |
| vp9-mkv | `archive/Khöömei Batch 7/Odugen-Taiga, Huun Huur Tu song feat. Marynka Nicolai-Krylova [l9Wb7QIghOM].mkv` | 1533 | mkv | vp9 | opus | 640x356 | 13m36s | 24.2 MB | 725 | mkv | vp9 | opus | 640x356 | 237 kbps | profile 0/PAL |
| vp9-mkv | `archive/Khöömei Batch 7/Kolhozchu Men [J_B15wNe8Do].mkv` | 1888 | mkv | vp9 | opus | 1080x1080 | 3m59s | 8.9 MB | 724 | mkv | vp9 | opus | 1080x1080 | 298 kbps | profile 0/PAL |
| vp9-mkv | `archive/Khöömei Batch 2/Горловое пение  тувинская группа  Алаш    2 часть [BsKeJrUzjhA].mkv` | 312 | mkv | vp9 | aac | 480x360 | 39m18s | 69.6 MB | 726 | mkv | vp9 | aac | 480x360 | 236 kbps | profile 0/PAL |
| vp9-mp4 | `Alash w: Radik 2.mp4` | 15 | mp4 | vp9 | aac | 480x360 | 39m18s | 56.4 MB | 728 | mp4 | vp9 | aac | 480x360 | 191 kbps | profile 0/PAL |
| vp9-mp4 | `archive/Khöömei Batch 4/＂Бай-Терек＂ в Палате ремёсел [1oqNJN9K2uI].mp4` | 849 | mp4 | vp9 | aac | 1920x1080 | 36m16s | 927.2 MB | 729 | mp4 | vp9 | aac | 1920x1080 | 3408 kbps | profile 0/ |
| vp9-mp4 | `archive/Khöömei Batch 4/＂Моя Тыва＂ тоджу [9ZLrawciLfI].mp4` | 851 | mp4 | vp9 | aac | 720x1280 | 2m12s | 28.5 MB | 730 | mp4 | vp9 | aac | 720x1280 | 1719 kbps | profile 0/NTSC |
| vp9-mp4 | `archive/Khöömei Batch 4/360 Video -  Alash Ensemble - Cal Arts - September 19, 2015 #2 [a9VVAmaoSwk].mp4` | 854 | mp4 | vp9 | aac | 1920x960 | 4m56s | 59.3 MB | 727 | mp4 | vp9 | aac | 1920x960 | 1602 kbps | profile 0/ |
| webm-opus | `archive/Khöömei Batch 5/THE WIGGLE ROOM MONGOLIAN&TUVAN THROAT SINGING ROBERT MCLAUCHLINANAND AVIRMED-ALTANGEREL [n2L5qOltRb0].webm` | 1315 | webm | vp9 | opus | 3840x2160 | 68m47s | 4718.1 MB | 732 | mkv | vp9 | opus | 3840x2160 | 9144 kbps | profile 0/24p |
| webm-opus | `archive/Khöömei Batch 3/ХООМЕЙ В ЦЕНТРЕ АЗИИ [pU7MnFGQrqA].webm` | 150 | webm | vp9 | opus | 1920x1080 | 155m38s | 3459.0 MB | 733 | mkv | vp9 | opus | 1920x1080 | 2963 kbps | profile 0/60p |
| webm-opus | `archive/Khöömei Batch 6/Huun Huur Tu - Saryglarlar ｜ Live acoustic concert in the Abbey Of Romainmôtier [8Tmvs41w29o].webm` | 683 | webm | vp9 | opus | 3840x2160 | 6m32s | 634.8 MB | 731 | mkv | vp9 | opus | 3840x2160 | 12930 kbps | profile 0/PAL |
