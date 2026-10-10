// Scrub throttle (spec 4.1): while dragging, one seek in flight and the latest pointer target wins when it lands.
// Click-to-seek is unthrottled. Pure: the caller supplies `issue` (set currentTime) and calls `landed` on `seeked`.

export class SeekThrottle {
  private inFlight = false;
  private since = 0;
  private queued: number | null = null;

  /** `staleMs`: a seek that never reports back (same-time seek, torn-down source) stops blocking after this long. */
  constructor(private issue: (t: number) => void, private staleMs = 1500) {}

  request(t: number, throttled: boolean, now = Date.now()) {
    if (!throttled) {
      this.queued = null;
      this.go(t, now);
      return;
    }
    if (this.inFlight && now - this.since < this.staleMs) {
      this.queued = t;
      return;
    }
    this.go(t, now);
  }

  landed(now = Date.now()) {
    this.inFlight = false;
    if (this.queued != null) {
      const t = this.queued;
      this.queued = null;
      this.go(t, now);
    }
  }

  reset() {
    this.inFlight = false;
    this.queued = null;
  }

  get busy() {
    return this.inFlight;
  }
  get pending() {
    return this.queued;
  }

  private go(t: number, now: number) {
    this.inFlight = true;
    this.since = now;
    this.issue(t);
  }
}
