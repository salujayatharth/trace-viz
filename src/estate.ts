import type { FlowRecord, FlowTable, NodeFact } from './model.js';
import { mulberry32 } from './particles.js';

/**
 * A synthetic estate at the scale Atlas is built for: hundreds of services in
 * an ownership tree (domain › team › service), sync calls between them, and
 * Kafka topics with producers, consumer groups and lag.
 *
 * The shape matters more than the numbers. Traffic is log-normal (a few hot
 * paths, a long tail), most calls stay inside a team, a platform domain is
 * called from everywhere, depth runs edge → app → core → data, a handful of
 * cycles exist because they always do, one service is sick and one is on
 * fire, and a few topics are backed up. Every one of those is something the
 * map has to make visible without being told where to look.
 */
export interface EstateOptions {
  seed?: number;
  /** Total services (excluding topics and the single client node). */
  services?: number;
  /** Kafka topics. */
  topics?: number;
  regions?: string[];
  baseRps?: number;
  title?: string;
}

type Tier = 'edge' | 'app' | 'core' | 'data';
const TIERS: Tier[] = ['edge', 'app', 'core', 'data'];

interface Svc {
  name: string;
  domain: string;
  team: string;
  tier: Tier;
  kind: string;
  role: string;
  engine?: string;
  /** Position on the request path: 0 edge … 6 data. Calls only go to a higher level, which bounds depth. */
  level: number;
  inbound: number;
  index: number;
}

interface Topic {
  name: string;
  domain: string;
  team: string;
  partitions: number;
}

const DOMAINS: [string, string[]][] = [
  ['identity', ['auth', 'accounts', 'sessions', 'consent']],
  ['payments', ['ledger', 'checkout', 'refunds', 'payouts', 'fraud-signals']],
  ['risk', ['scoring', 'rules', 'review', 'chargebacks']],
  ['marketplace', ['catalog', 'listings', 'sellers', 'reviews', 'media']],
  ['orders', ['orders-core', 'cart', 'fulfilment', 'returns']],
  ['logistics', ['dispatch', 'routing', 'tracking', 'carriers', 'warehouse']],
  ['comms', ['notify', 'email', 'push', 'templates']],
  ['search', ['query', 'indexing', 'ranking', 'suggest']],
  ['pricing', ['quotes', 'promotions', 'tax', 'fx']],
  ['growth', ['experiments', 'campaigns', 'referrals', 'loyalty']],
  ['platform', ['config', 'flags', 'observability', 'secrets', 'scheduler', 'api-gateway']],
  ['data', ['ingest', 'warehouse', 'features', 'ml-serving', 'lineage']],
];

const ROLES: Record<Tier, string[]> = {
  edge: ['bff', 'api', 'gateway', 'graphql', 'webhooks'],
  app: ['service', 'orchestrator', 'handler', 'router', 'worker', 'sync', 'dispatcher', 'projector'],
  core: ['engine', 'ledger', 'matcher', 'scorer', 'rules', 'calculator', 'validator', 'resolver', 'state'],
  data: ['db', 'store', 'index', 'cache', 'kv', 'blob', 'timeseries'],
};

const ENGINES: Record<string, string> = {
  db: 'postgres',
  store: 'cassandra',
  index: 'elasticsearch',
  cache: 'redis',
  kv: 'dynamo',
  blob: 's3',
  timeseries: 'clickhouse',
};

export function generateEstate(options: EstateOptions = {}): FlowTable {
  const {
    seed = 7,
    services: serviceCount = 600,
    topics: topicCount = 80,
    regions = ['eu-west', 'us-east'],
    baseRps = 42000,
    title = `Estate: ${serviceCount} services, ${topicCount} topics, ${DOMAINS.length} domains`,
  } = options;

  const rand = mulberry32(seed);
  const between = (lo: number, hi: number): number => lo + rand() * (hi - lo);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const lognormal = (mu: number, sigma: number): number => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.exp(mu + sigma * z);
  };

  // --- services --------------------------------------------------------------
  const svcs: Svc[] = [];
  const used = new Set<string>();
  const uniq = (base: string): string => {
    let n = base;
    let i = 2;
    while (used.has(n)) n = `${base}-${i++}`;
    used.add(n);
    return n;
  };

  const teams: { domain: string; team: string }[] = DOMAINS.flatMap(([d, ts]) => ts.map((t) => ({ domain: d, team: t })));
  // Team sizes are uneven on purpose: a couple of big teams per domain, a
  // long tail of small ones.
  const teamWeights = teams.map(() => lognormal(0, 0.6));
  const wsum = teamWeights.reduce((a, b) => a + b, 0);
  let remaining = serviceCount;
  teams.forEach((t, i) => {
    const want = i === teams.length - 1 ? remaining : Math.max(3, Math.round((serviceCount * teamWeights[i]!) / wsum));
    const n = Math.min(want, remaining);
    remaining -= n;
    for (let k = 0; k < n; k++) {
      const r = rand();
      const tier: Tier = k === 0 ? 'edge' : r < 0.36 ? 'app' : r < 0.74 ? 'core' : 'data';
      const role = pick(ROLES[tier]);
      const name = uniq(`${t.team}-${role}`);
      const kind =
        tier === 'data' ? (role === 'cache' ? 'cache' : 'datastore') : tier === 'edge' && role === 'gateway' ? 'gateway' : 'service';
      const level = tier === 'edge' ? 0 : tier === 'app' ? 1 + Math.floor(rand() * 2) : tier === 'core' ? 3 + Math.floor(rand() * 3) : 6;
      svcs.push({
        name,
        domain: t.domain,
        team: t.team,
        tier,
        kind,
        role,
        ...(tier === 'data' ? { engine: ENGINES[role] ?? 'postgres' } : {}),
        level,
        inbound: 0,
        index: 0,
      });
    }
  });

  // A strict order so the call graph is a DAG by construction: tier first,
  // then a shuffle. A few deliberate back-edges are added afterwards.
  svcs.sort((a, b) => a.level - b.level || rand() - 0.5);
  svcs.forEach((s, i) => (s.index = i));
  const byName = new Map(svcs.map((s) => [s.name, s]));
  const byTeam = new Map<string, Svc[]>();
  const byDomain = new Map<string, Svc[]>();
  for (const s of svcs) {
    byTeam.set(s.team, [...(byTeam.get(s.team) ?? []), s]);
    byDomain.set(s.domain, [...(byDomain.get(s.domain) ?? []), s]);
  }
  const platform = byDomain.get('platform')!.filter((s) => s.tier !== 'data');
  const hubs = platform.filter((s) => /config|flags|secrets|auth/.test(s.name)).concat(byTeam.get('auth')!.filter((s) => s.tier !== 'data'));

  // --- health ----------------------------------------------------------------
  const nonData = svcs.filter((s) => s.tier !== 'data' && s.tier !== 'edge');
  const sick = new Set<string>();
  while (sick.size < 6) sick.add(pick(nonData).name);
  const burning = new Set<string>();
  while (burning.size < 2) {
    const s = pick(nonData).name;
    if (!sick.has(s)) burning.add(s);
  }
  const errorFor = (target: string, healthy: number): number =>
    burning.has(target) ? between(0.12, 0.3) : sick.has(target) ? between(0.02, 0.05) : healthy;
  const latencyFor = (t: Tier): number =>
    t === 'edge' ? between(5, 20) : t === 'app' ? between(8, 60) : t === 'core' ? between(4, 40) : between(1, 8);

  // --- calls -------------------------------------------------------------------
  type Call = { from: Svc; to: Svc; api: string; rps: number; failure: string; protocol: string; back?: boolean };
  const calls: Call[] = [];
  const edgeCount = new Map<string, number>();
  const link = (from: Svc, to: Svc, rps: number, back = false): void => {
    if (from === to) return;
    const k = `${from.name}>${to.name}`;
    if (edgeCount.has(k)) return;
    edgeCount.set(k, 1);
    const sameTeam = from.team === to.team;
    const failure =
      to.tier === 'data' ? 'fail-closed' : sameTeam ? (rand() < 0.6 ? 'fail-closed' : 'fail-open') : rand() < 0.3 ? 'fail-closed' : 'fail-open';
    const api = to.tier === 'data' ? (to.role === 'cache' ? 'get' : to.role === 'blob' ? 'put' : 'query') : pick(['get', 'list', 'create', 'update', 'search', 'resolve', 'evaluate']);
    calls.push({ from, to, api, rps, failure, protocol: to.tier === 'data' ? to.engine! : rand() < 0.7 ? 'grpc' : 'http', back });
    to.inbound += rps;
  };

  // Ingress: clients hit every domain's edge services, unevenly.
  const clients: Svc = { name: 'clients', domain: 'outside', team: 'outside', tier: 'edge', kind: 'client', role: 'client', level: -1, inbound: 0, index: -1 };
  const domainWeight = new Map(DOMAINS.map(([d]) => [d, lognormal(0, 0.9)]));
  const dsum = [...domainWeight.values()].reduce((a, b) => a + b, 0);
  for (const s of svcs) {
    if (s.tier !== 'edge') continue;
    const teamEdges = byTeam.get(s.team)!.filter((x) => x.tier === 'edge').length;
    const share = (domainWeight.get(s.domain)! / dsum) / DOMAINS.find(([d]) => d === s.domain)![1].length / teamEdges;
    link(clients, s, baseRps * share * between(0.6, 1.4));
  }

  for (const s of svcs) {
    if (s.tier === 'data') continue;
    // Anything nobody calls still does work: a cron, a consumer, a job.
    if (s.inbound === 0) s.inbound = lognormal(1.5, 1);
    const fan = s.tier === 'edge' ? 2 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 3);
    for (let k = 0; k < fan; k++) {
      const r = rand();
      let pool: Svc[];
      if (r < 0.62) pool = byTeam.get(s.team)!;
      else if (r < 0.82) pool = byDomain.get(s.domain)!;
      else if (r < 0.94) pool = hubs;
      else pool = svcs;
      const later = pool.filter((t) => t.level > s.level && (t.tier !== 'data' || t.team === s.team || rand() < 0.05));
      if (!later.length) continue;
      link(s, pick(later), s.inbound * between(0.15, 1.6));
    }
    // Every app/core service owns some data.
    if (s.tier !== 'edge') {
      const stores = byTeam.get(s.team)!.filter((t) => t.tier === 'data');
      if (stores.length) link(s, pick(stores), s.inbound * between(0.8, 2.5));
    }
  }
  // Back-edges: callbacks and status polls that go against the grain.
  for (let i = 0; i < Math.round(svcs.length * 0.012); i++) {
    const a = pick(nonData);
    const earlier = nonData.filter((t) => t.level < a.level && t.domain === a.domain);
    if (earlier.length) link(a, pick(earlier), a.inbound * between(0.02, 0.1), true);
  }

  // --- kafka -------------------------------------------------------------------
  const topics: Topic[] = [];
  const topicNames = new Set<string>();
  const producerPool = svcs.filter((s) => s.tier === 'app' || s.tier === 'core');
  type Produce = { from: Svc; topic: Topic; rps: number };
  type Consume = { topic: Topic; to: Svc; group: string; rps: number; lag: number };
  const produces: Produce[] = [];
  const consumes: Consume[] = [];
  const topicLag = new Map<string, number>();
  const events = ['created', 'updated', 'completed', 'failed', 'events', 'changes', 'snapshots', 'audit', 'metrics', 'commands'];
  for (let i = 0; i < topicCount; i++) {
    const owner = pick(producerPool);
    let name = `${owner.team}.${pick(events)}`;
    let n = 2;
    while (topicNames.has(name)) name = `${owner.team}.${pick(events)}.v${n++}`;
    topicNames.add(name);
    const topic: Topic = { name, domain: owner.domain, team: owner.team, partitions: pick([3, 6, 12, 24, 48]) };
    topics.push(topic);
    const producers = new Set<Svc>([owner]);
    if (rand() < 0.35) producers.add(pick(byTeam.get(owner.team)!.filter((s) => s.tier !== 'data')) ?? owner);
    let produced = 0;
    for (const p of producers) {
      const rps = Math.max(0.2, p.inbound * between(0.1, 1.2));
      produces.push({ from: p, topic, rps });
      produced += rps;
    }
    const groups = 1 + Math.floor(rand() * 4);
    const backedUp = rand() < 0.15;
    let lag = 0;
    const seen = new Set<string>();
    for (let g = 0; g < groups; g++) {
      const r = rand();
      const pool = r < 0.45 ? byDomain.get(owner.domain)! : svcs;
      const c = pick(pool.filter((s) => (s.tier === 'app' || s.tier === 'core') && s.team !== owner.team));
      if (!c || seen.has(c.name)) continue;
      seen.add(c.name);
      const slow = backedUp && g === 0;
      const rate = produced * (slow ? between(0.45, 0.85) : between(0.97, 1.0));
      const l = slow ? Math.round(lognormal(12, 1)) : Math.round(lognormal(4, 1.2));
      lag += l;
      consumes.push({ topic, to: c, group: `${c.name}-cg`, rps: rate, lag: l });
      c.inbound += rate;
    }
    topicLag.set(name, lag);
  }

  // --- emit --------------------------------------------------------------------
  const records: FlowRecord[] = [];
  const nodes: NodeFact[] = [];
  const regionShare = regions.map((_, i) => (i === 0 ? 1 : between(0.4, 0.8)));
  const total = regionShare.reduce((a, b) => a + b, 0);
  const r4 = (x: number): number => Math.round(x * 10000) / 10000;

  regions.forEach((region, ri) => {
    const share = regionShare[ri]! / total;
    for (const c of calls) {
      records.push({
        from: { service: c.from.name, api: c.from.tier === 'edge' ? 'ingress' : 'call' },
        to: { service: c.to.name, api: c.api },
        dims: { env: 'prod', region, transport: 'sync', protocol: c.protocol, failure: c.failure },
        metrics: {
          rps: Math.round(c.rps * share * 100) / 100,
          latencyMs: Math.round(latencyFor(c.to.tier) * 10) / 10,
          errorRate: r4(errorFor(c.to.name, between(0, 0.003))),
          bytes: Math.round(between(200, 6000)),
        },
      });
    }
    for (const p of produces) {
      records.push({
        from: { service: p.from.name, api: 'produce' },
        to: { service: p.topic.name, api: 'produce' },
        dims: { env: 'prod', region, transport: 'kafka', protocol: 'kafka', failure: 'fail-open' },
        metrics: { rps: Math.round(p.rps * share * 100) / 100, latencyMs: Math.round(between(2, 12) * 10) / 10, errorRate: r4(between(0, 0.001)), bytes: Math.round(between(300, 4000)) },
      });
    }
    for (const c of consumes) {
      records.push({
        from: { service: c.topic.name, api: c.group },
        to: { service: c.to.name, api: 'consume' },
        dims: { env: 'prod', region, transport: 'kafka', protocol: 'kafka', failure: 'fail-open', group: c.group },
        metrics: { rps: Math.round(c.rps * share * 100) / 100, latencyMs: Math.round(between(5, 80) * 10) / 10, errorRate: r4(errorFor(c.to.name, between(0, 0.004))), bytes: Math.round(between(300, 4000)), lag: Math.round(c.lag * share) },
      });
    }
  });

  for (const s of svcs) {
    nodes.push({
      key: { service: s.name },
      dims: { domain: s.domain, team: s.team, kind: s.kind, tier: s.tier, role: s.role, ...(s.engine ? { engine: s.engine } : {}) },
      attrs: { instances: s.tier === 'data' ? Math.round(between(3, 9)) : Math.round(lognormal(2.2, 0.7)), cpu: between(0.1, 0.9), mem: between(0.2, 0.9) },
    });
  }
  for (const t of topics) {
    nodes.push({
      key: { service: t.name },
      dims: { domain: t.domain, team: t.team, kind: 'topic', tier: 'core', role: 'topic' },
      attrs: { partitions: t.partitions, lag: topicLag.get(t.name) ?? 0, retentionHours: pick([24, 72, 168]) },
    });
  }
  nodes.push({ key: { service: 'clients' }, dims: { domain: 'outside', team: 'outside', kind: 'client', tier: 'edge', role: 'client' }, attrs: { instances: 1 } });

  return {
    version: 1,
    records,
    nodes,
    meta: {
      title,
      window: 'synthetic',
      hierarchy: ['domain', 'team'],
      note: `${svcs.length} services, ${topics.length} topics, ${calls.length} sync edges, ${produces.length + consumes.length} kafka edges, ${sick.size} sick, ${burning.size} burning`,
    },
  };
}
