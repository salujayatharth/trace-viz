#!/usr/bin/env node
// Turns examples/atlas.html into one self-contained page: library and the
// 600-service estate inlined.
import { readFile, writeFile } from 'node:fs/promises';

const page = await readFile('examples/atlas.html', 'utf8');
const lib = await readFile('dist/trace-viz.min.js', 'utf8');
const estate = await readFile('examples/data/estate.json', 'utf8');

const style = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const fonts = page.match(/<link rel="stylesheet"[^>]*>/)[0];
const body = page.match(/<body>([\s\S]*?)<script src=/)[1].replace(/<a href="\.\/"[^>]*>studio ↗<\/a>/, '');
const app = page.match(/<script>\n([\s\S]*?)<\/script>\n<\/body>/)[1]
  .replace("const res = await fetch('./data/estate.json');\n    table = res.ok ? await res.json() : generateEstate();", 'table = ESTATE;');

const html = `<title>Trace-viz Atlas</title>
${fonts}
<style>${style}</style>
${body}
<script>${lib}</script>
<script>const ESTATE = ${JSON.stringify(JSON.parse(estate))};</script>
<script>${app}</script>
`;

await writeFile('examples/artifact-atlas.html', html);
console.log('wrote examples/artifact-atlas.html', (html.length / 1024).toFixed(0) + 'kb');
