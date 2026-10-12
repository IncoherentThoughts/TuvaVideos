-- 0009: View count. How many times a Video was watched here (the Player counts one view the first time playback
-- starts on a Now playing visit). Not shown in the grids; the State panel reports it, the grids and search results
-- can sort by it, and a right-click on a Video in any list resets it.
ALTER TABLE video ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0;
