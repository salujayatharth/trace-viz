#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const server = spawn('node', ['scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '4203' } });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });

async function run(colorScheme, tag) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2, colorScheme });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !/404|favicon|ERR_CONNECTION|fonts.googleapis/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:4203/studio.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `examples/studio-${tag}-map.png` });

  // Inspector: select a node programmatically through the same path a click takes.
  await page.evaluate(() => { onSelectTarget({ kind: 'node', node: tl.getScene().nodes.find((n) => n.id === 'gateway') }); });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `examples/studio-${tag}-inspect.png` });

  // Legend isolate.
  await page.evaluate(() => setHighlight({ field: 'region', value: 'eu-west' }, true));
  await page.waitForTimeout(700);
  await page.screenshot({ path: `examples/studio-${tag}-isolate.png` });
  await page.evaluate(() => { setHighlight(null); clearSelection(); });

  // World.
  await page.evaluate(() => { spec.mode = 'world'; apply(); });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `examples/studio-${tag}-world.png` });

  // Blast in the world.
  await page.evaluate(() => { spec.killed = ['identity']; tl.kill(spec.killed); });
  await page.waitForTimeout(3600);
  await page.screenshot({ path: `examples/studio-${tag}-blast.png` });

  const read = await page.evaluate(() => ({
    sentence: document.getElementById('sentence').textContent.replace(/\s+/g, ' ').trim(),
    readout: [...document.querySelectorAll('#readout b')].map((b) => b.textContent),
    inspectorOpen: document.getElementById('inspector').classList.contains('open'),
  }));
  await page.close();
  return { tag, read, errors };
}

const out = [await run('dark', 'dark'), await run('light', 'light')];
console.log(JSON.stringify(out, null, 1));
await browser.close();
server.kill();
for (const o of out) if (o.errors.length) throw new Error(`${o.tag}: ${o.errors.join(' | ')}`);
