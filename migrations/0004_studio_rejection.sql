-- 0004: tombstones for rejected Studio matches (ticket #27). Without them the matcher would suggest a rejected pair again
-- after the next import. Keyed by the pair, so a different candidate for the same Mirror Track can still be suggested.
-- Mirror Track uuid by value, no foreign key (ADR-0001).
CREATE TABLE studio_rejection (
  mirror_track_id TEXT NOT NULL,
  persistent_id TEXT NOT NULL,
  PRIMARY KEY (mirror_track_id, persistent_id)
);
