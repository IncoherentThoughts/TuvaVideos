const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto('http://127.0.0.1:4507/');
  await p.waitForSelector('.rail');
  const fk = () => p.evaluate(() => { const a = document.activeElement; if (!a || !a.dataset || !a.dataset.key) return a && a.tagName; const r = a.closest('.rail'); return a.dataset.key.slice(0,9) + (r ? ' in ' + r.querySelector('h2').firstChild.textContent : '') + ' title=' + (a.querySelector('.ttl')||{}).textContent });
  const key = async (k, n = 1) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(80) } };
  console.log('rails', await p.$$eval('.rail h2', a => a.map(x => x.textContent)));
  // Home: Library rail, move right 6, play, back
  await key('ArrowRight', 6);
  const before = await fk(); console.log('before', before);
  await key('Enter'); await p.waitForTimeout(2500);
  await key('Escape'); await p.waitForTimeout(1500);
  console.log('home after back', await fk());
  await key('ArrowRight'); console.log('after Right', await fk());
  // Recently added grid via See all (go down to recent rail, End)
  await key('ArrowDown'); await key('ArrowRight', 30); console.log('end of recent rail', await fk());
  await key('Enter'); await p.waitForTimeout(500); console.log('grid', await p.$eval('.top h1', e => e.textContent));
  await key('ArrowDown', 5); await key('ArrowRight', 2);
  const b2 = await fk(); console.log('before', b2);
  await key('Enter'); await p.waitForTimeout(2500);
  await key('Escape'); await p.waitForTimeout(1500);
  console.log('recent grid after back', await fk());
  await b.close();
})();
