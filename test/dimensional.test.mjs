import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeTable,
  project,
  styleScene,
  layoutWorld,
  fitCamera,
  project3,
  propagateFailure,
  validateSpec,
  heuristicSpec,
  extractJson,
  proposeSpec,
  generateMesh,
  pickComponent,
  COMPONENTS,
  CHANNELS,
  lightTheme,
} from '../dist/index.js';

const table = generateMesh({ seed: 21 });
const schema = describeTable(table);

test('schema reports every dimension with its cardinality', () => {
  const names = schema.dimensions.map((d) => d.name);
  for (const d of ['service', 'api', 'env', 'region', 'failure', 'engine', 'team']) {
    assert.ok(names.includes(d), `missing dimension ${d}`);
  }
  assert.deepEqual(schema.nodeAttrs, ['cpu', 'errorRate', 'instances', 'mem']);
  assert.equal(schema.dimensions.find((d) => d.name === 'region').cardinality, 2);
  assert.equal(schema.dimensions.find((d) => d.name === 'failure').flow, true);
});

test('the node key decides what a box is', () => {
  const byService = project(table, { nodeKey: ['service'] }).scene;
  const byApi = project(table, { nodeKey: ['service', 'api'] }).scene;
  const byRegion = project(table, { nodeKey: ['region', 'service'] }).scene;
  assert.ok(byApi.nodes.length > byService.nodes.length, 'per-api must be finer than per-service');
  assert.equal(byRegion.nodes.length, byService.nodes.length * 2, 'two regions doubles the nodes');
});

test('binding a dimension to an edge channel splits edges by it instead of averaging', () => {
  const plain = project(table, { nodeKey: ['service'], where: { env: ['prod'] } });
  const coloured = project(table, {
    nodeKey: ['service'],
    where: { env: ['prod'] },
    channels: { hue: { field: 'region' } },
  });
  assert.ok(coloured.splitBy.includes('region'));
  assert.ok(coloured.scene.edges.length > plain.scene.edges.length);
  // Every split edge must carry exactly one value of the split dimension.
  for (const e of coloured.scene.edges) assert.equal(typeof e.dims.region, 'string');
});

test('measures aggregate by kind: throughput sums, latency is throughput-weighted', () => {
  const t = {
    records: [
      { from: { service: 'a', api: 'x' }, to: { service: 'b', api: 'y' }, metrics: { rps: 1000, latencyMs: 2 } },
      { from: { service: 'a', api: 'z' }, to: { service: 'b', api: 'y' }, metrics: { rps: 1, latencyMs: 900 } },
    ],
  };
  const { scene } = project(t, { nodeKey: ['service'] });
  assert.equal(scene.edges.length, 1);
  assert.equal(scene.edges[0].metrics.rps, 1001);
  // The naive mean would be 451ms. The honest answer is ~2.9ms.
  assert.ok(scene.edges[0].metrics.latencyMs < 5, `got ${scene.edges[0].metrics.latencyMs}`);
});

test('filters remove records rather than hiding them after the fact', () => {
  const all = project(table, { nodeKey: ['service'] });
  const prod = project(table, { nodeKey: ['service'], where: { env: ['prod'] } });
  assert.ok(prod.matched < all.matched);
  assert.equal(prod.matched + prod.filtered, table.records.length);
});

test('focus expands one service into its APIs and leaves the rest collapsed', () => {
  const base = project(table, { nodeKey: ['service'] }).scene;
  const focused = project(table, {
    nodeKey: ['service'],
    focus: { match: { service: 'orders' }, expandBy: ['api'] },
  }).scene;
  assert.ok(focused.nodes.length > base.nodes.length);
  const expanded = focused.nodes.filter((n) => n.id.startsWith('orders / '));
  assert.ok(expanded.length >= 2, 'orders should have exploded into several APIs');
  assert.ok(focused.nodes.some((n) => n.id === 'pricing'), 'other services must stay collapsed');
});

test('node facts attach at whatever resolution the projection uses', () => {
  const { scene } = project(table, { nodeKey: ['service'], where: { env: ['prod'], region: ['eu-west'] } });
  const gateway = scene.nodes.find((n) => n.id === 'gateway');
  assert.ok(gateway.attrs.instances > 1);
  assert.ok(gateway.attrs.cpu > 0 && gateway.attrs.cpu <= 1);
  const store = scene.nodes.find((n) => n.id === 'notify-queue');
  assert.equal(store.component, 'db-drum');
});

test('a channel refuses a dimension it cannot show, and says so', () => {
  const spec = { nodeKey: ['service'], channels: { hue: { field: 'api' } } };
  const { scene } = project(table, spec);
  const styled = styleScene(scene, spec, lightTheme);
  assert.ok(styled.issues.some((i) => i.includes('too many')), styled.issues.join('; '));
});

test('distance is an encoding: bound to a measure it changes the layout', () => {
  const spec = { nodeKey: ['service'], where: { env: ['prod'] }, channels: { distance: { field: 'rps' } } };
  const { scene } = project(table, spec);
  const styled = styleScene(scene, spec, lightTheme);
  const attractions = [...styled.edges.values()].map((e) => e.attraction);
  assert.ok(Math.max(...attractions) - Math.min(...attractions) > 0.2, 'attraction must vary with rps');

  const tight = layoutWorld(scene, { attractionOf: (id) => styled.edges.get(id)?.attraction ?? 0.5 });
  const flat = layoutWorld(scene, { attractionOf: () => 0.5 });
  const moved = [...tight].some(([id, n]) => Math.abs(n.x - flat.get(id).x) > 0.05);
  assert.ok(moved, 'binding distance must actually move things');
});

test('world layout is deterministic and tiers services above datastores', () => {
  const { scene } = project(table, { nodeKey: ['service'], where: { env: ['prod'], region: ['eu-west'] } });
  const a = layoutWorld(scene, {});
  const b = layoutWorld(scene, {});
  for (const [id, n] of a) assert.deepEqual([n.x, n.y, n.z], [b.get(id).x, b.get(id).y, b.get(id).z]);

  // Three default planes: edge (0), services (1), data (2).
  const svc = [...a.values()].filter((n) => n.tier === 1);
  const db = [...a.values()].filter((n) => n.tier === 2);
  assert.ok(svc.length && db.length);
  assert.ok(Math.min(...svc.map((n) => n.y)) > Math.max(...db.map((n) => n.y)), 'services sit above datastores');
});

test('the camera projects the world inside its box', () => {
  const { scene } = project(table, { nodeKey: ['service'], where: { env: ['prod'], region: ['eu-west'] } });
  const world = layoutWorld(scene, {});
  const cam = fitCamera(world, 900, 600, 0.62);
  for (const n of world.values()) {
    const p = project3(n, cam);
    assert.ok(p.x >= -20 && p.x <= 920, `x out of frame: ${p.x}`);
    assert.ok(p.y >= -20 && p.y <= 620, `y out of frame: ${p.y}`);
  }
});

test('fail-open links are firebreaks; fail-closed links carry death', () => {
  const spec = {
    nodeKey: ['service'],
    where: { env: ['prod'], region: ['eu-west'] },
    channels: { coupling: { field: 'failure' } },
  };
  const { scene } = project(table, spec);
  const styled = styleScene(scene, spec, lightTheme);

  const contained = propagateFailure(scene, ['fraud'], styled.edges, true);
  const deadContained = [...contained.health.values()].filter((v) => v === 'dead').length;
  assert.ok(deadContained <= 2, `an optional dependency should not kill the estate, killed ${deadContained}`);
  assert.ok(contained.firebreaks.length > 0, 'a fail-open link should have stopped the front');

  const critical = propagateFailure(scene, ['identity'], styled.edges, true);
  const deadCritical = [...critical.health.values()].filter((v) => v === 'dead').length;
  assert.ok(deadCritical > deadContained, 'a fail-closed dependency must propagate further');
  assert.equal(critical.health.get('gateway'), 'dead');
});

test('failure propagation terminates on a cycle', () => {
  const t = {
    records: [
      { from: { service: 'a' }, to: { service: 'b' }, dims: { failure: 'fail-closed' }, metrics: { rps: 1 } },
      { from: { service: 'b' }, to: { service: 'c' }, dims: { failure: 'fail-closed' }, metrics: { rps: 1 } },
      { from: { service: 'c' }, to: { service: 'a' }, dims: { failure: 'fail-closed' }, metrics: { rps: 1 } },
    ],
  };
  const spec = { nodeKey: ['service'], channels: { coupling: { field: 'failure' } } };
  const { scene } = project(t, spec);
  const styled = styleScene(scene, spec, lightTheme);
  const f = propagateFailure(scene, ['a'], styled.edges, true);
  assert.equal([...f.health.values()].filter((v) => v === 'dead').length, 3);
});

test('components are picked from the engine, then the kind', () => {
  const node = (over) => ({ id: 'x', label: 'x', kind: 'service', key: {}, spans: {}, attrs: {}, inboundRps: 0, outboundRps: 0, records: 1, ...over });
  assert.equal(pickComponent(node({ kind: 'cache' })), 'cache-chip');
  assert.equal(pickComponent(node({ spans: { engine: ['kafka'] }, kind: 'queue' })), 'db-drum');
  assert.equal(pickComponent(node({ spans: { engine: ['postgres'] }, kind: 'datastore' })), 'db-cylinder');
  assert.equal(pickComponent(node({ spans: { engine: ['clickhouse'] }, kind: 'datastore' })), 'db-discs');
  assert.equal(pickComponent(node({}), 'db-cube'), 'db-cube');
  for (const c of Object.values(COMPONENTS)) assert.equal(typeof c.draw, 'function');
});

test('a model proposal is validated field by field, not trusted', () => {
  const { spec, issues } = validateSpec(
    {
      nodeKey: ['service', 'nonsense'],
      where: { env: ['prod'], bogus: ['x'] },
      channels: {
        hue: { field: 'region' },
        glyph: { field: 'api' },
        invented: { field: 'service' },
        speed: { field: 'team' },
      },
      world: { componentMap: { postgres: 'db-cylinder', redis: 'not-a-component' } },
      mode: 'world',
    },
    schema,
  );
  assert.deepEqual(spec.nodeKey, ['service']);
  assert.deepEqual(spec.where, { env: ['prod'] });
  assert.deepEqual(Object.keys(spec.channels), ['hue']);
  assert.deepEqual(spec.world.componentMap, { postgres: 'db-cylinder' });
  assert.equal(spec.mode, 'world');
  assert.ok(issues.length >= 5, issues.join('; '));
});

test('proposeSpec falls back to the heuristic when the model misbehaves', async () => {
  const junk = await proposeSpec('show services by region', {
    schema,
    complete: async () => 'I think you should look at the services, honestly.',
  });
  assert.equal(junk.source, 'fallback');
  assert.ok(junk.spec.nodeKey.length);

  const broken = await proposeSpec('show services', {
    schema,
    complete: async () => {
      throw new Error('429');
    },
  });
  assert.equal(broken.source, 'fallback');
  assert.ok(broken.issues[0].includes('429'));

  const good = await proposeSpec('colour by region', {
    schema,
    complete: async () => '```json\n{"nodeKey":["service"],"channels":{"hue":{"field":"region"}}}\n```',
  });
  assert.equal(good.source, 'model');
  assert.equal(good.spec.channels.hue.field, 'region');
});

test('extractJson survives prose and fences around the object', () => {
  assert.deepEqual(extractJson('sure!\n```json\n{"a":1}\n```\nhope that helps'), { a: 1 });
  assert.deepEqual(extractJson('{"a":{"b":"}"},"c":2}'), { a: { b: '}' }, c: 2 });
  assert.equal(extractJson('no object here'), null);
});

test('the heuristic reads a request without a model', () => {
  const world = heuristicSpec('show me the world with instances and cpu', schema);
  assert.equal(world.mode, 'world');
  assert.equal(world.world.instances, 'instances');
  const blast = heuristicSpec('what fails if identity goes down', schema);
  assert.equal(blast.channels.coupling.field, 'failure');
  const apis = heuristicSpec('break services out by api', schema);
  assert.deepEqual(apis.nodeKey, ['service', 'api']);
});

test('every registered channel is documented and reachable', () => {
  for (const [name, def] of Object.entries(CHANNELS)) {
    assert.equal(def.name, name);
    assert.ok(def.summary.length > 20, `${name} needs a real summary`);
    assert.ok(['edge', 'node'].includes(def.target));
  }
});
