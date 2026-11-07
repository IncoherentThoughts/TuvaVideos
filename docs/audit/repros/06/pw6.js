const { chromium } = require('playwright');
const VID = '237d9ce6-9de8-46b2-99c9-2e73f61e6d90';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  let down = false;
  await p.route('**/*', r => { const u = new URL(r.request().url()); if (down && (u.pathname.startsWith('/copy/') || u.pathname.startsWith('/api/videos/'))) return r.abort('connectionrefused'); return r.continue() });
  await p.goto(`http://127.0.0.1:4507/`);
  await p.waitForSelector('.rail');
  // let the player fetch /api/videos/:id, then the server "goes away" before the media request
  p.on('request', r => { if (/\/api\/videos\/[0-9a-f-]{36}$/.test(r.url()) && !down) setTimeout(() => { down = true }, 0) });
  await p.evaluate((id) => { history.replaceState(null, '', '/?play=' + id) }, VID);
  await p.reload(); await p.waitForSelector('.pl video', { timeout: 10000 });
  await p.waitForTimeout(4000);
  const st = () => p.evaluate(() => ({ msg: (document.querySelector('.plmsg') || {}).textContent, src: document.querySelector('.pl video').getAttribute('src') }));
  console.log('while down', await st());
  down = false; console.log('server back');
  await p.waitForTimeout(12000);
  console.log('12 s after the server is back', await st());
  await b.close();
})();
