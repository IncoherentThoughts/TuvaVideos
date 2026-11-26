// Slot arbitration for Live streams (docs/home-server-spec.md 7.2): at most two at a time per server, one per device.
// A device asking for the stream it has keeps it; asking for another replaces its own; a device without one gets a
// free slot or is told the server is busy. Pure.

export const MAX_LIVE_STREAMS = 2;

export interface Slot {
  device: string;
  /** Which stream: the Copy and quality. */
  key: string;
}

export type Arbitration = { action: "reuse" } | { action: "replace" } | { action: "start" } | { action: "busy"; holders: Slot[] };

export function arbitrate(slots: readonly Slot[], device: string, key: string, max = MAX_LIVE_STREAMS): Arbitration {
  const own = slots.find((s) => s.device === device);
  if (own) return own.key === key ? { action: "reuse" } : { action: "replace" };
  if (slots.length < max) return { action: "start" };
  return { action: "busy", holders: [...slots] };
}
