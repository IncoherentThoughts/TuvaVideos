# Instagram downloads: login and cookies with yt-dlp

Research for #189 (part of #186). Written 2026-11-08 against yt-dlp 2026.10.26 (`yt_dlp/version.py` on master). No sign-in, no browser cookie access, no media downloaded: everything below is from docs, source and issue threads.

## Short answer

- **Public posts and reels can work signed out**, but only for `/p/`, `/reel/`, `/reels/`, `/tv/` URLs and only until Instagram decides to redirect the anonymous request to a login page. The extractor itself names that case a rate limit ([instagram.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py)). Nobody publishes a number, so treat the threshold as unknown and bursty.
- **Stories and highlights always need login.** The user-profile extractor is marked `_WORKING = False` and the tag extractor is unmaintained, so "download everything from an account" is not supported.
- **Best authentication option: cookies, not a password.** `-u/-p` and `--netrc` for Instagram have been reported broken since 2023 (#7328) and the maintainer's advice there is to use cookies.
- **Account-ban risk is real for every logged-in option** and is not reduced by choosing a different cookie method. Use a throwaway account, never the account the user cares about.
- **Data-centre IPs are blocked** regardless of auth ([#9722](https://github.com/yt-dlp/yt-dlp/issues/9722)), which matters if downloads ever run on a server rather than the Mac.

## 1. Signed-out behaviour today

From the extractor source (`InstagramIE`):

1. Loads `https://www.instagram.com/` to get an LSD token.
2. Calls `web/get_ruling_for_content/` as a non-fatal accessibility check; its `title`/`description` text becomes the error if the post is gated.
3. POSTs `https://www.instagram.com/api/graphql` (query `PolarisLoggedOutDesktopWWWPostRootContentQuery`) using curl-cffi impersonation. If impersonation is unavailable this step is skipped (`if self._can_impersonate else None`).
4. Falls back to fetching `/p/{id}` and parsing embedded JSON. If that request is redirected to a login page it raises the rate-limit error below.

Takeaways for TuvaVideos:

- **Install the impersonation extra** (curl-cffi). Without it the primary signed-out path is skipped. Verify that against whatever yt-dlp install the app uses before relying on signed-out downloads.
- Signed-out extraction is brittle: the last two commits to this file (2026-07-03 "Avoid unnecessary API call", 2026-07-21 "Fix logged-in extraction") show it is still being patched, and the doc_id and query name are hard-coded. Keep yt-dlp updatable.
- Reports of "reel needs login" are common in the tracker: #1523, #3785, #9722, #10129, #11166. I did not find a published rate of how often public posts hit the wall. Frequency is unknown from primary sources.

## 2. Failure messages: login wall vs removed post

All strings from `instagram.py` unless noted.

| Situation | What yt-dlp prints | Notes |
|---|---|---|
| Anonymous rate limit / login redirect | `The webpage request was redirected to the login page. You have exceeded the rate-limit for accessing posts anonymously` | Raised via `raise_login_required`, so yt-dlp appends its cookies hint. Retry later or add cookies. |
| Gated by Instagram (age/region/"restricted") | `Restricted Video` (plus API title/description) | Also `raise_login_required`. Login may help. |
| Private account | `This content is only available for registered users who follow this account` | Only raised for ids longer than 28 characters after an empty response. Login helps only if that account follows the target. |
| Stories | `You need to log in to access this content`, `This content is unreachable` | Always login-gated. |
| Empty response | `Instagram sent an empty media response. Check if this post is accessible in your browser without being logged-in.` ... | Ambiguous: could be removed, could be gated. The message tells the user to test in a browser. |
| Removed / unavailable post | No dedicated string. Any non-"Restricted" API `title`/`description` is passed through as-is, otherwise the empty-response message above. | **A removed post is not reliably distinguishable from a login wall by message alone.** |
| Post without video | `There is no video in this post` | Photo-only posts. |
| Old tracker wording | `Requested content is not available, rate-limit reached or login required` | Seen in #9722 (2024) and #11166. This is an older extractor message; the current source has the split messages above. |

Practical rule for the app: treat the two `raise_login_required` messages (those that yt-dlp decorates with the `--cookies` hint) as "login wall, may retry or authenticate", the "empty media response" message as "unknown, check in browser", and everything else as "unavailable".

## 3. Authentication options

### `--cookies-from-browser`

README syntax: `BROWSER[+KEYRING][:PROFILE][::CONTAINER]`. Supported browsers: brave, chrome, chromium, edge, firefox, opera, safari, vivaldi, whale ([README](https://github.com/yt-dlp/yt-dlp#readme)). The extractor looks for the `sessionid` cookie.

macOS specifics, from [cookies.py](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py):

- **Chromium family** (Chrome, Brave, Edge, ...): yt-dlp runs the macOS `security find-generic-password` tool against the "<Browser> Safe Storage" keychain item to decrypt cookies. That is what triggers the macOS keychain permission prompt; the source shows no way around it. Failures surface as `find-generic-password failed` or `cannot decrypt v10 cookies: no key found`.
- **Safari:** supported. Reads `~/Library/Cookies/Cookies.binarycookies`, falling back to `~/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies`. If neither is found: `could not find safari cookies database`. The source has no Full Disk Access handling; a permission failure just becomes `failed to load cookies`. That macOS protects that path is outside the yt-dlp sources I read, so check it by testing, not from this note.
- **Firefox:** supports `::CONTAINER`. The keychain code path I read is Chromium-only; I did not verify Firefox end to end.
- The wiki's advice to avoid `--cookies-from-browser` is written for YouTube's cookie rotation ([Extractors wiki](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)). I found no Instagram-specific cookie guidance in the wiki or README, so whether Instagram rotates cookies the same way is unknown.
- Pros: no manual export, always current. Cons: keychain prompt (Chromium), couples the app to whichever browser holds the session, and it reads every cookie in that profile.

### Exported `cookies.txt` (`--cookies FILE`)

- Must be Netscape format, first line `# HTTP Cookie File` or `# Netscape HTTP Cookie File`; wrong newlines give `HTTP Error 400` ([FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)).
- The FAQ warns a full export covers cookies for **all sites** and the file must be protected. It recommends the "Get cookies.txt LOCALLY" (Chrome) and "cookies.txt" (Firefox) extensions and says the older "Get cookies.txt" extension was reported as malware.
- Pros: no keychain prompt at download time, app never touches the browser profile, easy to store in the existing Library Root config. Cons: goes stale when Instagram rotates or invalidates the session. The extractor handles that case by warning `The provided Instagram account cookies are no longer valid`, clearing the `sessionid` cookies and retrying signed out, which can mask the real problem.
- Mitigation: export from a throwaway account in a dedicated browser profile so the file contains nothing else sensitive.

### Username and password (`-u`, `-p`, `--netrc`)

- Generic yt-dlp options exist, but for Instagram they have been reported broken: [#7328](https://github.com/yt-dlp/yt-dlp/issues/7328) (opened 2023-06-16, `KeyError('config')`), where maintainer bashonly recommended cookies instead and warned Instagram may permanently ban accounts it detects using automated tools. It was closed 2025-02-23 via PR #12410, described as an error-handling improvement; I found no statement that credential login works again. [#17079](https://github.com/yt-dlp/yt-dlp/issues/17079) ("Broken instagram login page", closed 2026-06-28) is labelled `external-issue`; I did not read its body.
- `InstagramBaseIE` in the current source defines `_AUTH_COOKIE_NAME = 'sessionid'` and no `_perform_login`; I grepped for `_perform_login` and `_NETRC_MACHINE` in `instagram.py` and found neither. So the current extractor does not implement password login at all. **Do not build on this.**

### Comparison

| Option | Works today | macOS friction | Ban risk | Staleness |
|---|---|---|---|---|
| Signed out | Yes for public posts/reels, with impersonation | None | None to the user's account | n/a, but rate limit with login redirect |
| `--cookies-from-browser safari` | Yes | Possible file permission failure | Same as any login | Always fresh |
| `--cookies-from-browser chrome` etc. | Yes | Keychain prompt | Same | Always fresh |
| `--cookies cookies.txt` | Yes | None at run time | Same | Goes stale |
| `-u/-p`, `--netrc` | No: no password login in current extractor | n/a | Higher (automated login) | n/a |

## 4. Account-ban risk and terms

Primary evidence on bans:

- bashonly in #7328: Instagram may permanently ban accounts it detects using automated tools.
- [#9722](https://github.com/yt-dlp/yt-dlp/issues/9722): a reporter whose cookie workaround worked on 2024-04-19 said on 2024-05-26 their account was temporarily locked and then blocked after repeated use; maintainer reply was "No idea" and that newer accounts get banned faster. A later commenter (2024-09-05) reported being flagged for automated behaviour. These are anecdotes from two users, not rates.
- In the same thread bashonly attributed the original failure to Instagram blocking data-centre IPs, then suggested browser cookies.
- The wiki's general warning (written for YouTube, [Extractors wiki](https://github.com/yt-dlp/yt-dlp/wiki/Extractors)) is the only official account-risk text: using your account with yt-dlp risks a temporary or permanent ban; limit request rate and volume, or use a throwaway account. I found no Instagram-specific equivalent.
- Mitigations yt-dlp provides: `--sleep-requests`, `--sleep-interval`/`--max-sleep-interval` ([README](https://github.com/yt-dlp/yt-dlp#readme)). Whether they actually lower ban rates for Instagram is not documented.

Terms:

- **Verified:** Meta's [Automated Data Collection Terms](https://www.facebook.com/legal/automated_data_collection_terms) (effective 2024-10-07) bar scrapers, bots, crawlers and spiders against Meta products unless Meta has given prior written approval, and accepting the terms is not that approval. Whether a per-URL personal yt-dlp download counts as "automated data collection" is a legal reading I am not making.
- **Not verified from the source:** Instagram's own [Terms of Use](https://help.instagram.com/581066165581870) render only a "Help Center" shell to my fetcher (client-side rendered), so I could not read the text. A search surfaced a secondary summary that quotes a prohibition on accessing or collecting data by automated means without permission; treat that as a lead only. Someone should read the live page in a browser before the ticket's decision relies on the exact wording (including the suspension/termination clause).

## 5. Implications for the downstream tickets (#191, #194)

- Offer **signed-out first**; on the "login wall" messages, retry later or let the user opt in to cookies.
- If auth is offered, make it **explicit opt-in**, cookies only (browser or file), with a plain warning about ban risk and a recommendation of a throwaway account. Do not offer username/password.
- Keep the failure classification from section 2: three states (login wall, unknown, unavailable), because removed posts and some login walls cannot be told apart by message.
- Safari and Chromium on macOS each have a different failure mode (file permission vs keychain prompt); Firefox has neither.
- Update yt-dlp regularly; the Instagram extractor changed twice in July 2026.

## Open questions

- Actual frequency of anonymous login walls for public reels at TuvaVideos' volume. Needs a measurement with real downloads, which this research did not do.
- Whether Safari cookie reads on current macOS need Full Disk Access for the terminal/app.
- Exact wording of Instagram's Terms of Use on automated access and termination.
- Whether the app's bundled yt-dlp has curl-cffi (impersonation) available.

## Sources

- yt-dlp Instagram extractor: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/instagram.py
- yt-dlp cookies: https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/cookies.py
- yt-dlp common (`_login_hint`): https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/common.py
- yt-dlp README: https://github.com/yt-dlp/yt-dlp#readme
- yt-dlp FAQ: https://github.com/yt-dlp/yt-dlp/wiki/FAQ
- yt-dlp Extractors wiki: https://github.com/yt-dlp/yt-dlp/wiki/Extractors
- Issues: [#7328](https://github.com/yt-dlp/yt-dlp/issues/7328), [#9722](https://github.com/yt-dlp/yt-dlp/issues/9722), [#17079](https://github.com/yt-dlp/yt-dlp/issues/17079)
- Meta Automated Data Collection Terms: https://www.facebook.com/legal/automated_data_collection_terms
