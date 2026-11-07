const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:4507/');
  await p.waitForSelector('.rail');
  const fk = () => p.evaluate(() => { const a = document.activeElement; return a && a.dataset && a.dataset.key ? a.dataset.key + ' "' + a.textContent.slice(0, 30) + '"' : a && a.tagName });
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(80) } };
  await key('ArrowUp'); console.log('header', await fk());
  await key('Enter'); await p.waitForTimeout(300); console.log('search initial', await fk());
  // walk to the layer keys: Down many
  await key('ArrowDown', 6); console.log('bottom of kb', await fk());
  await key('ArrowRight'); console.log('right', await fk());
  await key('ArrowRight'); console.log('right', await fk());
  await key('ArrowRight'); console.log('right', await fk());
  const k1 = await fk();
  await key('Enter'); await p.waitForTimeout(150);
  console.log('after Enter on', k1, '->', await fk());
  await key('ArrowLeft'); console.log('then Left ->', await fk());
  // type "song" with keyboard chars
  for (const ch of 'song') { await p.keyboard.type(ch); await p.waitForTimeout(50) }
  await p.waitForTimeout(800);
  console.log('results', await p.$$eval('[data-zone=res][data-item]', a => a.length));
  await key('ArrowRight', 8); console.log('in results?', await fk());
  await key('ArrowDown', 3); console.log('res down', await fk());
  await key('Escape'); console.log('Back in results ->', await fk());
  await key('Escape'); await p.waitForTimeout(200); console.log('Back on kb -> search gone?', await p.$('.se') == null, await fk());
  await b.close();
})();
