// Which listener a request came through (docs/tv-spec.md 3.2): the Library Server marks every request it forwards to the
// shared localhost handler, so a route that depends on the player's Playback profile (`/copy/:id`) can tell the TV from
// the browser. A WeakSet of the Request objects, not a header, so nothing a client sends can claim to be either.

const viaTv = new WeakSet<Request>();

/** Called by the TV listener on a request it is about to hand to the localhost handler. */
export function markTvRequest(req: Request): void {
  viaTv.add(req);
}

/** True for a request that came in through the TV listener. */
export const isTvRequest = (req: Request): boolean => viaTv.has(req);

// home-server-spec §5.4: of those, the ones from an Approved device of `kind = 'mac'`. `/copy/:id` serves them by the
// browser Playback profile (a Mac's browser tab streams through its own companion), not the TV's.
const viaMac = new WeakSet<Request>();

/** Called by the TV listener, with `markTvRequest`, for a request from an Approved Mac. */
export function markMacRequest(req: Request): void {
  viaMac.add(req);
}

/** True for a request the Library Server passed in from an Approved Mac. */
export const isMacRequest = (req: Request): boolean => viaMac.has(req);
