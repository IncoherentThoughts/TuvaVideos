# Signing in to the app with a Tuvan Lyrics Archive account

Research for issue #84 (map #82). The question: how a **Member** signs in from this app, a Preact SPA (`src/web`) served by the Bun server (`src/server`) at `http://localhost:4400`, run from source on each collaborator's Mac. Terms (Member, Video Editor, Standalone, Shared) are from `CONTEXT.md` § Sharing.

Read-only sources, as of 2026-10-16:

- **The archive:** `/Users/evanwilliams/Desktop/Lyrics Website`. Files: `src/contexts/AuthContext.tsx`, `src/lib/supabase.ts`, `supabase/config.toml`, `supabase/functions/create-user/index.ts`, `src/pages/auth/ForgotPasswordPage.tsx`.
- **auth-js 2.112.3:** the archive's installed copy, `node_modules/@supabase/auth-js/dist/module/GoTrueClient.js` and `lib/constants.js`. Line numbers below refer to that build.
- **Supabase docs:** [Sessions](https://supabase.com/docs/guides/auth/sessions), [Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls), [PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow), [API keys](https://supabase.com/docs/guides/api/api-keys), [JWTs](https://supabase.com/docs/guides/auth/jwts).
- **The live project** (`ejabfdkhdmcfpvpwcuau`): its public endpoints only, `GET /auth/v1/settings` and `GET /auth/v1/.well-known/jwks.json`, plus a CORS preflight. Nothing was written.
- **This repo:** `src/server/app.ts`, `src/server/launch.ts`, `src/server/config.ts`, `src/server/web.ts`, `package.json`.

## TL;DR

- **Sign in with email and password, in the browser, using `supabase-js`.** That is the only way archive accounts are issued: an admin creates them with a temporary password through `create-user`. Live settings show sign-up disabled and email as the only provider. A password sign-in has **no redirect**, so the choice between PKCE and implicit flow does not arise, and the Supabase project needs **no new Redirect URL**.
- **Leave the session to `supabase-js` in `localStorage`** under the `http://localhost:4400` origin. It survives restarts of the app, the Bun server and the Mac. The Bun server never holds the refresh token.
- **Offline is the trap.** If the stored access token has expired and the network is down, `getSession()` and `INITIAL_SESSION` report **no session**, although the session is still on disk. The app has to keep its own last-known Member record (user id, email, Video Editor flag) to open in Member-offline mode rather than Standalone.
- **A week with the laptop closed is fine.** Refresh tokens never expire on their own. The first online load swaps the stored refresh token for a new pair. A session ends only by revocation, reuse detection, or (Pro plan) a time-box or inactivity limit. When it ends, supabase-js clears it and fires `SIGNED_OUT`. The app must treat that as "sign in again", **not** as the user choosing to sign out.
- **The anon key gives nothing away.** It already ships in the archive's public website bundle, and Supabase classes it as safe to expose. RLS is the only real control. Note that **this repo is public on GitHub**, not private as the map says.
- **The Bun server does need to know the mode.** Scans, the cache and the Player depend on it. The browser posts the access token to the server, and the server verifies it **locally** against the project's ES256 JWKS. It stores only the verified identity, never tokens.
- **From the archive, carry over** `authSettled` gating, the synchronous `onAuthStateChange` callback, the revocation probe, `scope: 'local'` sign-out and a `queryWithRetry` equivalent. **Leave behind** the 60-minute idle and away sign-outs, the no-op `lock` override (unnecessary now), Standard view and the profile column dance.

## 1. How a Member signs in

**How accounts are made.** `supabase/functions/create-user/index.ts:462-469` calls `auth.admin.createUser({ email_confirm: true, … must_change_password: true })`. It then emails a temporary password and a link to `songsofthesteppe.org/login` (line 493). The archive's own sign-in is `supabase.auth.signInWithPassword({ email, password })` (`AuthContext.tsx:435-439`).

**What the live project allows.** `GET /auth/v1/settings` returns `disable_signup: true` and `external: { email: true }`. Every other provider is off, and passkeys are off. So a Member's only credential is an email and password, and no one can create an account from this app.

**What follows for this app:**

1. **The sign-in form posts straight to Auth.** A small email-and-password form calls `signInWithPassword`, which POSTs to `/auth/v1/token?grant_type=password`. The preflight from `Origin: http://localhost:4400` returns `access-control-allow-origin: *`. The localhost origin needs no CORS or project configuration.
2. **A first-time password change happens on the archive.** A brand-new account has `profiles.must_change_password = true`. The simplest rule is to tell a new Member to sign in once on songsofthesteppe.org first, where the archive's change-password flow already exists. The app checks the flag after sign-in and links there if it is still set. Rebuilding the flow here would mean `updateUser({ password })` plus clearing the flag, and that duplicates archive UI.
3. **"Forgot password" is a link to the archive's `/forgot-password` page.** The reset email then redirects to the archive's own allowed URL, as it does today (`ForgotPasswordPage.tsx:51-63`).

**PKCE or implicit.** supabase-js defaults to `flowType: 'implicit'` (`GoTrueClient.js:21`). The archive uses that default: its reset page waits for `PASSWORD_RECOVERY` "when Supabase processes the hash tokens". The flow only matters when Auth **redirects** back to the app. The redirect-URL docs list three such cases: OTP or magic link, OAuth, and Web3. A password sign-in is none of them.

**If a redirect flow is ever added**, for example an in-app magic link or reset:

- **Use `flowType: 'pkce'`.** Tokens then never land in a URL fragment. The code is single-use and valid for 5 minutes.
- **Add the app's origin to the live project's Redirect URLs** in the Dashboard. `supabase/config.toml`'s `site_url` and `additional_redirect_urls` only configure the local CLI stack. Add `http://localhost:4400/**`, and also `http://127.0.0.1:4400/**` if the app is ever opened that way. Glob rules from the docs: `*` stops at `/` and `.`, while `**` matches anything.
- **Expect a desktop-specific failure.** The PKCE verifier lives in the storage of the browser that started the flow, and "the code exchange must be initiated on the same browser and device". A reset email clicked in Mail opens the **default** browser, which may not be the one running the app. A 6-digit email OTP entered in the form (`verifyOtp`) avoids redirects completely. The project already has `otp_length = 6` locally.

## 2. Where the session persists

**Where supabase-js keeps it.** In a browser, supabase-js stores the session in `localStorage` (`persistSession: true` and `autoRefreshToken: true` are the defaults, `GoTrueClient.js:16-21`). The key is `sb-ejabfdkhdmcfpvpwcuau-auth-token` (`supabase-js/dist/index.mjs:635`). It sits on disk in the browser profile and survives quitting the browser, restarting the Bun server and rebooting.

**What that ties the session to:**

- **One origin.** `localStorage` is per origin, so `http://localhost:4400` and `http://127.0.0.1:4400` are two separate stores. The server binds `127.0.0.1` (`app.ts:55`) but the launcher opens `http://localhost:${port}` (`launch.ts:17`). Keep it that way so there is one canonical origin. A second server on another `TUVA_PORT` (a test preview) gets its own session store. That is harmless, and arguably correct.
- **One browser profile.** A Member who switches from Chrome to Safari signs in again.

**Why not have the Bun server hold the session in a file?** It is possible: supabase-js accepts a custom `storage` adapter, and the docs mention one for the PKCE verifier. It would let the browser, the TV and the CLI scripts share one session. It loses on two counts:

1. **Two refreshers can kill the session.** Refresh tokens rotate and are single-use. Reusing one outside the 10-second window "terminates the entire session" (Sessions docs). If the server and the browser both refreshed the same session, one stale refresh would sign the Member out everywhere. A single owner is required. The browser is the natural owner because the sign-in form lives there.
2. **The server would become a credential store.** It would hold a bearer credential that never expires, behind an HTTP API that today has no Origin or Host check (`src/server/api.ts`). Any web page can send simple requests to `127.0.0.1:4400`, and DNS rebinding can read responses. Browser `localStorage` is also plaintext on disk, but no other origin can reach it.

**The offline gap.** This is the part the archive never had to solve. auth-js treats an access token as expired 90 s before its `exp` (`EXPIRY_MARGIN_MS`, `constants.js:3-10`). In that window `__loadSession` tries a refresh (`GoTrueClient.js:2551`). When the refresh fails with a network error and the access token is already past expiry:

- **The session stays on disk.** `_callRefreshToken` removes the session only on a non-retryable error (`GoTrueClient.js:4262-4281`).
- **The caller still gets `session: null`.** That is lines 2562-2571, and `_emitInitialSession` passes the same `null` to `INITIAL_SESSION` (`GoTrueClient.js:3640-3652`).

So a Member who opens the app on a plane looks signed out to supabase-js, until the network returns and the refresh succeeds. The live access token is short: `AuthContext.tsx:245` notes "this project's 300s JWT". This case is therefore the normal one, not an edge case.

**What the app needs to cover the gap.** The app records, on each successful sign-in and identity check, a **last-known Member record**: user id, email, Video Editor flag and the time it was last verified. It is not a token.

- **Where it lives.** The Bun server keeps it next to the Shared cache (SQLite), because the Player and the scanner need the mode as well (§5).
- **The startup rule.** With a stored session on disk and a Member record, the app opens as a **Member, offline**: browsing from the cache, edit controls disabled with a notice, as the map decided. It switches to online once `TOKEN_REFRESHED` or `SIGNED_IN` arrives. A cheap check for the stored session is `localStorage.getItem('sb-…-auth-token') !== null`.

## 3. Refresh after a week with the lid closed

**What the docs say.** Refresh tokens "never expire but can only be used once". The default access-token lifetime is 1 hour, and the docs advise "not … below 5 minutes". The project runs at the 5-minute floor, per the archive comment above.

**On the first online load after a week:**

1. `_recoverAndRefresh` reads the stored session. It finds the access token expired and calls `_callRefreshToken` with the stored refresh token (`GoTrueClient.js:4098-4103`).
2. Auth returns a new access and refresh pair. supabase-js saves it and emits `TOKEN_REFRESHED`. The archive's `INITIAL_SESSION`-then-`TOKEN_REFRESHED` gating (`AuthContext.tsx:218-235`) exists for exactly this. The app needs the same gating, so its first Supabase read is not sent with the dead token.
3. Offline at that moment, see §2. The session is kept, and the auto-refresh ticker (every 30 s while visible) retries once the network is back. A cooldown of 60 s stops it retrying the same failing token in a tight loop (`REFRESH_FAILURE_COOLDOWN_MS`).

**When the refresh token really is dead:**

- **The session was revoked.** Causes: "sign out everywhere" from the archive's Account actions, an admin removing the session or user, or a `scope: 'global'` sign-out on another device.
- **Reuse was detected.** See §2, item 1.
- **A time-box or inactivity timeout was set.** These are a Pro-plan feature, and they apply "the next time a session is refreshed". The local `config.toml` leaves `[auth.sessions]` commented out. The live setting cannot be read from public endpoints, so it is unknown. A week-long inactivity timeout set later would produce exactly the "closed for a week" sign-out.

**What happens then.** Auth answers with a non-retryable error such as `refresh_token_not_found`, `refresh_token_already_used` or `session_expired`. supabase-js runs `_removeSession()`, which clears `localStorage` and emits `SIGNED_OUT` (`GoTrueClient.js:4278-4281`).

**What the app should do then:**

- **Show "Your session ended; sign in again"** with the form, and keep the Shared cache and the Member record. What a deliberate sign-out does to the cache is the map's open "Moving between modes" question.
- **Keep the two kinds of sign-out apart.** A `SIGNED_OUT` with no preceding user click means "dropped". Only the app's own Sign out button means "left". The archive funnels every sign-out through one `buildUser(null)` (`AuthContext.tsx:146-160`). That is fine for a website, but here the two need different outcomes.

## 4. The anon key in this repository

**What the key is.** It is the legacy anon JWT (it starts `eyJhbGciOiJI…`), read from `VITE_SUPABASE_ANON_KEY` in the archive's `.env`. The API-keys docs call it "safe to expose online" and list desktop apps, CLIs and source code among the places it may appear. It identifies the project, not a user. Requests made with it alone run as the Postgres `anon` role. Once a user is signed in, they run as `authenticated`.

**What it exposes:**

- **Whatever the `anon` role can read and call today.** The archive's public website bundle already ships this same key to every visitor, so committing it here adds **no new exposure**.
- **The project's auth endpoints.** Sign-up is disabled live (`disable_signup: true`), so the key cannot be used to mint new `authenticated` users.
- **Rate-limited sign-in attempts against real accounts.** `sign_in_sign_ups = 30` per 5 min per IP in the local config. Exposing the key changes nothing here either: the archive's login page offers the same.

**What protects the data:**

- **RLS on every table**, as the docs put it. For the map, the Member and Video Editor gates must be **RLS on `auth.uid()`** plus the grant table, never "has the anon key".
- **Even the `authenticated` role means only "any archive account".** It includes the archive's reviewers and standard users. Reads of the Shared data can be `authenticated`. Writes must check the Video Editor grant.
- **Never ship a secret or service-role key** in this repo or the app. The docs say so for desktop and CLI packages explicitly.

**Housekeeping the move will need:**

- **The anon key is being retired.** Supabase "is deprecating `anon` by the end of 2026". The new `sb_publishable_…` key goes in the `apikey` header, and both work side by side until the legacy key is deactivated. The app should read the key from config, not hard-code it, so the swap is one line. The archive will have to make the same swap.
- **The repo is public.** `gh repo view` reports `visibility: PUBLIC`, while map #82 notes "Collaborators run from source with access to this private repo". Committing the URL and anon key is still fine. The visibility matters more for other things, such as Root paths and library contents in fixtures, and the map's note should be corrected.

## 5. Does the Bun server need to know who is signed in?

**Yes, as a mode rather than as a credential.** Under the map's standing decisions, the server:

- **Holds the SQLite cache of the Shared tables** for the Player and search. Whether it shows Shared data at all depends on Standalone versus Member.
- **Runs scans.** A Video Editor's unknown file goes to the Shared data; a non-editor's becomes an **Unshared** Video. That decision needs the Video Editor flag.
- **May fill the cache itself.** If Shared reads are RLS-gated to `authenticated`, any fetch by the server needs a valid access token.

**The proposed handshake.**

1. **The browser posts the token.** After `SIGNED_IN`, `TOKEN_REFRESHED` or `INITIAL_SESSION` with a session, the browser POSTs the **access token**, never the refresh token, to `POST /api/session`.
2. **The server verifies it locally.** The live project signs with an asymmetric key: `GET /auth/v1/.well-known/jwks.json` returns one ES256 P-256 key (`kid a853e8bd-…`). The JWT docs' recommended path is to match `kid` and `alg`, verify the signature against the JWKS, and check `iss`, `exp`, `sub` and `role`. Bun's built-in `crypto.subtle` can import the JWK and verify ES256 without a new dependency, or `jose` does it in one call. Cache the JWKS on disk so verification works offline. Re-fetch it on an unknown `kid`, since the docs warn that long caching hampers key rotation.
3. **The server records the identity.** It stores `sub`, the email and the Video Editor flag in the Member record (§2). It keeps the access token only in memory, for its own cache fetches until `exp`. When the token expires, it asks the browser for a fresh one or waits for the next push. It never refreshes, so there is only one refresher (§2).
4. **The server gets the Video Editor flag from the database.** It reads the grant table with that token, for example `select … where profile_id = auth.uid()`. The flag is not a JWT claim; claims can only be added with a custom access-token hook.

**Why verify on a single-user localhost server?** The API has no Origin check. Without verification, any web page could POST a made-up identity and flip the app into Member or Video Editor mode. RLS still guards the database, so the risk is a wrong mode, not a data leak. A verified JWT costs a few lines of code. Add an `Origin`/`Host` check on `/api/session` at the same time.

**Local check versus `GET /auth/v1/user`.** A local check says the token was valid when issued. It does not say whether the session has since been revoked; only `auth.getUser()` asks the server that (`AuthContext.tsx:362-369`). That gap lasts at most one JWT lifetime, 5 minutes, and RLS sees the same token anyway. Leave revocation to the browser's probe (§6).

## 6. What carries over from the archive's AuthContext

| Archive piece | Carry over? | Why |
|---|---|---|
| `authSettled` plus the `INITIAL_SESSION`-expired → `TOKEN_REFRESHED` wait (`AuthContext.tsx:107-110, 186-235`) | **Yes** | With a 300 s JWT, nearly every launch starts on an expired token. Gate the first Shared read and the `/api/session` push on it. The 2.5 s safety timer also applies: offline, settle into Member-offline from the Member record instead of rendering nothing. |
| Synchronous `onAuthStateChange` callback, with the work deferred via `setTimeout` (`:201-210`) | **Yes** | This is a supabase-js deadlock, independent of the framework. It applies to Preact `useEffect` just as to React. |
| Revocation probe: `getUser()` every 60 s while visible, ignoring `AuthRetryableFetchError` (`:362-424`) | **Yes, at a gentler interval** | It is the only way a revoked session notices before the token expires, and it already never signs anyone out for being offline. Every 5 minutes or on focus is plenty for a few Members. |
| `signOut({ scope: 'local' })` by default (`:441-453`) | **Yes** | Signing out of the video app must not sign the Member out of the archive in other browsers. |
| `queryWithRetry`: one `refreshSession()` and a retry on `PGRST301` or a "JWT" message (`supabase.ts:44-56`) | **Yes, as a backstop** | A laptop waking from sleep can fire a query before the ticker has refreshed, and the 300 s token makes this frequent. Do not retry on an `AuthRetryableFetchError`: offline is handled by the mode, not by retries. |
| 60-minute idle sign-out and 60-minute away sign-out (`:7-8, 276-360`) | **No** | These are shared-computer and website safeguards. Here they would break the main use: a Member leaves the Player running for an evening, or comes back after a week. That is the app's own Mac, a single user, with the session expected to last. If a timeout is ever wanted, the Pro-plan server-side inactivity timeout is the right tool, and it applies to the archive as well. |
| No-op `lock` override (`supabase.ts:24-30`) | **No, it is unnecessary** | In auth-js 2.112.3 the default is already lockless when no `lock` is passed (`GoTrueClient.js:195-201`, "no `navigator.locks` by default"). Tabs coordinate through a `BroadcastChannel` on the storage key (`:253-255`), and a commit guard discards a refresh whose stored token changed underneath it (`:4206-4227`). Pass nothing; the override only made sense against the archive's earlier custom lock. |
| Standard view (`sessionStorage`, ADR-0006) | **No** | It is an archive admin tool. |
| `fetchProfile`'s two column lists and the `locale` sync (`:60-101, 162-167`) | **No** | The app needs only `profiles.role` (or nothing) plus the Video Editor grant row. Select only granted columns. Migration 074 rejects the whole SELECT if one column is ungranted. |
| `sessionVersion` cache bump on identity change (`:237-269`) | **The idea, not the code** | The idea transfers: never let anon-scoped and signed-in reads share a cache entry. Here it means the server's Shared cache is keyed to the Member record. |

## Recommendation

1. **Sign in with a password form** that calls `supabase.auth.signInWithPassword`, using `@supabase/supabase-js` bundled by `Bun.build` into `src/web`. Keep the defaults: `persistSession`, `autoRefreshToken`, `localStorage`, no custom `lock`. Set `detectSessionInUrl: false`, since no redirect flow is used. Leave the project's Redirect URLs unchanged. Send first-time password changes and resets to songsofthesteppe.org.
2. **Make one canonical origin** (`http://localhost:4400`), which the launcher already opens.
3. **The browser owns the session; the server owns the mode.** The browser pushes the access token to `POST /api/session`. The server verifies it against the cached ES256 JWKS, reads the Video Editor grant, and persists a **Member record**: id, email, editor flag, last verified. The server never stores or refreshes a refresh token.
4. **Decide startup mode in this order:**
   - **Member, online:** a stored session refreshes successfully.
   - **Member, offline:** a stored session and a Member record, but no network.
   - **Signed out, cache kept, "sign in again":** a non-retryable refresh failure, ending in `SIGNED_OUT` without a user click.
   - **Standalone:** no stored session and no Member record.
5. **Port from the archive** `authSettled`, the synchronous auth callback, the revocation probe, local-scope sign-out and `queryWithRetry`. Drop the idle and away timeouts and the lock override (the default is now lockless anyway).
6. **Read the key from config, not code.** Committing the URL and anon key is fine, but plan the switch to the `sb_publishable_…` key before the end-of-2026 deprecation. Put every Member and Video Editor rule in RLS on `auth.uid()`. Correct the map's "private repo" note: the repo is public.

## Open items for the spec

- **The live session time-box and inactivity settings.** They cannot be read from public endpoints. Check Dashboard → Auth → Sessions, and the plan tier.
- **Whether Shared reads are `authenticated`-only or also `anon`.** This is the schema ticket's call. If `anon` may read them, the server can fill its cache without the token push, and §5 shrinks to the mode alone.
- **What a deliberate sign-out does to the cache,** versus a dropped session. This is the map's "Moving between modes".
