const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  // the TV Server on 4401 is played by the audit server on 4507; /tv.js stands in for a bundle the TV's engine cannot parse
  await p.route('http://127.0.0.1:4401/**', async r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/tv.js') return r.fulfill({ status: 200, contentType: 'text/javascript', body: 'let a = {}; a.b ??= 1; const x = a?.b; this is not valid js (' });
    const res = await r.fetch({ url: 'http://127.0.0.1:4507' + u.pathname + u.search });
    return r.fulfill({ response: res });
  });
  // serve the shell over http (as tv/shell/README.md says) via route too
  await p.route('http://shell.local/**', r => { const f = new URL(r.request().url()).pathname.slice(1) || 'index.html'; return require('fs').existsSync('/home/user/TuvaVideos/tv/shell/' + f) ? r.fulfill({ path: '/home/user/TuvaVideos/tv/shell/' + f }) : r.fulfill({ status: 404, body: '' }) });
  await p.goto('http://shell.local/index.html?addr=127.0.0.1');
  await p.waitForTimeout(4000);
  console.log('page errors', errs);
  console.log('shell hidden', await p.$eval('#shell', e => e.hidden), 'tuvaTv', await p.evaluate(() => !!window.tuvaTv), 'visible text:', JSON.stringify(await p.evaluate(() => document.body.innerText.trim())));
  await p.keyboard.press('Enter'); await p.keyboard.press('Backspace'); await p.waitForTimeout(500);
  console.log('after Enter/Back: visible text:', JSON.stringify(await p.evaluate(() => document.body.innerText.trim())), 'url', p.url());
  await b.close();
})();
