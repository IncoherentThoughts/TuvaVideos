-- 0019: the browser Playback profile's version per Copy (audit PLAY-8). `copy.playback` is the browser's verdict from
-- the ffprobe facts; CONTEXT.md says a Copy is judged again when its profile changes, which the TV profile already
-- does through `tv_profile_version`. NULL means "judged under no known version": the startup pass (browserJudge.ts)
-- re-judges it from the stored facts and stamps the current version.
ALTER TABLE copy ADD COLUMN playback_profile_version INTEGER;
