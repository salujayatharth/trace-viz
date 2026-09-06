#!/usr/bin/env node
// Builds the browser globals used by the demo page and by <script> users.
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

await mkdir('examples/dist', { recursive: true });

const common = {
  bundle: true,
  target: ['es2020'],
  logLevel: 'info',
};

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'examples/dist/trace-viz.global.js',
  format: 'iife',
  globalName: 'tracelight',
  sourcemap: true,
});

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/trace-viz.min.js',
  format: 'iife',
  globalName: 'tracelight',
  minify: true,
});

await build({
  ...common,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/trace-viz.esm.js',
  format: 'esm',
  minify: true,
});
