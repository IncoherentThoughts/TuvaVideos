// Which listener a request came through (docs/tv-spec.md 3.2): the TV Server marks every request it forwards to the
// shared localhost handler, so a route that depends on the player's Playback profile (`/copy/:id`) can tell the TV from
// the browser. A WeakSet of the Request objects, not a header, so nothing a client sends can claim to be either.

const viaTv = new WeakSet<Request>();

/** Called by the TV listener on a request it is about to hand to the localhost handler. */
export function markTvRequest(req: Request): void {
  viaTv.add(req);
}

/** True for a request that came in through the TV listener. */
export const isTvRequest = (req: Request): boolean => viaTv.has(req);
