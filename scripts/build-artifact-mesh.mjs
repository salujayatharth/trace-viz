#!/usr/bin/env node
// Turns examples/studio.html into one self-contained page for publishing: the
// library and the flow table are inlined, and the page's "ask" box reaches the
// viewer's own Claude through the artifact `sample` capability, which the page
// already probes for via window.claude.use('sample').
import { readFile, writeFile } from 'node:fs/promises';

const page = await readFile('examples/studio.html', 'utf8');
const lib = await readFile('dist/trace-viz.min.js', 'utf8');
const mesh = await readFile('examples/data/mesh.json', 'utf8');

const style = page.match(/<style>([\s\S]*?)<\/style>/)[1];
const fonts = page.match(/<link rel="stylesheet"[^>]*>/)[0];
const body = page.match(/<body>([\s\S]*?)<script src=/)[1];
const app = page.match(/<script>\n([\s\S]*?)<\/script>\n<\/body>/)[1];

const html = `<title>Trace-viz Studio</title>
${fonts}
<style>${style}</style>
${body}
<script>${lib}</script>
<script>const MESH = ${mesh};</script>
<script>${app}</script>
`;

await writeFile('examples/artifact-mesh.html', html);
console.log('wrote examples/artifact-mesh.html', (html.length / 1024).toFixed(0) + 'kb');
