#!/usr/bin/env node
// Renders the demo in headless Chromium and writes examples/screenshot-*.png.
// Doubles as a smoke test: it throws if nothing paints, or if the token
// scenario stops reporting zero wasted traffic.
// Requires `npm i -D playwright-core` and a Chromium at $CHROME_PATH.
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const server = spawn('node', ['scripts/serve.mjs'], { cwd: '/root/tracelight', env: { ...process.env, PORT: '4199' } });
await new Promise((r) => setTimeout(r, 900));

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:4199/', { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);

const stats = await page.evaluate(() => ({
  total: document.getElementById('s-total').textContent,
  wasted: document.getElementById('s-wasted').textContent,
  pct: document.getElementById('s-pct').textContent,
  shape: document.getElementById('s-shape').textContent,
  canvas: !!document.querySelector('#map canvas'),
  // count non-background pixels as a crude "did anything draw" check
}));
const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i+1] > 40 || d[i+2] > 60) n++;
  return n;
});
await page.screenshot({ path: '/root/tracelight/examples/screenshot-challenge.png' });

await page.selectOption('#scenario', 'data/auth-token.json');
await page.waitForTimeout(2200);
const stats2 = await page.evaluate(() => ({ pct: document.getElementById('s-pct').textContent }));
await page.screenshot({ path: '/root/tracelight/examples/screenshot-token.png' });

await page.selectOption('#scenario', 'data/random-large.json');
await page.waitForTimeout(2000);
await page.screenshot({ path: '/root/tracelight/examples/screenshot-random.png' });

console.log(JSON.stringify({ stats, painted, tokenPct: stats2.pct, errors }, null, 2));
if (painted < 10000) throw new Error('nothing painted - the renderer is broken');
if (stats2.pct !== '0%') throw new Error('token scenario should waste nothing');
await browser.close();
server.kill();
