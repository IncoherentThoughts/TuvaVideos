-- copy.keyframes: the Copy's keyframe timestamps as little-endian uint32 milliseconds, sorted (spec 4.1). NULL until
-- indexed (lazily, on first play, or by `bun run index-keyframes`); an empty blob records a file whose index failed.
ALTER TABLE copy ADD COLUMN keyframes BLOB;
