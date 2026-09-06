#!/usr/bin/env node
// Regenerates the static JSON fixtures in examples/data/.
import { writeFile, mkdir } from 'node:fs/promises';
import { authChallengeScenario, tokenAuthScenario, generateSeedGraph } from '../dist/seed.js';
import { generateMesh } from '../dist/mesh.js';
import { generateEstate } from '../dist/estate.js';

await mkdir('examples/data', { recursive: true });
const files = {
  'auth-challenge.json': authChallengeScenario(5000),
  'auth-token.json': tokenAuthScenario(5000),
  'random-small.json': generateSeedGraph({ seed: 7, services: 5, datastores: 2 }),
  'random-large.json': generateSeedGraph({ seed: 1312, services: 11, datastores: 4, extraCalls: 9, baseRps: 48000 }),
  'mesh.json': generateMesh({ seed: 21 }),
  'estate.json': generateEstate({ seed: 7 }),
};
for (const [name, graph] of Object.entries(files)) {
  await writeFile(`examples/data/${name}`, `${JSON.stringify(graph, null, 2)}\n`);
  console.log('wrote', name);
}
