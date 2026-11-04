const { chromium } = require('playwright');
const VID = '237d9ce6-9de8-46b2-99c9-2e73f61e6d90';
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  const reqs = [];
  p.on('request', r => { const u = new URL(r.url()); if (/resume|view/.test(u.pathname)) reqs.push(`${r.method()} ${u.pathname.split('/').pop()} ${r.postData() || ''}`) });
  await p.goto(`http://127.0.0.1:4507/?play=${VID}&t=30`);
  await p.waitForSelector('.pl video');
  await p.waitForTimeout(2500);
  const st = () => p.evaluate(() => { const v = document.querySelector('.pl video'); return { t: v.currentTime.toFixed(1), paused: v.paused, err: v.error && v.error.code, msg: (document.querySelector('.plmsg')||{}).textContent, flash: (document.querySelector('.pl-flash')||{}).textContent, badge: (document.querySelector('.pl-badge')||{}).textContent, zoneBtn: (document.querySelector('.pbtn.f')||{}).textContent, list: (document.querySelector('.pl-list h3')||{}).textContent, band: (document.querySelector('.lyrband')||{}).textContent } });
  const key = async (k, n = 1, d = 80) => { for (let i = 0; i < n; i++) { await p.keyboard.press(k); await p.waitForTimeout(d) } };
  console.log('start', await st());
  await key('ArrowRight'); await p.waitForTimeout(500); console.log('R', await st());
  await key('ArrowUp'); console.log('Up', await st());
  await key('ArrowUp'); console.log('Up2', await st());
  await key('Escape'); console.log('Back', await st());
  await key('ArrowDown'); console.log('Down', await st());
  await key('ArrowRight', 2); console.log('R2 in buttons', await st());
  await key('Enter'); console.log('Enter Copy', await st());
  await key('Escape'); console.log('Back', await st());
  await key('ArrowDown'); console.log('Down (chapters)', await st());
  await p.waitForTimeout(3500); console.log('after 3.5s idle', await st());
  await key('Enter'); await p.waitForTimeout(600); console.log('Enter (pause)', await st());
  // Hold Right: 40 repeat events 50 ms apart
  await p.keyboard.down('ArrowRight');
  for (let i = 0; i < 30; i++) { await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', keyCode: 39, repeat: true, bubbles: true }))); await p.waitForTimeout(50) }
  await p.keyboard.up('ArrowRight');
  await p.waitForTimeout(800); console.log('after 1.5s hold of Right', await st());
  // server goes away mid-playback: abort all further requests
  await key('Enter'); await p.waitForTimeout(300);
  await p.evaluate(() => { const v = document.querySelector('.pl video'); v.currentTime = 10; });
  await p.waitForTimeout(800);
  await p.route('**/*', r => r.abort('connectionrefused'));
  await p.evaluate(() => { const v = document.querySelector('.pl video'); v.currentTime = 170; });
  await p.waitForTimeout(6000); console.log('server gone', await st());
  console.log(reqs.join('\n'));
  await b.close();
})();
