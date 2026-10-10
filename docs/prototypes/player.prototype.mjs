// PROTOTYPE — throwaway. Issue #10: in-browser Player with mpv keys over localhost streaming.
// Node 22 (bun is not installed on this machine; Bun.file() would do the same Range dance for free).
// Serves player.prototype.html plus a fixed set of sample Copies from both Roots with HTTP Range,
// probes each with ffprobe at startup, and runs the two ffmpeg fallbacks from the #3 research on demand
// into player-cache.PROTOTYPE-WIPE-ME/. Nothing persists except that cache. Run: node docs/prototypes/player.prototype.mjs
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4412);
const CACHE = path.join(HERE, 'player-cache.PROTOTYPE-WIPE-ME');
fs.mkdirSync(path.join(CACHE, 'shots'), { recursive: true });

const ROOTS = {
  local: { kind: 'local', dir: '/Users/evanwilliams/Desktop/Khoomei/Videos' },
  external: { kind: 'external', dir: '/Volumes/General/хөөмей/Хөөмей' },
};

// Sample Copies chosen from the #8 inventory: every container/codec family plus the two fallback cases.
const SAMPLES = [
  ['local', 'Alash Chicago.mkv', 'mkv h264+aac · 735 MB · 80 min concert'],
  ['local', 'Nachyn Choreve Full.mkv', 'mkv vp9+opus · 1080p · 56 min'],
  ['local', 'Alash w: Radik.mkv', 'mkv vp9+aac · 360p · 52 min'],
  ['local', 'Тожу Кызы [LHnEgA_v6BY].mkv', 'mkv h264+opus · 1080p'],
  ['local', 'Alash 1999.webm', 'webm vp9+opus · 1080p'],
  ['local', 'Alash Kongurei.webm', 'webm vp9+opus · 480p · small'],
  ['local', 'Raw Silk & Alash.mp4', 'mp4 h264+aac · 1080p'],
  ['local', 'Bady-Dorzhu Solo Colgate.mp4', 'mp4 h264+aac · 720p'],
  ['external', "Khöömei Batch 2/'Хайыралдыг эргим авай' [wXcOTYqOXIc].webm", 'webm vp9+opus · 1080p'],
  ['external', "Khöömei Batch 3/'Эдиски дег боостаамны' - группа 'Алаш' [I24egnMmiNQ].mkv", 'mkv h264+opus'],
  ['external', 'Khöömei Batch 3/41 участник - Artur Damdyn ool (Russia, Tuva) [IiJOt3zjek4].mp4', 'mp4 h264+aac'],
  ['external', 'Khöömei Batch 2/18 Тувинское горловое пение. Группа Алаш. Тувинский релакс. Relax. Tuvan throat singing. Alash. [5Om2KFo18EU].mkv', 'mkv vp9+E-AC3 · the one file needing an audio transcode'],
  ['external', 'Khöömei Batch 2/March 30, 2019 _ Алаш [2tuvBN_-VCA].f303.webm', 'yt-dlp video-only partial, no Cues; has an .f251 audio sibling'],
  ['external', "Khöömei Batch 2/02 Тувинская фольклорная группа 'Алаш' в Абакане.  Горловое пение. Throat singing. [0qMztplyev4].f303.webm", 'yt-dlp video-only partial, no Cues, no sibling'],
].map(([root, rel, note], i) => ({ id: `f${i}`, root, rel, note, abs: path.join(ROOTS[root].dir, rel) }));

const MIME = { '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const NATIVE_AUDIO = new Set(['aac', 'opus', 'vorbis', 'mp3', 'flac', '']);

function run(cmd, args, timeoutMs = 20000) {
  return new Promise((res, rej) => {
    const t0 = performance.now();
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8e6 }, (err, stdout, stderr) =>
      err ? rej(Object.assign(err, { stderr })) : res({ stdout, ms: Math.round(performance.now() - t0) }));
  });
}

async function probe(s) {
  const info = { ...s, abs: undefined, available: false, size: 0 };
  try {
    const st = await fsp.stat(s.abs);
    info.size = st.size;
    // exFAT via FSKit has been throwing EIO on readdir today; a 1-byte read is the real availability test.
    const fh = await fsp.open(s.abs, 'r'); await fh.read(Buffer.alloc(1), 0, 1, 0); await fh.close();
    info.available = true;
  } catch (e) { info.error = e.code || String(e); return info; }
  try {
    const { stdout, ms } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', s.abs]);
    const j = JSON.parse(stdout);
    const v = j.streams.find(x => x.codec_type === 'video'), a = j.streams.find(x => x.codec_type === 'audio');
    info.probeMs = ms;
    info.duration = j.format.duration ? Number(j.format.duration) : null;
    info.vcodec = v?.codec_name || ''; info.acodec = a?.codec_name || '';
    info.res = v ? `${v.width}×${v.height}` : '';
    if (v?.r_frame_rate) { const [n, d] = v.r_frame_rate.split('/').map(Number); info.fps = d ? n / d : n; }
    info.fallback = !NATIVE_AUDIO.has(info.acodec) ? 'audio-transcode' : info.duration == null ? 'remux-cues' : null;
    const sib = s.rel.replace(/\.f\d+\.webm$/, '.f251.webm');
    if (info.fallback === 'remux-cues' && sib !== s.rel && fs.existsSync(path.join(ROOTS[s.root].dir, sib))) info.audioSibling = sib;
    info.cached = fs.existsSync(cachePath(s));
  } catch (e) { info.error = 'ffprobe: ' + (e.stderr || e.message).trim().slice(0, 200); }
  return info;
}

const cachePath = s => path.join(CACHE, `${s.id}.${/webm$/.test(s.rel) ? 'webm' : 'mp4'}`);
let FILES = [], probing = null;
function probeAll() { return probing ??= Promise.all(SAMPLES.map(probe)).then(f => { FILES = f; probing = null; return f; }); }

// Run the one-time fallback from #3 into the cache and report how long it took.
async function prepare(s, info) {
  const out = cachePath(s);
  if (fs.existsSync(out)) return { cached: true, ms: 0 };
  let args;
  if (info.fallback === 'audio-transcode') args = ['-y', '-v', 'error', '-i', s.abs, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out];
  else if (info.audioSibling) args = ['-y', '-v', 'error', '-i', s.abs, '-i', path.join(ROOTS[s.root].dir, info.audioSibling), '-c', 'copy', '-cues_to_front', '1', out];
  else args = ['-y', '-v', 'error', '-i', s.abs, '-c', 'copy', '-cues_to_front', '1', out];
  const { ms } = await run('ffmpeg', args, 10 * 60 * 1000);
  return { cached: false, ms, cmd: 'ffmpeg ' + args.slice(2, -1).map(a => a.includes(' ') ? `'${path.basename(a)}'` : a).join(' ') };
}

// Single-range + suffix-range support. Without this Chromium cannot seek at all (see #3).
function serveFile(req, res, abs, type) {
  let st; try { st = fs.statSync(abs); } catch { res.writeHead(404); return res.end('not found'); }
  const size = st.size;
  const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m) { res.writeHead(200, { ...h, 'Content-Length': size }); return fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res); }
  let [, a, b] = m; let start, end;
  if (a === '') { start = Math.max(0, size - Number(b)); end = size - 1; } else { start = Number(a); end = b === '' ? size - 1 : Math.min(Number(b), size - 1); }
  if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
  res.writeHead(206, { ...h, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
  console.log(`  206 ${path.basename(abs).slice(0, 40)} bytes=${start}-${end}`);
  fs.createReadStream(abs, { start, end }).on('error', e => { console.log('  read error', e.code); res.destroy(); }).pipe(res);
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { const c = []; req.on('data', d => c.push(d)).on('end', () => r(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const seg = u.pathname.split('/').filter(Boolean);
  try {
    if (u.pathname === '/') return serveFile(req, res, path.join(HERE, 'player.prototype.html'), MIME['.html']);
    if (u.pathname === '/olchey.svg') return serveFile(req, res, path.join(HERE, 'olchey.svg'), MIME['.svg']);
    if (u.pathname === '/api/files') return json(res, 200, { roots: ROOTS, files: u.searchParams.has('refresh') || probing ? await probeAll() : FILES });
    if (seg[0] === 'media' && seg[1]) {
      const s = SAMPLES.find(x => x.id === seg[1]); if (!s) return json(res, 404, { error: 'no such sample' });
      const abs = u.searchParams.has('cached') ? cachePath(s) : s.abs;
      return serveFile(req, res, abs, MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    }
    if (seg[0] === 'api' && seg[1] === 'prepare' && seg[2] && req.method === 'POST') {
      const s = SAMPLES.find(x => x.id === seg[2]); const info = FILES.find(x => x.id === seg[2]);
      if (!s || !info?.fallback) return json(res, 400, { error: 'no fallback needed' });
      const r = await prepare(s, info); info.cached = true; console.log('  prepared', s.rel.slice(0, 50), r);
      return json(res, 200, r);
    }
    if (u.pathname === '/api/shot' && req.method === 'POST') {
      const name = `${u.searchParams.get('id')}-${u.searchParams.get('t')}.png`;
      await fsp.writeFile(path.join(CACHE, 'shots', name), await body(req));
      return json(res, 200, { saved: `player-cache.PROTOTYPE-WIPE-ME/shots/${name}` });
    }
    if (u.pathname === '/api/keylog' && req.method === 'POST') { console.log('  key', (await body(req)).toString()); return json(res, 200, {}); }
    res.writeHead(404); res.end('not found');
  } catch (e) { console.error(e); json(res, 500, { error: String(e.stderr || e.message || e) }); }
}).listen(PORT, async () => {
  console.log(`player prototype → http://localhost:${PORT}  (cache: ${CACHE})`);
  await probeAll();
  for (const f of FILES) console.log(`  ${f.available ? 'ok ' : 'NO '} ${f.root.padEnd(8)} ${f.rel.slice(0, 60).padEnd(60)} ${f.vcodec}/${f.acodec} ${f.duration ? Math.round(f.duration) + 's' : '-'} ${f.fallback || ''} ${f.error || ''}`);
});
