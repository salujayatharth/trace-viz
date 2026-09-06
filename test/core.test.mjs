import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveGraph,
  safeResolveGraph,
  emissionRate,
  particleSpeed,
  logNorm,
  rpsDomain,
  formatRps,
  layoutGraph,
  generateSeedGraph,
  authChallengeScenario,
  tokenAuthScenario,
} from '../dist/index.js';

const tiny = {
  nodes: [{ id: 'a' }, { id: 'b' }],
  edges: [{ from: 'a', to: 'b', metrics: { rps: 10 } }],
};

test('resolveGraph fills defaults', () => {
  const g = resolveGraph(tiny);
  assert.equal(g.nodes[0].label, 'a');
  assert.equal(g.nodes[0].kind, 'service');
  assert.equal(g.edges[0].kind, 'request');
  assert.equal(g.edges[0].metrics.errorRate, 0);
  assert.equal(g.edges[0].id, 'a->b');
});

test('resolveGraph reports every problem at once', () => {
  const r = safeResolveGraph({
    nodes: [{ id: 'a' }, { id: 'a' }],
    edges: [{ from: 'a', to: 'ghost', metrics: { rps: -1 } }],
  });
  assert.equal(r.ok, false);
  assert.ok(r.issues.length >= 3, `expected several issues, got ${r.issues.length}`);
  assert.ok(r.issues.some((i) => i.includes('duplicate id')));
  assert.ok(r.issues.some((i) => i.includes('unknown to-node')));
  assert.ok(r.issues.some((i) => i.includes('rps must be')));
});

test('reciprocal edges get distinct ids', () => {
  const g = resolveGraph({
    nodes: [{ id: 'a' }, { id: 'b' }],
    edges: [
      { from: 'a', to: 'b', metrics: { rps: 1 } },
      { from: 'a', to: 'b', metrics: { rps: 2 } },
    ],
  });
  assert.notEqual(g.edges[0].id, g.edges[1].id);
});

test('emission rate is monotonic and log-compressed', () => {
  const d = rpsDomain([1, 10, 100, 50000]);
  const a = emissionRate(10, d);
  const b = emissionRate(1000, d);
  const c = emissionRate(50000, d);
  assert.ok(a < b && b < c, 'must increase with rps');
  // Log compression with a contrast curve: a 5000x jump in rps must be far
  // less than 5000x in density, but still clearly more than a couple of notches.
  assert.ok(c / a < 120 && c / a > 4, `expected compressed but visible contrast, got ratio ${c / a}`);
  assert.equal(emissionRate(0, d), 0);
});

test('particle speed falls as latency rises, and is clamped', () => {
  assert.ok(particleSpeed(1) > particleSpeed(50));
  assert.ok(particleSpeed(50) > particleSpeed(900));
  assert.equal(particleSpeed(0.0001), particleSpeed(2));
  assert.equal(particleSpeed(5000), particleSpeed(800));
});

test('logNorm stays in range', () => {
  for (const v of [0, 1, 5, 1e9]) {
    const n = logNorm(v, 1, 1000);
    assert.ok(n >= 0 && n <= 1, `${v} -> ${n}`);
  }
});

test('layout is deterministic and layers left to right', () => {
  const g = resolveGraph(authChallengeScenario(1000));
  const a = layoutGraph(g, { width: 900, height: 500 });
  const b = layoutGraph(g, { width: 900, height: 500 });
  for (const [id, pos] of a) {
    assert.deepEqual({ x: pos.x, y: pos.y }, { x: b.get(id).x, y: b.get(id).y });
  }
  assert.ok(a.get('client').x < a.get('orders').x, 'client must sit left of the datastore');
});

test('layout terminates on a cyclic graph', () => {
  const g = resolveGraph({
    nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    edges: [
      { from: 'a', to: 'b', metrics: { rps: 1 } },
      { from: 'b', to: 'c', metrics: { rps: 1 } },
      { from: 'c', to: 'a', metrics: { rps: 1 } },
    ],
  });
  const pos = layoutGraph(g, { width: 600, height: 400 });
  assert.equal(pos.size, 3);
  for (const p of pos.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
});

test('seed generator is deterministic and valid', () => {
  const a = JSON.stringify(generateSeedGraph({ seed: 5 }));
  const b = JSON.stringify(generateSeedGraph({ seed: 5 }));
  assert.equal(a, b);
  assert.notEqual(a, JSON.stringify(generateSeedGraph({ seed: 6 })));
  assert.doesNotThrow(() => resolveGraph(generateSeedGraph({ seed: 5, services: 12 })));
});

test('the challenge scenario wastes traffic and the token one does not', () => {
  const waste = (graph) => {
    const g = resolveGraph(graph);
    let total = 0;
    let wasted = 0;
    for (const e of g.edges) {
      total += e.metrics.rps;
      if (e.kind === 'retry' || e.kind === 'challenge') wasted += e.metrics.rps;
    }
    return wasted / total;
  };
  const challenge = waste(authChallengeScenario(5000));
  const token = waste(tokenAuthScenario(5000));
  assert.ok(challenge >= 0.25, `expected the challenge design to waste a lot, got ${challenge}`);
  assert.equal(token, 0);
});

test('formatRps is compact', () => {
  assert.equal(formatRps(12345), '12k');
  assert.equal(formatRps(1234), '1.2k');
  assert.equal(formatRps(42), '42');
  assert.equal(formatRps(0.5), '0.50');
});
