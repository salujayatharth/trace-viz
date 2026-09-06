import { mulberry32 } from './particles.js';
import type { EdgeKind, Graph, GraphEdge, GraphNode, NodeKind } from './types.js';

export interface SeedOptions {
  /** Same seed, same graph. Always. */
  seed?: number;
  /** How many application services to generate between the gateway and the data tier. */
  services?: number;
  datastores?: number;
  /** Roughly how many extra service-to-service calls beyond the spine. */
  extraCalls?: number;
  /** Baseline requests per second entering at the client. */
  baseRps?: number;
  /** Give a few edges a visible error rate. */
  withErrors?: boolean;
  title?: string;
}

const SERVICE_NAMES = [
  'orders', 'pricing', 'catalog', 'search', 'identity', 'payments', 'shipping',
  'inventory', 'reviews', 'notify', 'fraud', 'ledger', 'geo', 'recs', 'billing',
];
const STORE_NAMES = ['orders-db', 'user-db', 'events', 'blob-store', 'ledger-db'];

/**
 * Generate a plausible random topology. Deterministic for a given seed, so the
 * README screenshots and the test fixtures never drift.
 */
export function generateSeedGraph(options: SeedOptions = {}): Graph {
  const {
    seed = 42,
    services = 6,
    datastores = 2,
    extraCalls = 4,
    baseRps = 4200,
    withErrors = true,
    title = 'Randomly generated topology',
  } = options;

  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);

  const nodes: GraphNode[] = [
    { id: 'client', label: 'Clients', kind: 'client', layer: 0 },
    { id: 'edge-lb', label: 'Edge LB', kind: 'gateway', layer: 1 },
    { id: 'gateway', label: 'API gateway', kind: 'gateway', layer: 2 },
  ];

  const serviceIds: string[] = [];
  const names = [...SERVICE_NAMES];
  for (let i = 0; i < services; i++) {
    void i;
    const idx = Math.floor(rand() * names.length);
    const name = names.splice(idx, 1)[0] ?? `svc-${i}`;
    serviceIds.push(name);
    nodes.push({ id: name, label: name, kind: 'service' as NodeKind });
  }

  const storeIds: string[] = [];
  const stores = [...STORE_NAMES];
  for (let i = 0; i < datastores; i++) {
    const idx = Math.floor(rand() * stores.length);
    const name = stores.splice(idx, 1)[0] ?? `store-${i}`;
    storeIds.push(name);
    nodes.push({ id: name, label: name, kind: 'datastore' });
  }
  nodes.push({ id: 'cache', label: 'redis', kind: 'cache' });

  const edges: GraphEdge[] = [
    edge('client', 'edge-lb', baseRps, between(1, 3), 'request'),
    edge('edge-lb', 'gateway', baseRps * 0.99, between(1, 4), 'request'),
  ];

  // Gateway fans out to services, splitting traffic unevenly (real traffic is
  // never uniform, and a uniform picture teaches the wrong intuition).
  const weights = serviceIds.map(() => between(0.4, 3));
  const total = weights.reduce((a, b) => a + b, 0);
  serviceIds.forEach((id, i) => {
    const rps = (baseRps * 0.99 * weights[i]!) / total;
    edges.push(edge('gateway', id, rps, between(4, 60), 'request', errorFor(withErrors, rand)));
  });

  // Each service reads something. Stores are assigned round-robin rather than
  // at random, so no datastore ends up orphaned with nothing pointing at it.
  for (const [si, id] of serviceIds.entries()) {
    const target = rand() < 0.4 ? 'cache' : (storeIds[si % storeIds.length] ?? 'cache');
    const fanout = between(0.8, 2.6);
    const inbound = edges.find((e) => e.to === id)?.metrics.rps ?? 100;
    edges.push(
      edge(
        id,
        target,
        inbound * fanout,
        target === 'cache' ? between(0.4, 2) : between(6, 120),
        'request',
        errorFor(withErrors, rand),
      ),
    );
  }

  // A few service-to-service calls, which is where the interesting coupling is.
  for (let i = 0; i < extraCalls && serviceIds.length > 1; i++) {
    const from = pick(serviceIds);
    let to = pick(serviceIds);
    if (to === from) to = serviceIds[(serviceIds.indexOf(from) + 1) % serviceIds.length]!;
    const inbound = edges.find((e) => e.to === from)?.metrics.rps ?? 80;
    edges.push(edge(from, to, inbound * between(0.15, 0.9), between(5, 90), 'request', errorFor(withErrors, rand)));
  }

  // Drop anything nothing points at and that points at nothing. An orphan node
  // is not a topology, it is a layout artefact.
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.from);
    connected.add(e.to);
  }

  return {
    version: 1,
    nodes: nodes.filter((n) => connected.has(n.id)),
    edges,
    meta: { title, window: 'synthetic', generatedAt: new Date(0).toISOString(), seed },
  };
}

function errorFor(enabled: boolean, rand: () => number): number {
  if (!enabled) return 0;
  return rand() < 0.25 ? rand() * 0.06 : rand() * 0.004;
}

function edge(
  from: string,
  to: string,
  rps: number,
  latencyMs: number,
  kind: EdgeKind = 'request',
  errorRate = 0,
  bytes = 1400,
): GraphEdge {
  return {
    from,
    to,
    kind,
    metrics: {
      rps: Math.round(rps * 10) / 10,
      latencyMs: Math.round(latencyMs * 10) / 10,
      errorRate: Math.round(errorRate * 10000) / 10000,
      bytes,
    },
  };
}

/**
 * The worked example: an API whose auth is a per-request 401 challenge.
 *
 * Every client call costs two round trips, the second of which has to validate
 * a password with a deliberately slow KDF, and the challenge nonce lives in a
 * shared store that now sits on the hot path. The challenge and retry legs are
 * tagged as such, so they render as dashed reverse lanes: visibly, half the
 * traffic turns around before reaching the data tier.
 */
export function authChallengeScenario(clientRps = 5000): Graph {
  return {
    version: 1,
    nodes: [
      { id: 'client', label: 'Clients', kind: 'client', layer: 0 },
      { id: 'lb', label: 'Load balancer', kind: 'gateway', layer: 1 },
      { id: 'api-1', label: 'api-1', kind: 'service', layer: 2 },
      { id: 'api-2', label: 'api-2', kind: 'service', layer: 2 },
      { id: 'nonce', label: 'nonce store', kind: 'cache', layer: 3 },
      { id: 'users', label: 'user-db', kind: 'datastore', layer: 3 },
      { id: 'orders', label: 'orders-db', kind: 'datastore', layer: 4 },
    ],
    edges: [
      { from: 'client', to: 'lb', label: 'unauthenticated attempt', kind: 'request', metrics: { rps: clientRps, latencyMs: 2, bytes: 700 } },
      { from: 'lb', to: 'api-1', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3, bytes: 700 } },
      { from: 'lb', to: 'api-2', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3, bytes: 700 } },
      { from: 'api-1', to: 'nonce', label: 'issue nonce', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 1.4, bytes: 120 } },
      { from: 'api-2', to: 'nonce', label: 'issue nonce', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 1.4, bytes: 120 } },
      { from: 'lb', to: 'client', label: '401 challenge', kind: 'challenge', metrics: { rps: clientRps, latencyMs: 4, bytes: 320 } },
      { from: 'client', to: 'lb', id: 'retry', label: 'retry with credentials', kind: 'retry', metrics: { rps: clientRps, latencyMs: 2, bytes: 900 } },
      { from: 'api-1', to: 'users', label: 'verify password (KDF)', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 82, errorRate: 0.012, bytes: 400 } },
      { from: 'api-2', to: 'users', label: 'verify password (KDF)', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 82, errorRate: 0.012, bytes: 400 } },
      { from: 'api-1', to: 'nonce', id: 'nonce-check-1', label: 'validate nonce (cross-node)', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3.5, errorRate: 0.09, bytes: 120 } },
      { from: 'api-2', to: 'nonce', id: 'nonce-check-2', label: 'validate nonce (cross-node)', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3.5, errorRate: 0.09, bytes: 120 } },
      { from: 'api-1', to: 'orders', label: 'actual work', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 11, bytes: 4200 } },
      { from: 'api-2', to: 'orders', label: 'actual work', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 11, bytes: 4200 } },
    ],
    meta: {
      title: 'Per-request 401 challenge',
      window: 'modelled',
      note: 'Every useful call costs two round trips and one password KDF.',
    },
  };
}

/** The same system after the challenge is amortised into a bearer token. */
export function tokenAuthScenario(clientRps = 5000): Graph {
  const refresh = clientRps * 0.004; // one challenge per ~15 min session
  return {
    version: 1,
    nodes: [
      { id: 'client', label: 'Clients', kind: 'client', layer: 0 },
      { id: 'lb', label: 'Load balancer', kind: 'gateway', layer: 1 },
      { id: 'api-1', label: 'api-1', kind: 'service', layer: 2 },
      { id: 'api-2', label: 'api-2', kind: 'service', layer: 2 },
      { id: 'authz', label: 'token issuer', kind: 'service', layer: 3 },
      { id: 'users', label: 'user-db', kind: 'datastore', layer: 4 },
      { id: 'orders', label: 'orders-db', kind: 'datastore', layer: 4 },
    ],
    edges: [
      { from: 'client', to: 'lb', label: 'request with bearer token', kind: 'request', metrics: { rps: clientRps, latencyMs: 2, bytes: 900 } },
      { from: 'lb', to: 'api-1', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3, bytes: 900 } },
      { from: 'lb', to: 'api-2', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 3, bytes: 900 } },
      { from: 'client', to: 'authz', label: 'token refresh (amortised)', kind: 'request', metrics: { rps: refresh, latencyMs: 95, bytes: 700 } },
      { from: 'authz', to: 'users', label: 'verify password (KDF)', kind: 'request', metrics: { rps: refresh, latencyMs: 82, errorRate: 0.012, bytes: 400 } },
      { from: 'api-1', to: 'orders', label: 'actual work', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 11, bytes: 4200 } },
      { from: 'api-2', to: 'orders', label: 'actual work', kind: 'request', metrics: { rps: clientRps / 2, latencyMs: 11, bytes: 4200 } },
    ],
    meta: {
      title: 'Token auth, verified in-process',
      window: 'modelled',
      note: 'Signature check is microseconds and touches no shared state.',
    },
  };
}
