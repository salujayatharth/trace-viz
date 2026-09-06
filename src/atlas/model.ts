import type { DimValues, FlowTable } from '../model.js';

/**
 * The Atlas model: an ownership tree over leaves (services, topics), the
 * leaf-level call graph with depth, and the two operations everything else
 * is built on - which units are visible under a view state, and how the
 * leaf graph aggregates onto them.
 *
 * Nothing here knows about pixels. See ATLAS.md for the reasoning.
 */

export interface AtlasLeaf {
  id: string;
  label: string;
  kind: string;
  /** Group ids from root-most to nearest: ['payments', 'payments/ledger']. */
  path: string[];
  /** Longest path from an ingress, cycles broken. Drives the x axis. */
  depth: number;
  dims: DimValues;
  attrs: Record<string, number>;
  inRps: number;
  outRps: number;
  /** rps-weighted inbound error rate. */
  errorRate: number;
}

export interface AtlasGroup {
  id: string;
  label: string;
  /** 0 for the top level. */
  level: number;
  parent: string | null;
  /** Child group ids, in display order. Empty for a leaf-holding group. */
  groups: string[];
  /** Direct leaf ids. Only the deepest groups hold leaves. */
  leaves: string[];
  /** Every leaf below, transitively. */
  all: string[];
  depthMin: number;
  depthMax: number;
  rps: number;
  errorRate: number;
  /** Highest consumer lag of any topic in the group. */
  lag: number;
}

export interface AtlasEdge {
  id: string;
  from: string;
  to: string;
  rps: number;
  latencyMs: number;
  errorRate: number;
  bytes: number;
  async: boolean;
  /** fail-closed on every underlying flow. */
  rigid: boolean;
  /** Goes against depth: a callback, a poll, a cycle. */
  back: boolean;
  /** Distinct apis / consumer groups seen on this edge. */
  apis: string[];
  flows: number;
}

export interface AtlasModel {
  leaves: Map<string, AtlasLeaf>;
  groups: Map<string, AtlasGroup>;
  /** Top-level group ids in display order. */
  roots: string[];
  edges: AtlasEdge[];
  byId: Map<string, AtlasEdge>;
  /** Leaf id -> outgoing / incoming edge ids. */
  out: Map<string, string[]>;
  inc: Map<string, string[]>;
  hierarchy: string[];
  leafKey: string;
  maxDepth: number;
}

export interface AtlasModelOptions {
  /** Node dimensions forming the ownership tree, coarsest first. */
  hierarchy?: string[];
  /** The dimension naming a leaf. */
  leafKey?: string;
  /** Keep only records whose dims match every listed value. */
  where?: Record<string, string | string[]>;
}

export function buildAtlas(table: FlowTable, options: AtlasModelOptions = {}): AtlasModel {
  const hierarchy = options.hierarchy ?? ((table.meta?.hierarchy as string[] | undefined) ?? ['domain', 'team']);
  const leafKey = options.leafKey ?? 'service';
  const where = options.where ?? {};

  // Node facts: the dims that place a leaf in the tree.
  const facts = new Map<string, { dims: DimValues; attrs: Record<string, number> }>();
  for (const n of table.nodes ?? []) {
    const id = n.key[leafKey];
    if (!id) continue;
    const prev = facts.get(id);
    facts.set(id, { dims: { ...(prev?.dims ?? {}), ...(n.dims ?? {}) }, attrs: { ...(prev?.attrs ?? {}), ...(n.attrs ?? {}) } });
  }

  const matches = (dims: DimValues | undefined): boolean => {
    for (const [k, v] of Object.entries(where)) {
      const val = dims?.[k];
      if (val === undefined) continue;
      if (Array.isArray(v) ? !v.includes(val) : v !== val) return false;
    }
    return true;
  };

  // Aggregate records to leaf pairs.
  type Acc = { rps: number; lat: number; err: number; bytes: number; async: boolean; rigid: boolean; apis: Set<string>; flows: number };
  const acc = new Map<string, Acc>();
  const leafIds = new Set<string>();
  for (const r of table.records) {
    if (!matches(r.dims)) continue;
    const from = r.from[leafKey];
    const to = r.to[leafKey];
    if (!from || !to || from === to) continue;
    leafIds.add(from);
    leafIds.add(to);
    const key = `${from}\u0000${to}`;
    const a = acc.get(key) ?? { rps: 0, lat: 0, err: 0, bytes: 0, async: true, rigid: true, apis: new Set(), flows: 0 };
    const rps = r.metrics.rps;
    a.rps += rps;
    a.lat += (r.metrics.latencyMs ?? 0) * rps;
    a.err += (r.metrics.errorRate ?? 0) * rps;
    a.bytes += (r.metrics.bytes ?? 0) * rps;
    const transport = r.dims?.transport ?? r.dims?.protocol ?? '';
    if (!/kafka|async|queue|sqs|pubsub|rabbit/i.test(transport)) a.async = false;
    if (!/closed|rigid|hard|required/i.test(r.dims?.failure ?? '')) a.rigid = false;
    const api = r.dims?.group ?? r.to[`api`] ?? r.from[`api`];
    if (api) a.apis.add(api);
    a.flows++;
    acc.set(key, a);
  }
  for (const id of facts.keys()) leafIds.add(id);

  const edges: AtlasEdge[] = [];
  const out = new Map<string, string[]>();
  const inc = new Map<string, string[]>();
  for (const id of leafIds) {
    out.set(id, []);
    inc.set(id, []);
  }
  for (const [key, a] of acc) {
    const [from, to] = key.split('\u0000') as [string, string];
    const e: AtlasEdge = {
      id: `${from}>${to}`,
      from,
      to,
      rps: a.rps,
      latencyMs: a.rps > 0 ? a.lat / a.rps : 0,
      errorRate: a.rps > 0 ? a.err / a.rps : 0,
      bytes: a.rps > 0 ? a.bytes / a.rps : 0,
      async: a.async,
      rigid: a.rigid,
      back: false,
      apis: [...a.apis].sort(),
      flows: a.flows,
    };
    edges.push(e);
    out.get(from)!.push(e.id);
    inc.get(to)!.push(e.id);
  }
  const edgeById = new Map(edges.map((e) => [e.id, e]));

  // --- depth: longest sync path from sources, DFS by traffic, cycles broken --
  // Async hops do not count: an event consumed by a worker at the edge does
  // not make that worker "deeper" than the store it reads. Topics sit one
  // column past their producers, and a consume edge that goes against depth
  // is drawn as an arc, which is exactly what it is - a feedback loop.
  const depth = new Map<string, number>();
  const state = new Map<string, 1 | 2>();
  const isTopic = (id: string): boolean => /topic|queue/i.test(facts.get(id)?.dims.kind ?? '');
  const byRps = (ids: string[]): string[] => [...ids].sort((a, b) => edgeById.get(b)!.rps - edgeById.get(a)!.rps);
  const visit = (id: string): number => {
    if (state.get(id) === 2) return depth.get(id)!;
    if (state.get(id) === 1) return -1; // in stack: the caller's edge is a back-edge
    state.set(id, 1);
    let d = 0;
    for (const eid of byRps(inc.get(id) ?? [])) {
      const e = edgeById.get(eid)!;
      if (e.async || isTopic(e.from) || isTopic(id)) continue;
      const pd = visit(e.from);
      if (pd < 0) e.back = true;
      else d = Math.max(d, pd + 1);
    }
    depth.set(id, d);
    state.set(id, 2);
    return d;
  };
  const totalOut = (id: string): number => (out.get(id) ?? []).reduce((s, eid) => s + edgeById.get(eid)!.rps, 0);
  for (const id of [...leafIds].sort((a, b) => totalOut(b) - totalOut(a))) visit(id);
  const placeTopics = (): void => {
    for (const id of leafIds) {
      if (!isTopic(id)) continue;
      let d = 0;
      for (const eid of inc.get(id) ?? []) if (!isTopic(edgeById.get(eid)!.from)) d = Math.max(d, (depth.get(edgeById.get(eid)!.from) ?? 0) + 1);
      depth.set(id, d);
    }
  };
  placeTopics();
  // A pure consumer (no sync callers, only events in) belongs downstream of
  // what it consumes, not in the ingress column. Lift it, then push the lift
  // through its sync callees; the sync graph is a DAG so this settles.
  for (const id of leafIds) {
    if (isTopic(id)) continue;
    const ins = (inc.get(id) ?? []).map((eid) => edgeById.get(eid)!);
    if (ins.some((e) => !e.async && !e.back)) continue;
    let d = depth.get(id) ?? 0;
    for (const e of ins) if (e.async) d = Math.max(d, (depth.get(e.from) ?? 0) + 1);
    depth.set(id, d);
  }
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    for (const e of edges) {
      if (e.async || e.back || isTopic(e.from) || isTopic(e.to)) continue;
      const want = (depth.get(e.from) ?? 0) + 1;
      if ((depth.get(e.to) ?? 0) < want) {
        depth.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  placeTopics();
  for (const e of edges) if ((depth.get(e.to) ?? 0) <= (depth.get(e.from) ?? 0)) e.back = true;
  const maxDepth = Math.max(0, ...depth.values());

  // --- leaves ---------------------------------------------------------------
  const leaves = new Map<string, AtlasLeaf>();
  for (const id of leafIds) {
    const f = facts.get(id);
    const dims = f?.dims ?? {};
    const path: string[] = [];
    let prefix = '';
    for (const h of hierarchy) {
      const v = dims[h] ?? '—';
      prefix = prefix ? `${prefix}/${v}` : v;
      path.push(prefix);
    }
    let inRps = 0;
    let err = 0;
    for (const eid of inc.get(id) ?? []) {
      const e = edgeById.get(eid)!;
      inRps += e.rps;
      err += e.errorRate * e.rps;
    }
    const outRps = totalOut(id);
    leaves.set(id, {
      id,
      label: id,
      kind: dims.kind ?? 'service',
      path,
      depth: depth.get(id) ?? 0,
      dims,
      attrs: f?.attrs ?? {},
      inRps,
      outRps,
      errorRate: inRps > 0 ? err / inRps : 0,
    });
  }

  // --- groups ---------------------------------------------------------------
  const groups = new Map<string, AtlasGroup>();
  for (const leaf of leaves.values()) {
    leaf.path.forEach((gid, level) => {
      let g = groups.get(gid);
      if (!g) {
        g = {
          id: gid,
          label: gid.slice(gid.lastIndexOf('/') + 1),
          level,
          parent: level > 0 ? leaf.path[level - 1]! : null,
          groups: [],
          leaves: [],
          all: [],
          depthMin: Infinity,
          depthMax: -Infinity,
          rps: 0,
          errorRate: 0,
          lag: 0,
        };
        groups.set(gid, g);
        if (g.parent) {
          const p = groups.get(g.parent)!;
          if (!p.groups.includes(gid)) p.groups.push(gid);
        }
      }
      g.all.push(leaf.id);
      if (level === leaf.path.length - 1) g.leaves.push(leaf.id);
      g.depthMin = Math.min(g.depthMin, leaf.depth);
      g.depthMax = Math.max(g.depthMax, leaf.depth);
      g.rps += leaf.inRps;
      g.errorRate += leaf.errorRate * leaf.inRps;
      g.lag = Math.max(g.lag, leaf.attrs.lag ?? 0);
    });
  }
  for (const g of groups.values()) {
    g.errorRate = g.rps > 0 ? g.errorRate / g.rps : 0;
    if (!Number.isFinite(g.depthMin)) g.depthMin = g.depthMax = 0;
  }
  // Display order: shallow (edge) groups first, then by name. Stable across
  // every view state, which is what makes positions memorable.
  const meanDepth = (g: AtlasGroup): number => g.all.reduce((s, id) => s + leaves.get(id)!.depth, 0) / Math.max(1, g.all.length);
  const orderIds = (ids: string[]): string[] =>
    ids.sort((a, b) => meanDepth(groups.get(a)!) - meanDepth(groups.get(b)!) || a.localeCompare(b));
  for (const g of groups.values()) orderIds(g.groups);
  const roots = orderIds([...groups.values()].filter((g) => g.level === 0).map((g) => g.id));

  return { leaves, groups, roots, edges, byId: edgeById, out, inc, hierarchy, leafKey, maxDepth };
}

// --- view state ---------------------------------------------------------------

export interface AtlasState {
  /** Expanded group ids. A collapsed group is one unit; an expanded one shows its children. */
  expanded: string[];
  focus: string | null;
  /** Neighbourhood radius around the focus that is forced to leaf level. */
  hops: number;
  killed: string[];
  /** Leaves that must be visible regardless of expansion (a trail); their groups open partially. */
  pins?: string[];
}

export const emptyState = (): AtlasState => ({ expanded: [], focus: null, hops: 1, killed: [], pins: [] });

/** A unit is anything drawn as one thing: a collapsed group or a leaf. */
export interface Unit {
  id: string;
  kind: 'group' | 'leaf';
  /** Leaf ids the unit stands for. */
  members: string[];
  depthMin: number;
  depthMax: number;
}

/** Leaves within `hops` of `id`, either direction. */
export function neighbourhood(model: AtlasModel, id: string, hops: number): Set<string> {
  const seen = new Set<string>([id]);
  let frontier = [id];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const eid of model.out.get(n) ?? []) {
        const to = eid.slice(eid.indexOf('>') + 1);
        if (!seen.has(to)) {
          seen.add(to);
          next.push(to);
        }
      }
      for (const eid of model.inc.get(n) ?? []) {
        const from = eid.slice(0, eid.indexOf('>'));
        if (!seen.has(from)) {
          seen.add(from);
          next.push(from);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

/** The effective expanded set: the user's, plus whatever the focus forces open. */
export function effectiveExpanded(model: AtlasModel, state: AtlasState): Set<string> {
  const expanded = new Set(state.expanded);
  // Expanding a group implies its ancestors are expanded too.
  for (const id of [...expanded]) {
    let g = model.groups.get(id);
    while (g?.parent) {
      expanded.add(g.parent);
      g = model.groups.get(g.parent);
    }
  }
  for (const id of wanted(model, state)) for (const gid of model.leaves.get(id)!.path) expanded.add(gid);
  return expanded;
}

/** Leaves the state insists on seeing: the focus neighbourhood plus any pins. */
function wanted(model: AtlasModel, state: AtlasState): Set<string> {
  const w = new Set<string>();
  if (state.focus && model.leaves.has(state.focus)) for (const id of neighbourhood(model, state.focus, state.hops)) w.add(id);
  for (const id of state.pins ?? []) if (model.leaves.has(id)) w.add(id);
  return w;
}

/** The id of the "N more" tile that stands for the unfocused rest of a partially opened group. */
export const restOf = (gid: string): string => `${gid}#rest`;
export const baseOf = (id: string): string => (id.endsWith('#rest') ? id.slice(0, -5) : id);

export function visibleUnits(model: AtlasModel, state: AtlasState): { units: Unit[]; expanded: Set<string> } {
  const expanded = effectiveExpanded(model, state);
  // Groups the user opened (and their ancestors) show everything. Groups
  // opened only because the focus's neighbourhood lives there show just
  // those neighbours, and fold the rest of the team into one "N more" tile -
  // a service's 45 teammates are context, not the thing you asked to see.
  const user = effectiveExpanded(model, { ...state, focus: null, pins: [] });
  const want = wanted(model, state);
  const hood = want.size ? want : null;
  const units: Unit[] = [];
  const walk = (gid: string): void => {
    const g = model.groups.get(gid)!;
    if (!expanded.has(gid)) {
      units.push({ id: gid, kind: 'group', members: g.all, depthMin: g.depthMin, depthMax: g.depthMax });
      return;
    }
    for (const c of g.groups) walk(c);
    const partial = hood && !user.has(gid);
    const rest: string[] = [];
    for (const lid of g.leaves) {
      const l = model.leaves.get(lid)!;
      if (partial && !hood!.has(lid)) {
        rest.push(lid);
        continue;
      }
      units.push({ id: lid, kind: 'leaf', members: [lid], depthMin: l.depth, depthMax: l.depth });
    }
    if (rest.length) {
      const ds = rest.map((id) => model.leaves.get(id)!.depth);
      units.push({ id: restOf(gid), kind: 'group', members: rest, depthMin: Math.min(...ds), depthMax: Math.max(...ds) });
    }
  };
  for (const r of model.roots) walk(r);
  return { units, expanded };
}

export interface UnitEdge {
  id: string;
  from: string;
  to: string;
  rps: number;
  latencyMs: number;
  errorRate: number;
  bytes: number;
  /** All underlying flows are async. */
  async: boolean;
  /** Some underlying flow is async and some is not. */
  mixed: boolean;
  rigid: boolean;
  back: boolean;
  /** Underlying leaf edges. */
  leafEdges: AtlasEdge[];
  /** Distinct leaves on each side. */
  fromLeaves: number;
  toLeaves: number;
  /** rps-weighted mean depth of the leaves on each side: where along the path this traffic leaves and lands. */
  fromDepth: number;
  toDepth: number;
}

/** Fold the leaf graph onto the visible units. Internal traffic of a unit is dropped (it is reported on the unit). */
export function aggregateEdges(model: AtlasModel, units: Unit[], keep: (e: AtlasEdge) => boolean = () => true): { edges: UnitEdge[]; unitOf: Map<string, string>; internal: Map<string, number> } {
  const unitOf = new Map<string, string>();
  for (const u of units) for (const m of u.members) unitOf.set(m, u.id);
  const internal = new Map<string, number>();
  const acc = new Map<string, UnitEdge & { lat: number; err: number; by: number; fd: number; td: number; syncSeen: boolean; asyncSeen: boolean; fl: Set<string>; tl: Set<string> }>();
  for (const e of model.edges) {
    if (!keep(e)) continue;
    const a = unitOf.get(e.from);
    const b = unitOf.get(e.to);
    if (!a || !b) continue;
    if (a === b) {
      internal.set(a, (internal.get(a) ?? 0) + e.rps);
      continue;
    }
    const key = `${a}>${b}`;
    let u = acc.get(key);
    if (!u) {
      u = {
        id: key, from: a, to: b, rps: 0, latencyMs: 0, errorRate: 0, bytes: 0, async: false, mixed: false, rigid: true, back: true,
        leafEdges: [], fromLeaves: 0, toLeaves: 0, fromDepth: 0, toDepth: 0, lat: 0, err: 0, by: 0, fd: 0, td: 0, syncSeen: false, asyncSeen: false, fl: new Set(), tl: new Set(),
      };
      acc.set(key, u);
    }
    u.rps += e.rps;
    u.lat += e.latencyMs * e.rps;
    u.err += e.errorRate * e.rps;
    u.by += e.bytes * e.rps;
    u.fd += model.leaves.get(e.from)!.depth * e.rps;
    u.td += model.leaves.get(e.to)!.depth * e.rps;
    if (e.async) u.asyncSeen = true;
    else u.syncSeen = true;
    if (!e.rigid) u.rigid = false;
    if (!e.back) u.back = false;
    u.leafEdges.push(e);
    u.fl.add(e.from);
    u.tl.add(e.to);
  }
  const edges: UnitEdge[] = [];
  for (const u of acc.values()) {
    edges.push({
      id: u.id, from: u.from, to: u.to, rps: u.rps,
      latencyMs: u.rps > 0 ? u.lat / u.rps : 0,
      errorRate: u.rps > 0 ? u.err / u.rps : 0,
      bytes: u.rps > 0 ? u.by / u.rps : 0,
      async: u.asyncSeen && !u.syncSeen,
      mixed: u.asyncSeen && u.syncSeen,
      rigid: u.rigid,
      back: u.back,
      leafEdges: u.leafEdges,
      fromLeaves: u.fl.size,
      toLeaves: u.tl.size,
      fromDepth: u.rps > 0 ? u.fd / u.rps : 0,
      toDepth: u.rps > 0 ? u.td / u.rps : 0,
    });
  }
  edges.sort((a, b) => b.rps - a.rps);
  return { edges, unitOf, internal };
}

/**
 * The heaviest path from `from` to `to`: Dijkstra on -log(share), so the path
 * that carries the most of each hop's traffic wins. Returns leaf ids, or null.
 */
export function trail(model: AtlasModel, from: string, to: string): string[] | null {
  if (!model.leaves.has(from) || !model.leaves.has(to)) return null;
  const dist = new Map<string, number>([[from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const outRps = (id: string): number => model.leaves.get(id)!.outRps || 1;
  while (true) {
    let best: string | null = null;
    let bd = Infinity;
    for (const [id, d] of dist) if (!done.has(id) && d < bd) { bd = d; best = id; }
    if (best === null) return null;
    if (best === to) break;
    done.add(best);
    for (const eid of model.out.get(best) ?? []) {
      const e = model.byId.get(eid)!;
      const w = -Math.log(Math.max(1e-6, e.rps / outRps(best)));
      const nd = bd + w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, best);
      }
    }
  }
  const path = [to];
  while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
  return path;
}

/**
 * Blast radius on the leaf graph. Rigid edges carry death upstream; breakaway
 * edges stop it (the caller is degraded). Same semantics as the flat renderer.
 */
export function propagate(model: AtlasModel, killed: string[]): { dead: Set<string>; degraded: Set<string> } {
  const dead = new Set(killed.filter((k) => model.leaves.has(k)));
  const degraded = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of model.edges) {
      if (!dead.has(e.to) || dead.has(e.from)) continue;
      if (e.rigid) {
        dead.add(e.from);
        degraded.delete(e.from);
        changed = true;
      } else if (!degraded.has(e.from)) {
        degraded.add(e.from);
      }
    }
  }
  return { dead, degraded };
}

/** Search leaves and groups by substring; leaves first, then groups. */
export function search(model: AtlasModel, query: string, limit = 12): { id: string; kind: string; label: string; path: string[] }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: { id: string; kind: string; label: string; path: string[]; score: number }[] = [];
  for (const l of model.leaves.values()) {
    const i = l.id.toLowerCase().indexOf(q);
    if (i >= 0) hits.push({ id: l.id, kind: l.kind, label: l.id, path: l.path, score: i + (l.id.length - q.length) * 0.01 });
  }
  for (const g of model.groups.values()) {
    const i = g.label.toLowerCase().indexOf(q);
    if (i >= 0) hits.push({ id: g.id, kind: `group:${model.hierarchy[g.level] ?? 'group'}`, label: g.label, path: g.parent ? [g.parent] : [], score: i - 0.5 });
  }
  return hits.sort((a, b) => a.score - b.score).slice(0, limit);
}
