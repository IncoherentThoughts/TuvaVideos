const { chromium } = require('playwright');
const VID = '237d9ce6-9de8-46b2-99c9-2e73f61e6d90';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  let armed = false; const ev = [];
  p.on('request', r => { if (armed && /resume$/.test(r.url())) ev.push('POST resume ' + r.postData()) });
  p.on('response', async r => { if (armed && /\/api\/videos$/.test(r.url())) { const d = await r.json(); ev.push('GET /api/videos -> resumeS ' + d.find(v => v.id === VID).resumeS) } });
  await p.goto(`http://127.0.0.1:4507/?play=${VID}&t=60`);
  await p.waitForSelector('.pl video');
  await p.waitForTimeout(9000);
  armed = true;
  await p.keyboard.press('Escape');
  await p.waitForTimeout(2000);
  console.log(ev.join('\n'));
  console.log('continue rail progress width', await p.evaluate(() => { const r = [...document.querySelectorAll('.rail')].find(x => /Continue/.test(x.textContent)); const c = r && r.querySelector('.prog'); return c && c.style.width }));
  await b.close();
})();
