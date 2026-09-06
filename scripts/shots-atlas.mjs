#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';

const server = spawn('node', ['scripts/serve.mjs'], { cwd: process.cwd(), env: { ...process.env, PORT: '4204' } });
await new Promise((r) => setTimeout(r, 900));
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });

async function run(colorScheme, tag) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 2, colorScheme });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !/404|favicon|ERR_CONNECTION|fonts.googleapis/.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:4204/atlas.html', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `examples/atlas-${tag}-domains.png` });

  await page.evaluate(() => atlas.expand('payments'));
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `examples/atlas-${tag}-teams.png` });

  await page.evaluate(() => atlas.expand('payments/ledger'));
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `examples/atlas-${tag}-team.png` });

  const focus = await page.evaluate(() => {
    const m = atlas.getModel();
    const l = [...m.leaves.values()].filter((x) => x.path[1] === 'payments/ledger' && x.kind === 'service').sort((a, b) => b.inRps - a.inRps)[0];
    atlas.goTo(l.id);
    return l.id;
  });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `examples/atlas-${tag}-focus.png` });

  await page.evaluate(() => { atlas.setLens('kafka'); atlas.focus(null); });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `examples/atlas-${tag}-kafka.png` });

  await page.evaluate(() => { atlas.setLens('reliability'); atlas.collapseAll(); });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `examples/atlas-${tag}-reliability.png` });

  await page.evaluate(() => {
    atlas.setLens('blast');
    const m = atlas.getModel();
    const store = [...m.leaves.values()].filter((l) => l.kind === 'datastore' && l.path[1] === 'payments/ledger').sort((a, b) => b.inRps - a.inRps)[0];
    atlas.expand('payments/ledger', false);
    atlas.kill([store.id]);
    atlas.fit('payments');
  });
  await page.waitForTimeout(1300);
  await page.screenshot({ path: `examples/atlas-${tag}-blast.png` });

  await page.evaluate(() => {
    atlas.revive(); atlas.setLens('traffic'); atlas.collapseAll();
    const m = atlas.getModel();
    const deep = [...m.leaves.values()].filter((l) => l.kind === 'datastore' && l.depth >= 6).sort((a, b) => b.inRps - a.inRps)[0];
    atlas.setTrail('clients', deep.id);
  });
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `examples/atlas-${tag}-trail.png` });

  // Live: update three times and check the place holds.
  const held = await page.evaluate(async () => {
    atlas.clearTrail();
    atlas.collapseAll();
    atlas.expand('payments/ledger', true);
    await new Promise((r) => setTimeout(r, 700));
    const before = { state: atlas.getState(), cam: atlas.getCamera() };
    for (let i = 0; i < 3; i++) {
      const t = { ...atlas.getModel && (await (await fetch('./data/estate.json')).json()) };
      t.records = t.records.map((r) => ({ ...r, metrics: { ...r.metrics, rps: r.metrics.rps * (0.5 + Math.random()) } }));
      atlas.update(t);
    }
    const after = { state: atlas.getState(), cam: atlas.getCamera() };
    return JSON.stringify(before.state.expanded) === JSON.stringify(after.state.expanded) && before.cam.x === after.cam.x && before.cam.scale === after.cam.scale;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `examples/atlas-${tag}-live.png` });
  if (!held) errors.push('live update moved the view');

  console.log(tag, focus, JSON.stringify({ stats: await page.evaluate(() => atlas.stats()), errors }, null, 1));
  await page.close();
}

try {
  await run('dark', 'dark');
  await run('light', 'light');
} finally {
  await browser.close();
  server.kill();
}
