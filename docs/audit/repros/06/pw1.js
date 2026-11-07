const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const log = [];
  p.on('request', r => { if (/\/api\/videos(\/|$)|resume|view/.test(r.url())) log.push(`${Date.now()} ${r.method()} ${new URL(r.url()).pathname}`) });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:4507/');
  await p.waitForSelector('.rail');
  const fk = () => p.evaluate(() => { const a = document.activeElement; return a && a.dataset ? (a.dataset.key || a.tagName) : null });
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(60) } };
  console.log('initial', await fk());
  await key('ArrowRight', 3); console.log('after R3', await fk());
  await key('ArrowDown', 1); console.log('after D', await fk());
  await key('ArrowUp', 2); console.log('after U2', await fk());
  await key('ArrowLeft', 5); console.log('after L5', await fk(), 'pane', await p.$('.pane') != null);
  await key('ArrowRight'); console.log('after R (close pane)', await fk(), 'pane', await p.$('.pane') != null);
  // Rails count
  console.log('cards on home', await p.$$eval('[data-item]', a => a.length));
  // open Library grid via pane
  await key('Escape'); console.log('pane after Back', await p.$('.pane') != null, await fk());
  await key('Enter'); await p.waitForTimeout(300); console.log('grid?', await p.$('.gridscroll') != null, await fk());
  // walk down the grid
  for (let i = 0; i < 12; i++) { await key('ArrowDown'); const k = await fk(); if (i % 3 == 0 || !k || !k.startsWith('v')) console.log('down', i, k) }
  console.log('rendered tiles', await p.$$eval('.gridrows [data-item]', a => a.length));
  await key('PageUp'); console.log('pageUp', await fk());
  await key('PageDown'); await p.waitForTimeout(100); console.log('pageDown', await fk());
  await key('PageDown'); await p.waitForTimeout(100); console.log('pageDown2', await fk());
  // play a tile far down
  await key('ArrowRight', 2);
  const before = await fk();
  console.log('open', before);
  await key('Enter'); await p.waitForTimeout(2500);
  console.log('player?', await p.$('.pl') != null);
  log.length = 0;
  await key('Escape'); await p.waitForTimeout(1500);
  console.log('requests after Back:\n' + log.join('\n'));
  console.log('focus after back', await fk(), 'same?', (await fk()) === before);
  await key('ArrowDown'); console.log('focus after a Down', await fk());
  await b.close();
})();
