---
status: accepted
amends: docs/tv-spec.md §3, §11 ("video transcoding of any kind" out of scope)
---

# Live streams may re-encode video, in hardware, on the fly and uncached

The planned Live remux becomes the **Live stream**: one HLS route on a Library Server that either copies the video or re-encodes it with VideoToolbox (the Mac mini is an M6). It re-encodes when the user picks a quality below Original for one play (1080p, 720p or 480p; Original is always the default and the pick is never remembered), and automatically for a Copy that neither it nor its Fallback suits the player's Playback profile. Nothing is cached, seeking restarts the encode at the segment sought, at most two run at once per server (a third gets "server busy"), and a hard stop kills them. This reverses the TV spec's "no video transcoding of any kind", because streaming from the Home Server away from home needs a smaller stream than the original file. Considered and rejected: adaptive bitrate ladders (several encodes per stream), and caching transcodes like Fallbacks (would fill the drive).
