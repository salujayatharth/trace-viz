#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const server = spawn('node', ['scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '4201' } });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1420, height: 1180 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const errors = [];
page.on('console', (m) => m.type() === 'error' && !/favicon/i.test(m.text()) && !/404/.test(m.text()) && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:4201/mesh.html', { waitUntil: 'networkidle' });
await page.waitForTimeout(2600);
const read = () => page.evaluate(() => ({
  key: document.getElementById('keynote').textContent,
  stats: [...document.querySelectorAll('#stats .stat b')].map((b) => b.textContent),
  legend: [...document.querySelectorAll('#legend .ch')].map((c) => c.textContent),
  issues: [...document.querySelectorAll('#issues div')].map((d) => d.textContent),
}));
const out = { flat: await read() };
await page.screenshot({ path: 'examples/shot-mesh-flat.png' });

await page.click('#m-world');
await page.waitForTimeout(2800);
out.world = await read();
await page.screenshot({ path: 'examples/shot-mesh-world.png' });

// Focus a service into its APIs.
await page.evaluate(() => { spec.focus = { match: { service: 'orders' }, expandBy: ['api'] }; apply(); });
await page.waitForTimeout(2600);
out.focus = await read();
await page.screenshot({ path: 'examples/shot-mesh-focus.png' });

// Blast radius.
await page.evaluate(() => { delete spec.focus; spec.killed = ['identity']; apply(); });
await page.waitForTimeout(3400);
out.blast = await read();
await page.screenshot({ path: 'examples/shot-mesh-blast.png' });

const painted = await page.evaluate(() => {
  const c = document.querySelector('#map canvas');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 40 || d[i + 1] > 40 || d[i + 2] > 60) n++;
  return n;
});
console.log(JSON.stringify({ ...out, painted, errors }, null, 1));
await browser.close();
server.kill();
if (painted < 10000) throw new Error('nothing painted');
if (errors.length) throw new Error('console errors: ' + errors.join(' | '));
