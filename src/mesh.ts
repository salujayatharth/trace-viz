import type { FlowRecord, FlowTable, NodeFact } from './model.js';
import { mulberry32 } from './particles.js';

export interface MeshOptions {
  seed?: number;
  services?: number;
  /** Environments, in the order you would promote through them. */
  envs?: string[];
  regions?: string[];
  /** Baseline requests per second entering prod in the primary region. */
  baseRps?: number;
  title?: string;
}

interface ServiceSpec {
  name: string;
  team: string;
  apis: string[];
  store: { name: string; engine: string };
}

// Three teams. Each service, and the store it owns, belongs to exactly one, so
// "group by team" draws three neighbourhoods rather than a scatter.
const CATALOG: [string, string, string[]][] = [
  ['orders', 'Payments', ['POST /orders', 'GET /orders/{id}', 'POST /orders/{id}/cancel']],
  ['pricing', 'Payments', ['GET /quote', 'POST /quote/bulk']],
  ['catalog', 'Identity', ['GET /items/{sku}', 'GET /items:search', 'POST /items']],
  ['identity', 'Identity', ['POST /token', 'GET /me', 'POST /introspect']],
  ['payments', 'Payments', ['POST /charges', 'POST /refunds', 'GET /charges/{id}']],
  ['shipping', 'Payments', ['POST /shipments', 'GET /rates']],
  ['inventory', 'Risk', ['GET /stock/{sku}', 'POST /reserve']],
  ['fraud', 'Risk', ['POST /score']],
  ['notify', 'Identity', ['POST /send', 'GET /prefs']],
  ['reviews', 'Risk', ['GET /reviews/{sku}', 'POST /reviews']],
  ['ledger', 'Payments', ['POST /entries', 'GET /balance']],
  ['search', 'Identity', ['GET /search', 'POST /index']],
];

const STORES: [string, string][] = [
  ['orders-db', 'postgres'],
  ['pricing-cache', 'redis'],
  ['catalog-db', 'postgres'],
  ['identity-db', 'postgres'],
  ['payments-db', 'postgres'],
  ['shipping-db', 'postgres'],
  ['inventory-kv', 'dynamo'],
  ['fraud-features', 'cassandra'],
  ['notify-queue', 'kafka'],
  ['reviews-blob', 's3'],
  ['ledger-db', 'postgres'],
  ['search-index', 'clickhouse'],
];

/**
 * A deliberately messy but realistic mesh.
 *
 * Every knob the framework exposes is present in the data: services own several
 * APIs, the same API runs in several environments and regions, dependencies
 * declare whether the caller fails open or closed on them, and every thing
 * carries an engine, a team, an instance count and live CPU and memory. That is
 * the point - a demo where each dimension has exactly one plausible use teaches
 * you nothing about choosing between them.
 */
export function generateMesh(options: MeshOptions = {}): FlowTable {
  const {
    seed = 21,
    services = 12,
    envs = ['prod', 'staging', 'dev'],
    regions = ['eu-west', 'us-east'],
    baseRps = 6400,
    title = 'Messy mesh: 12 services, ~40 APIs, 3 environments, 2 regions',
  } = options;

  const rand = mulberry32(seed);
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

  const specs: ServiceSpec[] = CATALOG.slice(0, services).map(([name, team, apis], i) => ({
    name,
    team,
    apis,
    store: { name: STORES[i % STORES.length]![0], engine: STORES[i % STORES.length]![1] },
  }));

  // Only prod runs everywhere. Lower environments live in the primary region,
  // which is exactly the asymmetry that makes region worth being a dimension.
  const deployments: { env: string; region: string; share: number }[] = [];
  for (const env of envs) {
    for (const region of regions) {
      if (env !== 'prod' && region !== regions[0]) continue;
      const share = env === 'prod' ? (region === regions[0] ? 1 : 0.62) : env === 'staging' ? 0.06 : 0.015;
      deployments.push({ env, region, share });
    }
  }

  const records: FlowRecord[] = [];
  const nodes: NodeFact[] = [];

  const push = (
    from: Record<string, string>,
    to: Record<string, string>,
    dims: Record<string, string>,
    rps: number,
    latencyMs: number,
    errorRate: number,
    bytes: number,
  ): void => {
    records.push({
      from,
      to,
      dims,
      metrics: {
        rps: Math.round(rps * 100) / 100,
        latencyMs: Math.round(latencyMs * 10) / 10,
        errorRate: Math.round(errorRate * 10000) / 10000,
        bytes: Math.round(bytes),
      },
    });
  };

  for (const { env, region, share } of deployments) {
    const scale = baseRps * share;

    // Edge: clients -> gateway -> each public API.
    push(
      { service: 'clients', api: 'browser', kind: 'client' },
      { service: 'gateway', api: 'ingress', kind: 'gateway' },
      { env, region, failure: 'fail-closed', protocol: 'https' },
      scale,
      between(1.5, 3),
      between(0, 0.002),
      820,
    );

    const publicApis = specs.flatMap((s) => s.apis.slice(0, 2).map((api) => ({ service: s.name, api })));
    // Log-normal, not uniform: a handful of APIs carry most of the traffic and
    // a long tail carries almost none, spanning two to three orders of
    // magnitude. That is what production looks like, and it is the contrast
    // the density channel exists to show.
    const weights = publicApis.map(() => Math.exp(between(-2.6, 2.6)));
    const total = weights.reduce((a, b) => a + b, 0);

    // The gateway is hard-wired to the services a request cannot complete
    // without, and deliberately soft on the rest. Getting this wrong - failing
    // closed on everything - is what turns one dead service into a dead site,
    // and the blast-radius view exists to show exactly that.
    const CRITICAL = new Set(['identity', 'orders', 'payments']);
    publicApis.forEach((target, i) => {
      push(
        { service: 'gateway', api: 'ingress', kind: 'gateway' },
        { ...target, kind: 'service' },
        {
          env,
          region,
          failure: CRITICAL.has(target.service) ? 'fail-closed' : 'fail-open',
          protocol: 'https',
        },
        (scale * weights[i]!) / total,
        between(4, 40),
        between(0, 0.01),
        900,
      );
    });

    for (const spec of specs) {
      for (const api of spec.apis) {
        const inbound =
          records.find((r) => r.to.service === spec.name && r.to.api === api && r.dims?.env === env && r.dims?.region === region)
            ?.metrics.rps ?? scale * Math.exp(between(-6, -2.5));

        // Every API touches its own store.
        push(
          { service: spec.name, api, kind: 'service' },
          { service: spec.store.name, api: 'primary', kind: storeKind(spec.store.engine), engine: spec.store.engine },
          { env, region, failure: 'fail-closed', protocol: engineProtocol(spec.store.engine) },
          inbound * between(0.9, 2.4),
          storeLatency(spec.store.engine, between(0.6, 1.4)),
          between(0, 0.006),
          between(300, 5200),
        );

        // Cross-service calls, each with its own failure contract. Most
        // enrichment is genuinely optional, so fail-open is the common case -
        // and those links are the firebreaks that keep one dead service from
        // taking the estate with it.
        const fanout = rand() < 0.55 ? 1 : rand() < 0.8 ? 2 : 0;
        for (let k = 0; k < fanout; k++) {
          const other = specs[Math.floor(rand() * specs.length)]!;
          if (other.name === spec.name) continue;
          const otherApi = other.apis[Math.floor(rand() * other.apis.length)]!;
          const failOpen = rand() < 0.66;
          push(
            { service: spec.name, api, kind: 'service' },
            { service: other.name, api: otherApi, kind: 'service' },
            {
              env,
              region,
              failure: failOpen ? 'fail-open' : 'fail-closed',
              protocol: rand() < 0.7 ? 'grpc' : 'https',
            },
            inbound * between(0.1, 0.9),
            between(3, 70),
            failOpen ? between(0, 0.03) : between(0, 0.012),
            between(200, 2600),
          );
        }
      }
    }

    // Per-thing facts: instances, and how hot they are running.
    for (const spec of specs) {
      const instances = env === 'prod' ? Math.round(between(4, 48)) : env === 'staging' ? 2 : 1;
      nodes.push({
        key: { service: spec.name },
        dims: { env, region, team: spec.team, kind: 'service' },
        attrs: {
          instances,
          cpu: clamp01(between(0.18, env === 'prod' ? 0.94 : 0.4)),
          mem: clamp01(between(0.3, env === 'prod' ? 0.88 : 0.5)),
        },
      });
      nodes.push({
        key: { service: spec.store.name },
        dims: { env, region, engine: spec.store.engine, team: spec.team, kind: storeKind(spec.store.engine) },
        component: componentFor(spec.store.engine),
        attrs: {
          instances: env === 'prod' ? Math.round(between(3, 12)) : 1,
          cpu: clamp01(between(0.25, 0.9)),
          mem: clamp01(between(0.4, 0.95)),
        },
      });
    }
    nodes.push({
      key: { service: 'gateway' },
      dims: { env, region, team: 'Identity', kind: 'gateway' },
      attrs: { instances: env === 'prod' ? 24 : 2, cpu: clamp01(between(0.3, 0.8)), mem: clamp01(between(0.3, 0.7)) },
    });
    nodes.push({
      key: { service: 'clients' },
      dims: { env, region, team: 'Outside', kind: 'client' },
      attrs: { instances: 1, cpu: 0, mem: 0 },
    });
  }

  return {
    version: 1,
    records,
    nodes,
    meta: {
      title,
      window: 'synthetic',
      note: 'Every dimension here is a knob: service, api, env, region, team, engine, protocol, failure.',
    },
  };
}

function storeKind(engine: string): string {
  if (/redis|memcache/.test(engine)) return 'cache';
  if (/kafka|sqs|rabbit/.test(engine)) return 'queue';
  return 'datastore';
}

function componentFor(engine: string): string {
  if (/postgres|mysql|aurora/.test(engine)) return 'db-cylinder';
  if (/cassandra|clickhouse|bigtable/.test(engine)) return 'db-discs';
  if (/dynamo|rocks|kv/.test(engine)) return 'db-cube';
  if (/kafka|pulsar|kinesis/.test(engine)) return 'db-drum';
  if (/redis|memcache/.test(engine)) return 'cache-chip';
  if (/s3|gcs|blob/.test(engine)) return 'blob-bucket';
  return 'db-cylinder';
}

function engineProtocol(engine: string): string {
  if (/redis/.test(engine)) return 'resp';
  if (/kafka/.test(engine)) return 'kafka';
  if (/s3/.test(engine)) return 'https';
  return 'sql';
}

function storeLatency(engine: string, jitter: number): number {
  const base = /redis|memcache/.test(engine)
    ? 0.7
    : /dynamo|kv/.test(engine)
      ? 4
      : /kafka/.test(engine)
        ? 2.5
        : /s3|blob/.test(engine)
          ? 38
          : /clickhouse|cassandra/.test(engine)
            ? 22
            : 9;
  return base * jitter;
}

function clamp01(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
}
