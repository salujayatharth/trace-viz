import test from 'node:test';
import assert from 'node:assert/strict';
import { generateMesh, project, styleScene, ERROR_FLOOR, darkTheme } from '../dist/index.js';

test('error halo reads on an absolute scale and is quiet for healthy boxes', () => {
  const table = generateMesh();
  const { scene } = project(table, { nodeKey: ['service'], where: { env: ['prod'] }, channels: { halo: { field: 'errorRate' } } });
  const styles = styleScene(scene, { nodeKey: ['service'], channels: { halo: { field: 'errorRate' } } }, darkTheme);
  const lit = scene.nodes.filter((n) => (styles.nodes.get(n.id)?.haloIntensity ?? 0) > 0);
  const quiet = scene.nodes.filter((n) => (styles.nodes.get(n.id)?.haloIntensity ?? 0) === 0);
  assert.ok(lit.length >= 2 && lit.length <= 5, `expected a few lit boxes, got ${lit.length}`);
  assert.ok(quiet.length > lit.length, 'most boxes should be quiet');
  for (const n of quiet) assert.ok((n.attrs.errorRate ?? 0) <= ERROR_FLOOR);
  const worst = lit.sort((a, b) => b.attrs.errorRate - a.attrs.errorRate)[0];
  const st = styles.nodes.get(worst.id);
  assert.ok(st.haloDanger);
  assert.ok(st.haloIntensity > 0.6, `worst box should burn, got ${st.haloIntensity}`);
  for (const n of lit) assert.ok(styles.nodes.get(n.id).haloIntensity <= st.haloIntensity);
});
