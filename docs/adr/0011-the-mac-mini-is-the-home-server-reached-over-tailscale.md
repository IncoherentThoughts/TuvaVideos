---
status: accepted
amends: ADR 0004
---

# The Mac mini is the Home Server: Macs stream from it, Tailscale devices are approved on sight, and it serves on its own

The TV Server of ADR 0004 becomes the **Library Server**, which any Mac may run. One of them, the Mac mini with the library's drive, is the **Home Server**: the user's other Macs stream the Videos they lack from it, and it keeps their Resume positions and Favorites, which follow the user across machines (the laptop's Favorites replace the mini's on first connect, after a mandatory export to a file). Only the owner ever connects to it from other machines; other Members keep their own libraries and get link data through Sharing. It is reached by its Tailscale name at home and away. A device signed in to the user's own Tailscale account, checked with Tailscale's identity lookup, is an **Approved device** on sight; any other (a TV on the home network) still needs one Allow click, which can come from any already-approved Mac, since nobody sits at the mini. The mini launches at login, serves on launch and keeps itself awake while serving; a TV reaches it without any other Mac running, and picks among Library Servers found at startup (switchable by hand mid-session). This supersedes ADR 0004's "home network only", the browser-tab-only approval prompt and "off at every launch" (now a per-machine setting, off by default). Remote Macs stay watch-only on the server; edits go through Sharing as before.

## Considered Options

- **Mount the drive over SMB on each Mac as an external Root**: no code, but every machine rescans and makes its own Thumbnails, and SMB over Tailscale is slow.
- **Jellyfin or Plex on the mini**: none of the Chapters, Songs, Artists or Audio settings.
- **Public exposure with real logins**: unnecessary for one owner, and a real attack surface.
