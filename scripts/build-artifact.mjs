#!/usr/bin/env node
// Builds a single self-contained page (no external fetches) for publishing.
import { readFile, writeFile } from 'node:fs/promises';

const lib = await readFile('dist/trace-viz.min.js', 'utf8');
const names = ['auth-challenge', 'auth-token', 'random-small', 'random-large'];
const data = {};
for (const n of names) data[n] = JSON.parse(await readFile(`examples/data/${n}.json`, 'utf8'));

const html = `<title>Tracelight</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" />
<style>
  :root {
    --paper: #f4f6f8;
    --surface: #ffffff;
    --rule: #d8dee7;
    --rule-soft: #e7ecf2;
    --ink: #121821;
    --muted: #5d6b7d;
    --signal: #1f6feb;
    --waste: #b45c09;
    --sans: "IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --paper: #0c1016;
      --surface: #141a22;
      --rule: #28313d;
      --rule-soft: #1d242e;
      --ink: #e6edf4;
      --muted: #8794a5;
      --signal: #5aa9ff;
      --waste: #ffb54d;
    }
  }
  :root[data-theme="dark"] {
    --paper: #0c1016;
    --surface: #141a22;
    --rule: #28313d;
    --rule-soft: #1d242e;
    --ink: #e6edf4;
    --muted: #8794a5;
    --signal: #5aa9ff;
    --waste: #ffb54d;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1180px;
    margin: 0 auto;
    padding: 40px 24px 72px;
    display: flex;
    flex-direction: column;
    gap: 22px;
  }

  header { display: flex; flex-direction: column; gap: 10px; }
  .eyebrow {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 {
    margin: 0;
    font-size: clamp(30px, 4.4vw, 44px);
    font-weight: 600;
    letter-spacing: -0.025em;
    text-wrap: balance;
  }
  .lede { margin: 0; max-width: 66ch; color: var(--muted); font-size: 16px; }
  .lede em { color: var(--ink); font-style: normal; font-weight: 600; }

  /* Instrument panel: hairline-separated fields, not cards. */
  .readout {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
  }
  .field { padding: 14px 20px 15px; border-left: 1px solid var(--rule-soft); }
  .field:first-child { border-left: 0; padding-left: 0; }
  .field b {
    display: block;
    font-family: var(--mono);
    font-size: 26px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
  }
  .field span {
    display: block;
    margin-top: 3px;
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .field.alarm b { color: var(--waste); }

  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 22px; }
  .segmented { display: flex; border: 1px solid var(--rule); border-radius: 7px; overflow: hidden; }
  .segmented button {
    font: 500 13px/1 var(--sans);
    padding: 9px 15px;
    background: var(--surface);
    color: var(--muted);
    border: 0;
    border-left: 1px solid var(--rule);
    cursor: pointer;
  }
  .segmented button:first-child { border-left: 0; }
  .segmented button[aria-pressed="true"] { background: var(--signal); color: #fff; }
  .segmented button:focus-visible { outline: 2px solid var(--signal); outline-offset: -2px; }
  .toggle {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--mono); font-size: 12px; color: var(--muted);
  }
  input[type="range"] { accent-color: var(--signal); width: 110px; }
  input[type="checkbox"] { accent-color: var(--signal); }

  #map {
    height: min(620px, 68vh);
    min-height: 420px;
    border: 1px solid var(--rule);
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }

  .caption { margin: 0; color: var(--muted); font-size: 14px; max-width: 72ch; }
  .caption strong { color: var(--ink); font-weight: 600; }

  .encoding { border-top: 1px solid var(--rule); padding-top: 20px; }
  .encoding h2 {
    margin: 0 0 14px;
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .map-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .map-table th, .map-table td { text-align: left; padding: 9px 14px 9px 0; vertical-align: top; border-bottom: 1px solid var(--rule-soft); }
  .map-table th { font-family: var(--mono); font-size: 12px; font-weight: 500; color: var(--signal); white-space: nowrap; width: 1%; }
  .map-table td.channel { font-family: var(--mono); font-size: 12px; color: var(--ink); white-space: nowrap; width: 1%; }
  .map-table td.why { color: var(--muted); }
  .map-table tr:last-child th, .map-table tr:last-child td { border-bottom: 0; }
  .scroller { overflow-x: auto; }

  footer { color: var(--muted); font-size: 13px; border-top: 1px solid var(--rule); padding-top: 18px; }
  footer code { font-family: var(--mono); font-size: 12px; color: var(--ink); }

  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 620px) {
    .field { padding: 12px 14px; }
    .field:first-child { padding-left: 0; }
  }
</style>

<div class="page">
  <header>
    <div class="eyebrow">tracelight · flow map</div>
    <h1>Half this API's traffic turns around</h1>
    <p class="lede">
      Throughput is particle <em>density</em>, latency is particle <em>speed</em>, errors are hollow rings,
      and work that never reaches the data tier is dashed. Switch between the two auth designs and watch
      the reverse stream vanish.
    </p>
  </header>

  <div class="controls">
    <div class="segmented" role="group" aria-label="Scenario">
      <button type="button" data-key="auth-challenge" aria-pressed="true">401 per request</button>
      <button type="button" data-key="auth-token" aria-pressed="false">Bearer token</button>
      <button type="button" data-key="random-small" aria-pressed="false">Random</button>
      <button type="button" data-key="random-large" aria-pressed="false">Random · large</button>
    </div>
    <label class="toggle">speed <input id="speed" type="range" min="0" max="3" step="0.1" value="1" /></label>
    <label class="toggle"><input id="labels" type="checkbox" checked /> numbers</label>
    <label class="toggle"><input id="animate" type="checkbox" checked /> animate</label>
  </div>

  <div class="readout">
    <div class="field"><b id="s-total">—</b><span>total rps on the wire</span></div>
    <div class="field alarm"><b id="s-wasted">—</b><span>retry / challenge rps</span></div>
    <div class="field alarm"><b id="s-pct">—</b><span>share wasted</span></div>
    <div class="field"><b id="s-shape">—</b><span>nodes · flows</span></div>
  </div>

  <div id="map"></div>
  <p class="caption" id="caption"></p>

  <section class="encoding">
    <h2>What the picture encodes</h2>
    <div class="scroller">
      <table class="map-table">
        <tbody>
          <tr><th>rps</th><td class="channel">particle density</td><td class="why">Log-scaled. Linear scaling makes a 50k rps edge solid white next to a 5 rps edge that looks empty.</td></tr>
          <tr><th>latencyMs</th><td class="channel">particle speed</td><td class="why">Inverse. A slow-crawling stream <em>is</em> a slow hop, so the intuition arrives without a legend.</td></tr>
          <tr><th>errorRate</th><td class="channel">hollow red ring</td><td class="why">Colour plus shape, so it survives colour-vision deficiency and greyscale.</td></tr>
          <tr><th>bytes</th><td class="channel">particle radius</td><td class="why">Square-root scaled, because area reads as quantity.</td></tr>
          <tr><th>kind</th><td class="channel">dashed lane</td><td class="why">Retry and challenge traffic is drawn as its own reverse lane and counted separately above.</td></tr>
        </tbody>
      </table>
    </div>
  </section>

  <footer>
    Speed deliberately does not carry throughput: people read speed as fast-vs-slow but cannot judge 3× from 5×.
    The animation tells you where to look; the numbers on each edge tell you how much.
    Hover any node or flow for its figures. MIT licensed — <code>npm install trace-viz</code>.
  </footer>
</div>

<script>${lib}</script>
<script>
  const GRAPHS = ${JSON.stringify(data)};
  const { TraceLight, formatRps } = tracelight;
  const el = (id) => document.getElementById(id);

  const pageTheme = () => {
    const stamped = document.documentElement.getAttribute('data-theme');
    if (stamped === 'dark' || stamped === 'light') return stamped;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };

  const tl = new TraceLight(el('map'), { theme: pageTheme(), seed: 11 });

  function show(key) {
    const graph = GRAPHS[key];
    tl.setGraph(graph);
    const s = tl.stats();
    el('s-total').textContent = formatRps(s.totalRps) + '/s';
    el('s-wasted').textContent = formatRps(s.wastedRps) + '/s';
    el('s-pct').textContent = Math.round(s.wastedFraction * 100) + '%';
    el('s-shape').textContent = s.nodes + ' · ' + s.edges;
    el('caption').textContent = (graph.meta && (graph.meta.note || graph.meta.title)) || '';
    for (const b of document.querySelectorAll('.segmented button')) {
      b.setAttribute('aria-pressed', String(b.dataset.key === key));
    }
  }

  for (const b of document.querySelectorAll('.segmented button')) {
    b.addEventListener('click', () => show(b.dataset.key));
  }
  el('speed').addEventListener('input', (e) => tl.setOptions({ speed: Number(e.target.value) }));
  el('labels').addEventListener('change', (e) => tl.setOptions({ showEdgeLabels: e.target.checked }));
  el('animate').addEventListener('change', (e) => tl.setOptions({ animate: e.target.checked }));

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    tl.setOptions({ theme: pageTheme() });
  });
  new MutationObserver(() => tl.setOptions({ theme: pageTheme() }))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  show('auth-challenge');
</script>
`;

await writeFile('examples/artifact.html', html);
console.log('wrote examples/artifact.html', (html.length / 1024).toFixed(0) + 'kb');
