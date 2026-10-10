#!/usr/local/bin/node
// Generate the TuvaVideos Thumbnail cache (one poster + one scrub strip per Video).
//
// Usage:  node scripts/generate-thumbnails.mjs [--force] [--root DIR]... [--out DIR]
//                                              [--jobs 4] [--limit N] [--only ID]
//   --force   regenerate Videos whose poster and strip already exist
//   --root    scan DIR instead of the two default Roots (repeatable; first match wins as "local"
//             only if it is under the home directory)
//   --out     cache directory (default ~/Library/Application Support/TuvaVideos/thumbs)
//   --jobs    Videos processed in parallel (default 4)
//   --limit   stop after generating N Videos (testing)    --only  generate only this Video id
//
// Writes <id>.poster.webp, <id>.strip.webp, manifest.json (per-Video records) and run-report.json
// (counts, skipped files with reasons, failures) into the cache directory. Idempotent: a Video
// with a manifest record and both files present is skipped. Media files are only ever read.
// Needs ffmpeg, ffprobe and cwebp in /usr/local/bin; no npm dependencies.
//
// Identity: YouTube id from "[xxxxxxxxxxx]" in the filename (also before .fNNN), else SHA-256 of
// the whole file. Source Copy order: local Root, native-playable, highest resolution, largest size.
// Poster: frame at 10% of duration, 480px wide, WebP q75. Strip: N=min(100,floor(duration)) frames,
// 160px wide, 10 columns, WebP q40. Single-pass `-skip_frame nokey` for H.264 under 30 min,
// otherwise one `-ss` seek per frame. Reads that fail with I/O errors are retried 3 times; persistent
// failures are recorded and never treated as "no video".

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const BIN = '/usr/local/bin';
const FFMPEG = `${BIN}/ffmpeg`, FFPROBE = `${BIN}/ffprobe`, CWEBP = `${BIN}/cwebp`;
const HOME = os.homedir();
const DEFAULT_ROOTS = [
  { kind: 'local', dir: '/Users/evanwilliams/Desktop/Khoomei/Videos' },
  { kind: 'external', dir: '/Volumes/General/хөөмей/Хөөмей' },
];
const POSTER_W = 480, POSTER_Q = 75, POSTER_AT = 0.10;
const STRIP_W = 160, STRIP_Q = 40, STRIP_MAX = 100, STRIP_COLS = 10;
const SINGLE_PASS_MAX_SEC = 30 * 60;
const SEEK_JOBS = 2; // per Video; 4 Videos in parallel => at most 8 ffmpeg at once
const RETRIES = 3;

const VIDEO_EXT = new Set(['mp4', 'mkv', 'webm', 'mov', 'm4v', 'avi', 'ts', 'flv', 'wmv', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'flac', 'opus', 'ogg', 'oga', 'wav', 'wma', 'aif', 'aiff']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'svg']);
const SKIP_DIRS = new Set(['.Spotlight-V100', '.Trashes', '.fseventsd', '.TemporaryItems', '$RECYCLE.BIN', 'System Volume Information']);
const IO_RE = /input\/output error|device not configured|operation timed out|i\/o error|stale file|no such device|broken pipe|connection reset|resource busy/i;
const NATIVE_V = new Set(['h264', 'vp8', 'vp9', 'av1']);
const NATIVE_A = new Set(['aac', 'opus', 'vorbis', 'mp3', 'flac']);

// ---------- args ----------
const argv = process.argv.slice(2);
const opt = { force: false, roots: [], out: path.join(HOME, 'Library/Application Support/TuvaVideos/thumbs'), jobs: 4, limit: Infinity, only: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--force') opt.force = true;
  else if (a === '--root') opt.roots.push(argv[++i]);
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--jobs') opt.jobs = Number(argv[++i]);
  else if (a === '--limit') opt.limit = Number(argv[++i]);
  else if (a === '--only') opt.only = argv[++i];
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
const ROOTS = opt.roots.length
  ? opt.roots.map((dir) => ({ kind: dir.startsWith('/Volumes/') ? 'external' : 'local', dir }))
  : DEFAULT_ROOTS;

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function pool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function run(cmd, args, { timeout = 300000, stdoutMode = 'text' } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: String(e) }); });
    p.on('close', (code, sig) => {
      clearTimeout(t);
      resolve({ code: sig ? -1 : code, out: Buffer.concat(out).toString('utf8'), err: sig ? `killed (${sig}, timeout?) ${err}` : err });
    });
  });
}

// ffmpeg ... -f image2pipe png - | cwebp ... -o outFile
function pipeToWebp(ffArgs, q, outFile, timeout) {
  return new Promise((resolve) => {
    const ff = spawn(FFMPEG, ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    const cw = spawn(CWEBP, ['-quiet', '-q', String(q), '-m', '4', '-o', outFile, '--', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const add = (d) => { if (err.length < 20000) err += d; };
    ff.stderr.on('data', add); cw.stderr.on('data', add);
    ff.stdout.pipe(cw.stdin);
    cw.stdin.on('error', () => {});
    let ffCode = null, cwCode = null;
    const done = () => {
      if (ffCode === null || cwCode === null) return;
      clearTimeout(t);
      resolve({ ok: ffCode === 0 && cwCode === 0, err: `ffmpeg=${ffCode} cwebp=${cwCode} ${err}` });
    };
    const t = setTimeout(() => { ff.kill('SIGKILL'); cw.kill('SIGKILL'); }, timeout);
    ff.on('error', (e) => { err += String(e); });
    ff.on('close', (c, s) => { ffCode = s ? -1 : c; done(); });
    cw.on('close', (c, s) => { cwCode = s ? -1 : c; done(); });
  });
}

async function fileSize(f) { try { const s = await fsp.stat(f); return s.size; } catch { return 0; } }

// After an I/O error, pause every worker until all Roots answer a readdir again (max 20 min).
let waiting = null;
function waitForRoots() {
  if (waiting) return waiting;
  waiting = (async () => {
    const dirs = ROOTS.map((r) => r.dir);
    const ok = async () => { for (const d of dirs) { try { await fsp.readdir(d); } catch { return false; } } return true; };
    if (await ok()) return;
    log('Root unreadable (I/O error); waiting for it to come back...');
    for (let i = 0; i < 120 && !(await ok()); i++) await sleep(10000);
    log('Root readable again (or gave up waiting)');
  })().finally(() => { waiting = null; });
  return waiting;
}

// Retry wrapper: fn() -> {ok, err, value}. Retries RETRIES times; longer pause for I/O errors.
async function withRetry(label, fn) {
  let last;
  for (let a = 1; a <= RETRIES; a++) {
    last = await fn();
    if (last.ok) return last;
    const io = IO_RE.test(last.err || '');
    last.io = io;
    if (io) await waitForRoots();
    if (a < RETRIES) { log(`retry ${a}/${RETRIES - 1} ${label}${io ? ' (I/O error)' : ''}: ${(last.err || '').trim().split('\n').pop().slice(0, 160)}`); await sleep(io ? 5000 * a : 1000); }
  }
  last.io = IO_RE.test(last.err || '');
  return last;
}

// WebP dimensions from the RIFF header (VP8 / VP8L / VP8X).
async function webpSize(file) {
  const fh = await fsp.open(file, 'r');
  const b = Buffer.alloc(40);
  await fh.read(b, 0, 40, 0); await fh.close();
  const fmt = b.toString('ascii', 12, 16);
  if (fmt === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (fmt === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
  if (fmt === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

// ---------- scan ----------
async function readdirRetry(dir) {
  let lastErr;
  for (let a = 1; a <= RETRIES; a++) {
    try { return await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { lastErr = e; log(`readdir ${dir} failed (${e.code}), attempt ${a}`); await waitForRoots(); await sleep(4000 * a); }
  }
  throw lastErr;
}

const scanErrors = [];
async function walk(rootDir, dir, files) {
  let ents;
  try { ents = await readdirRetry(dir); } catch (e) { scanErrors.push({ dir, error: String(e.message || e) }); return; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(rootDir, full, files); }
    else if (e.isFile()) files.push(full);
  }
}

function classify(name) {
  if (name === '.DS_Store') return 'ds-store';
  if (name.startsWith('._')) return 'apple-double';
  if (/\.part(-Frag\d+)?$/i.test(name) || /\.f\d+\.[A-Za-z0-9]+$/.test(name) || /\.ytdl$/i.test(name)) return 'ytdlp-partial';
  const ext = path.extname(name).slice(1).toLowerCase();
  if (IMAGE_EXT.has(ext)) return 'image';
  if (AUDIO_EXT.has(ext)) return 'audio-only';
  if (VIDEO_EXT.has(ext)) return null;
  return 'other-extension';
}

function youtubeId(name) {
  const m = name.match(/\[([A-Za-z0-9_-]{11})\](?:\.f\d+)?(?:\.[A-Za-z0-9]+)*$/);
  return m ? m[1] : null;
}

// ---------- probe ----------
async function probe(file) {
  const r = await withRetry(`probe ${path.basename(file)}`, async () => {
    const res = await run(FFPROBE, ['-v', 'error', '-show_entries',
      'stream=codec_type,codec_name,width,height,duration:stream_disposition=attached_pic:format=duration',
      '-of', 'json', file], { timeout: 120000 });
    if (res.code !== 0) return { ok: false, err: res.err || `ffprobe exit ${res.code}` };
    try { return { ok: true, value: JSON.parse(res.out) }; } catch (e) { return { ok: false, err: `bad ffprobe json: ${e}` }; }
  });
  if (!r.ok) return { error: (r.err || '').trim().slice(0, 300), io: r.io };
  const streams = r.value.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) && n > 0 ? n : null; };
  const duration = num(r.value.format && r.value.format.duration) ?? (v ? num(v.duration) : null);
  return { hasVideo: !!v, vcodec: v ? v.codec_name : null, acodec: a ? a.codec_name : null,
    width: v ? v.width : null, height: v ? v.height : null, duration };
}

async function sha256(file) {
  const r = await withRetry(`sha256 ${path.basename(file)}`, () => new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('error', (e) => resolve({ ok: false, err: String(e.message || e) }));
    s.on('end', () => resolve({ ok: true, value: h.digest('hex') }));
  }));
  return r;
}

// ---------- generation ----------
function ffInput(file, ss) { return ss != null ? ['-ss', ss.toFixed(3), '-i', file] : ['-i', file]; }

async function makePoster(src, dur, tmpOut) {
  const t = dur ? dur * POSTER_AT : 5;
  return withRetry(`poster ${path.basename(src)}`, async () => {
    let last = '';
    for (const ss of [t, 0]) {
      await fsp.rm(tmpOut, { force: true });
      const r = await pipeToWebp(['-v', 'error', '-y', ...ffInput(src, ss), '-an', '-sn', '-dn', '-frames:v', '1',
        '-vf', `scale=${POSTER_W}:-2,setsar=1`, '-f', 'image2pipe', '-c:v', 'png', '-'], POSTER_Q, tmpOut, 120000);
      last = r.err;
      if (r.ok && (await fileSize(tmpOut)) > 0) return { ok: true, at: ss };
      if (IO_RE.test(r.err)) break; // I/O trouble: let the outer retry pause first
    }
    return { ok: false, err: last };
  });
}

async function makeStripSingle(src, dur, n, cols, rows, tmpOut) {
  return withRetry(`strip(single) ${path.basename(src)}`, async () => {
    await fsp.rm(tmpOut, { force: true });
    const r = await pipeToWebp(['-v', 'error', '-y', '-skip_frame', 'nokey', '-i', src, '-an', '-sn', '-dn',
      '-vf', `fps=${n}/${dur},scale=${STRIP_W}:-2,setsar=1,tile=${cols}x${rows}`, '-frames:v', '1',
      '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1', '-'], STRIP_Q, tmpOut, 900000);
    if (r.ok && (await fileSize(tmpOut)) > 0) return { ok: true };
    return { ok: false, err: r.err };
  });
}

async function makeStripSeek(src, dur, n, cols, rows, tmpOut, tmpDir) {
  let filled = 0, ioFail = null;
  const good = new Array(n).fill(false);
  await pool([...Array(n).keys()], SEEK_JOBS, async (i) => {
    if (ioFail) return;
    const t = dur * (i + 0.5) / n;
    const f = path.join(tmpDir, `f${String(i).padStart(4, '0')}.png`);
    const r = await withRetry(`frame ${i} ${path.basename(src)}`, async () => {
      for (const ss of [t, t * 0.9, Math.max(0, t - 5)]) {
        await fsp.rm(f, { force: true });
        const res = await run(FFMPEG, ['-v', 'error', '-y', ...ffInput(src, ss), '-an', '-sn', '-dn', '-frames:v', '1',
          '-vf', `scale=${STRIP_W}:-2,setsar=1`, '-c:v', 'png', '-compression_level', '1', f], { timeout: 120000 });
        if (res.code === 0 && (await fileSize(f)) > 0) return { ok: true };
        if (IO_RE.test(res.err)) return { ok: false, err: res.err };
      }
      return { ok: false, err: 'no frame produced' };
    });
    if (r.ok) good[i] = true;
    else if (r.io) ioFail = r.err;
  });
  if (ioFail) return { ok: false, err: `I/O error during seek frames: ${ioFail}`.slice(0, 400), io: true };
  const nGood = good.filter(Boolean).length;
  if (nGood < n * 0.5) return { ok: false, err: `only ${nGood}/${n} frames could be extracted` };
  // Fill missing frames with the nearest earlier good frame (or the first good one).
  const firstGood = good.indexOf(true);
  let prev = firstGood;
  for (let i = 0; i < n; i++) {
    const f = path.join(tmpDir, `f${String(i).padStart(4, '0')}.png`);
    if (good[i]) { prev = i; continue; }
    await fsp.copyFile(path.join(tmpDir, `f${String(prev < 0 ? firstGood : prev).padStart(4, '0')}.png`), f);
    filled++;
  }
  const r = await pipeToWebp(['-v', 'error', '-y', '-framerate', '1', '-i', path.join(tmpDir, 'f%04d.png'),
    '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-compression_level', '1', '-'],
    STRIP_Q, tmpOut, 300000);
  if (r.ok && (await fileSize(tmpOut)) > 0) return { ok: true, filled };
  return { ok: false, err: r.err };
}

// ---------- main ----------
const T0 = Date.now();
await fsp.mkdir(opt.out, { recursive: true });
const TMP = path.join(opt.out, '.tmp');
await fsp.rm(TMP, { recursive: true, force: true });
await fsp.mkdir(TMP, { recursive: true });

const manifestPath = path.join(opt.out, 'manifest.json');
const hashCachePath = path.join(opt.out, 'hash-cache.json');
const manifest = new Map();
try { for (const v of JSON.parse(await fsp.readFile(manifestPath, 'utf8')).videos) manifest.set(v.id, v); } catch {}
let hashCache = {};
try { hashCache = JSON.parse(await fsp.readFile(hashCachePath, 'utf8')); } catch {}

async function saveManifest() {
  const videos = [...manifest.values()].sort((a, b) => a.id.localeCompare(b.id));
  const tmp = `${manifestPath}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ version: 1, settings: {
    posterWidth: POSTER_W, posterQuality: POSTER_Q, posterAt: POSTER_AT, stripFrameWidth: STRIP_W, stripQuality: STRIP_Q,
    stripMaxFrames: STRIP_MAX, stripColumns: STRIP_COLS }, videos }, null, 1));
  await fsp.rename(tmp, manifestPath);
}

const skipped = []; // {path, root, reason}
const failures = []; // {id, path, stage, error, io}
const candidates = []; // video-extension files
const rootStatus = [];

for (const root of ROOTS) {
  const files = [];
  log(`scanning ${root.kind} root ${root.dir}`);
  try { await fsp.access(root.dir); } catch (e) { rootStatus.push({ ...root, scanned: false, error: String(e.message) }); scanErrors.push({ dir: root.dir, error: `root unreadable: ${e.message}` }); log(`ROOT UNAVAILABLE ${root.dir}`); continue; }
  await walk(root.dir, root.dir, files);
  if (!files.length) { // a flaky mount can list as empty; never treat that as "no videos"
    scanErrors.push({ dir: root.dir, error: 'Root listed no files at all (unmounted or I/O trouble); not treated as empty' });
    rootStatus.push({ ...root, scanned: false, error: 'empty listing' }); log(`ROOT UNAVAILABLE (empty listing) ${root.dir}`); continue;
  }
  let n = 0;
  for (const full of files) {
    const rel = path.relative(root.dir, full);
    const reason = classify(path.basename(full));
    if (reason) { skipped.push({ root: root.kind, path: rel, reason }); continue; }
    candidates.push({ root: root.kind, rootDir: root.dir, rel, abs: full }); n++;
  }
  rootStatus.push({ ...root, scanned: true, files: files.length, candidates: n });
}
log(`candidates: ${candidates.length}, skipped by name: ${skipped.length}, scan errors: ${scanErrors.length}`);

// Group by YouTube id where the filename has one; others need a hash.
const groups = new Map(); // key id -> {id, kind, copies[]}
const needHash = [];
for (const c of candidates) {
  const yt = youtubeId(path.basename(c.rel));
  if (yt) { c.id = yt; c.idKind = 'youtube'; } else needHash.push(c);
}
const statKey = (c, st) => `${c.abs}|${st.size}|${Math.round(st.mtimeMs)}`;
let hashed = 0;
await pool(needHash, 2, async (c) => {
  let st;
  try { st = await fsp.stat(c.abs); } catch (e) { failures.push({ id: null, path: c.abs, stage: 'stat', error: String(e.message), io: IO_RE.test(String(e)) }); return; }
  c.size = st.size;
  const key = statKey(c, st);
  if (hashCache[key]) { c.id = hashCache[key]; c.idKind = 'sha256'; return; }
  const r = await sha256(c.abs);
  if (!r.ok) { failures.push({ id: null, path: c.abs, stage: 'sha256', error: (r.err || '').slice(0, 300), io: !!r.io }); return; }
  hashCache[key] = r.value; c.id = r.value; c.idKind = 'sha256';
  if (++hashed % 5 === 0) await fsp.writeFile(hashCachePath, JSON.stringify(hashCache));
});
if (hashed) await fsp.writeFile(hashCachePath, JSON.stringify(hashCache));
log(`hashed ${hashed} files (${needHash.length} without YouTube id)`);

const isDone = async (id) => {
  if (opt.force) return false;
  const m = manifest.get(id);
  if (!m) return false;
  if ((await fileSize(path.join(opt.out, `${id}.poster.webp`))) === 0) return false;
  if (m.strip && (await fileSize(path.join(opt.out, `${id}.strip.webp`))) === 0) return false;
  return true;
};

for (const c of candidates) {
  if (!c.id) continue;
  if (!groups.has(c.id)) groups.set(c.id, { id: c.id, idKind: c.idKind, copies: [] });
  groups.get(c.id).copies.push(c);
}

// Probe copies of Videos that still need work.
const todo = [], doneIds = new Set();
for (const g of groups.values()) {
  if (opt.only && g.id !== opt.only) continue;
  if (await isDone(g.id)) doneIds.add(g.id); else todo.push(g);
}
const toProbe = todo.flatMap((g) => g.copies);
log(`Videos in scan: ${groups.size}; already cached: ${doneIds.size}; to generate: ${todo.length}; files to probe: ${toProbe.length}`);
let probed = 0;
await pool(toProbe, opt.jobs, async (c) => {
  const p = await probe(c.abs);
  Object.assign(c, { probe: p });
  if (++probed % 100 === 0) log(`probed ${probed}/${toProbe.length}`);
});

// Decide, per Video, which Copies are usable and which is the source.
const jobs = [];
const noSource = new Set();
for (const g of todo) {
  const usable = [];
  for (const c of g.copies) {
    const p = c.probe;
    if (p.error) { failures.push({ id: g.id, path: c.abs, stage: 'probe', error: p.error, io: !!p.io }); continue; }
    if (!p.hasVideo) { skipped.push({ root: c.root, path: c.rel, reason: 'audio-only' }); continue; }
    c.native = NATIVE_V.has(p.vcodec) && (!p.acodec || NATIVE_A.has(p.acodec)) && p.duration != null;
    c.pixels = (p.width || 0) * (p.height || 0);
    if (c.size == null) { try { c.size = (await fsp.stat(c.abs)).size; } catch { c.size = 0; } }
    usable.push(c);
  }
  if (!usable.length) { noSource.add(g.id); continue; }
  usable.sort((a, b) => (b.root === 'local') - (a.root === 'local') || (b.native - a.native) || (b.pixels - a.pixels) || (b.size - a.size));
  jobs.push({ g, src: usable[0], copies: g.copies.length });
}
// Videos with no copy at all that survived (everything failed/skipped) are not Videos with thumbnails.
let generated = 0, attempted = 0;
const limited = jobs.slice(0, Number.isFinite(opt.limit) ? opt.limit : undefined);
log(`generating ${limited.length} Videos with ${opt.jobs} in parallel`);

async function generate({ g, src, copies }) {
  const id = g.id, p = src.probe;
  const posterFinal = path.join(opt.out, `${id}.poster.webp`);
  const stripFinal = path.join(opt.out, `${id}.strip.webp`);
  const posterTmp = path.join(TMP, `${id}.poster.webp`);
  const stripTmp = path.join(TMP, `${id}.strip.webp`);
  const work = await fsp.mkdtemp(path.join(TMP, 'w-'));
  const dur = p.duration;
  const fail = (stage, r) => failures.push({ id, path: src.abs, stage, error: (r.err || '').trim().slice(-300), io: !!r.io });
  try {
    const pr = await makePoster(src.abs, dur, posterTmp);
    if (!pr.ok) return fail('poster', pr);
    const n = dur ? Math.min(STRIP_MAX, Math.floor(dur)) : 0;
    let strip = null, method = null, stripNote = null;
    if (n >= 2) {
      const cols = Math.min(STRIP_COLS, n), rows = Math.ceil(n / cols);
      const single = p.vcodec === 'h264' && dur < SINGLE_PASS_MAX_SEC;
      method = single ? 'single-pass-nokey' : 'seek-per-frame';
      const sr = single ? await makeStripSingle(src.abs, dur, n, cols, rows, stripTmp)
        : await makeStripSeek(src.abs, dur, n, cols, rows, stripTmp, work);
      if (!sr.ok) return fail('strip', sr);
      const dims = await webpSize(stripTmp);
      strip = { frames: n, columns: cols, rows, frameWidth: dims ? dims.w / cols : STRIP_W, frameHeight: dims ? dims.h / rows : null,
        interval: dur / n, bytes: await fileSize(stripTmp), method, filledFrames: sr.filled || 0 };
    } else stripNote = dur ? 'duration under 2 s: poster only' : 'no duration: poster only';
    await fsp.rename(posterTmp, posterFinal);
    if (strip) await fsp.rename(stripTmp, stripFinal);
    else await fsp.rm(stripFinal, { force: true });
    manifest.set(id, {
      id, idKind: g.idKind,
      source: { root: src.root, path: src.abs, relPath: src.rel, vcodec: p.vcodec, acodec: p.acodec, width: p.width, height: p.height, native: src.native },
      copies, duration: dur, posterAt: pr.at,
      posterBytes: await fileSize(posterFinal), strip, note: stripNote,
      // flat copies of the requested fields for convenience
      frames: strip ? strip.frames : 0, columns: strip ? strip.columns : 0, rows: strip ? strip.rows : 0,
      frameWidth: strip ? strip.frameWidth : 0, frameHeight: strip ? strip.frameHeight : 0, stripBytes: strip ? strip.bytes : 0,
      generatedAt: new Date().toISOString(),
    });
    await saveManifest();
    generated++;
  } catch (e) {
    fail('exception', { err: String(e && e.stack || e) });
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
    await fsp.rm(posterTmp, { force: true }); await fsp.rm(stripTmp, { force: true });
    attempted++;
    if (attempted % 10 === 0 || attempted === limited.length) {
      const el = (Date.now() - T0) / 1000;
      log(`progress ${attempted}/${limited.length} generated=${generated} failed=${failures.filter((f) => f.stage !== 'probe').length} elapsed=${Math.round(el)}s`);
    }
  }
}
await pool(limited, opt.jobs, generate);
await saveManifest();
await fsp.rm(TMP, { recursive: true, force: true });

// ---------- report ----------
const reasons = {};
const seen = new Set();
for (const s of skipped) { const k = `${s.root}|${s.path}`; if (seen.has(k)) continue; seen.add(k); reasons[s.reason] = (reasons[s.reason] || 0) + 1; }
const vids = [...manifest.values()];
const report = {
  generatedAt: new Date().toISOString(), runtimeSeconds: Math.round((Date.now() - T0) / 1000), force: opt.force,
  roots: rootStatus, scanErrors,
  candidateFiles: candidates.length, videosInScan: groups.size, videosCachedBefore: doneIds.size,
  videosGeneratedThisRun: generated, videosWithoutUsableSource: noSource.size,
  manifestVideos: vids.length,
  posters: vids.length, strips: vids.filter((v) => v.strip).length,
  skippedByReason: reasons, skipped, failures,
  posterBytes: vids.reduce((s, v) => s + v.posterBytes, 0), stripBytes: vids.reduce((s, v) => s + v.stripBytes, 0),
};
await fsp.writeFile(path.join(opt.out, 'run-report.json'), JSON.stringify(report, null, 1));
log(`done in ${report.runtimeSeconds}s: manifest=${vids.length} generated=${generated} failures=${failures.length} skipped=`, JSON.stringify(reasons));
process.exit(failures.length || scanErrors.length ? 1 : 0);
