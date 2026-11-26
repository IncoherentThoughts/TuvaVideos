-- 0025: approved_tv becomes approved_device (docs/home-server-spec.md §3). The click-to-approve IP allowlist now also
-- holds Macs (kind) and says how a device came in (via: 'click' on an Allow prompt, 'tailscale' on sight, #239).
-- Every row that exists is a TV approved by a click.
CREATE TABLE approved_device (
  ip TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'tv' CHECK (kind IN ('tv', 'mac')),
  name TEXT,
  model TEXT,
  via TEXT NOT NULL DEFAULT 'click' CHECK (via IN ('tailscale', 'click')),
  tailscale_login TEXT,
  approved_at TEXT NOT NULL,
  last_seen_at TEXT
);
INSERT INTO approved_device (ip, kind, model, via, approved_at, last_seen_at)
  SELECT ip, 'tv', model, 'click', approved_at, last_seen_at FROM approved_tv;
DROP TABLE approved_tv;
