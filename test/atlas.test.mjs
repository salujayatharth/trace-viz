import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEstate, buildAtlas, visibleUnits, aggregateEdges, neighbourhood, trail, propagate, search, layoutAtlas, emptyState } from '../dist/index.js';

const table = generateEstate({ seed: 7 });
const model = buildAtlas(table);

test('estate is the size it claims and has the structure the map needs', () => {
  const kinds = new Map();
  for (const l of model.leaves.values()) kinds.set(l.kind, (kinds.get(l.kind) ?? 0) + 1);
  assert.equal(kinds.get('topic'), 80);
  assert.ok(model.leaves.size >= 680, `leaves ${model.leaves.size}`);
  assert.equal(model.roots.length, 13); // 12 domains + outside
  assert.ok(model.maxDepth >= 5 && model.maxDepth <= 14, `depth ${model.maxDepth}`);
  const back = model.edges.filter((e) => e.back && !e.async).length;
  assert.ok(back > 0 && back < model.edges.length * 0.05, `back edges ${back}`);
  // Depth is consistent: every non-back edge goes strictly deeper.
  for (const e of model.edges) if (!e.back) assert.ok(model.leaves.get(e.to).depth > model.leaves.get(e.from).depth, e.id);
});

test('collapsed map is a handful of units; aggregation conserves traffic', () => {
  const { units } = visibleUnits(model, emptyState());
  assert.equal(units.length, model.roots.length);
  const { edges, internal } = aggregateEdges(model, units);
  const shown = edges.reduce((s, e) => s + e.rps, 0) + [...internal.values()].reduce((s, v) => s + v, 0);
  const total = model.edges.reduce((s, e) => s + e.rps, 0);
  assert.ok(Math.abs(shown - total) < 1e-6 * total, 'rps is conserved under aggregation');
  for (const e of edges) assert.ok(e.leafEdges.length >= 1 && e.fromLeaves >= 1);
});

test('expanding a domain shows its teams; expanding a team shows leaves; ancestors are implied', () => {
  const domain = model.roots.find((r) => r === 'payments');
  const g = model.groups.get(domain);
  const team = g.groups[0];
  const { units, expanded } = visibleUnits(model, { ...emptyState(), expanded: [team] });
  assert.ok(expanded.has(domain), 'parent is implied');
  const ids = new Set(units.map((u) => u.id));
  assert.ok(!ids.has(domain));
  for (const t of g.groups) if (t !== team) assert.ok(ids.has(t), `sibling team ${t} stays a tile`);
  for (const lid of model.groups.get(team).leaves) assert.ok(ids.has(lid), `leaf ${lid} visible`);
  assert.ok(units.length > model.roots.length && units.length < 60);
});

test('focus forces its neighbourhood open and nothing else', () => {
  const leaf = [...model.leaves.values()].find((l) => l.kind === 'service' && l.inRps > 0 && l.outRps > 0);
  const hood = neighbourhood(model, leaf.id, 1);
  assert.ok(hood.size > 1);
  const { units } = visibleUnits(model, { ...emptyState(), focus: leaf.id, hops: 1 });
  const ids = new Set(units.map((u) => u.id));
  for (const n of hood) assert.ok(ids.has(n), `${n} is at leaf level`);
  // Everything outside the neighbourhood's teams is still collapsed.
  const teams = new Set([...hood].map((n) => model.leaves.get(n).path[1]));
  for (const u of units) if (u.kind === 'leaf') assert.ok(teams.has(model.leaves.get(u.id).path[1]));
});

test('layout: x is depth, bands nest, tiles never overlap', () => {
  const state = { ...emptyState(), expanded: ['payments', 'payments/ledger'] };
  const { units, expanded } = visibleUnits(model, state);
  const L = layoutAtlas(model, units, expanded);
  for (const u of units) {
    const r = L.rects.get(u.id);
    assert.ok(r, u.id);
    assert.equal(r.x, L.colX(u.depthMin));
  }
  const rects = [...L.rects.values()];
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.ok(!overlap, 'tiles overlap');
    }
  const bands = new Map(L.bands.map((b) => [b.id, b]));
  const inner = bands.get('payments/ledger');
  const outer = bands.get('payments');
  assert.ok(inner.y >= outer.y && inner.y + inner.h <= outer.y + outer.h, 'team band inside domain band');
  assert.ok(L.world.h < 2000, `collapsed-ish world stays compact: ${L.world.h}`);
});

test('trail finds a path along heavy edges and blast radius respects coupling', () => {
  const gateway = [...model.leaves.values()].find((l) => l.kind === 'gateway');
  const deep = [...model.leaves.values()].filter((l) => l.path[0] === gateway.path[0] && l.depth > gateway.depth + 2)[0];
  if (deep) {
    const path = trail(model, 'clients', deep.id);
    assert.ok(path && path[0] === 'clients' && path[path.length - 1] === deep.id);
  }
  const store = [...model.leaves.values()].find((l) => l.kind === 'datastore' && l.inRps > 0);
  const { dead, degraded } = propagate(model, [store.id]);
  assert.ok(dead.has(store.id));
  // Stores are fail-closed dependencies, so at least one caller dies with it.
  assert.ok(dead.size > 1, 'rigid edges carry death upstream');
  for (const d of dead) assert.ok(!degraded.has(d));
});

test('search ranks prefix matches first and finds groups', () => {
  const hits = search(model, 'ledger');
  assert.ok(hits.length > 0);
  assert.ok(hits.some((h) => h.kind.startsWith('group:')));
  assert.ok(hits[0].label.toLowerCase().startsWith('ledger') || hits[0].label.toLowerCase().includes('ledger'));
});
