-- 0008: the A-B loop persists per Video (spec 4.3). A loop left set when the Player closes comes back when the Video
-- reopens, in this or a later session, until the user turns it off. Both columns NULL means no loop; a half-set
-- loop (A only) is never stored.
ALTER TABLE video ADD COLUMN loop_a_s REAL;
ALTER TABLE video ADD COLUMN loop_b_s REAL;
